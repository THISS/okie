import { stableJson, type GithubClient, type GithubSourceRef, type ScanArtifacts } from "@okie/scan";
import { githubRepoIsPublic, repoApiPath } from "@okie/scan";
import type { ScanGithubAccess } from "./githubAccess.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore } from "./operatorStore.js";

export interface OperatorRunnerScan { commitSha: string; artifacts: ScanArtifacts; }
export interface OperatorRunnerDeps { store: OperatorStore; publication: OperatorPublicationService; githubClient(access: ScanGithubAccess): GithubClient; scan(source: GithubSourceRef, options: { client: GithubClient; analysisMode: "full"; codeSurface: "all" }): Promise<OperatorRunnerScan>; }
export interface OperatorRunner { enqueue(input: { kind: "run" | "retry" | "refresh"; runId: string; githubAccess: ScanGithubAccess; draftRevisionId?: string; scopeIds?: string[] }): Promise<void>; }

/** Controller seam: full committed scans create immutable drafts only; publication is never called here. */
export function createOperatorRunner(deps: OperatorRunnerDeps): OperatorRunner {
  return { async enqueue(input) {
    if (input.kind !== "run") return; // targeted enrichment binds after the runner has a draft artifact
    const run = deps.store.snapshot().runs.find(value => value.runId === input.runId); if (!run) throw new Error("unknown operator run");
    deps.store.updateRun(run.runId, { state: "running" });
    try {
      const client = deps.githubClient(input.githubAccess); const publicRepo = await client.getJson(repoApiPath(run.source.owner, run.source.repo));
      if (!publicRepo.ok || !githubRepoIsPublic(publicRepo.json)) throw new Error("repository is not public");
      const scanned = await deps.scan({ owner: run.source.owner, repo: run.source.repo, ...(run.source.ref ? { ref: run.source.ref } : {}), dirSlug: run.source.slug }, { client, analysisMode: "full", codeSurface: "all" });
      const artifacts = scanned.artifacts;
      const files: Record<string, string> = { "extraction.json": stableJson(artifacts.extraction), "snapshot.json": stableJson(artifacts.snapshot), "view.json": stableJson(artifacts.view), "scene.json": stableJson(artifacts.scene), "story.json": stableJson(artifacts.story), "stories.json": stableJson(artifacts.catalog), "timeline.json": stableJson(artifacts.timeline), "operator-explanations.json": stableJson({ schemaVersion: 1, explanations: [] }) };
      const artifact = deps.store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: scanned.commitSha, files });
      const draft = deps.publication.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId, coverage: { total: artifacts.snapshot.entities.length, accepted: 0, failed: 0, stale: 0 } });
      deps.store.updateRun(run.runId, { state: "awaiting_review", draftRevisionId: draft.draftRevisionId, source: { ...run.source, commitSha: scanned.commitSha } });
    } catch (error) { deps.store.updateRun(run.runId, { state: "failed", error: error instanceof Error ? error.message : String(error) }); }
  } };
}
