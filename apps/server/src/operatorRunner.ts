import { scanGithubRepository, stableJson, type GithubClient, type GithubSourceRef, type ScanArtifacts } from "@okie/scan";
import { githubRepoIsPublic, repoApiPath } from "@okie/scan";
import type { ScanGithubAccess } from "./githubAccess.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore } from "./operatorStore.js";
import { runOperatorEnrichment, type OperatorEnrichmentGateway, type OperatorEnrichmentScope, type OperatorEnrichmentStore, type OperatorExplanation } from "./operatorEnrichment.js";
import { createLlmGatewayClient, resolveLlmGatewayConfig } from "./llmGateway.js";
import { githubClientForAccess } from "./githubAccess.js";

export interface OperatorRunnerScan { commitSha: string; artifacts: ScanArtifacts; }
export interface OperatorRunnerDeps { store: OperatorStore; publication: OperatorPublicationService; githubClient?(access: ScanGithubAccess): GithubClient; scan?(source: GithubSourceRef, options: { client: GithubClient; analysisMode: "full"; codeSurface: "all" }): Promise<OperatorRunnerScan>; gateway?: OperatorEnrichmentGateway; }
export interface OperatorRunner { enqueue(input: { kind: "run" | "retry" | "refresh"; runId: string; githubAccess: ScanGithubAccess; draftRevisionId?: string; scopeIds?: string[] }): Promise<void>; }

/** Controller seam: full committed scans create immutable drafts only; publication is never called here. */
export function createOperatorRunner(deps: OperatorRunnerDeps): OperatorRunner {
  return { async enqueue(input) {
    if (input.kind !== "run") return; // targeted enrichment binds after the runner has a draft artifact
    const run = deps.store.snapshot().runs.find(value => value.runId === input.runId); if (!run) throw new Error("unknown operator run");
    deps.store.updateRun(run.runId, { state: "running" });
    try {
      const client = (deps.githubClient ?? githubClientForAccess)(input.githubAccess); const publicRepo = await client.getJson(repoApiPath(run.source.owner, run.source.repo));
      if (!publicRepo.ok || !githubRepoIsPublic(publicRepo.json)) throw new Error("repository is not public");
      const scanned = await (deps.scan ?? (async (source, options) => scanGithubRepository(source, options)) )({ owner: run.source.owner, repo: run.source.repo, ...(run.source.ref ? { ref: run.source.ref } : {}), dirSlug: run.source.slug }, { client, analysisMode: "full", codeSurface: "all" });
      const artifacts = scanned.artifacts;
      const files: Record<string, string> = { "extraction.json": stableJson(artifacts.extraction), "snapshot.json": stableJson(artifacts.snapshot), "view.json": stableJson(artifacts.view), "scene.json": stableJson(artifacts.scene), "story.json": stableJson(artifacts.story), "stories.json": stableJson(artifacts.catalog), "timeline.json": stableJson(artifacts.timeline), "operator-explanations.json": stableJson({ schemaVersion: 1, explanations: [] }) };
      const artifact = deps.store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: scanned.commitSha, files });
      const draft = deps.publication.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId, coverage: { total: artifacts.snapshot.entities.length, accepted: 0, failed: 0, stale: 0 } });
      const gateway = deps.gateway ?? createLlmGatewayClient(resolveLlmGatewayConfig());
      if (gateway) {
        const scopes: OperatorEnrichmentScope[] = artifacts.snapshot.entities.map(entity => ({ scopeId: entity.id, ...(entity.parentId ? { parentScopeId: entity.parentId } : {}), name: entity.name, kind: entity.kind as OperatorEnrichmentScope["kind"], facts: { tags: entity.tags, technology: entity.technology, relationships: artifacts.snapshot.relations.filter(relation => relation.from === entity.id || relation.to === entity.id).map(relation => ({ id: relation.id, from: relation.from, to: relation.to, kind: relation.kind })) }, allowedEvidence: entity.sourceRefs.map(ref => ({ entityId: entity.id, path: ref.path, ...(ref.startLine ? { startLine: ref.startLine } : {}), ...(ref.endLine ? { endLine: ref.endLine } : {}) })) }));
        const attemptMap = new Map<string, string>();
        const adapter: OperatorEnrichmentStore = { async createAttempt(attempt) { const row = deps.store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: attempt.scopeId, kind: "enrichment", state: "running", modelId: attempt.modelId, inputHash: attempt.inputHash, taskId: attempt.attemptId }); attemptMap.set(attempt.attemptId, row.attemptId); }, async updateAttempt(id, patch) { const mapped = attemptMap.get(id); if (mapped) deps.store.updateAttempt(mapped, { state: patch.state === "accepted" ? "accepted" : patch.state === "cancelled" ? "cancelled" : "failed", ...(patch.error ? { error: patch.error } : {}) }); }, async latestAttempt(scopeId) { const row = deps.store.listAttempts(draft.draftRevisionId, scopeId).at(-1); return row ? { attemptId: row.attemptId, scopeId, role: "owner", state: row.state === "accepted" ? "accepted" : "failed", modelId: row.modelId ?? "", inputHash: row.inputHash ?? "", createdAt: row.createdAt, updatedAt: row.updatedAt } : undefined; }, async putAcceptedExplanation(scopeId, explanation, attemptId, inputHash) { const row = deps.store.putAcceptedExplanation({ draftRevisionId: draft.draftRevisionId, scopeId, attemptId: attemptMap.get(attemptId) ?? attemptId, inputHash, content: explanation, validation: { accepted: true, validator: "operator-enrichment/v1" } }); return { explanationVersionId: row.explanationVersionId }; }, async getAcceptedExplanation(scopeId) { const row = deps.store.getAcceptedExplanation(draft.draftRevisionId, scopeId); return row?.content as OperatorExplanation | undefined; }, async markStale(ids) { ids.forEach(id => deps.store.markScopeStale(draft.draftRevisionId, id)); } };
        await runOperatorEnrichment({ draftRevisionId: draft.draftRevisionId, scopes, store: adapter, gateway, cancelled: () => deps.store.isCancelled(run.runId) });
      }
      deps.store.updateRun(run.runId, { state: "awaiting_review", draftRevisionId: draft.draftRevisionId, source: { ...run.source, commitSha: scanned.commitSha } });
    } catch (error) { deps.store.updateRun(run.runId, { state: "failed", error: error instanceof Error ? error.message : String(error) }); }
  } };
}
