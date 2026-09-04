import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  regenerateScanManifest,
  scanGithubRepository,
  stableJson,
  githubRepoIsPublic,
  repoApiPath,
  type EmittedPackets,
  type GithubClient,
  type GithubSourceRef,
  type ScanArtifacts,
} from "@okie/scan";
import type { JobRunner, ScanJob, ScanJobEnrichment } from "./jobs.js";
import { createEnricher } from "./enrichment.js";
import { githubClientForAccess } from "./githubAccess.js";
import {
  clampEnrichmentBudget,
  GLOBAL_ENRICHMENT_BUDGET_SKIP_NOTE,
  type GlobalEnrichmentSpend,
} from "./globalSpend.js";
import {
  createLlmGatewayClient,
  enrichmentModelId,
  enrichmentProviderLabel,
  hasLlmCredentials,
  isUsableModelId,
  redactGatewayText,
  resolveEnrichmentBudget,
  resolveLlmGatewayConfig,
  type LlmGatewayConfig,
  type LlmGatewayLocalConfig,
} from "./llmGateway.js";
import { publishedEnrichmentStatus, type PublishedEnrichmentStatus } from "./publishedEnrichmentStatus.js";

export type EnrichmentHook = (packets: EmittedPackets) => Promise<ReadonlyMap<string, unknown>>;

export interface ScanServiceOptions {
  /** Directory holding per-repo scan slots + index.json (the served scan root). */
  scanRoot: string;
  maxTarballBytes?: number;
  /**
   * "auto": enrich when a gateway or Anthropic key is visible; "force": attempt even
   * without one (profile-based auth the sniff can't see); "off": deterministic only.
   */
  enrich?: "auto" | "force" | "off";
  /** Env dict for gateway resolution (tests). Defaults to process.env. */
  env?: NodeJS.Dict<string>;
  /** Non-secret local overlay (base URL / model id). */
  llmLocal?: LlmGatewayLocalConfig;
  /** Injectable enrichment factory (tests). Returning undefined skips enrichment. */
  enricherFactory?: (onProgress: (note: string) => void) => EnrichmentHook | undefined;
  /**
   * Process-wide token/$ ceiling across GitHub users (CLA-38). When exhausted,
   * enrichment is skipped and the deterministic atlas stays live.
   */
  globalSpend?: GlobalEnrichmentSpend;
  /**
   * GitHub transport override for tests. Production uses per-job
   * `job.githubAccess` via `githubClientForAccess` — HTTPS Bearer for OAuth/App,
   * HTTPS-only for the loopback test-double, never `gh`, never env tokens.
   */
  githubClient?: GithubClient;
  log?: (line: string) => void;
}

/** Writes published scan artifacts (overview `story.json`, catalog `stories.json`, enrichment report) into the repo's scan slot. */
function publishArtifacts(scanRoot: string, dirSlug: string, artifacts: ScanArtifacts): void {
  const out = join(scanRoot, dirSlug);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "extraction.json"), stableJson(artifacts.extraction));
  writeFileSync(join(out, "snapshot.json"), stableJson(artifacts.snapshot));
  writeFileSync(join(out, "view.json"), stableJson(artifacts.view));
  writeFileSync(join(out, "story.json"), stableJson(artifacts.story));
  writeFileSync(join(out, "stories.json"), stableJson(artifacts.catalog));
  writeFileSync(join(out, "scene.json"), stableJson(artifacts.scene));
  writeFileSync(join(out, "timeline.json"), stableJson(artifacts.timeline));
  const reportPath = join(out, "enrichment-report.json");
  if (artifacts.enrichmentReport) {
    writeFileSync(reportPath, stableJson(artifacts.enrichmentReport));
  } else if (existsSync(reportPath)) {
    unlinkSync(reportPath);
  }
  const manifest = regenerateScanManifest(scanRoot);
  writeFileSync(join(scanRoot, "index.json"), stableJson(manifest));
}

/** Secret-free skip/reject sidecar for the published atlas (CLA-75). Absent when enrichment never ran. */
function publishEnrichmentStatus(
  scanRoot: string,
  dirSlug: string,
  status: PublishedEnrichmentStatus | undefined,
): void {
  const out = join(scanRoot, dirSlug);
  const path = join(out, "enrichment-status.json");
  if (!status) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(path, stableJson(status));
}

function skipNote(config: LlmGatewayConfig): string {
  if (config.keySource === "none") {
    return "no LLM credentials visible (set OKIE_LLM_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY; ANTHROPIC_API_KEY remains a fallback, or OKIE_SCAN_ENRICH=1 for profile auth)";
  }
  return "no LLM credentials visible";
}

