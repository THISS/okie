import type { ScanGithubAccess } from "./githubAccess.js";
import { belowEnrichmentCap, coverageFor, legacyEnrichmentCap, type OperatorScopeAttempt, type OperatorUsage } from "./operatorContracts.js";
import { createOperatorBudgetLedger, type OperatorBudgetLedger } from "./operatorBudget.js";
import { resolveLlmRateLimitConfig, resolveOperatorEnrichmentBudget } from "./llmGateway.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore } from "./operatorStore.js";

/** `kind` is the C4 kind recorded in the sidecar (absent on hand-written legacy rows); `depth` counts ancestors. */
/**
 * `path`: the scope's primary source path (first source ref), for list search and tooltips (CLA-259).
 * `metrics`: operator-only cost/tokens/last-updated summary of the attempts behind the scope's current state (CLA-259).
 */
export interface OperatorScopeDto { scopeId: string; entityId?: string; parentScopeId?: string; name: string; kind?: string; path?: string; depth: number; state: string; stale: boolean; explanation?: unknown; explanationVersionId?: string; diagramError?: string; /** `inherited`: borrowed from an earlier revision of the run (lineage, CLA-264); display only, never counted in metrics. */ attempts?: Array<OperatorScopeAttempt & { inherited?: true }>; metrics?: OperatorScopeMetrics; }
/** Every field optional; `metrics` is omitted when none is known. */
export interface OperatorScopeMetrics { costUsd?: number; totalTokens?: number; updatedAt?: number; }

/**
 * Metrics for the attempts that produced a scope's current state: this draft's attempts for the scope when it has any
 * (a retry or a live pass), else the attempt the artifact's explanation row names — an enriched sidecar's attempts live
 * under the pre-enrichment draft — with the row's install time. Cost is measured, else estimated.
 */
export function scopeMetricsFor(draftAttempts: readonly OperatorScopeAttempt[], row: Record<string, unknown> | undefined, attemptById: ReadonlyMap<string, OperatorScopeAttempt>): OperatorScopeMetrics | undefined {
  const linked = typeof row?.attemptId === "string" ? attemptById.get(row.attemptId) : undefined;
  const sources = draftAttempts.length ? draftAttempts : linked ? [linked] : [];
  let costUsd: number | undefined; let totalTokens: number | undefined; let updatedAt: number | undefined;
  const later = (at: unknown) => { if (typeof at === "number" && Number.isFinite(at) && (updatedAt === undefined || at > updatedAt)) updatedAt = at; };
  for (const attempt of sources) {
    const cost = attempt.usage?.measuredCostUsd ?? attempt.usage?.estimatedCostUsd;
    if (cost !== undefined) costUsd = (costUsd ?? 0) + cost;
    if (attempt.usage?.inputTokens !== undefined || attempt.usage?.outputTokens !== undefined) totalTokens = (totalTokens ?? 0) + (attempt.usage.inputTokens ?? 0) + (attempt.usage.outputTokens ?? 0);
    later(attempt.updatedAt);
  }
  if (!draftAttempts.length) later(row?.createdAt);
  return costUsd === undefined && totalTokens === undefined && updatedAt === undefined ? undefined : { ...(costUsd !== undefined ? { costUsd } : {}), ...(totalTokens !== undefined ? { totalTokens } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}) };
}
/** `batch`: the retry came in the API's `scopeIds` form and re-reduces affected ancestors in one pass. */
export interface OperatorWorkflowJob { kind: "run" | "retry" | "refresh"; runId: string; draftRevisionId?: string; scopeIds?: string[]; batch?: boolean; githubAccess: ScanGithubAccess; }
/** The run ledger as the operator sees it: spend so far against the configured per-run limits. */
export interface OperatorRunBudget { maxDollars: number; spentDollars: number; maxRequests: number; requests: number; maxTokens: number; tokens: number; /** Present only when a global operator dollar cap is configured. */ globalRemainingDollars?: number; /** Run requests left (maxRequests − requests). */ remainingRequests: number; /** Present only when a global request cap is configured. */ globalRemainingRequests?: number; /** Run tokens left (maxTokens − tokens, reservations included; CLA-264). */ remainingTokens: number; /** Present only when a global token cap is configured. */ globalRemainingTokens?: number; /** Requests the pass keeps in flight at once; each holds a token reservation until it settles. */ maxConcurrent: number; /** Average tokens one admission reserved (request bytes + max output tokens) in this run; absent before any. */ avgTokenReservation?: number; }
/** The process-wide operator ledger and its dollar cap (OKIE_LLM_GLOBAL_*). */
export interface OperatorGlobalBudget { /** Only when a global dollar cap is configured. */ maxDollars?: number; /** Only when a global request cap is configured. */ maxRequests?: number; /** Only when a global token cap is configured (OKIE_LLM_GLOBAL_MAX_TOKENS). */ maxTokens?: number; ledger: Pick<OperatorBudgetLedger, "snapshot">; }
export interface OperatorWorkflowOptions { store: OperatorStore; publications: OperatorPublicationService; enqueue: (job: OperatorWorkflowJob) => void | Promise<void>; globalBudget?: OperatorGlobalBudget; }

