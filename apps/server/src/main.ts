import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_TARBALL_BYTES } from "@okie/scan";
import { createGithubAuthService } from "./githubOAuth.js";
import { createGlobalEnrichmentSpend, resolveGlobalEnrichmentCap } from "./globalSpend.js";
import { createScanJobQueue, createSubmitLimiter } from "./jobs.js";
import { resolveListenHost } from "./localDefaults.js";
import {
  describeEnrichmentMode,
  createLlmGatewayClient,
  loadOperatorDotenv,
  resolveLlmGatewayConfig,
  resolveLlmGatewayLocalConfig,
} from "./llmGateway.js";
import { createScanHttpServer } from "./scanServer.js";
import { createScanJobRunner } from "./scanService.js";
import { resolveOperatorGithubIds } from "./operatorAccess.js";
import { OperatorStore } from "./operatorStore.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { createOperatorRunner } from "./operatorRunner.js";
import { createOperatorBudgetLedger } from "./operatorBudget.js";

/**
 * Paste-a-repo scan process used by the hosted public atlas (CLA-30):
 *
 *   GET  /api/auth/github          start GitHub OAuth (CSRF state cookie)
 *   GET  /api/auth/github/callback OAuth callback (state must match)
 *   GET  /api/auth/me              public identity, never a token
 *   POST /api/scans {url}          GitHub session required → enqueue a worker job
 *   GET  /api/scans/:id            job status with stage + enrichment progress
 *   GET  /api/scans                recent jobs (dev visibility)
 *   GET  /api/ask                  { connected } — gateway key present, never the key
 *   GET  /api/ask/thread           GitHub session required — that user's turns for owner/repo@sha
 *   POST /api/ask                  GitHub session required → one-shot Q&A; persist thread
 *   GET  /scan/*                   published trio objects, neighborhood packets, excerpts, index.json
 *
 * Public atlas *views* are the web app's `/r/<owner>/<repo>` URLs (no login wall).
 * Docs-site oEmbed (`GET /oembed?url=`) is served by the web origin, not here.
 * Vite proxies /api and /scan here during `pnpm dev`. This process binds loopback
 * by default (CLA-17). Hosted scan requires GitHub sign-in (or a loopback test
 * double). GitHub reads are HTTPS Bearer (OAuth) or HTTPS-only (test-double) —
 * never operator `gh` (CLA-18/30). State on disk (the scan root) is the durable
 * output; job rows are ephemeral progress.
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

const auth = createGithubAuthService({ env: process.env, bind });
const globalSpend = createGlobalEnrichmentSpend(resolveGlobalEnrichmentCap());
const queue = createScanJobQueue(createScanJobRunner({
  scanRoot,
  enrich,
  llmLocal,
  maxTarballBytes: DEFAULT_MAX_TARBALL_BYTES,
  globalSpend,
  log,
}));
const allowSubmit = createSubmitLimiter();
const operatorStore = new OperatorStore(scanRoot);
const operatorPublication = new OperatorPublicationService(operatorStore, scanRoot);
const operatorGlobalBudget = createOperatorBudgetLedger({
  maxRequests: Number.MAX_SAFE_INTEGER,
  maxTokens: globalSpend.cap.maxTokens ?? Number.MAX_SAFE_INTEGER,
  maxDollars: globalSpend.cap.maxDollars ?? Number.MAX_SAFE_INTEGER,
}, { store: operatorStore, runId: "global-operator-enrichment" });
const operatorGateway = createLlmGatewayClient(llm);
const operatorRunner = createOperatorRunner({
  store: operatorStore, publication: operatorPublication, gatewayConfig: llm,
  ...(operatorGateway ? { gateway: {
    modelId: operatorGateway.modelId,
    async chatCompletions(body: Record<string, unknown>) {
      const requestId = operatorGlobalBudget.reserve(Buffer.byteLength(JSON.stringify(body), "utf8") + Number(body.max_tokens ?? 4096));
      if (!requestId) throw new Error("Global enrichment budget reached");
      let usage: import("./llmGateway.js").GatewayUsage | undefined;
      try {
        const result = await operatorGateway.chatCompletions(body);
        usage = result.usage;
        return result;
      } finally {
        operatorGlobalBudget.settle(requestId, usage ? {
          inputTokens: usage.promptTokens ?? Math.max(0, usage.totalTokens - (usage.completionTokens ?? 0)),
          outputTokens: usage.completionTokens ?? 0,
          measuredCostUsd: usage.costUsd,
        } : {});
      }
    },
  } } : {}),
});

const server = createScanHttpServer({
  queue,
  allowSubmit,
  auth,
  scanRoot,
  llm,
  enrich,
  bind,
  operator: {
    auth,
    allowedGithubIds: resolveOperatorGithubIds(process.env),
    publicOrigin: process.env.OKIE_PUBLIC_ORIGIN ?? "http://localhost:4173",
    store: operatorStore,
    publications: operatorPublication,
    enqueue: input => {
      operatorStore.updateRun(input.runId, { state: "queued" });
      void Promise.resolve().then(() => operatorRunner.enqueue(input)).catch(() => {
        operatorStore.updateRun(input.runId, { state: "failed", error: "Operator job failed; review the recorded attempts." });
      });
    },
  },
});

server.listen(port, bind, () => {
  const authMode = auth.config.oauthConfigured
    ? "GitHub OAuth"
    : auth.config.testDouble
      ? "loopback GitHub test-double"
      : "GitHub OAuth unconfigured";
  log(`listening on http://${bind}:${port} (loopback default; ${authMode}; no operator gh)`);
  log(`scan root: ${scanRoot}`);
  log(`enrichment: ${describeEnrichmentMode(enrich, llm)}`);
});
