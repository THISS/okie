import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createBlockPlanReplayStore, createBlockPlanService, publicationBlockPlanSource, resolveBlockPlannerConfig } from "./blockPlans.js";
import { resolveTrustedProxy } from "./clientAddress.js";
import type { LlmGatewayConfig } from "./llmGateway.js";
import { createOperatorBudgetLedger } from "./operatorBudget.js";
import { createJevProvider } from "./operatorJudgments.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore } from "./operatorStore.js";
import { createPublishedMirror, resolvePublishedRefreshMs, type PublishedMirror } from "./publishedMirror.js";
import { resolvePublishedTrioCacheEntries, setPublishedTrioCacheLimit } from "./scanNeighborhood.js";
import { createScanHttpServer } from "./scanServer.js";

/**
 * CLA-266 `OKIE_SERVER_MODE=public-readonly`: the stateless container behind the edge Worker. No OAuth, no operator
 * workflow, no scan submit, no incremental automation, no enrichment runner. The scan root is scratch disk the
 * published mirror fills from `OKIE_PUBLISHED_STORE_URL`; the planner ledger and replay rows live in a separate
 * scratch runtime directory, so the mirror is the only writer of its store.
 */
export interface PublicReadonlyRuntime {
  server: ReturnType<typeof createScanHttpServer>;
  mirror: PublishedMirror | undefined;
  scanRoot: string;
  /** Scratch directory for the planner ledger and replay rows (never served). */
  runtimeRoot: string;
}

export function createPublicReadonlyRuntime(input: {
  env: NodeJS.Dict<string>;
  llm: LlmGatewayConfig;
  bind: string;
  log: (line: string) => void;
  fetch?: typeof fetch;
}): PublicReadonlyRuntime {
  const { env, llm, bind, log } = input;
  const scanRoot = env.OKIE_SCAN_ROOT?.trim() ? resolve(env.OKIE_SCAN_ROOT) : mkdtempSync(join(tmpdir(), "okie-published-"));
  mkdirSync(scanRoot, { recursive: true });
  const runtimeRoot = mkdtempSync(join(tmpdir(), "okie-runtime-"));
  setPublishedTrioCacheLimit(resolvePublishedTrioCacheEntries(env));

  // Opened before the mirror writes: the store's open-time scrub/recovery runs on an empty (or its own) state.
  const store = new OperatorStore(scanRoot);
  const publications = new OperatorPublicationService(store);
  const storeUrl = env.OKIE_PUBLISHED_STORE_URL?.trim();
  const mirror = storeUrl
    ? createPublishedMirror({ storeUrl, store, refreshMs: resolvePublishedRefreshMs(env), log, ...(input.fetch ? { fetch: input.fetch } : {}) })
    : undefined;

  const runtimeStore = new OperatorStore(runtimeRoot);
  const blockPlannerConfig = resolveBlockPlannerConfig(env);
  const blockPlans = createBlockPlanService({
    config: blockPlannerConfig,
    provider: blockPlannerConfig.enabled ? createJevProvider() : undefined,
    source: publicationBlockPlanSource(publications, store),
    plannerLedger: createOperatorBudgetLedger({
      maxRequests: blockPlannerConfig.maxRequests,
      maxTokens: Number.MAX_SAFE_INTEGER,
      maxDollars: blockPlannerConfig.maxDollars,
    }, { store: runtimeStore, runId: "jev-block-planner" }),
    replay: createBlockPlanReplayStore(join(runtimeRoot, "block-plans")),
    log,
  });

  const server = createScanHttpServer({
    mode: "public-readonly",
    published: { publications, store },
    ...(mirror ? { ensurePublished: (slug: string, versionId?: string, hint?: { commitSha?: string }) => mirror.ensure(slug, versionId, hint) } : {}),
    blockPlans,
    scanRoot,
    llm,
    enrich: "off",
    bind,
    trustedProxy: resolveTrustedProxy(env),
  });
  return { server, mirror, scanRoot, runtimeRoot };
}