const EMPTY_MODEL_NOTE = "empty model id; enrichment not started";

function shouldAttemptEnrichment(mode: "auto" | "force", config: LlmGatewayConfig): boolean {
  return mode === "force" || hasLlmCredentials(config);
}

/** Provider host + model id when enrichment was attempted. Never a key or URL. */
function enrichmentIdentity(
  config: LlmGatewayConfig,
  mode: "auto" | "force",
): Pick<ScanJobEnrichment, "modelId" | "provider"> {
  const modelId = enrichmentModelId(config);
  const provider = enrichmentProviderLabel(config, mode);
  return {
    ...(modelId ? { modelId } : {}),
    ...(provider ? { provider } : {}),
  };
}

/**
 * Default factory for the live enricher. Auto mode skips when no gateway or
 * Anthropic key is visible so the deterministic atlas still publishes. The
 * OpenAI-compatible client is constructed here when a gateway key is present
 * (with the configured per-request timeout). Packet HTTP POSTs each bounded
 * packet to `chatCompletions`; `ANTHROPIC_*` stays on the Anthropic SDK.
 * The hook still runs only inside `scanGithubRepository`'s checkout window.
 */
export function createDefaultEnricherFactory(
  mode: "auto" | "force",
  env: NodeJS.Dict<string> = process.env,
  local: LlmGatewayLocalConfig = {},
  globalSpend?: GlobalEnrichmentSpend,
): (onProgress: (note: string) => void) => EnrichmentHook | undefined {
  return onProgress => {
    const config = resolveLlmGatewayConfig(env, local);
    // Profile-based Anthropic auth (`ant auth login`) is invisible to the sniff —
    // OKIE_SCAN_ENRICH=1 forces the attempt for that setup.
    if (mode === "auto" && !hasLlmCredentials(config)) return undefined;
    if (!isUsableModelId(config.modelId)) {
      return async () => {
        throw new Error(EMPTY_MODEL_NOTE);
      };
    }
    try {
      const budget = clampEnrichmentBudget(resolveEnrichmentBudget(env), globalSpend);
      const gateway = createLlmGatewayClient(config, { timeoutMs: budget.requestTimeoutMs });
      const globalCap = Boolean(
        globalSpend && (globalSpend.cap.maxTokens !== undefined || globalSpend.cap.maxDollars !== undefined),
      );
      return createEnricher({
        onProgress,
        modelId: config.modelId,
        budget,
        ...(globalSpend ? {
          onUsage: usage => globalSpend.record(usage),
          budgetExhausted: () => globalSpend.isExhausted(),
        } : {}),
        ...(globalCap ? { maxConcurrent: 1 } : {}),
        ...(gateway ? { gateway } : {}),
      });
    } catch {
      return undefined;
    }
  };
}

/**
 * The worker body for one paste-a-repo job, staged per the embed-hosting design:
 * the DETERMINISTIC atlas publishes first (instant gratification — the atlas URL
 * is live the moment stage "publishing" completes), then enrichment runs as an
 * async upgrade against the SAME pinned commit and republishes. An enrichment
 * failure downgrades gracefully: the job still completes with the deterministic
 * atlas and carries the failure note.
 */
