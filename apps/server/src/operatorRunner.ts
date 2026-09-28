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
import { belowEnrichmentCap, coverageFor, legacyEnrichmentCap, sidecarState, type OperatorEnrichmentCap, type OperatorSidecarScopeState } from "./operatorContracts.js";
import { createJevProvider, runOperatorJudgments, type JudgmentLimits, type JudgmentOutcome, type JudgmentProvider, type JudgmentRequest } from "./operatorJudgments.js";
import { runSectionProfile } from "./sectionProfiles.js";

export interface OperatorRunnerScan { commitSha: string; artifacts: ScanArtifacts; }
export interface OperatorRunnerDeps { store: OperatorStore; publication: OperatorPublicationService; githubClient?(access: ScanGithubAccess): GithubClient; scan?(source: GithubSourceRef, options: { client: GithubClient; analysisMode: "full"; codeSurface: "all" }): Promise<OperatorRunnerScan>; gateway?: OperatorEnrichmentGateway; gatewayConfig?: LlmGatewayConfig; judgmentProvider?: JudgmentProvider | null; judgmentLimits?: Partial<JudgmentLimits>; /** Test seam; defaults to the process-wide limiter for the gateway's provider. */ rateLimiter?: LlmRateLimiter; /** Process-wide operator spend ledger (OKIE_LLM_GLOBAL_*), reserved before the run ledger. */ globalLedger?: OperatorBudgetLedger; }
export interface OperatorRunner { profile(input: { runId: string; draftRevisionId: string; scopeId: string }, signal?: AbortSignal): ReturnType<typeof runSectionProfile>; judge(request: JudgmentRequest, signal?: AbortSignal): Promise<JudgmentOutcome>; enqueue(input: { kind: "run" | "retry" | "refresh"; runId: string; githubAccess: ScanGithubAccess; draftRevisionId?: string; scopeIds?: string[]; /** Batch retry: re-reduce affected ancestors in the same pass (CLA-258). */ batch?: boolean; /** Internal audit label for refresh's targeted retry execution. */ attemptKind?: "retry" | "refresh" }): Promise<void>; }

function persistedUsage(usage?: GatewayUsage) {
  return usage ? {
    inputTokens: usage.promptTokens ?? Math.max(0, usage.totalTokens - (usage.completionTokens ?? 0)),
    outputTokens: usage.completionTokens ?? 0,
    ...(usage.costUsd !== undefined ? { measuredCostUsd: usage.costUsd } : {}),
  } : undefined;
}

export { coverageFor, sidecarState, type OperatorSidecarScopeState } from "./operatorContracts.js";

