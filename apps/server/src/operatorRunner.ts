import { scanGithubRepository, stableJson, portableAtlasFromScan, type GithubClient, type GithubSourceRef, type ScanArtifacts } from "@okie/scan";
import { serializePortableAtlas, type ArchitectureSnapshot } from "@okie/architecture";
import { githubRepoIsPublic, repoApiPath } from "@okie/scan";
import type { ScanGithubAccess } from "./githubAccess.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore } from "./operatorStore.js";
import { createOperatorBudgetLedger, type OperatorBudgetLedger } from "./operatorBudget.js";
import { runOperatorEnrichment, type OperatorAdmission, type OperatorEnrichmentGateway, type OperatorEnrichmentScope, type OperatorEnrichmentStore, type OperatorExplanation } from "./operatorEnrichment.js";
import { createLlmGatewayClient, isOpenRouterProvider, resolveOperatorLeafReasoning, resolveLlmGatewayConfig, resolveLlmRateLimitConfig, resolveOperatorEnrichmentBudget, resolveOperatorEnrichmentDepth, safeGatewayProvider, type GatewayUsage, type LlmGatewayConfig } from "./llmGateway.js";
import { rateLimitedGateway, sharedLlmRateLimiter, type LlmRateLimiter } from "./llmRateLimiter.js";
import { githubClientForAccess } from "./githubAccess.js";
import { createJevProvider, runOperatorJudgments, type JudgmentLimits, type JudgmentOutcome, type JudgmentProvider, type JudgmentRequest } from "./operatorJudgments.js";
import { runSectionProfile } from "./sectionProfiles.js";

export interface OperatorRunnerScan { commitSha: string; artifacts: ScanArtifacts; }
export interface OperatorRunnerDeps { store: OperatorStore; publication: OperatorPublicationService; githubClient?(access: ScanGithubAccess): GithubClient; scan?(source: GithubSourceRef, options: { client: GithubClient; analysisMode: "full"; codeSurface: "all" }): Promise<OperatorRunnerScan>; gateway?: OperatorEnrichmentGateway; gatewayConfig?: LlmGatewayConfig; judgmentProvider?: JudgmentProvider | null; judgmentLimits?: Partial<JudgmentLimits>; /** Test seam; defaults to the process-wide limiter for the gateway's provider. */ rateLimiter?: LlmRateLimiter; /** Process-wide operator spend ledger (OKIE_LLM_GLOBAL_*), reserved before the run ledger. */ globalLedger?: OperatorBudgetLedger; }
export interface OperatorRunner { profile(input: { runId: string; draftRevisionId: string; scopeId: string }, signal?: AbortSignal): ReturnType<typeof runSectionProfile>; judge(request: JudgmentRequest, signal?: AbortSignal): Promise<JudgmentOutcome>; enqueue(input: { kind: "run" | "retry" | "refresh"; runId: string; githubAccess: ScanGithubAccess; draftRevisionId?: string; scopeIds?: string[]; /** Internal audit label for refresh's targeted retry execution. */ attemptKind?: "retry" | "refresh" }): Promise<void>; }

function persistedUsage(usage?: GatewayUsage) {
  return usage ? {
    inputTokens: usage.promptTokens ?? Math.max(0, usage.totalTokens - (usage.completionTokens ?? 0)),
    outputTokens: usage.completionTokens ?? 0,
    ...(usage.costUsd !== undefined ? { measuredCostUsd: usage.costUsd } : {}),
  } : undefined;
}

/** Per-scope enrichment state recorded in the sidecar; `stale` stays a separate overlay. */
export type OperatorSidecarScopeState = "accepted" | "failed" | "not run";

/**
 * Durable ledger admission, called by runOperatorEnrichment before it creates an
 * attempt row: the global ledger (if any) reserves first, then the run ledger.
 * A refusal at either step releases what was already reserved and creates no
 * row. Both reservations precede network I/O and are settled exactly once with
 * the real usage. Rate-limit retries live below this layer (in the limiter
 * around the raw gateway), so they never touch a ledger.
 */