/** Safe controller façade: draft data stays here, never under public /scan routes. */
export class OperatorWorkflow {
  constructor(private readonly options: OperatorWorkflowOptions) {}
  runDetail(runId: string) {
    const state = this.options.store.snapshot();
    const run = state.runs.find(value => value.runId === runId);
    if (!run) return undefined;
    const draftIds = new Set(state.drafts.filter(value => value.runId === runId).map(value => value.draftRevisionId));
    const attempts = state.attempts.filter(value => draftIds.has(value.draftRevisionId));
    return {
      run,
      draft: state.drafts.find(value => value.draftRevisionId === run.draftRevisionId),
      attempts: attempts.slice(-100),
      events: state.events.filter(value => value.runId === runId).slice(-100),
      usage: usage(attempts),
      budget: { ...runBudget(this.options.store, runId), ...globalRemaining(this.options.globalBudget) },
      // Live progress of the current pass only: its attempts land on the current draft (until a new one installs)
      // and were created since the run last entered "running" (earlier passes on the same draft are not counted).
      progress: progressOf(attempts.filter(value => value.draftRevisionId === run.draftRevisionId && value.createdAt >= passStartedAt(state.events.filter(event => event.runId === runId)))),
      ...avgCost(attempts), ...avgTokens(attempts),
    };
  }
  draftDetail(draftRevisionId: string) {
    const state = this.options.store.snapshot();
    const draft = state.drafts.find(value => value.draftRevisionId === draftRevisionId);
    if (!draft) return undefined;
    const run = state.runs.find(value => value.runId === draft.runId);
    if (!run) return undefined;
    const attempts = state.attempts.filter(value => value.draftRevisionId === draftRevisionId);
    // A pass is writing to this draft: settled attempts that are not installed yet read as pending ("running").
    const live = run.draftRevisionId === draftRevisionId && (run.state === "running" || run.state === "queued");
    // Lineage (CLA-264): a full run's attempts live on its pre-enrichment draft and a retry's on the draft it started from,
    // while the revision it installs has none. Scopes with no attempt here show the run's latest attempt from an earlier
    // revision, so its error stays visible; it never changes the scope's state or metrics.
    const earlier = new Set(state.drafts.filter(value => value.runId === draft.runId && value.revision < draft.revision).map(value => value.draftRevisionId));
    const lineage = new Map<string, OperatorScopeAttempt>(); for (const attempt of state.attempts) if (earlier.has(attempt.draftRevisionId)) lineage.set(attempt.scopeId, attempt);
    const scopes = readArtifactScopes(this.options.store, draft.artifactRevisionId, attempts, { live, metrics: true, lineage });
    const current = this.options.publications.currentPublication(draft.repositoryId);
    const artifact = state.artifacts.find(value => value.artifactRevisionId === draft.artifactRevisionId);
    // Coverage is re-derived from the immutable sidecar (+ this draft's attempts) so legacy drafts count "below cap" correctly.
    const coverage = scopes.length ? coverageFor(scopes, scopes.filter(scope => scope.explanation !== undefined)) : draft.coverage;
    return { draft: { ...draft, coverage }, source: run.source, scopes, usage: usage(attempts), artifact,
      ...(current ? { currentPublicationVersionId: current.versionId } : {}) };
  }
  bundle(draftRevisionId: string): Buffer | undefined { const detail = this.draftDetail(draftRevisionId); return detail ? this.options.store.readArtifactFile(detail.draft.artifactRevisionId, "atlas.okie.json") : undefined; }
  async enqueue(job: OperatorWorkflowJob): Promise<void> { await this.options.enqueue(job); }
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

const sidecarState = (value: unknown): string | undefined => value === "accepted" || value === "failed" || value === "not run" || value === "below cap" ? value : undefined;

/** Settled run-ledger spend (measured + estimated) and in-flight reservations against the current limits. */
export function runBudget(store: OperatorStore, runId: string): OperatorRunBudget {
  const limits = resolveOperatorEnrichmentBudget();
  const snapshot = createOperatorBudgetLedger({ maxRequests: limits.maxScopes, maxTokens: limits.maxTokens, maxDollars: limits.maxDollars }, { store, runId }).snapshot();
  const tokens = snapshot.inputTokens + snapshot.outputTokens + snapshot.reservedTokens;
  const reservations = store.snapshot().events.filter(event => event.runId === runId && event.type === "budget.reserved" && event.detail?.kind !== "judgment" && typeof event.detail?.tokens === "number").map(event => event.detail!.tokens as number);
  return { maxConcurrent: Math.max(1, Math.floor(resolveLlmRateLimitConfig().maxConcurrent)), ...(reservations.length ? { avgTokenReservation: reservations.reduce((total, value) => total + value, 0) / reservations.length } : {}), maxDollars: limits.maxDollars, spentDollars: (snapshot.measuredCostUsd ?? 0) + (snapshot.estimatedCostUsd ?? 0), maxRequests: limits.maxScopes, requests: snapshot.requests, remainingRequests: Math.max(0, limits.maxScopes - snapshot.requests), maxTokens: limits.maxTokens, tokens, remainingTokens: Math.max(0, limits.maxTokens - tokens) };
}

/** When the current pass started: the latest run.state → running transition (0 when none is recorded). */
export function passStartedAt(events: readonly { type: string; at: number; detail?: Record<string, unknown> }[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) { const event = events[index]!; if (event.type === "run.state" && event.detail?.state === "running") return event.at; }
  return 0;
}

export function progressOf(attempts: readonly OperatorScopeAttempt[]): { accepted: number; failed: number; inFlight: number } {
  return { accepted: attempts.filter(value => value.state === "accepted").length, failed: attempts.filter(value => value.state === "failed").length, inFlight: attempts.filter(value => value.state === "running" || value.state === "queued").length };
}

/** Global dollars/requests/tokens left (settled spend plus reservations still holding them), per configured global cap. */
export function globalRemaining(global?: OperatorGlobalBudget): { globalRemainingDollars?: number; globalRemainingRequests?: number; globalRemainingTokens?: number } {
  if (!global) return {};
  const snapshot = global.ledger.snapshot();
  return { ...(global.maxDollars !== undefined ? { globalRemainingDollars: Math.max(0, global.maxDollars - (snapshot.measuredCostUsd ?? 0) - (snapshot.estimatedCostUsd ?? 0) - snapshot.reservedCostUsd) } : {}), ...(global.maxRequests !== undefined ? { globalRemainingRequests: Math.max(0, global.maxRequests - snapshot.requests) } : {}), ...(global.maxTokens !== undefined ? { globalRemainingTokens: Math.max(0, global.maxTokens - snapshot.inputTokens - snapshot.outputTokens - snapshot.reservedTokens) } : {}) };
}

/** Average cost of the run's attempts that reported one (measured, else estimated); absent when none did. */
export function avgCost(attempts: readonly OperatorScopeAttempt[]): { avgCostPerScopeUsd?: number } {
  const costs = attempts.map(attempt => attempt.usage?.measuredCostUsd ?? attempt.usage?.estimatedCostUsd).filter((value): value is number => value !== undefined);
  return costs.length ? { avgCostPerScopeUsd: costs.reduce((total, value) => total + value, 0) / costs.length } : {};
}

/**
 * Average reported tokens (input + output) per attempt that reported usage, estimated like {@link avgCost} (CLA-264): the
 * web's fit-to-budget checks the token cap with it. Absent when no attempt reported tokens.
 */
export function avgTokens(attempts: readonly OperatorScopeAttempt[]): { avgTokensPerScope?: number } {
  const totals = attempts.flatMap(attempt => attempt.usage?.inputTokens !== undefined || attempt.usage?.outputTokens !== undefined ? [(attempt.usage.inputTokens ?? 0) + (attempt.usage.outputTokens ?? 0)] : []);
  return totals.length ? { avgTokensPerScope: totals.reduce((total, value) => total + value, 0) / totals.length } : {};
}

/** Artifact content is authoritative, so later attempts cannot rewrite a frozen preview. */
/** `metrics` adds the operator-only per-scope cost/tokens/updated summary (never on public routes). */
/** `lineage`: per scope, the run's latest attempt on an earlier revision; listed only when this draft has none for the scope. */
export function readArtifactScopes(store: OperatorStore, artifactRevisionId: string, attempts: OperatorScopeAttempt[] = [], options: { live?: boolean; metrics?: boolean; lineage?: ReadonlyMap<string, OperatorScopeAttempt> } = {}): OperatorScopeDto[] {
  const bytes = store.readArtifactFile(artifactRevisionId, "operator-explanations.json");
  if (!bytes) return [];
  const sidecar = object(JSON.parse(bytes.toString("utf8")));
  const definitions = Array.isArray(sidecar.scopes) ? sidecar.scopes : [];
  const explanations = Array.isArray(sidecar.explanations) ? sidecar.explanations : [];
  const byScope = new Map<string, Record<string, unknown>>();
  for (const value of explanations) {
    const row = object(value);
    if (typeof row.scopeId === "string") byScope.set(row.scopeId, row);
  }
  const staleScopes = new Set(Array.isArray(sidecar.staleScopes) ? sidecar.staleScopes : []);
  // CLA-258 sidecars record the run's depth cap. Legacy (CLA-254) sidecars have none: see legacyEnrichmentCap
  // (component cap unless some code scope shows the run opted symbols in, in which case nothing is inferred).
  const recordedCap = sidecar.maxKind === "component" || sidecar.maxKind === "code" ? sidecar.maxKind : undefined;
  const legacyCap = recordedCap ? undefined : legacyEnrichmentCap(definitions.map(object).map(scope => ({ scopeId: String(scope.scopeId), kind: scope.kind, state: scope.state })), new Set(byScope.keys()));
  const parents = new Map<string, string>();
  for (const value of definitions) { const scope = object(value); if (typeof scope.scopeId === "string" && typeof scope.parentScopeId === "string") parents.set(scope.scopeId, scope.parentScopeId); }
  const attemptById = options.metrics ? new Map(store.snapshot().attempts.map(attempt => [attempt.attemptId, attempt])) : undefined;
  const attemptsByScope = new Map<string, OperatorScopeAttempt[]>(); for (const attempt of attempts) { const list = attemptsByScope.get(attempt.scopeId); if (list) list.push(attempt); else attemptsByScope.set(attempt.scopeId, [attempt]); }
  const depthOf = (scopeId: string): number => { let depth = 0; const seen = new Set([scopeId]); let cursor = parents.get(scopeId); while (cursor && !seen.has(cursor)) { seen.add(cursor); depth += 1; cursor = parents.get(cursor); } return depth; };
  return definitions.flatMap(value => {
    const scope = object(value);
    if (typeof scope.scopeId !== "string" || typeof scope.name !== "string") return [];
    const row = byScope.get(scope.scopeId);
    const content = row?.content ?? row?.explanation;
    const explanation = object(content);
    const rows = attemptsByScope.get(scope.scopeId) ?? [];
    const metrics = attemptById ? scopeMetricsFor(rows, row, attemptById) : undefined;
    const latest = rows.at(-1);
    const recorded = sidecarState(scope.state);
    // Sidecar-only inference; an in-flight attempt still shows as running/queued because live states win below.
    const inferredBelowCap = !row && (recordedCap ? recorded === undefined && belowEnrichmentCap(scope.kind, recordedCap) : legacyCap !== undefined && belowEnrichmentCap(scope.kind, legacyCap) && (recorded === undefined || recorded === "not run"));
    const settled = (inferredBelowCap ? "below cap" : recorded) ?? latest?.state ?? (row ? "accepted" : "not run");
    // An opted-in below-cap scope with ANY attempt on this draft is in scope and shows that attempt, so the in-scope
    // total never drifts mid-pass. Accepted still needs an explanation row: an accepted attempt awaiting install
    // reads as "running" while its pass is live (else "not run"), and never raises accepted coverage.
    const attemptedBelowCap = settled === "below cap" && latest ? (latest.state === "accepted" ? (row ? "accepted" : options.live ? "running" : "not run") : latest.state === "interrupted" ? "failed" : latest.state) : undefined;
    return [{
      scopeId: scope.scopeId, entityId: scope.scopeId, name: scope.name,
      ...(typeof scope.kind === "string" ? { kind: scope.kind } : {}), ...(primaryPath(scope.sourceRefs) ? { path: primaryPath(scope.sourceRefs)! } : {}), depth: depthOf(scope.scopeId),
      ...(typeof scope.parentScopeId === "string" ? { parentScopeId: scope.parentScopeId } : {}),
      // The enriched sidecar's recorded state wins (its attempts live under the pre-enrichment
      // draft id) unless this draft has live or cancelled work in progress.
      // "accepted" only with an explanation row in this artifact: an attempt state can never raise it
      // (the full run's accepted attempts live under the pre-enrichment draft, whose sidecar has none).
      state: attemptedBelowCap ?? (latest && ["running", "queued", "cancelled"].includes(latest.state) ? latest.state : undefined) ?? (settled === "accepted" && !row ? "not run" : settled),
      stale: Boolean(scope.stale || row?.stale || staleScopes.has(scope.scopeId) || latest?.stale),
      ...(typeof explanation.summary === "string" ? { explanation } : {}),
      ...(typeof row?.explanationVersionId === "string" ? { explanationVersionId: row.explanationVersionId } : {}),
      ...(typeof explanation.diagramError === "string" ? { diagramError: explanation.diagramError } : {}),
      ...(rows.length ? { attempts: rows } : options.lineage?.has(scope.scopeId) ? { attempts: [{ ...options.lineage.get(scope.scopeId)!, inherited: true as const }] } : {}),
      ...(metrics ? { metrics } : {}),
    }];
  });
}

/** First source ref's path, when the sidecar recorded one. */
function primaryPath(refs: unknown): string | undefined { const first = Array.isArray(refs) ? object(refs[0]) : {}; return typeof first.path === "string" && first.path ? first.path : undefined; }

export function usage(attempts: OperatorScopeAttempt[]): OperatorUsage & { costStatus: "measured" | "estimated" | "unknown"; unknownCostAttempts: number } {
  const rows = attempts.map(value => value.usage);
  const measured = rows.filter(value => value?.measuredCostUsd !== undefined);
  const estimated = rows.filter(value => value?.estimatedCostUsd !== undefined && value.measuredCostUsd === undefined);
  const unknownCostAttempts = rows.filter(value => value?.measuredCostUsd === undefined && value?.estimatedCostUsd === undefined).length;
  return {
    inputTokens: rows.reduce((total, value) => total + (value?.inputTokens ?? 0), 0),
    outputTokens: rows.reduce((total, value) => total + (value?.outputTokens ?? 0), 0),
    ...(measured.length ? { measuredCostUsd: measured.reduce((total, value) => total + value!.measuredCostUsd!, 0) } : {}),
    ...(estimated.length ? { estimatedCostUsd: estimated.reduce((total, value) => total + value!.estimatedCostUsd!, 0) } : {}),
    costStatus: unknownCostAttempts || !rows.length ? "unknown" : estimated.length ? "estimated" : "measured",
    unknownCostAttempts,
  };
}
