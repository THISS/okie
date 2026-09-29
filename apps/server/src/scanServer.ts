import { createSourceService, isSourceScanPath, SourceRequestError } from "./scanSource.js";
import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HOSTED_SCAN_AUTH_ERROR, resolveScanGithubAccess, scanQuotaKey } from "./githubAccess.js";
import type { GithubAuthService } from "./githubOAuth.js";
import { LOGIN_PATH } from "./githubOAuth.js";
import { createSubmitLimiter, toPublicJob, type ScanJob, type ScanJobQueue } from "./jobs.js";
import { healthzBody, type EnrichMode } from "./localDefaults.js";
import { answerAskQuestion, askGatewayConnected, HOSTED_ASK_AUTH_ERROR, publicAskStatus } from "./ask.js";
import {
  ASK_THREAD_PATH,
  askAtlasIdentityFromSearch,
  createAskThreadStore,
  emptyPublicAskThread,
  persistAskTurn,
  publicAskThread,
  sanitizeAskAtlasIdentity,
  type AskThreadStore,
} from "./askThreads.js";
import { redactGatewayErrorText, redactGatewayText, type LlmGatewayConfig } from "./llmGateway.js";
import { normalizeRepoInput } from "./repoUrl.js";
import {
  isExcerptScanPath,
  isNeighborhoodScanPath,
  serveExcerptPacket,
  serveNeighborhoodPacket,
} from "./scanNeighborhood.js";
import { resolvePublishedScanFile, resolvePublicationScanFile } from "./scanObjects.js";
import { handleOperatorApi, type OperatorApiOptions } from "./operatorApi.js";
import { automationBodyLimit, automationPreflight, handleIncrementalAutomation, INCREMENTAL_CRON_PATH, INCREMENTAL_WEBHOOK_PATH } from "./operatorIncrementalTriggers.js";
import { readArtifactScopes } from "./operatorWorkflow.js";
import { MAX_BLOCK_PLAN_REQUEST_BYTES, type BlockPlanService } from "./blockPlans.js";
import { createAskCorpusSource, sanitizeAskSlug, type AskCorpusSource } from "./askRetrieval.js";

export interface ScanHttpOptions {
  queue: ScanJobQueue;
  allowSubmit: (key: string) => boolean;
  auth: GithubAuthService;
  scanRoot: string;
  llm: LlmGatewayConfig;
  enrich: EnrichMode;
  bind: string;
  threads?: AskThreadStore;
  sourceFetch?: typeof fetch;
  operator?: OperatorApiOptions;
  /** CLA-149 Jev block planner (`POST /api/block-plan`); absent → the route answers `unavailable`. */
  blockPlans?: BlockPlanService;
  /** CLA-265 whole-atlas Ask corpus; default resolves published snapshots like `/scan/*`. */
  askCorpus?: AskCorpusSource;
  /** Per-account Ask rate limit (CLA-265); default ASK_REQUESTS_PER_WINDOW per 10 minutes. */
  allowAsk?: (key: string) => boolean;
}

/** Default POST /api/ask budget per signed-in account per 10 minutes. */
export const ASK_REQUESTS_PER_WINDOW = 30;

/** CLA-149 Jev block planner: public, bounded, off unless OKIE_JEV_BLOCK_PLANNER=on. */
export const BLOCK_PLAN_PATH = "/api/block-plan";