export function createScanJobRunner(options: ScanServiceOptions): JobRunner {
  const log = options.log ?? (() => {});
  const enrichMode = options.enrich ?? "auto";
  const env = options.env ?? process.env;
  const llmLocal = options.llmLocal ?? {};
  const globalSpend = options.globalSpend;
  const enricherFactory = options.enricherFactory
    ?? (enrichMode === "off" ? () => undefined : createDefaultEnricherFactory(enrichMode, env, llmLocal, globalSpend));
  const githubClientOverride = options.githubClient;
  const redact = (line: string): string => redactGatewayText(line, resolveLlmGatewayConfig(env, llmLocal).apiKey);

  const clientForJob = (job: ScanJob): GithubClient => {
    if (githubClientOverride) return githubClientOverride;
    if (job.githubAccess) return githubClientForAccess(job.githubAccess);
    throw new Error("hosted scan requires GitHub sign-in");
  };

  const rejectPrivateHostedTree = async (client: GithubClient, job: ScanJob): Promise<void> => {
    if (!job.githubAccess) return;
    const result = await client.getJson(repoApiPath(job.owner, job.repo));
    if (!result.ok || !githubRepoIsPublic(result.json)) {
      throw new Error("Could not confirm that repository is public. Private trees stay closed until the GitHub App can read them.");
    }
  };

  return async (job, update) => {
    try {
      const source: GithubSourceRef = {
        owner: job.owner,
        repo: job.repo,
        ...(job.ref ? { ref: job.ref } : {}),
        dirSlug: job.slug,
      };
      const scanOptions = {
        client: clientForJob(job),
        codeSurface: "public" as const,
        ...(options.maxTarballBytes ? { maxTarballBytes: options.maxTarballBytes } : {}),
      };

      update({ stage: "scanning" });
      log(redact(`${job.id}: scanning gh:${job.owner}/${job.repo}${job.ref ? `@${job.ref}` : ""}`));
      await rejectPrivateHostedTree(scanOptions.client, job);
      const deterministic = await scanGithubRepository(source, scanOptions);
      update({
        stage: "publishing",
        commitSha: deterministic.commitSha,
        entityCount: deterministic.artifacts.snapshot.entities.length,
        relationCount: deterministic.artifacts.snapshot.relations.length,
      });
      publishArtifacts(options.scanRoot, job.slug, deterministic.artifacts);
      update({ atlasReady: true });
      log(redact(`${job.id}: deterministic atlas published (${deterministic.artifacts.snapshot.entities.length} entities @ ${deterministic.commitSha.slice(0, 12)})`));

      const writeHonesty = (
        state: ScanJobEnrichment["state"],
        note?: string,
        report?: { results?: ReadonlyArray<{ accepted?: boolean }> },
      ): void => {
        publishEnrichmentStatus(
          options.scanRoot,
          job.slug,
          publishedEnrichmentStatus({ state, ...(note ? { note } : {}), ...(report ? { report } : {}) }),
        );
      };

      if (enrichMode === "off") {
        update({ enrichment: { state: "skipped", note: "enrichment disabled" } });
        writeHonesty("skipped", "enrichment disabled");
        return;
      }

      const config = resolveLlmGatewayConfig(env, llmLocal);
      const identity = enrichmentIdentity(config, enrichMode);
      if (shouldAttemptEnrichment(enrichMode, config) && !isUsableModelId(config.modelId)) {
        update({
          enrichment: { state: "failed", note: EMPTY_MODEL_NOTE, ...identity },
        });
        writeHonesty("failed", EMPTY_MODEL_NOTE);
        log(redact(`${job.id}: enrichment failed (${EMPTY_MODEL_NOTE}); deterministic atlas stands`));
        return;
      }

      const enricher = enricherFactory(note => log(redact(`${job.id}: ${note}`)));
      if (!enricher) {
        const note = skipNote(config);
        update({
          enrichment: {
            state: "skipped",
            note,
          },
        });
        writeHonesty("skipped", note);
        return;
      }

      if (globalSpend?.isExhausted()) {
        update({
          enrichment: { state: "skipped", note: GLOBAL_ENRICHMENT_BUDGET_SKIP_NOTE },
        });
        writeHonesty("skipped", GLOBAL_ENRICHMENT_BUDGET_SKIP_NOTE);
        log(redact(`${job.id}: ${GLOBAL_ENRICHMENT_BUDGET_SKIP_NOTE}; deterministic atlas stands`));
        return;
      }

      update({ stage: "enriching", enrichment: { state: "running", ...identity } });
      try {
        // Pin the enrichment pass to the exact commit the deterministic pass
        // resolved, so both passes describe one tree and the republish is a pure
        // upgrade of the same sha (never a silent version bump mid-job).
        const enriched = await scanGithubRepository(
          { ...source, ref: deterministic.commitSha },
          { ...scanOptions, enrichWithPackets: enricher },
        );
        publishArtifacts(options.scanRoot, job.slug, enriched.artifacts);
        const report = enriched.artifacts.enrichmentReport;
        update({
          entityCount: enriched.artifacts.snapshot.entities.length,
          relationCount: enriched.artifacts.snapshot.relations.length,
          enrichment: {
            state: "complete",
            ...identity,
            enrichedContainers: report?.enrichedContainers.length ?? 0,
            ...(report && report.results.some(result => !result.accepted)
              ? { note: `${report.results.filter(result => !result.accepted).length} scope(s) rejected by the gate; they stay deterministic` }
              : {}),
          },
        });
        writeHonesty("complete", undefined, report);
        log(redact(`${job.id}: enriched atlas republished (${report?.enrichedContainers.length ?? 0} containers)`));
      } catch (error) {
        // The deterministic atlas is already live — record the downgrade, don't fail the job.
        const note = redact(error instanceof Error ? error.message : String(error));
        update({
          enrichment: {
            state: "failed",
            ...identity,
            note,
          },
        });
        writeHonesty("failed", note);
        log(redact(`${job.id}: enrichment failed (${note}); deterministic atlas stands`));
      }
    } catch (error) {
      throw new Error(redact(error instanceof Error ? error.message : String(error)));
    }
  };
}