function ledgerAdmission(store: OperatorStore, runId: string, budget: ReturnType<typeof resolveOperatorEnrichmentBudget>, global?: OperatorBudgetLedger) {
  const ledger = createOperatorBudgetLedger({ maxRequests: budget.maxScopes, maxTokens: budget.maxTokens, maxDollars: budget.maxDollars }, { store, runId });
  /** Which ledger refused last; the run-level cap inside runOperatorEnrichment also counts as "run". */
  const state: { refusedBy?: "global" | "run" } = {};
  return Object.assign(({ body }: { body: Record<string, unknown> }): OperatorAdmission | false => {
    const maxOutputTokens = typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens) ? Math.max(0, Math.floor(body.max_tokens)) : 0;
    const size = Buffer.byteLength(JSON.stringify(body), "utf8") + maxOutputTokens;
    const globalId = global?.reserve(size);
    if (global && !globalId) { state.refusedBy = "global"; return false; }
    let requestId: string | undefined;
    try { requestId = ledger.reserve(size); } catch (error) { if (globalId) global!.release(globalId); throw error; }
    if (!requestId) { if (globalId) global!.release(globalId); state.refusedBy = "run"; return false; }
    return { settle: (usage?: GatewayUsage) => { const settled = persistedUsage(usage) ?? {}; try { ledger.settle(requestId, settled); } finally { if (globalId) global!.settle(globalId, settled); } } };
  }, { refusedBy: () => state.refusedBy ?? "run" });
}

/** Gateway hostname from the client's own baseUrl, else the config; never a URL or key. */
function gatewayProvider(raw: OperatorEnrichmentGateway, config: LlmGatewayConfig | undefined): string {
  const baseUrl = (raw as { baseUrl?: unknown }).baseUrl;
  return (typeof baseUrl === "string" ? safeGatewayProvider(baseUrl) : undefined) ?? (config ? safeGatewayProvider(config.baseUrl) : undefined) ?? "unconfigured";
}

/** Raw gateway → per-provider limiter (429 backoff, in-flight cap). Budget admission sits above it. */
function limitedGateway(raw: OperatorEnrichmentGateway, config: LlmGatewayConfig | undefined, override?: LlmRateLimiter): OperatorEnrichmentGateway {
  return rateLimitedGateway(raw, override ?? sharedLlmRateLimiter(gatewayProvider(raw, config), resolveLlmRateLimitConfig()));
}

/** OKIE_LLM_REASONING_LEAVES=off only changes requests to OpenRouter; every other gateway keeps its default. */
function leafReasoningFor(raw: OperatorEnrichmentGateway | undefined, config: LlmGatewayConfig | undefined): "provider-default" | "off" {
  return raw && resolveOperatorLeafReasoning() === "off" && isOpenRouterProvider(gatewayProvider(raw, config)) ? "off" : "provider-default";
}

/** Accepted = pinned explanation; failed = attempted without one; not run = never attempted. */
function sidecarState(hasExplanation: boolean, attempted: boolean, prior?: unknown): OperatorSidecarScopeState {
  if (hasExplanation) return "accepted";
  if (attempted) return "failed";
  return prior === "failed" ? "failed" : "not run";
}

/** Coverage is derived from the same per-scope states the scope list shows. */
export function coverageFor(scopes: readonly { scopeId: string; stale?: boolean; state?: string }[], explanations: readonly { scopeId: string }[] = []) {
  const explained = new Set(explanations.map(value => value.scopeId));
  const state = (scope: { scopeId: string; state?: string }) => scope.state === "accepted" || scope.state === "failed" || scope.state === "not run" ? scope.state : explained.has(scope.scopeId) ? "accepted" : "not run";
  const count = (value: OperatorSidecarScopeState) => scopes.filter(scope => state(scope) === value).length;
  return { total: scopes.length, accepted: count("accepted"), failed: count("failed"), notRun: count("not run"), stale: scopes.filter(scope => scope.stale).length };
}

