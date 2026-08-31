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
import type { JobRunner } from "./jobs.js";
import { createEnricher } from "./enrichment.js";

export type EnrichmentHook = (packets: EmittedPackets) => Promise<ReadonlyMap<string, unknown>>;

export interface ScanServiceOptions {
  /** Directory holding per-repo scan slots + index.json (the served scan root). */
  scanRoot: string;
  maxTarballBytes?: number;
  /**
   * "auto": enrich when an Anthropic key/token is visible; "force": attempt even
   * without one (profile-based auth the sniff can't see); "off": deterministic only.
   */
  enrich?: "auto" | "force" | "off";
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

function defaultEnricherFactory(
  mode: "auto" | "force",
): (onProgress: (note: string) => void) => EnrichmentHook | undefined {
  return onProgress => {
    // The SDK resolves credentials lazily (at request time), so "auto" sniffs the
    // two visible sources up front rather than burning a whole enrichment pass on
    // auth failures. Profile-based auth (`ant auth login`) is invisible to the
    // sniff — OKIE_SCAN_ENRICH=1 forces the attempt for that setup, and a total
    // auth failure then surfaces as an honest "enrichment failed" on the job.
    const credentialVisible = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
    if (mode === "auto" && !credentialVisible) return undefined;
    try {
      return createEnricher({ onProgress });
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
  const enricherFactory = options.enricherFactory
    ?? (enrichMode === "off" ? () => undefined : defaultEnricherFactory(enrichMode));
  const githubClient = options.githubClient ?? createAnonymousGithubClient();

  return async (job, update) => {
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
    log(`${job.id}: scanning gh:${job.owner}/${job.repo}${job.ref ? `@${job.ref}` : ""}`);
    const deterministic = await scanGithubRepository(source, scanOptions);
    update({
      stage: "publishing",
      commitSha: deterministic.commitSha,
      entityCount: deterministic.artifacts.snapshot.entities.length,
      relationCount: deterministic.artifacts.snapshot.relations.length,
    });
    publishArtifacts(options.scanRoot, job.slug, deterministic.artifacts);
    update({ atlasReady: true });
    log(`${job.id}: deterministic atlas published (${deterministic.artifacts.snapshot.entities.length} entities @ ${deterministic.commitSha.slice(0, 12)})`);

    if (enrichMode === "off") {
      update({ enrichment: { state: "skipped", note: "enrichment disabled" } });
      return;
    }
    const enricher = enricherFactory(note => log(`${job.id}: ${note}`));
    if (!enricher) {
      update({
        enrichment: {
          state: "skipped",
          note: "no Anthropic credentials visible (set ANTHROPIC_API_KEY, or OKIE_SCAN_ENRICH=1 for profile auth)",
        },
      });
      return;
    }

    update({ stage: "enriching", enrichment: { state: "running" } });
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
          enrichedContainers: report?.enrichedContainers.length ?? 0,
          ...(report && report.results.some(result => !result.accepted)
            ? { note: `${report.results.filter(result => !result.accepted).length} scope(s) rejected by the gate; they stay deterministic` }
            : {}),
        },
      });
      log(`${job.id}: enriched atlas republished (${report?.enrichedContainers.length ?? 0} containers)`);
    } catch (error) {
      // The deterministic atlas is already live — record the downgrade, don't fail the job.
      update({
        enrichment: {
          state: "failed",
          note: error instanceof Error ? error.message : String(error),
        },
      });
      log(`${job.id}: enrichment failed (${error instanceof Error ? error.message : String(error)}); deterministic atlas stands`);
    }
  };
}
