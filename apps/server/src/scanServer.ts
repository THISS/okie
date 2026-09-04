import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HOSTED_SCAN_AUTH_ERROR, resolveScanGithubAccess, scanQuotaKey } from "./githubAccess.js";
import type { GithubAuthService } from "./githubOAuth.js";
import { LOGIN_PATH } from "./githubOAuth.js";
import { toPublicJob, type ScanJob, type ScanJobQueue } from "./jobs.js";
import { healthzBody, type EnrichMode } from "./localDefaults.js";
import { answerAskQuestion, HOSTED_ASK_AUTH_ERROR, publicAskStatus } from "./ask.js";
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
import { redactGatewayText, type LlmGatewayConfig } from "./llmGateway.js";
import { normalizeRepoInput } from "./repoUrl.js";
import {
  isExcerptScanPath,
  isNeighborhoodScanPath,
  serveExcerptPacket,
  serveNeighborhoodPacket,
} from "./scanNeighborhood.js";
import { resolvePublishedScanFile } from "./scanObjects.js";

export interface ScanHttpOptions {
  queue: ScanJobQueue;
  allowSubmit: (key: string) => boolean;
  auth: GithubAuthService;
  scanRoot: string;
  llm: LlmGatewayConfig;
  enrich: EnrichMode;
  bind: string;
  threads?: AskThreadStore;
}

function sendJson(response: ServerResponse, status: number, body: unknown, pretty = true): void {
  const text = `${pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(text);
}

async function readJsonBody(request: IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Serves one published scan object; the scan root is the only readable tree. */
function serveScanObject(scanRoot: string, pathname: string, response: ServerResponse): void {
  const target = resolvePublishedScanFile(scanRoot, pathname);
  if (!target) {
    sendJson(response, 404, { error: "not found" });
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
  const threads = options.threads ?? createAskThreadStore();

  function publicJob(job: ScanJob): Record<string, unknown> {
    return toPublicJob(job, text => redactGatewayText(text, llm.apiKey));
  }

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (await auth.handle(request, response, url)) return;

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
      const result = await answerAskQuestion(llm, body);
      if (result.connected && "answer" in result && result.answer) {
        const question = typeof record.question === "string" ? record.question : "";
        const answer = redactGatewayText(result.answer, llm.apiKey);
        const thread = persistAskTurn(threads, session.userId, atlas, {
          question,
          answer,
          citations: result.citations,
          scopeIds: result.scopeIds,
        }, llm.apiKey);
        sendJson(response, 200, { ...result, answer, thread: publicAskThread(thread) });
        return;
      }
      sendJson(response, 200, result);
      return;
    }

    if (request.method === "POST" && pathname === "/api/scans") {
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
      const job = queue.get(decodeURIComponent(pathname.slice("/api/scans/".length)));
      if (!job) {
        sendJson(response, 404, { error: "no such scan job" });
        return;
      }
      sendJson(response, 200, { job: publicJob(job) });
      return;
    }

    if (request.method === "GET" && pathname === "/api/scans") {
      sendJson(response, 200, { jobs: queue.list().slice(0, 50).map(publicJob) });
      return;
    }

    if (request.method === "GET" && isNeighborhoodScanPath(pathname)) {
      const packet = serveNeighborhoodPacket(scanRoot, { pathname, searchParams: url.searchParams });
      if (!packet) {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      sendJson(response, 200, packet, false);
      return;
    }

    if (request.method === "GET" && isExcerptScanPath(pathname)) {
      const packet = serveExcerptPacket(scanRoot, { pathname, searchParams: url.searchParams });
      if (!packet) {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      sendJson(response, 200, packet, false);
      return;
    }

    if (request.method === "GET" && pathname.startsWith("/scan/")) {
      serveScanObject(scanRoot, pathname, response);
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
      sendJson(response, 500, { error: redactGatewayText(raw, options.llm.apiKey) });
    });
  });
}
