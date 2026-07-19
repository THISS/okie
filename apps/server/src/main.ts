import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_TARBALL_BYTES } from "@okie/scan";
import { createScanJobQueue, createSubmitLimiter, type ScanJob } from "./jobs.js";
import { normalizeRepoInput } from "./repoUrl.js";
import { createScanJobRunner } from "./scanService.js";

/**
 * The paste-a-repo scan service (embed-hosting design, v2 self-serve):
 *
 *   POST /api/scans {url}   validate GitHub URL → dedupe → enqueue a worker job
 *   GET  /api/scans/:id     job status with stage + enrichment progress
 *   GET  /api/scans         recent jobs (dev visibility)
 *   GET  /scan/*            the published trio objects + index.json manifest
 *
 * The vite dev server proxies /api and /scan here; hosted deployments put the
 * same routes behind the CDN. State on disk (the scan root) is the durable
 * output; job rows are ephemeral progress.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "../../..");
const scanRoot = process.env.OKIE_SCAN_ROOT
  ? resolve(process.env.OKIE_SCAN_ROOT)
  : join(repoRoot, "fixtures/scan");
const port = Number.parseInt(process.env.OKIE_SERVER_PORT ?? "4175", 10);
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
  maxTarballBytes: DEFAULT_MAX_TARBALL_BYTES,
  log,
}));
const allowSubmit = createSubmitLimiter();

function publicJob(job: ScanJob): Record<string, unknown> {
  return {
    id: job.id,
    slug: job.slug,
    owner: job.owner,
    repo: job.repo,
    ...(job.ref ? { ref: job.ref } : {}),
    stage: job.stage,
    atlasReady: job.atlasReady,
    ...(job.commitSha ? { commitSha: job.commitSha } : {}),
    ...(job.entityCount !== undefined ? { entityCount: job.entityCount } : {}),
    ...(job.relationCount !== undefined ? { relationCount: job.relationCount } : {}),
    enrichment: job.enrichment,
    ...(job.error ? { error: job.error } : {}),
    atlasPath: `/r/${job.owner}/${job.repo}`,
    fixtureParam: `scan:${job.slug}`,
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body, null, 2)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(text);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 16 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Serves one published scan object; the scan root is the only readable tree. */
function serveScanObject(pathname: string, response: ServerResponse): void {
  const relative = normalize(decodeURIComponent(pathname.slice("/scan/".length)));
  const target = resolve(scanRoot, relative);
  if (target !== scanRoot && !target.startsWith(scanRoot + sep)) {
    sendJson(response, 404, { error: "not found" });
    return;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
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
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (request.method === "POST" && pathname === "/api/scans") {
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
    sendJson(response, 200, { service: "okie-scan-server", scanRoot, enrich });
    return;
  }

  sendJson(response, 404, { error: "not found" });
}

server.listen(port, () => {
  log(`listening on http://localhost:${port}`);
  log(`scan root: ${scanRoot}`);
  log(`enrichment: ${enrich === "off"
    ? "disabled (OKIE_SCAN_ENRICH=0)"
    : enrich === "force"
      ? "forced (OKIE_SCAN_ENRICH=1)"
      : "auto (runs when ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN is set)"}`);
});