/** Durable completion record for an enrichment pass (CLA-258); counts are the installed draft's coverage. */
/** This pass's own provider cost (sum of its attempts' reported cost); absent when no attempt reported one. */
function passCost(attempts: readonly { usage?: GatewayUsage }[]): { costUsd?: number } {
  const costs = attempts.map(attempt => attempt.usage?.costUsd).filter((value): value is number => value !== undefined);
  return costs.length ? { costUsd: costs.reduce((total, value) => total + value, 0) } : {};
}
function finishedDetail(kind: "run" | "retry", stopped: string, coverage: ReturnType<typeof coverageFor>, startedAt: number, extra: Record<string, number> = {}): Record<string, string | number> {
  return { kind, stopped, accepted: coverage.accepted, failed: coverage.failed, notRun: coverage.notRun, belowCap: coverage.belowCap, inScope: coverage.total - coverage.belowCap, durationMs: Math.max(0, Date.now() - startedAt), ...extra };
}

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
      // Nothing will execute: release the run from the API's "queued" mark.
      if (run.state === "queued") deps.store.updateRun(run.runId, { state: "awaiting_review" });
      return;
    }
    /** Retry/refresh execution is visible as "running" (the API's 409 guard covers it); a cancellation is never overwritten. */
    const markRunning = () => { if (!deps.store.isCancelled(run.runId)) deps.store.updateRun(run.runId, { state: "running" }); };
    if (input.kind === "refresh") {
      const draft = deps.store.snapshot().drafts.find(value => value.draftRevisionId === input.draftRevisionId && value.runId === run.runId);
      if (!draft) throw new Error("refresh requires draft");
      const sidecar = JSON.parse(deps.store.readArtifactFile(draft.artifactRevisionId, "operator-explanations.json")!.toString()) as { scopes: Array<{ scopeId: string; parentScopeId?: string; stale?: boolean }> };
      const byId = new Map(sidecar.scopes.map(scope => [scope.scopeId, scope]));
      const depth = (scopeId: string): number => { let result = 0; let cursor = byId.get(scopeId)?.parentScopeId; while (cursor) { result += 1; cursor = byId.get(cursor)?.parentScopeId; } return result; };
      let activeDraftRevisionId = draft.draftRevisionId;
      markRunning();
      for (const scopeId of [...new Set(input.scopeIds ?? [])].filter(scopeId => byId.get(scopeId)?.stale).sort((left, right) => depth(right) - depth(left) || left.localeCompare(right))) {
        await runner.enqueue({ ...input, kind: "retry", attemptKind: "refresh", draftRevisionId: activeDraftRevisionId, scopeIds: [scopeId] });
        if (deps.store.isCancelled(run.runId)) return;
        activeDraftRevisionId = deps.store.snapshot().runs.find(value => value.runId === run.runId)?.draftRevisionId ?? activeDraftRevisionId;
      }
      if (deps.store.snapshot().runs.find(value => value.runId === run.runId)?.state === "running") deps.store.updateRun(run.runId, { state: "awaiting_review" });
      return;
    }
    if (input.kind === "retry") {
      const startedAt = Date.now();
      const draft = deps.store.snapshot().drafts.find(value => value.draftRevisionId === input.draftRevisionId && value.runId === run.runId); const requested = [...new Set(input.scopeIds ?? [])];
      if (!draft || !requested.length) throw new Error("retry requires draft and scope");
      const artifact = deps.store.snapshot().artifacts.find(value => value.artifactRevisionId === draft.artifactRevisionId)!;
      const sidecar = JSON.parse(deps.store.readArtifactFile(artifact.artifactRevisionId, "operator-explanations.json")!.toString()) as { maxKind?: OperatorEnrichmentCap; scopes: Array<{ scopeId: string; parentScopeId?: string; name: string; kind: OperatorEnrichmentScope["kind"]; stale?: boolean; state?: OperatorSidecarScopeState; sourceRefs: Array<{ path: string; startLine?: number; endLine?: number }> }>; explanations: Array<{ scopeId: string; content: unknown; explanationVersionId?: string }> };
      const selectedIds = requested.filter(scopeId => sidecar.scopes.some(scope => scope.scopeId === scopeId)); const rawGateway = deps.gateway ?? createLlmGatewayClient(deps.gatewayConfig ?? resolveLlmGatewayConfig(), { timeoutMs: resolveOperatorEnrichmentBudget().requestTimeoutMs });
      if (!selectedIds.length) { if (!deps.store.isCancelled(run.runId)) deps.store.updateRun(run.runId, { state: "awaiting_review" }); return; }
      markRunning();
      const single = selectedIds.length === 1 ? selectedIds[0]! : undefined;
      /** Error/event subject: the scope id for one target (unchanged CLA-134 wording), else a count. */
      const subject = single ?? `${selectedIds.length} scopes`; const subjectDetail = single ? { scopeId: single } : { scopes: selectedIds.length };
      // A recorded cap wins. A legacy (CLA-254) sidecar is treated as component-capped only when no code scope shows a
      // code-opt-in run (legacyEnrichmentCap); otherwise no scope is ever "below cap" and no maxKind is stamped.
      const recordedCap: OperatorEnrichmentCap | undefined = sidecar.maxKind === "code" || sidecar.maxKind === "component" ? sidecar.maxKind : undefined;
      const sidecarCap: OperatorEnrichmentCap | undefined = recordedCap ?? legacyEnrichmentCap(sidecar.scopes, new Set(sidecar.explanations.map(value => value.scopeId)));
      const capped = (kind: unknown) => sidecarCap !== undefined && belowEnrichmentCap(kind, sidecarCap);
      const budget = resolveOperatorEnrichmentBudget(); const gateway = rawGateway && limitedGateway(rawGateway, deps.gatewayConfig, deps.rateLimiter);
      const snapshot = JSON.parse(deps.store.readArtifactFile(artifact.artifactRevisionId, "snapshot.json")!.toString()) as ArchitectureSnapshot;
      const scopes: OperatorEnrichmentScope[] = sidecar.scopes.map(scope => {
        const entity = snapshot.entities.find(value => value.id === scope.scopeId);
        const { state: _state, ...definition } = scope;
        return { ...definition, facts: { tags: entity?.tags, technology: entity?.technology, exposure: entity?.exposure, sourceExcerpts: entity?.sourceExcerpts, relationships: snapshot.relations.filter(relation => relation.from === scope.scopeId || relation.to === scope.scopeId).map(relation => ({ id: relation.id, from: relation.from, to: relation.to, kind: relation.kind })) }, allowedEvidence: scope.sourceRefs.map(ref => ({ entityId: scope.scopeId, path: ref.path, ...(ref.startLine ? { startLine: ref.startLine } : {}), ...(ref.endLine ? { endLine: ref.endLine } : {}) })) };
      });
      const attempts = new Map<string, string>(); const acceptedContent = new Map<string, unknown>(); const acceptedVersionId = new Map<string, string>();
      const staleScopes = new Set<string>();
      // latestAttempt: a scope with a pinned explanation is passed up as accepted/stale even after a failed retry attempt on
      // this draft (a pass that changes nothing installs no revision, so such attempts stay on the current draft).
      const adapter: OperatorEnrichmentStore = { async createAttempt(attempt) { attempts.set(attempt.attemptId, deps.store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: attempt.scopeId, kind: input.attemptKind ?? "retry", state: "running", modelId: attempt.modelId, inputHash: attempt.inputHash }).attemptId); }, async updateAttempt(id, patch) { const mapped = attempts.get(id); if (mapped) deps.store.updateAttempt(mapped, { state: patch.state === "accepted" ? "accepted" : patch.state === "cancelled" ? "cancelled" : "failed", ...(patch.usage ? { usage: persistedUsage(patch.usage)! } : {}), ...(patch.error ? { error: patch.error } : {}) }); }, async latestAttempt(scope) { const previous = deps.store.listAttempts(draft.draftRevisionId, scope).at(-1); const sidecarScope = sidecar.scopes.find(value => value.scopeId === scope); const prior = sidecar.explanations.some(value => value.scopeId === scope) || acceptedContent.has(scope); const stale = Boolean(sidecarScope?.stale || staleScopes.has(scope) || previous?.stale); if (previous && previous.state !== "accepted" && !prior) return { attemptId: previous.attemptId, scopeId: scope, role: "owner", state: previous.state === "cancelled" ? "cancelled" : "failed", modelId: previous.modelId ?? "", inputHash: previous.inputHash ?? "", createdAt: previous.createdAt, updatedAt: previous.updatedAt }; if (!previous && !prior && sidecarScope?.state === "failed") return { attemptId: "sidecar", scopeId: scope, role: "owner", state: "failed", modelId: "", inputHash: "", createdAt: 0, updatedAt: 0 }; return prior ? { attemptId: previous?.attemptId ?? "sidecar", scopeId: scope, role: "owner", state: stale ? "stale" : "accepted", modelId: previous?.modelId ?? "", inputHash: previous?.inputHash ?? "", createdAt: previous?.createdAt ?? 0, updatedAt: previous?.updatedAt ?? 0 } : undefined; }, async putAcceptedExplanation(scope, explanation, attempt, inputHash) { acceptedContent.set(scope, explanation); const row = deps.store.putAcceptedExplanation({ draftRevisionId: draft.draftRevisionId, scopeId: scope, attemptId: attempts.get(attempt)!, inputHash, content: explanation, validation: { accepted: true, validator: "operator-enrichment/v1" } }); acceptedVersionId.set(scope, row.explanationVersionId); return { explanationVersionId: row.explanationVersionId }; }, async getAcceptedExplanation(scope) { const prior = sidecar.explanations.find(value => value.scopeId === scope); return (acceptedContent.get(scope) ?? prior?.content) as OperatorExplanation | undefined; }, async markStale(ids) { ids.forEach(id => staleScopes.add(id)); } };
      let result: Awaited<ReturnType<typeof runOperatorEnrichment>>;
      const admission = ledgerAdmission(deps.store, run.runId, budget, deps.globalLedger);
      // A batch (the API's `scopeIds` form) re-reduces affected ancestors in the same pass; the single `scopeId` form and refresh keep marking them stale.
      try { result = await runOperatorEnrichment({ draftRevisionId: draft.draftRevisionId, scopes, store: adapter, ...(gateway ? { gateway } : {}), limits: { maxScopes: budget.maxScopes, maxTokens: budget.maxTokens, maxDollars: budget.maxDollars, maxConcurrent: resolveLlmRateLimitConfig().maxConcurrent }, maxKind: sidecarCap ?? "code", leafReasoning: leafReasoningFor(rawGateway, deps.gatewayConfig), admitRequest: admission, retryScopeIds: selectedIds, ...(input.batch ? { reReduceAncestors: true } : {}), cancelled: () => deps.store.isCancelled(run.runId) }); }
      catch (error) { deps.store.appendEvent({ runId: run.runId, type: "enrichment.retry_failed", detail: subjectDetail }); deps.store.updateRun(run.runId, { state: "awaiting_review", error: `Retry of ${subject} failed: ${error instanceof Error ? error.message : String(error)}` }); return; }
      const attemptedIds = new Set(result.attempts.map(attempt => attempt.scopeId));
      const hadExplanation = new Set(sidecar.explanations.map(value => value.scopeId));
      /** Per selected scope: accepted in this pass, or attempted and failed (a previous explanation, if any, is kept). */
      const selectedOutcome = () => { const accepted = new Set(result.attempts.filter(attempt => attempt.state === "accepted").map(attempt => attempt.scopeId)); const failed = selectedIds.filter(scopeId => attemptedIds.has(scopeId) && !accepted.has(scopeId)); return { retryAccepted: selectedIds.filter(scopeId => accepted.has(scopeId)).length, retryFailed: failed.length, retryKept: failed.filter(scopeId => hadExplanation.has(scopeId)).length }; };
      const finishedEvent = (stopped: string, coverage: ReturnType<typeof coverageFor>, installed = true) => deps.store.appendEvent({ runId: run.runId, type: "enrichment.finished", detail: { ...finishedDetail("retry", stopped, coverage, startedAt, { selected: selectedIds.length, retried: selectedIds.filter(scopeId => attemptedIds.has(scopeId)).length, ...selectedOutcome(), ...passCost(result.attempts) }), installed } });
      const recordedScopes = () => sidecar.scopes.map(scope => ({ ...scope, state: sidecarState(sidecar.explanations.some(value => value.scopeId === scope.scopeId), false, scope.state, capped(scope.kind)) }));
      if (deps.store.isCancelled(run.runId)) { finishedEvent("cancelled", coverageFor(recordedScopes())); return; }
      // Nothing was attempted (budget refused or no gateway): no new draft and no persisted stale marks.
      if (!result.attempts.length && (result.stopped === "limit" || result.stopped === "unavailable")) {
        const limit = result.stopped === "limit";
        const ledger = admission.refusedBy();
        deps.store.appendEvent({ runId: run.runId, type: limit ? "enrichment.budget_refused" : "enrichment.unavailable", detail: { ...subjectDetail, ...(limit ? { ledger } : {}) } });
        deps.store.updateRun(run.runId, { state: "awaiting_review", error: !limit ? `Retry of ${subject} was not run: no enrichment gateway is configured.` : ledger === "global" ? `Retry of ${subject} was not run: the process-wide operator budget is exhausted. Raise the global operator limits (OKIE_LLM_GLOBAL_MAX_DOLLARS or its matching global cap) to retry.` : `Retry of ${subject} was not run: this run's enrichment budget is exhausted. Raise OKIE_LLM_OPERATOR_MAX_REQUESTS (or the matching budget limit) to retry.` });
        return;
      }
      const files = Object.fromEntries(artifact.files.map(name => [name, deps.store.readArtifactFile(artifact.artifactRevisionId, name)!.toString()]));
      /** Every scope accepted in this pass (selected targets and re-reduced ancestors) gets its new immutable version. */
      const newlyAccepted = new Set(result.attempts.filter(attempt => attempt.state === "accepted" && acceptedContent.has(attempt.scopeId)).map(attempt => attempt.scopeId));
      const nextEntry = (scopeId: string) => ({ scopeId, content: acceptedContent.get(scopeId), ...(acceptedVersionId.has(scopeId) ? { explanationVersionId: acceptedVersionId.get(scopeId) } : {}) });
      const nextExplanations = sidecar.explanations.map(value => newlyAccepted.has(value.scopeId) ? nextEntry(value.scopeId) : value);
      for (const scopeId of newlyAccepted) if (!nextExplanations.some(value => value.scopeId === scopeId)) nextExplanations.push(nextEntry(scopeId));
      const explained = new Set(nextExplanations.map(value => value.scopeId));
      // A below-cap scope that was explicitly retried now has an attempt and counts as in scope; untouched ones stay "below cap".
      const nextScopes = sidecar.scopes.map(scope => ({ ...scope, state: sidecarState(explained.has(scope.scopeId), attemptedIds.has(scope.scopeId), scope.state, capped(scope.kind)), ...(staleScopes.has(scope.scopeId) ? { stale: true } : {}) }));
      // Freshness is judged against the next sidecar, children first, so a child refreshed in this same pass counts as fresh.
      const nextById = new Map(nextScopes.map(scope => [scope.scopeId, scope]));
      const depthOf = (scopeId: string) => { let depth = 0; let cursor = nextById.get(scopeId)?.parentScopeId; const seen = new Set<string>(); while (cursor && !seen.has(cursor)) { seen.add(cursor); depth += 1; cursor = nextById.get(cursor)?.parentScopeId; } return depth; };
      const hasUnfreshChild = (parentScopeId: string) => nextScopes.some(child => child.parentScopeId === parentScopeId && (child.stale || (() => { const latest = deps.store.listAttempts(draft.draftRevisionId, child.scopeId).at(-1); return latest !== undefined && (latest.stale || latest.state !== "accepted"); })()));
      for (const scopeId of [...newlyAccepted].sort((left, right) => depthOf(right) - depthOf(left))) { const scope = nextById.get(scopeId); if (scope && !hasUnfreshChild(scopeId)) scope.stale = false; }
      const nextSidecar = { ...sidecar, ...(sidecarCap ? { maxKind: sidecarCap } : {}), scopes: nextScopes, explanations: nextExplanations };
      files["operator-explanations.json"] = stableJson(nextSidecar);
      const coverage = coverageFor(nextScopes);
      const limitStop = result.stopped === "limit"; const ledger = limitStop ? admission.refusedBy() : undefined;
      const retried = selectedIds.filter(scopeId => attemptedIds.has(scopeId)).length;
      const outcome = selectedOutcome();
      // Honest run error: a budget stop and/or failed selected scopes (their previous explanations stay pinned).
      const errors = [
        ...(limitStop ? [`Retried ${retried} of ${selectedIds.length} selected scope${selectedIds.length === 1 ? "" : "s"}: stopped at the ${ledger === "global" ? "process-wide operator budget (OKIE_LLM_GLOBAL_*)" : "run budget (OKIE_LLM_OPERATOR_*)"}; ${selectedIds.length - retried} not run.`] : []),
        ...(outcome.retryFailed ? [`Retry: ${outcome.retryFailed} of ${selectedIds.length} selected scope${selectedIds.length === 1 ? "" : "s"} failed${outcome.retryKept === outcome.retryFailed ? `; previous explanation${outcome.retryKept === 1 ? " was" : "s were"} kept.` : outcome.retryKept ? `; ${outcome.retryKept} previous explanation${outcome.retryKept === 1 ? " was" : "s were"} kept.` : "."}`] : []),
      ];
      const error = errors.length ? errors.join(" ") : undefined;
      // A pass that changed nothing (no new accepted content, no state or stale change) installs no new revision.
      const comparable = (state?: string) => state === undefined || state === "below cap" ? "not run" : state;
      const changed = newlyAccepted.size > 0 || nextScopes.some((scope, index) => comparable(scope.state) !== comparable(sidecar.scopes[index]!.state) || Boolean(scope.stale) !== Boolean(sidecar.scopes[index]!.stale));
      if (!changed) {
        deps.store.updateRun(run.runId, { state: "awaiting_review", error: error as never });
        if (limitStop) deps.store.appendEvent({ runId: run.runId, type: "enrichment.budget_reached", detail: { accepted: 0, attempted: result.attempts.length, ledger: ledger ?? "run", ...subjectDetail } });
        finishedEvent(result.stopped, coverageFor(recordedScopes()), false);
        return;
      }
      let installed = false; let conflict = false;
      deps.store.withExclusiveLock(() => {
        if (deps.store.snapshot().runs.find(value => value.runId === run.runId)?.draftRevisionId !== draft.draftRevisionId) { conflict = true; return; }
        const nextArtifact = deps.store.writeArtifactRevision({ repositoryId: run.source.repositoryId, ...(artifact.sourceCommitSha ? { sourceCommitSha: artifact.sourceCommitSha } : {}), files });
        const nextDraft = deps.publication.createDraftRevision({ runId: run.runId, artifactRevisionId: nextArtifact.artifactRevisionId, coverage });
        deps.store.updateRun(run.runId, { state: "awaiting_review", draftRevisionId: nextDraft.draftRevisionId, error: error as never }); installed = true;
      });
      if (!installed) { if (conflict) deps.store.appendEvent({ runId: run.runId, type: "draft.conflict", detail: { reason: "retry_compare_and_swap", draftRevisionId: draft.draftRevisionId } }); return; }
      if (limitStop) deps.store.appendEvent({ runId: run.runId, type: "enrichment.budget_reached", detail: { accepted: newlyAccepted.size, attempted: result.attempts.length, ledger: ledger ?? "run", ...subjectDetail } });
      finishedEvent(result.stopped, coverage);
      return;
    }
    if (input.kind !== "run") return;
    const startedAt = Date.now();
    deps.store.updateRun(run.runId, { state: "running" });
    try {
      const client = (deps.githubClient ?? githubClientForAccess)(input.githubAccess); const publicRepo = await client.getJson(repoApiPath(run.source.owner, run.source.repo));
      if (!publicRepo.ok || !githubRepoIsPublic(publicRepo.json)) throw new Error("repository is not public");
      const scanned = await (deps.scan ?? (async (source, options) => scanGithubRepository(source, options)) )({ owner: run.source.owner, repo: run.source.repo, ...(run.source.ref ? { ref: run.source.ref } : {}), dirSlug: run.source.slug }, { client, analysisMode: "full", codeSurface: "all" });
      if (deps.store.isCancelled(run.runId)) return;
      const artifacts = scanned.artifacts;
      // The cap in effect for this run is recorded in every sidecar so "below cap" never has to be guessed later.
      const maxKind = resolveOperatorEnrichmentDepth();
      const scopeDto = artifacts.snapshot.entities.map(entity => ({ scopeId: entity.id, ...(entity.parentId ? { parentScopeId: entity.parentId } : {}), name: entity.name, kind: entity.kind, sourceRefs: entity.sourceRefs }));
      const files: Record<string, string> = { "atlas.okie.json": serializePortableAtlas(portableAtlasFromScan(artifacts, `https://github.com/${run.source.owner}/${run.source.repo}`)), "extraction.json": stableJson(artifacts.extraction), "snapshot.json": stableJson(artifacts.snapshot), "view.json": stableJson(artifacts.view), "scene.json": stableJson(artifacts.scene), "story.json": stableJson(artifacts.story), "stories.json": stableJson(artifacts.catalog), "timeline.json": stableJson(artifacts.timeline), "operator-explanations.json": stableJson({ schemaVersion: 1, maxKind, scopes: scopeDto, explanations: [] }) };
      const artifact = deps.store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: scanned.commitSha, files });
      const draft = deps.publication.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId, coverage: coverageFor(scopeDto.map(scope => ({ ...scope, state: sidecarState(false, false, undefined, belowEnrichmentCap(scope.kind, maxKind)) }))) }); let activeDraftRevisionId = draft.draftRevisionId;
      const rawGateway = deps.gateway ?? createLlmGatewayClient(deps.gatewayConfig ?? resolveLlmGatewayConfig(), { timeoutMs: resolveOperatorEnrichmentBudget().requestTimeoutMs });
      const budget = resolveOperatorEnrichmentBudget();
      const gateway = rawGateway && limitedGateway(rawGateway, deps.gatewayConfig, deps.rateLimiter);
        const scopes: OperatorEnrichmentScope[] = artifacts.snapshot.entities.map(entity => ({ scopeId: entity.id, ...(entity.parentId ? { parentScopeId: entity.parentId } : {}), name: entity.name, kind: entity.kind as OperatorEnrichmentScope["kind"], facts: { tags: entity.tags, technology: entity.technology, exposure: entity.exposure, sourceExcerpts: entity.sourceExcerpts, relationships: artifacts.snapshot.relations.filter(relation => relation.from === entity.id || relation.to === entity.id).map(relation => ({ id: relation.id, from: relation.from, to: relation.to, kind: relation.kind })) }, allowedEvidence: entity.sourceRefs.map(ref => ({ entityId: entity.id, path: ref.path, ...(ref.startLine ? { startLine: ref.startLine } : {}), ...(ref.endLine ? { endLine: ref.endLine } : {}) })) }));
        const attemptMap = new Map<string, string>();
        const adapter: OperatorEnrichmentStore = { async createAttempt(attempt) { const row = deps.store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: attempt.scopeId, kind: "enrichment", state: "running", modelId: attempt.modelId, inputHash: attempt.inputHash, taskId: attempt.attemptId }); attemptMap.set(attempt.attemptId, row.attemptId); }, async updateAttempt(id, patch) { const mapped = attemptMap.get(id); const usage = persistedUsage(patch.usage); if (mapped) deps.store.updateAttempt(mapped, { state: patch.state === "accepted" ? "accepted" : patch.state === "cancelled" ? "cancelled" : "failed", ...(usage ? { usage } : {}), ...(patch.error ? { error: patch.error } : {}) }); }, async latestAttempt(scopeId) { const row = deps.store.listAttempts(draft.draftRevisionId, scopeId).at(-1); return row ? { attemptId: row.attemptId, scopeId, role: "owner", state: row.state === "accepted" ? "accepted" : "failed", modelId: row.modelId ?? "", inputHash: row.inputHash ?? "", createdAt: row.createdAt, updatedAt: row.updatedAt } : undefined; }, async putAcceptedExplanation(scopeId, explanation, attemptId, inputHash) { const row = deps.store.putAcceptedExplanation({ draftRevisionId: draft.draftRevisionId, scopeId, attemptId: attemptMap.get(attemptId) ?? attemptId, inputHash, content: explanation, validation: { accepted: true, validator: "operator-enrichment/v1" } }); return { explanationVersionId: row.explanationVersionId }; }, async getAcceptedExplanation(scopeId) { const row = deps.store.getAcceptedExplanation(draft.draftRevisionId, scopeId); return row?.content as OperatorExplanation | undefined; }, async markStale(ids) { ids.forEach(id => deps.store.markScopeStale(draft.draftRevisionId, id)); } };
        const admission = ledgerAdmission(deps.store, run.runId, budget, deps.globalLedger);
        const enrichment = await runOperatorEnrichment({ draftRevisionId: draft.draftRevisionId, scopes, store: adapter, ...(gateway ? { gateway } : {}), limits: { maxScopes: budget.maxScopes, maxTokens: budget.maxTokens, maxDollars: budget.maxDollars, maxConcurrent: resolveLlmRateLimitConfig().maxConcurrent }, maxKind, leafReasoning: leafReasoningFor(rawGateway, deps.gatewayConfig), admitRequest: admission, cancelled: () => deps.store.isCancelled(run.runId) });
        const stateOf = (explained: ReadonlySet<string>, attempted: ReadonlySet<string>) => scopeDto.map(scope => ({ ...scope, state: sidecarState(explained.has(scope.scopeId), attempted.has(scope.scopeId), undefined, belowEnrichmentCap(scope.kind, maxKind)) }));
        if (deps.store.isCancelled(run.runId)) {
          // Cancellation installs no draft; the completion record still says what was known.
          const known = deps.store.snapshot(); const mine = (value: { draftRevisionId: string }) => value.draftRevisionId === draft.draftRevisionId;
          deps.store.appendEvent({ runId: run.runId, type: "enrichment.finished", detail: finishedDetail("run", "cancelled", coverageFor(stateOf(new Set(known.explanations.filter(mine).map(value => value.scopeId)), new Set(known.attempts.filter(mine).map(value => value.scopeId)))), startedAt, passCost(enrichment.attempts)) });
          return;
        }
        if (enrichment.stopped === "unavailable") deps.store.appendEvent({ runId: run.runId, type: "enrichment.unavailable", detail: { reason: "no enrichment gateway configured" } });
        // A limit stop still lands here: every accepted explanation is kept in the enriched draft.
        const state = deps.store.snapshot(); const explanations = state.explanations.filter(value => value.draftRevisionId === draft.draftRevisionId);
        const explained = new Set(explanations.map(value => value.scopeId)); const attempted = new Set(state.attempts.filter(value => value.draftRevisionId === draft.draftRevisionId).map(value => value.scopeId));
        const enrichedScopes = stateOf(explained, attempted);
        if (enrichment.stopped === "limit") deps.store.appendEvent({ runId: run.runId, type: "enrichment.budget_reached", detail: { accepted: explained.size, attempted: attempted.size, ledger: admission.refusedBy() } });
        const enrichedArtifact = deps.store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: scanned.commitSha, files: { ...files, "operator-explanations.json": stableJson({ schemaVersion: 1, maxKind, scopes: enrichedScopes, explanations }) } });
        const enrichedCoverage = coverageFor(enrichedScopes);
        const enrichedDraft = deps.publication.createDraftRevision({ runId: run.runId, artifactRevisionId: enrichedArtifact.artifactRevisionId, coverage: enrichedCoverage });
        deps.store.appendEvent({ runId: run.runId, type: "enrichment.finished", detail: finishedDetail("run", enrichment.stopped, enrichedCoverage, startedAt, passCost(enrichment.attempts)) });
        activeDraftRevisionId = enrichedDraft.draftRevisionId;
        deps.store.updateRun(run.runId, { state: "running", draftRevisionId: enrichedDraft.draftRevisionId });
      deps.store.updateRun(run.runId, { state: "awaiting_review", draftRevisionId: activeDraftRevisionId, source: { ...run.source, commitSha: scanned.commitSha }, error: undefined as never });
    } catch (error) { deps.store.updateRun(run.runId, { state: "failed", error: error instanceof Error ? error.message : String(error) }); }
  } };
  return runner;
}
