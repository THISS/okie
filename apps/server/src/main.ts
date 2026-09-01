import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_TARBALL_BYTES } from "@okie/scan";
import { answerAskQuestion, publicAskStatus } from "./ask.js";
import { githubClientForAccess, resolveScanGithubAccess } from "./githubAccess.js";
import { createScanJobQueue, createSubmitLimiter, toPublicJob, type ScanJob } from "./jobs.js";
import { healthzBody, resolveListenHost } from "./localDefaults.js";
import {
  describeEnrichmentMode,
  loadOperatorDotenv,
  redactGatewayText,
  resolveLlmGatewayConfig,
  resolveLlmGatewayLocalConfig,
} from "./llmGateway.js";
import { normalizeRepoInput } from "./repoUrl.js";
import { resolvePublishedScanFile } from "./scanObjects.js";
import { createScanJobRunner } from "./scanService.js";

/**
 * Paste-a-repo scan process used by the hosted public atlas (CLA-30):
 *
 *   POST /api/scans {url}   validate GitHub URL → dedupe → enqueue a worker job
 *   GET  /api/scans/:id     job status with stage + enrichment progress
 *   GET  /api/scans         recent jobs (dev visibility)
 *   GET  /api/ask           { connected } — gateway key present, never the key
 *   POST /api/ask           one-shot Q&A grounded in submitted packets/summaries
 *   GET  /scan/*            the published trio objects + index.json manifest
 *
 * Public atlas *views* are the web app's `/r/<owner>/<repo>` URLs (no login wall).
 * Docs-site oEmbed (`GET /oembed?url=`) is served by the web origin, not here.
 * Vite proxies /api and /scan here during `pnpm dev`. This process still has no
 * HTTP auth and binds loopback by default (CLA-17). Anonymous POST /api/scans
 * uses HTTPS-only GitHub reads — never operator `gh` (CLA-18/30). State on disk
 * (the scan root) is the durable output; job rows are ephemeral progress.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "../../..");
loadOperatorDotenv(repoRoot);
const llmLocal = resolveLlmGatewayLocalConfig(repoRoot);
const llm = resolveLlmGatewayConfig(process.env, llmLocal);
const scanRoot = process.env.OKIE_SCAN_ROOT
  ? resolve(process.env.OKIE_SCAN_ROOT)
  : join(repoRoot, "fixtures/scan");
const port = Number.parseInt(process.env.OKIE_SERVER_PORT ?? "4180", 10);
const bind = resolveListenHost();
const enrich = process.env.OKIE_SCAN_ENRICH === "0"
  ? "off"
  : process.env.OKIE_SCAN_ENRICH === "1"
    ? "force"
    : "auto";

const log = (line: string): void => {
  process.stdout.write(`[okie-server] ${line}\n`);
};

const queue = createScanJobQueue(createScanJobRunner({
  scanRoot,
  enrich,
  llmLocal,
  maxTarballBytes: DEFAULT_MAX_TARBALL_BYTES,
  githubClient: githubClientForAccess(resolveScanGithubAccess()),
  log,
}));
const allowSubmit = createSubmitLimiter();

function publicJob(job: ScanJob): Record<string, unknown> {
  return toPublicJob(job, text => redactGatewayText(text, llm.apiKey));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body, null, 2)}\n`;
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
function serveScanObject(pathname: string, response: ServerResponse): void {
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

const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    const raw = error instanceof Error ? error.message : String(error);
    sendJson(response, 500, { error: redactGatewayText(raw, llm.apiKey) });
  });
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (request.method === "GET" && pathname === "/api/ask") {
    sendJson(response, 200, publicAskStatus(llm));
    return;
  }

  if (request.method === "POST" && pathname === "/api/ask") {
    let body: unknown;
    try {
      body = await readJsonBody(request, 48 * 1024);
    } catch {
      sendJson(response, 400, { error: "Expected a JSON body: {\"question\": \"...\", \"packets\": [...]}" });
      return;
    }
    sendJson(response, 200, await answerAskQuestion(llm, body));
    return;
  }

  if (request.method === "POST" && pathname === "/api/scans") {
    // Vercel-like GitHub auth is the intended abuse gate (CLA-30). This PR
    // keeps paste anonymous: no login wall, no operator `gh`, no private trees.
    const access = resolveScanGithubAccess(request.headers);
    if (access.kind !== "anonymous") {
      sendJson(response, 401, {
        error: "GitHub sign-in is not available yet. Public repositories scan without login.",
      });
      return;
    }
    const key = request.socket.remoteAddress ?? "unknown";
    if (!allowSubmit(key)) {
      sendJson(response, 429, { error: "Too many scans from this address; try again in a few minutes." });
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

  if (request.method === "GET" && pathname.startsWith("/scan/")) {
    serveScanObject(pathname, response);
    return;
  }

  if (request.method === "GET" && (pathname === "/" || pathname === "/healthz")) {
    sendJson(response, 200, healthzBody({ enrich, bind }));
    return;
  }

  sendJson(response, 404, { error: "not found" });
}

server.listen(port, bind, () => {
  log(`listening on http://${bind}:${port} (loopback default; anonymous GitHub HTTPS, no operator gh)`);
  log(`scan root: ${scanRoot}`);
  log(`enrichment: ${describeEnrichmentMode(enrich, llm)}`);
});