function sendJson(response: ServerResponse, status: number, body: unknown, pretty = true): void {
  const text = `${pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(text);
}

function operatorRepositoryForSlug(operator: OperatorApiOptions | undefined, slug: string | undefined): string | undefined {
  return slug && operator ? operator.publications.repositoryIdForSlug(slug) : undefined;
}

async function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(request: IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
  return JSON.parse((await readRawBody(request, maxBytes)).toString("utf8")) as unknown;
}

/** Serves one published scan object; the scan root is the only readable tree. */
function serveScanObject(scanRoot: string, pathname: string, response: ServerResponse, operator?: OperatorApiOptions, versionId?: string): void {
  const slug = pathname.split("/")[2];
  const repositoryId = operatorRepositoryForSlug(operator, slug);
  const target = operator ? resolvePublicationScanFile({ scanRoot, pathname, ...(repositoryId ? { repositoryId } : {}), ...(versionId ? { versionId } : {}), publications: operator.publications, store: operator.store }) : resolvePublishedScanFile(scanRoot, pathname);
  if (!target) {
    sendJson(response, 404, { error: "not found" });
    return;
  }
  if (pathname.endsWith("/operator-explanations.json") && operator && repositoryId) {
    const publication = operator.publications.currentPublication(repositoryId);
    const artifact = versionId ? operator.publications.artifactForVersion(repositoryId, versionId) : publication && operator.publications.artifactForVersion(repositoryId, publication.versionId);
    if (!artifact) { sendJson(response, 404, { error: "not found" }); return; }
    sendJson(response, 200, { versionId: versionId ?? publication?.versionId, explanations: readArtifactScopes(operator.store, artifact.artifactRevisionId) }, false);
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    // The per-slug layout is mutable (a rescan republishes in place), so scan
    // objects revalidate; the immutable sha-pinned layout is the hosted v-next.
    "cache-control": "no-cache",
  });
  createReadStream(target).pipe(response);
}

function askAuthDenied(): Record<string, unknown> {
  return {
    error: HOSTED_ASK_AUTH_ERROR,
    auth: { required: true, loginPath: LOGIN_PATH },
  };
}

export function createScanHttpHandler(options: ScanHttpOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const { queue, allowSubmit, auth, scanRoot, llm, enrich, bind } = options;
  const sourceService = createSourceService(options.sourceFetch, options.operator ? input => {
    const operator = options.operator!;
    const slug = input.pathname.split("/")[2];
    const repositoryId = operatorRepositoryForSlug(operator, slug);
    return repositoryId ? resolvePublicationScanFile({ ...input, repositoryId, publications: operator.publications, store: operator.store }) : undefined;
  } : undefined);
  const threads = options.threads ?? createAskThreadStore();
  const allowAsk = options.allowAsk ?? createSubmitLimiter(ASK_REQUESTS_PER_WINDOW);
  const askCorpus = options.askCorpus ?? createAskCorpusSource({
    scanRoot,
    ...(options.operator ? { publications: options.operator.publications, store: options.operator.store } : {}),
  });

  function publicJob(job: ScanJob): Record<string, unknown> {
    return toPublicJob(job, text => redactGatewayErrorText(text, llm.apiKey));
  }

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (await auth.handle(request, response, url)) return;

    if (options.operator && (pathname === INCREMENTAL_WEBHOOK_PATH || pathname === INCREMENTAL_CRON_PATH)) {
      // CLA-271: no session here; each route checks its own secret. Method, configuration, cron token and a declared
      // oversize are decided before the body is read (404 when unconfigured); the webhook signature is over the raw body.
      const preflight = automationPreflight(options.operator.incremental, request, pathname);
      if (preflight !== "read") { if (preflight) sendJson(response, preflight.status, preflight.body); return; }
      let raw: Buffer;
      try { raw = await readRawBody(request, automationBodyLimit(pathname)); } catch { sendJson(response, 413, { error: "request body too large" }); return; }
      const result = await handleIncrementalAutomation(options.operator.incremental, request, pathname, raw);
      if (result) { sendJson(response, result.status, result.body); return; }
    }

    if (options.operator && pathname.startsWith("/api/operator")) {
      let body: unknown;
      if (request.method === "POST") { try { body = await readJsonBody(request); } catch { sendJson(response, 400, { error: "Expected JSON body" }); return; } }
      const result = await handleOperatorApi(options.operator, request, pathname, body);
      if (result) {
        const bundle = typeof result.body === "object" && result.body !== null ? (result.body as { bundle?: unknown }).bundle : undefined;
        if (pathname.endsWith("/bundle") && typeof bundle === "string" && result.status === 200) { response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(bundle); return; }
        sendJson(response, result.status, result.body); return;
      }
    }

    if (request.method === "GET" && pathname === "/api/ask") {
      sendJson(response, 200, publicAskStatus(llm));
      return;
    }

    if (request.method === "GET" && pathname === ASK_THREAD_PATH) {
      const session = auth.sessionFromRequest(request);
      if (!session) {
        sendJson(response, 401, askAuthDenied());
        return;
      }
      const atlas = askAtlasIdentityFromSearch(url.searchParams);
      if (!atlas) {
        sendJson(response, 400, { error: "Ask thread needs atlas identity {owner, repo, commitSha}." });
        return;
      }
      const thread = threads.get(session.userId, atlas);
      sendJson(response, 200, { thread: thread ? publicAskThread(thread) : emptyPublicAskThread(atlas) });
      return;
    }

    if (request.method === "POST" && pathname === "/api/ask") {
      const session = auth.sessionFromRequest(request);
      if (!session) {
        sendJson(response, 401, askAuthDenied());
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(request, 48 * 1024);
      } catch {
        sendJson(response, 400, { error: "Expected a JSON body: {\"question\": \"...\", \"packets\": [...], \"atlas\": {\"owner\": \"...\", \"repo\": \"...\", \"commitSha\": \"...\"}}" });
        return;
      }
      const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const atlas = sanitizeAskAtlasIdentity(record.atlas);
      if (!atlas) {
        sendJson(response, 400, { error: "Ask needs atlas identity {owner, repo, commitSha}." });
        return;
      }
      // Cheap checks first: never parse a snapshot / build an index for a request that cannot be answered.
      if (!askGatewayConnected(llm)) { sendJson(response, 200, { connected: false }); return; }
      if (typeof record.question !== "string" || !record.question.trim()) { sendJson(response, 200, { connected: true, error: "Ask needs a question." }); return; }
      if (!allowAsk(`ask:${session.userId}`)) { sendJson(response, 429, { error: "Too many questions from this account; try again in a few minutes." }); return; }
      const slug = sanitizeAskSlug((record.atlas as Record<string, unknown>).slug);
      let corpus;
      try { corpus = askCorpus.resolve({ ...(slug !== undefined ? { slug } : {}), owner: atlas.owner, repo: atlas.repo, commitSha: atlas.commitSha }); } catch { corpus = undefined; }
      const result = await answerAskQuestion(llm, body, { ...(corpus ? { corpus } : {}), systemNames: [atlas.repo] });
      if (result.connected && "answer" in result && result.answer) {
        const question = typeof record.question === "string" ? record.question : "";
        const answer = redactGatewayText(result.answer, llm.apiKey);
        const thread = persistAskTurn(threads, session.userId, atlas, {
          question,
          answer,
          citations: result.citations,
          scopeIds: result.scopeIds,
          citationDetails: result.citationDetails,
          retrieval: result.retrieval,
        }, llm.apiKey);
        sendJson(response, 200, { ...result, answer, thread: publicAskThread(thread) });
        return;
      }
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && pathname === BLOCK_PLAN_PATH) {
      if (!options.blockPlans?.config.enabled) { sendJson(response, 200, { state: "unavailable", reason: "disabled" }, false); return; }
      let body: unknown;
      try { body = await readJsonBody(request, MAX_BLOCK_PLAN_REQUEST_BYTES); } catch { sendJson(response, 400, { error: "Expected a JSON block plan request." }, false); return; }
      const result = await options.blockPlans.handle(body, request.socket.remoteAddress ?? "unknown");
      sendJson(response, result.status, result.body, false);
      return;
    }

    if (request.method === "POST" && pathname === "/api/scans") {
      if (options.operator) { sendJson(response, 403, { error: "use operator workflow" }); return; }
      const session = auth.sessionFromRequest(request);
      const access = resolveScanGithubAccess({
        ...(session ? { session } : {}),
        headers: {
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
        },
      });
      if (access.kind !== "github") {
        sendJson(response, 401, {
          error: HOSTED_SCAN_AUTH_ERROR,
          auth: { required: true, loginPath: LOGIN_PATH },
        });
        return;
      }
      if (!allowSubmit(scanQuotaKey(access)) || !allowSubmit(`ip:${request.socket.remoteAddress ?? "unknown"}`)) {
        sendJson(response, 429, { error: "Too many scans from this account; try again in a few minutes." });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        sendJson(response, 400, { error: "Expected a JSON body: {\"url\": \"https://github.com/owner/repo\"}" });
        return;
      }
      const input = typeof body === "object" && body !== null ? (body as { url?: unknown }).url : undefined;
      const parsed = typeof input === "string" ? normalizeRepoInput(input) : undefined;
      if (!parsed) {
        sendJson(response, 422, {
          error: "That doesn't look like a public GitHub repository. Try https://github.com/owner/repo, owner/repo, or gh:owner/repo@ref.",
        });
        return;
      }
      const { job, deduped } = queue.submit({
        owner: parsed.owner,
        repo: parsed.repo,
        ...(parsed.ref ? { ref: parsed.ref } : {}),
        slug: parsed.dirSlug,
        githubAccess: access,
      });
      sendJson(response, deduped ? 200 : 202, { job: publicJob(job), deduped });
      return;
    }

    if (request.method === "GET" && pathname.startsWith("/api/scans/")) {
      if (options.operator) { sendJson(response, 404, { error: "not found" }); return; }
      const job = queue.get(decodeURIComponent(pathname.slice("/api/scans/".length)));
      if (!job) {
        sendJson(response, 404, { error: "no such scan job" });
        return;
      }
      sendJson(response, 200, { job: publicJob(job) });
      return;
    }

    if (request.method === "GET" && pathname === "/api/scans") {
      if (options.operator) { sendJson(response, 404, { error: "not found" }); return; }
      sendJson(response, 200, { jobs: queue.list().slice(0, 50).map(publicJob) });
      return;
    }

    if (request.method === "GET" && isSourceScanPath(pathname)) {
      try {
        const source = await sourceService(scanRoot, pathname, url.searchParams);
        sendJson(response, 200, source, false);
      }
      catch (error) { sendJson(response, error instanceof SourceRequestError ? error.status : 502, { error: error instanceof SourceRequestError ? error.message : 'Historical source unavailable.' }); }
      return;
    }

    if (request.method === "GET" && isNeighborhoodScanPath(pathname)) {
      const slug = pathname.split("/")[2]; const repositoryId = operatorRepositoryForSlug(options.operator, slug);
      const packet = serveNeighborhoodPacket(scanRoot, { pathname, searchParams: url.searchParams, ...(repositoryId ? { repositoryId, publications: options.operator!.publications, store: options.operator!.store } : {}) });
      if (!packet) {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      sendJson(response, 200, packet, false);
      return;
    }

    if (request.method === "GET" && isExcerptScanPath(pathname)) {
      const slug = pathname.split("/")[2]; const repositoryId = operatorRepositoryForSlug(options.operator, slug);
      const packet = serveExcerptPacket(scanRoot, { pathname, searchParams: url.searchParams, ...(repositoryId ? { repositoryId, publications: options.operator!.publications, store: options.operator!.store } : {}) });
      if (!packet) {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      sendJson(response, 200, packet, false);
      return;
    }

    if (request.method === "GET" && pathname.startsWith("/scan/")) {
      serveScanObject(scanRoot, pathname, response, options.operator, url.searchParams.get("version") ?? undefined);
      return;
    }

    if (request.method === "GET" && (pathname === "/" || pathname === "/healthz")) {
      sendJson(response, 200, healthzBody({ enrich, bind }));
      return;
    }

    sendJson(response, 404, { error: "not found" });
  };
}

export function createScanHttpServer(options: ScanHttpOptions) {
  const handle = createScanHttpHandler(options);
  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const raw = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: redactGatewayErrorText(raw, options.llm.apiKey) });
    });
  });
}
