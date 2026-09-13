import { scanGithubRepository, stableJson, portableAtlasFromScan, type GithubClient, type GithubSourceRef, type ScanArtifacts } from "@okie/scan";
import { serializePortableAtlas, type ArchitectureSnapshot } from "@okie/architecture";
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
    const run = deps.store.snapshot().runs.find(value => value.runId === input.runId); if (!run) throw new Error("unknown operator run");
    if (input.kind === "retry") {
      const draft = deps.store.snapshot().drafts.find(value => value.draftRevisionId === input.draftRevisionId && value.runId === run.runId); const scopeId = input.scopeIds?.[0];
      if (!draft || !scopeId) throw new Error("retry requires draft and scope");
      const artifact = deps.store.snapshot().artifacts.find(value => value.artifactRevisionId === draft.artifactRevisionId)!;
      const sidecar = JSON.parse(deps.store.readArtifactFile(artifact.artifactRevisionId, "operator-explanations.json")!.toString()) as { scopes: Array<{ scopeId: string; parentScopeId?: string; name: string; kind: OperatorEnrichmentScope["kind"]; sourceRefs: Array<{ path: string; startLine?: number; endLine?: number }> }>; explanations: Array<{ scopeId: string; content: unknown; explanationVersionId?: string }> };
      const selected = sidecar.scopes.find(scope => scope.scopeId === scopeId); const gateway = deps.gateway ?? createLlmGatewayClient(resolveLlmGatewayConfig());
      if (!selected || !gateway) return;
      const snapshot = JSON.parse(deps.store.readArtifactFile(artifact.artifactRevisionId, "snapshot.json")!.toString()) as ArchitectureSnapshot;
      const scopes: OperatorEnrichmentScope[] = sidecar.scopes.map(scope => {
        const entity = snapshot.entities.find(value => value.id === scope.scopeId);
        return { ...scope, facts: { tags: entity?.tags, technology: entity?.technology, relationships: snapshot.relations.filter(relation => relation.from === scope.scopeId || relation.to === scope.scopeId).map(relation => ({ id: relation.id, from: relation.from, to: relation.to, kind: relation.kind })) }, allowedEvidence: scope.sourceRefs.map(ref => ({ entityId: scope.scopeId, path: ref.path, ...(ref.startLine ? { startLine: ref.startLine } : {}), ...(ref.endLine ? { endLine: ref.endLine } : {}) })) };
      });
      let mappedAttemptId: string | undefined; let acceptedContent: unknown; let acceptedVersionId: string | undefined;
      const adapter: OperatorEnrichmentStore = { async createAttempt(attempt) { mappedAttemptId = deps.store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: attempt.scopeId, kind: "retry", state: "running", modelId: attempt.modelId, inputHash: attempt.inputHash }).attemptId; }, async updateAttempt(_id, patch) { if (mappedAttemptId) deps.store.updateAttempt(mappedAttemptId, { state: patch.state === "accepted" ? "accepted" : "failed", ...(patch.error ? { error: patch.error } : {}) }); }, async latestAttempt() { return undefined; }, async putAcceptedExplanation(scope, explanation, _attempt, inputHash) { acceptedContent = explanation; const row = deps.store.putAcceptedExplanation({ draftRevisionId: draft.draftRevisionId, scopeId: scope, attemptId: mappedAttemptId!, inputHash, content: explanation, validation: { accepted: true, validator: "operator-enrichment/v1" } }); acceptedVersionId = row.explanationVersionId; return { explanationVersionId: row.explanationVersionId }; }, async getAcceptedExplanation(scope) { const prior = sidecar.explanations.find(value => value.scopeId === scope); return (acceptedContent ?? prior?.content) as OperatorExplanation | undefined; }, async markStale(ids) { ids.forEach(id => deps.store.markScopeStale(draft.draftRevisionId, id)); } };
      const result = await runOperatorEnrichment({ draftRevisionId: draft.draftRevisionId, scopes, store: adapter, gateway, retryScopeId: scopeId });
      const accepted = result.attempts.find(attempt => attempt.scopeId === scopeId && attempt.role === "owner" && attempt.state === "accepted");
      const files = Object.fromEntries(artifact.files.map(name => [name, deps.store.readArtifactFile(artifact.artifactRevisionId, name)!.toString()]));
      const nextSidecar = { ...sidecar, explanations: sidecar.explanations.filter(value => value.scopeId !== scopeId) };
      if (accepted && acceptedContent) nextSidecar.explanations.push({ scopeId, content: acceptedContent, ...(acceptedVersionId ? { explanationVersionId: acceptedVersionId } : {}) });
      files["operator-explanations.json"] = stableJson(nextSidecar);
      const nextArtifact = deps.store.writeArtifactRevision({ repositoryId: run.source.repositoryId, ...(artifact.sourceCommitSha ? { sourceCommitSha: artifact.sourceCommitSha } : {}), files });
      const nextDraft = deps.publication.createDraftRevision({ runId: run.runId, artifactRevisionId: nextArtifact.artifactRevisionId, coverage: draft.coverage });
      deps.store.updateRun(run.runId, { state: "awaiting_review", draftRevisionId: nextDraft.draftRevisionId }); return;
    }
    if (input.kind !== "run") return;
    deps.store.updateRun(run.runId, { state: "running" });
    try {
      const client = (deps.githubClient ?? githubClientForAccess)(input.githubAccess); const publicRepo = await client.getJson(repoApiPath(run.source.owner, run.source.repo));
      if (!publicRepo.ok || !githubRepoIsPublic(publicRepo.json)) throw new Error("repository is not public");
      const scanned = await (deps.scan ?? (async (source, options) => scanGithubRepository(source, options)) )({ owner: run.source.owner, repo: run.source.repo, ...(run.source.ref ? { ref: run.source.ref } : {}), dirSlug: run.source.slug }, { client, analysisMode: "full", codeSurface: "all" });
      const artifacts = scanned.artifacts;
      const scopeDto = artifacts.snapshot.entities.map(entity => ({ scopeId: entity.id, ...(entity.parentId ? { parentScopeId: entity.parentId } : {}), name: entity.name, kind: entity.kind, sourceRefs: entity.sourceRefs }));
      const files: Record<string, string> = { "atlas.okie.json": serializePortableAtlas(portableAtlasFromScan(artifacts, `https://github.com/${run.source.owner}/${run.source.repo}`)), "extraction.json": stableJson(artifacts.extraction), "snapshot.json": stableJson(artifacts.snapshot), "view.json": stableJson(artifacts.view), "scene.json": stableJson(artifacts.scene), "story.json": stableJson(artifacts.story), "stories.json": stableJson(artifacts.catalog), "timeline.json": stableJson(artifacts.timeline), "operator-explanations.json": stableJson({ schemaVersion: 1, scopes: scopeDto, explanations: [] }) };
      const artifact = deps.store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: scanned.commitSha, files });
      const draft = deps.publication.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId, coverage: { total: artifacts.snapshot.entities.length, accepted: 0, failed: 0, stale: 0 } }); let activeDraftRevisionId = draft.draftRevisionId;
      const gateway = deps.gateway ?? createLlmGatewayClient(resolveLlmGatewayConfig());
      if (gateway) {
        const scopes: OperatorEnrichmentScope[] = artifacts.snapshot.entities.map(entity => ({ scopeId: entity.id, ...(entity.parentId ? { parentScopeId: entity.parentId } : {}), name: entity.name, kind: entity.kind as OperatorEnrichmentScope["kind"], facts: { tags: entity.tags, technology: entity.technology, relationships: artifacts.snapshot.relations.filter(relation => relation.from === entity.id || relation.to === entity.id).map(relation => ({ id: relation.id, from: relation.from, to: relation.to, kind: relation.kind })) }, allowedEvidence: entity.sourceRefs.map(ref => ({ entityId: entity.id, path: ref.path, ...(ref.startLine ? { startLine: ref.startLine } : {}), ...(ref.endLine ? { endLine: ref.endLine } : {}) })) }));
        const attemptMap = new Map<string, string>();
        const adapter: OperatorEnrichmentStore = { async createAttempt(attempt) { const row = deps.store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: attempt.scopeId, kind: "enrichment", state: "running", modelId: attempt.modelId, inputHash: attempt.inputHash, taskId: attempt.attemptId }); attemptMap.set(attempt.attemptId, row.attemptId); }, async updateAttempt(id, patch) { const mapped = attemptMap.get(id); if (mapped) deps.store.updateAttempt(mapped, { state: patch.state === "accepted" ? "accepted" : patch.state === "cancelled" ? "cancelled" : "failed", ...(patch.error ? { error: patch.error } : {}) }); }, async latestAttempt(scopeId) { const row = deps.store.listAttempts(draft.draftRevisionId, scopeId).at(-1); return row ? { attemptId: row.attemptId, scopeId, role: "owner", state: row.state === "accepted" ? "accepted" : "failed", modelId: row.modelId ?? "", inputHash: row.inputHash ?? "", createdAt: row.createdAt, updatedAt: row.updatedAt } : undefined; }, async putAcceptedExplanation(scopeId, explanation, attemptId, inputHash) { const row = deps.store.putAcceptedExplanation({ draftRevisionId: draft.draftRevisionId, scopeId, attemptId: attemptMap.get(attemptId) ?? attemptId, inputHash, content: explanation, validation: { accepted: true, validator: "operator-enrichment/v1" } }); return { explanationVersionId: row.explanationVersionId }; }, async getAcceptedExplanation(scopeId) { const row = deps.store.getAcceptedExplanation(draft.draftRevisionId, scopeId); return row?.content as OperatorExplanation | undefined; }, async markStale(ids) { ids.forEach(id => deps.store.markScopeStale(draft.draftRevisionId, id)); } };
        await runOperatorEnrichment({ draftRevisionId: draft.draftRevisionId, scopes, store: adapter, gateway, cancelled: () => deps.store.isCancelled(run.runId) });
        const explanations = deps.store.snapshot().explanations.filter(value => value.draftRevisionId === draft.draftRevisionId);
        if (explanations.length) {
          const enrichedArtifact = deps.store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: scanned.commitSha, files: { ...files, "operator-explanations.json": stableJson({ schemaVersion: 1, scopes: scopeDto, explanations }) } });
          const enrichedDraft = deps.publication.createDraftRevision({ runId: run.runId, artifactRevisionId: enrichedArtifact.artifactRevisionId, coverage: { total: scopes.length, accepted: explanations.length, failed: scopes.length - explanations.length, stale: 0 } });
          activeDraftRevisionId = enrichedDraft.draftRevisionId;
          deps.store.updateRun(run.runId, { state: "running", draftRevisionId: enrichedDraft.draftRevisionId });
        }
      }
      deps.store.updateRun(run.runId, { state: "awaiting_review", draftRevisionId: activeDraftRevisionId, source: { ...run.source, commitSha: scanned.commitSha } });
    } catch (error) { deps.store.updateRun(run.runId, { state: "failed", error: error instanceof Error ? error.message : String(error) }); }
  } };
}