/** Controller seam: full committed scans create immutable drafts only; publication is never called here. */
export function createOperatorRunner(deps: OperatorRunnerDeps): OperatorRunner {
  const runner: OperatorRunner = {
    async profile(input, signal) {
      // Opt-in scan enrichment only. Existing scans and portable atlases need no provider.
      const provider = deps.judgmentProvider === undefined ? createJevProvider() : deps.judgmentProvider;
      return runSectionProfile({ store: deps.store, publication: deps.publication, ...input, ...(provider ? { provider } : {}), ...(deps.judgmentLimits ? { limits: deps.judgmentLimits } : {}), ...(signal ? { signal } : {}) });
    },
    async judge(request, signal) {
      // No default consumer: deterministic scans and GLM generation never call Jev.
      // Null explicitly disables the provider even if a server key exists.
      const provider = deps.judgmentProvider === undefined ? createJevProvider() : deps.judgmentProvider;
      return runOperatorJudgments({ store: deps.store, publication: deps.publication, request, ...(provider ? { provider } : {}), ...(deps.judgmentLimits ? { limits: deps.judgmentLimits } : {}), ...(signal ? { signal } : {}) });
    },
    async enqueue(input) {
    const run = deps.store.snapshot().runs.find(value => value.runId === input.runId); if (!run) throw new Error("unknown operator run");
    if (input.kind !== "run" && run.draftRevisionId !== input.draftRevisionId) {
      deps.store.appendEvent({ runId: run.runId, type: "draft.conflict", detail: { reason: "stale_retry_base", ...(input.draftRevisionId ? { draftRevisionId: input.draftRevisionId } : {}) } });
      return;
    }
    if (input.kind === "refresh") {
      const draft = deps.store.snapshot().drafts.find(value => value.draftRevisionId === input.draftRevisionId && value.runId === run.runId);
      if (!draft) throw new Error("refresh requires draft");
      const sidecar = JSON.parse(deps.store.readArtifactFile(draft.artifactRevisionId, "operator-explanations.json")!.toString()) as { scopes: Array<{ scopeId: string; parentScopeId?: string; stale?: boolean }> };
      const byId = new Map(sidecar.scopes.map(scope => [scope.scopeId, scope]));
      const depth = (scopeId: string): number => { let result = 0; let cursor = byId.get(scopeId)?.parentScopeId; while (cursor) { result += 1; cursor = byId.get(cursor)?.parentScopeId; } return result; };
      let activeDraftRevisionId = draft.draftRevisionId;
      for (const scopeId of [...new Set(input.scopeIds ?? [])].filter(scopeId => byId.get(scopeId)?.stale).sort((left, right) => depth(right) - depth(left) || left.localeCompare(right))) {
        await runner.enqueue({ ...input, kind: "retry", attemptKind: "refresh", draftRevisionId: activeDraftRevisionId, scopeIds: [scopeId] });
        if (deps.store.isCancelled(run.runId)) return;
        activeDraftRevisionId = deps.store.snapshot().runs.find(value => value.runId === run.runId)?.draftRevisionId ?? activeDraftRevisionId;
      }
      return;
    }
    if (input.kind === "retry") {
      const draft = deps.store.snapshot().drafts.find(value => value.draftRevisionId === input.draftRevisionId && value.runId === run.runId); const scopeId = input.scopeIds?.[0];
      if (!draft || !scopeId) throw new Error("retry requires draft and scope");
      const artifact = deps.store.snapshot().artifacts.find(value => value.artifactRevisionId === draft.artifactRevisionId)!;
      const sidecar = JSON.parse(deps.store.readArtifactFile(artifact.artifactRevisionId, "operator-explanations.json")!.toString()) as { scopes: Array<{ scopeId: string; parentScopeId?: string; name: string; kind: OperatorEnrichmentScope["kind"]; stale?: boolean; state?: OperatorSidecarScopeState; sourceRefs: Array<{ path: string; startLine?: number; endLine?: number }> }>; explanations: Array<{ scopeId: string; content: unknown; explanationVersionId?: string }> };
      const selected = sidecar.scopes.find(scope => scope.scopeId === scopeId); const rawGateway = deps.gateway ?? createLlmGatewayClient(deps.gatewayConfig ?? resolveLlmGatewayConfig(), { timeoutMs: resolveOperatorEnrichmentBudget().requestTimeoutMs });
      if (!selected) return;
      const budget = resolveOperatorEnrichmentBudget(); const gateway = rawGateway && limitedGateway(rawGateway, deps.gatewayConfig, deps.rateLimiter);
      const snapshot = JSON.parse(deps.store.readArtifactFile(artifact.artifactRevisionId, "snapshot.json")!.toString()) as ArchitectureSnapshot;
      const scopes: OperatorEnrichmentScope[] = sidecar.scopes.map(scope => {
        const entity = snapshot.entities.find(value => value.id === scope.scopeId);
        const { state: _state, ...definition } = scope;
        return { ...definition, facts: { tags: entity?.tags, technology: entity?.technology, exposure: entity?.exposure, sourceExcerpts: entity?.sourceExcerpts, relationships: snapshot.relations.filter(relation => relation.from === scope.scopeId || relation.to === scope.scopeId).map(relation => ({ id: relation.id, from: relation.from, to: relation.to, kind: relation.kind })) }, allowedEvidence: scope.sourceRefs.map(ref => ({ entityId: scope.scopeId, path: ref.path, ...(ref.startLine ? { startLine: ref.startLine } : {}), ...(ref.endLine ? { endLine: ref.endLine } : {}) })) };
      });
      const attempts = new Map<string, string>(); const acceptedContent = new Map<string, unknown>(); const acceptedVersionId = new Map<string, string>();
      const staleScopes = new Set<string>();
      const adapter: OperatorEnrichmentStore = { async createAttempt(attempt) { attempts.set(attempt.attemptId, deps.store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: attempt.scopeId, kind: input.attemptKind ?? "retry", state: "running", modelId: attempt.modelId, inputHash: attempt.inputHash }).attemptId); }, async updateAttempt(id, patch) { const mapped = attempts.get(id); if (mapped) deps.store.updateAttempt(mapped, { state: patch.state === "accepted" ? "accepted" : patch.state === "cancelled" ? "cancelled" : "failed", ...(patch.usage ? { usage: persistedUsage(patch.usage)! } : {}), ...(patch.error ? { error: patch.error } : {}) }); }, async latestAttempt(scope) { const previous = deps.store.listAttempts(draft.draftRevisionId, scope).at(-1); const sidecarScope = sidecar.scopes.find(value => value.scopeId === scope); const prior = sidecar.explanations.some(value => value.scopeId === scope) || acceptedContent.has(scope); const stale = Boolean(sidecarScope?.stale || staleScopes.has(scope) || previous?.stale); if (previous && previous.state !== "accepted") return { attemptId: previous.attemptId, scopeId: scope, role: "owner", state: previous.state === "cancelled" ? "cancelled" : "failed", modelId: previous.modelId ?? "", inputHash: previous.inputHash ?? "", createdAt: previous.createdAt, updatedAt: previous.updatedAt }; if (!previous && !prior && sidecarScope?.state === "failed") return { attemptId: "sidecar", scopeId: scope, role: "owner", state: "failed", modelId: "", inputHash: "", createdAt: 0, updatedAt: 0 }; return prior ? { attemptId: previous?.attemptId ?? "sidecar", scopeId: scope, role: "owner", state: stale ? "stale" : "accepted", modelId: previous?.modelId ?? "", inputHash: previous?.inputHash ?? "", createdAt: previous?.createdAt ?? 0, updatedAt: previous?.updatedAt ?? 0 } : undefined; }, async putAcceptedExplanation(scope, explanation, attempt, inputHash) { acceptedContent.set(scope, explanation); const row = deps.store.putAcceptedExplanation({ draftRevisionId: draft.draftRevisionId, scopeId: scope, attemptId: attempts.get(attempt)!, inputHash, content: explanation, validation: { accepted: true, validator: "operator-enrichment/v1" } }); acceptedVersionId.set(scope, row.explanationVersionId); return { explanationVersionId: row.explanationVersionId }; }, async getAcceptedExplanation(scope) { const prior = sidecar.explanations.find(value => value.scopeId === scope); return (acceptedContent.get(scope) ?? prior?.content) as OperatorExplanation | undefined; }, async markStale(ids) { ids.forEach(id => staleScopes.add(id)); } };
      let result: Awaited<ReturnType<typeof runOperatorEnrichment>>;
      const admission = ledgerAdmission(deps.store, run.runId, budget, deps.globalLedger);
      try { result = await runOperatorEnrichment({ draftRevisionId: draft.draftRevisionId, scopes, store: adapter, ...(gateway ? { gateway } : {}), limits: { maxScopes: budget.maxScopes, maxTokens: budget.maxTokens, maxDollars: budget.maxDollars, maxConcurrent: resolveLlmRateLimitConfig().maxConcurrent }, maxKind: resolveOperatorEnrichmentDepth(), leafReasoning: leafReasoningFor(rawGateway, deps.gatewayConfig), admitRequest: admission, retryScopeId: scopeId, cancelled: () => deps.store.isCancelled(run.runId) }); }
      catch (error) { deps.store.appendEvent({ runId: run.runId, type: "enrichment.retry_failed", detail: { scopeId } }); deps.store.updateRun(run.runId, { state: "awaiting_review", error: `Retry of ${scopeId} failed: ${error instanceof Error ? error.message : String(error)}` }); return; }
      if (deps.store.isCancelled(run.runId)) return;
      // Nothing was attempted (budget refused or no gateway): no new draft and no persisted stale marks.
      if (!result.attempts.some(attempt => attempt.scopeId === scopeId) && (result.stopped === "limit" || result.stopped === "unavailable")) {
        const limit = result.stopped === "limit";
        const ledger = admission.refusedBy();
        deps.store.appendEvent({ runId: run.runId, type: limit ? "enrichment.budget_refused" : "enrichment.unavailable", detail: { scopeId, ...(limit ? { ledger } : {}) } });
        deps.store.updateRun(run.runId, { state: "awaiting_review", error: !limit ? `Retry of ${scopeId} was not run: no enrichment gateway is configured.` : ledger === "global" ? `Retry of ${scopeId} was not run: the process-wide operator budget is exhausted. Raise the global operator limits (OKIE_LLM_GLOBAL_MAX_DOLLARS or its matching global cap) to retry.` : `Retry of ${scopeId} was not run: this run's enrichment budget is exhausted. Raise OKIE_LLM_OPERATOR_MAX_REQUESTS (or the matching budget limit) to retry.` });
        return;
      }
      const accepted = result.attempts.find(attempt => attempt.scopeId === scopeId && attempt.state === "accepted");
      const attempted = result.attempts.some(attempt => attempt.scopeId === scopeId);
      const files = Object.fromEntries(artifact.files.map(name => [name, deps.store.readArtifactFile(artifact.artifactRevisionId, name)!.toString()]));
      const hasUnfreshChild = (parentScopeId: string) => sidecar.scopes.some(child => child.parentScopeId === parentScopeId && (child.stale || staleScopes.has(child.scopeId) || (() => { const latest = deps.store.listAttempts(draft.draftRevisionId, child.scopeId).at(-1); return latest !== undefined && (latest.stale || latest.state !== "accepted"); })()));
      const nextExplanations = sidecar.explanations.map(value => value.scopeId === scopeId && accepted && acceptedContent.has(scopeId) ? { scopeId, content: acceptedContent.get(scopeId), ...(acceptedVersionId.has(scopeId) ? { explanationVersionId: acceptedVersionId.get(scopeId) } : {}) } : value);
      if (accepted && acceptedContent.has(scopeId) && !nextExplanations.some(value => value.scopeId === scopeId)) nextExplanations.push({ scopeId, content: acceptedContent.get(scopeId), ...(acceptedVersionId.has(scopeId) ? { explanationVersionId: acceptedVersionId.get(scopeId) } : {}) });
      const explained = new Set(nextExplanations.map(value => value.scopeId));
      const nextScopes = sidecar.scopes.map(scope => ({ ...scope, state: sidecarState(explained.has(scope.scopeId), scope.scopeId === scopeId && attempted, scope.state), ...(staleScopes.has(scope.scopeId) ? { stale: true } : {}), ...(accepted && scope.scopeId === scopeId && !hasUnfreshChild(scopeId) ? { stale: false } : {}) }));
      const nextSidecar = { ...sidecar, scopes: nextScopes, explanations: nextExplanations };
      files["operator-explanations.json"] = stableJson(nextSidecar);
      let installed = false; let conflict = false;
      deps.store.withExclusiveLock(() => {
        if (deps.store.snapshot().runs.find(value => value.runId === run.runId)?.draftRevisionId !== draft.draftRevisionId) { conflict = true; return; }
        const nextArtifact = deps.store.writeArtifactRevision({ repositoryId: run.source.repositoryId, ...(artifact.sourceCommitSha ? { sourceCommitSha: artifact.sourceCommitSha } : {}), files });
        const nextDraft = deps.publication.createDraftRevision({ runId: run.runId, artifactRevisionId: nextArtifact.artifactRevisionId, coverage: coverageFor(nextScopes) });
        deps.store.updateRun(run.runId, { state: "awaiting_review", draftRevisionId: nextDraft.draftRevisionId, error: undefined as never }); installed = true;
      });
      if (!installed) { if (conflict) deps.store.appendEvent({ runId: run.runId, type: "draft.conflict", detail: { reason: "retry_compare_and_swap", draftRevisionId: draft.draftRevisionId } }); return; }
      return;
    }
    if (input.kind !== "run") return;
    deps.store.updateRun(run.runId, { state: "running" });
    try {
      const client = (deps.githubClient ?? githubClientForAccess)(input.githubAccess); const publicRepo = await client.getJson(repoApiPath(run.source.owner, run.source.repo));
      if (!publicRepo.ok || !githubRepoIsPublic(publicRepo.json)) throw new Error("repository is not public");
      const scanned = await (deps.scan ?? (async (source, options) => scanGithubRepository(source, options)) )({ owner: run.source.owner, repo: run.source.repo, ...(run.source.ref ? { ref: run.source.ref } : {}), dirSlug: run.source.slug }, { client, analysisMode: "full", codeSurface: "all" });
      if (deps.store.isCancelled(run.runId)) return;
      const artifacts = scanned.artifacts;
      const scopeDto = artifacts.snapshot.entities.map(entity => ({ scopeId: entity.id, ...(entity.parentId ? { parentScopeId: entity.parentId } : {}), name: entity.name, kind: entity.kind, sourceRefs: entity.sourceRefs }));
      const files: Record<string, string> = { "atlas.okie.json": serializePortableAtlas(portableAtlasFromScan(artifacts, `https://github.com/${run.source.owner}/${run.source.repo}`)), "extraction.json": stableJson(artifacts.extraction), "snapshot.json": stableJson(artifacts.snapshot), "view.json": stableJson(artifacts.view), "scene.json": stableJson(artifacts.scene), "story.json": stableJson(artifacts.story), "stories.json": stableJson(artifacts.catalog), "timeline.json": stableJson(artifacts.timeline), "operator-explanations.json": stableJson({ schemaVersion: 1, scopes: scopeDto, explanations: [] }) };
      const artifact = deps.store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: scanned.commitSha, files });
      const draft = deps.publication.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId, coverage: { total: artifacts.snapshot.entities.length, accepted: 0, failed: 0, notRun: artifacts.snapshot.entities.length, stale: 0 } }); let activeDraftRevisionId = draft.draftRevisionId;
      const rawGateway = deps.gateway ?? createLlmGatewayClient(deps.gatewayConfig ?? resolveLlmGatewayConfig(), { timeoutMs: resolveOperatorEnrichmentBudget().requestTimeoutMs });
      const budget = resolveOperatorEnrichmentBudget();
      const gateway = rawGateway && limitedGateway(rawGateway, deps.gatewayConfig, deps.rateLimiter);
        const scopes: OperatorEnrichmentScope[] = artifacts.snapshot.entities.map(entity => ({ scopeId: entity.id, ...(entity.parentId ? { parentScopeId: entity.parentId } : {}), name: entity.name, kind: entity.kind as OperatorEnrichmentScope["kind"], facts: { tags: entity.tags, technology: entity.technology, exposure: entity.exposure, sourceExcerpts: entity.sourceExcerpts, relationships: artifacts.snapshot.relations.filter(relation => relation.from === entity.id || relation.to === entity.id).map(relation => ({ id: relation.id, from: relation.from, to: relation.to, kind: relation.kind })) }, allowedEvidence: entity.sourceRefs.map(ref => ({ entityId: entity.id, path: ref.path, ...(ref.startLine ? { startLine: ref.startLine } : {}), ...(ref.endLine ? { endLine: ref.endLine } : {}) })) }));
        const attemptMap = new Map<string, string>();
        const adapter: OperatorEnrichmentStore = { async createAttempt(attempt) { const row = deps.store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: attempt.scopeId, kind: "enrichment", state: "running", modelId: attempt.modelId, inputHash: attempt.inputHash, taskId: attempt.attemptId }); attemptMap.set(attempt.attemptId, row.attemptId); }, async updateAttempt(id, patch) { const mapped = attemptMap.get(id); const usage = persistedUsage(patch.usage); if (mapped) deps.store.updateAttempt(mapped, { state: patch.state === "accepted" ? "accepted" : patch.state === "cancelled" ? "cancelled" : "failed", ...(usage ? { usage } : {}), ...(patch.error ? { error: patch.error } : {}) }); }, async latestAttempt(scopeId) { const row = deps.store.listAttempts(draft.draftRevisionId, scopeId).at(-1); return row ? { attemptId: row.attemptId, scopeId, role: "owner", state: row.state === "accepted" ? "accepted" : "failed", modelId: row.modelId ?? "", inputHash: row.inputHash ?? "", createdAt: row.createdAt, updatedAt: row.updatedAt } : undefined; }, async putAcceptedExplanation(scopeId, explanation, attemptId, inputHash) { const row = deps.store.putAcceptedExplanation({ draftRevisionId: draft.draftRevisionId, scopeId, attemptId: attemptMap.get(attemptId) ?? attemptId, inputHash, content: explanation, validation: { accepted: true, validator: "operator-enrichment/v1" } }); return { explanationVersionId: row.explanationVersionId }; }, async getAcceptedExplanation(scopeId) { const row = deps.store.getAcceptedExplanation(draft.draftRevisionId, scopeId); return row?.content as OperatorExplanation | undefined; }, async markStale(ids) { ids.forEach(id => deps.store.markScopeStale(draft.draftRevisionId, id)); } };
        const admission = ledgerAdmission(deps.store, run.runId, budget, deps.globalLedger);
        const enrichment = await runOperatorEnrichment({ draftRevisionId: draft.draftRevisionId, scopes, store: adapter, ...(gateway ? { gateway } : {}), limits: { maxScopes: budget.maxScopes, maxTokens: budget.maxTokens, maxDollars: budget.maxDollars, maxConcurrent: resolveLlmRateLimitConfig().maxConcurrent }, maxKind: resolveOperatorEnrichmentDepth(), leafReasoning: leafReasoningFor(rawGateway, deps.gatewayConfig), admitRequest: admission, cancelled: () => deps.store.isCancelled(run.runId) });
        if (deps.store.isCancelled(run.runId)) return;
        if (enrichment.stopped === "unavailable") deps.store.appendEvent({ runId: run.runId, type: "enrichment.unavailable", detail: { reason: "no enrichment gateway configured" } });
        // A limit stop still lands here: every accepted explanation is kept in the enriched draft.
        const state = deps.store.snapshot(); const explanations = state.explanations.filter(value => value.draftRevisionId === draft.draftRevisionId);
        const explained = new Set(explanations.map(value => value.scopeId)); const attempted = new Set(state.attempts.filter(value => value.draftRevisionId === draft.draftRevisionId).map(value => value.scopeId));
        const enrichedScopes = scopeDto.map(scope => ({ ...scope, state: sidecarState(explained.has(scope.scopeId), attempted.has(scope.scopeId)) }));
        if (enrichment.stopped === "limit") deps.store.appendEvent({ runId: run.runId, type: "enrichment.budget_reached", detail: { accepted: explained.size, attempted: attempted.size, ledger: admission.refusedBy() } });
        const enrichedArtifact = deps.store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: scanned.commitSha, files: { ...files, "operator-explanations.json": stableJson({ schemaVersion: 1, scopes: enrichedScopes, explanations }) } });
        const enrichedDraft = deps.publication.createDraftRevision({ runId: run.runId, artifactRevisionId: enrichedArtifact.artifactRevisionId, coverage: coverageFor(enrichedScopes) });
        activeDraftRevisionId = enrichedDraft.draftRevisionId;
        deps.store.updateRun(run.runId, { state: "running", draftRevisionId: enrichedDraft.draftRevisionId });
      deps.store.updateRun(run.runId, { state: "awaiting_review", draftRevisionId: activeDraftRevisionId, source: { ...run.source, commitSha: scanned.commitSha }, error: undefined as never });
    } catch (error) { deps.store.updateRun(run.runId, { state: "failed", error: error instanceof Error ? error.message : String(error) }); }
  } };
  return runner;
}
