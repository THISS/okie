import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAnonymousGithubClient,
  regenerateScanManifest,
  scanGithubRepository,
  stableJson,
  type EmittedPackets,
  type GithubClient,
  type GithubSourceRef,
  type ScanArtifacts,
} from "@okie/scan";
import type { JobRunner, ScanJobEnrichment } from "./jobs.js";
import { createEnricher } from "./enrichment.js";
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
   * GitHub transport for HTTP scans. Defaults to anonymous HTTPS with no `gh`
   * CLI fallback — an unauthenticated POST /api/scans must not inherit the
   * operator's credentials (CLA-18). The operator CLI still uses
   * `createDefaultGithubClient()`.
   */
  githubClient?: GithubClient;
  log?: (line: string) => void;
}

/** Writes the six-artifact trio (+ enrichment report) into the repo's scan slot. */
function publishArtifacts(scanRoot: string, dirSlug: string, artifacts: ScanArtifacts): void {
  const out = join(scanRoot, dirSlug);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "extraction.json"), stableJson(artifacts.extraction));
  writeFileSync(join(out, "snapshot.json"), stableJson(artifacts.snapshot));
  writeFileSync(join(out, "view.json"), stableJson(artifacts.view));
  writeFileSync(join(out, "story.json"), stableJson(artifacts.story));
  writeFileSync(join(out, "scene.json"), stableJson(artifacts.scene));
  writeFileSync(join(out, "timeline.json"), stableJson(artifacts.timeline));
  if (artifacts.enrichmentReport) {
    writeFileSync(join(out, "enrichment-report.json"), stableJson(artifacts.enrichmentReport));
  }
  const manifest = regenerateScanManifest(scanRoot);
  writeFileSync(join(scanRoot, "index.json"), stableJson(manifest));
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
      const budget = resolveEnrichmentBudget(env);
      const gateway = createLlmGatewayClient(config, { timeoutMs: budget.requestTimeoutMs });
      return createEnricher({
        onProgress,
        modelId: config.modelId,
        budget,
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
  const enricherFactory = options.enricherFactory
    ?? (enrichMode === "off" ? () => undefined : createDefaultEnricherFactory(enrichMode, env, llmLocal));
  const githubClient = options.githubClient ?? createAnonymousGithubClient();
  const redact = (line: string): string => redactGatewayText(line, resolveLlmGatewayConfig(env, llmLocal).apiKey);

  return async (job, update) => {
    try {
      const source: GithubSourceRef = {
        owner: job.owner,
        repo: job.repo,
        ...(job.ref ? { ref: job.ref } : {}),
        dirSlug: job.slug,
      };
      const scanOptions = {
        client: githubClient,
        codeSurface: "public" as const,
        ...(options.maxTarballBytes ? { maxTarballBytes: options.maxTarballBytes } : {}),
      };

      update({ stage: "scanning" });
      log(redact(`${job.id}: scanning gh:${job.owner}/${job.repo}${job.ref ? `@${job.ref}` : ""}`));
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

      if (enrichMode === "off") {
        update({ enrichment: { state: "skipped", note: "enrichment disabled" } });
        return;
      }

      const config = resolveLlmGatewayConfig(env, llmLocal);
      const identity = enrichmentIdentity(config, enrichMode);
      if (shouldAttemptEnrichment(enrichMode, config) && !isUsableModelId(config.modelId)) {
        update({
          enrichment: { state: "failed", note: EMPTY_MODEL_NOTE, ...identity },
        });
        log(redact(`${job.id}: enrichment failed (${EMPTY_MODEL_NOTE}); deterministic atlas stands`));
        return;
      }

      const enricher = enricherFactory(note => log(redact(`${job.id}: ${note}`)));
      if (!enricher) {
        update({
          enrichment: {
            state: "skipped",
            note: skipNote(config),
          },
        });
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
        log(redact(`${job.id}: enrichment failed (${note}); deterministic atlas stands`));
      }
    } catch (error) {
      throw new Error(redact(error instanceof Error ? error.message : String(error)));
    }
  };
}
