import type { ScanGithubAccess } from "./githubAccess.js";
import { belowEnrichmentCap, coverageFor, legacyEnrichmentCap, type OperatorScopeAttempt, type OperatorUsage } from "./operatorContracts.js";
import { createOperatorBudgetLedger, type OperatorBudgetLedger } from "./operatorBudget.js";
import { resolveOperatorEnrichmentBudget } from "./llmGateway.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore } from "./operatorStore.js";

/** `kind` is the C4 kind recorded in the sidecar (absent on hand-written legacy rows); `depth` counts ancestors. */
export interface OperatorScopeDto { scopeId: string; entityId?: string; parentScopeId?: string; name: string; kind?: string; depth: number; state: string; stale: boolean; explanation?: unknown; explanationVersionId?: string; diagramError?: string; attempts?: OperatorScopeAttempt[]; }
/** `batch`: the retry came in the API's `scopeIds` form and re-reduces affected ancestors in one pass. */
export interface OperatorWorkflowJob { kind: "run" | "retry" | "refresh"; runId: string; draftRevisionId?: string; scopeIds?: string[]; batch?: boolean; githubAccess: ScanGithubAccess; }
/** The run ledger as the operator sees it: spend so far against the configured per-run limits. */
export interface OperatorRunBudget { maxDollars: number; spentDollars: number; maxRequests: number; requests: number; maxTokens: number; tokens: number; /** Present only when a global operator dollar cap is configured. */ globalRemainingDollars?: number; /** Run requests left (maxRequests − requests). */ remainingRequests: number; /** Present only when a global request cap is configured. */ globalRemainingRequests?: number; }
/** The process-wide operator ledger and its dollar cap (OKIE_LLM_GLOBAL_*). */
export interface OperatorGlobalBudget { maxDollars: number; /** Only when a global request cap is configured. */ maxRequests?: number; ledger: Pick<OperatorBudgetLedger, "snapshot">; }
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
      ...avgCost(attempts),
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
    const scopes = readArtifactScopes(this.options.store, draft.artifactRevisionId, attempts, { live });
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
  return { maxDollars: limits.maxDollars, spentDollars: (snapshot.measuredCostUsd ?? 0) + (snapshot.estimatedCostUsd ?? 0), maxRequests: limits.maxScopes, requests: snapshot.requests, remainingRequests: Math.max(0, limits.maxScopes - snapshot.requests), maxTokens: limits.maxTokens, tokens: snapshot.inputTokens + snapshot.outputTokens + snapshot.reservedTokens };
}

/** When the current pass started: the latest run.state → running transition (0 when none is recorded). */
export function passStartedAt(events: readonly { type: string; at: number; detail?: Record<string, unknown> }[]): number {
  for (let index = events.length - 1; index >= 0; index -= 1) { const event = events[index]!; if (event.type === "run.state" && event.detail?.state === "running") return event.at; }
  return 0;
}

export function progressOf(attempts: readonly OperatorScopeAttempt[]): { accepted: number; failed: number; inFlight: number } {
  return { accepted: attempts.filter(value => value.state === "accepted").length, failed: attempts.filter(value => value.state === "failed").length, inFlight: attempts.filter(value => value.state === "running" || value.state === "queued").length };
}

/** Global dollars left (settled spend plus reservations still holding dollars), when a global cap is configured. */
export function globalRemaining(global?: OperatorGlobalBudget): { globalRemainingDollars?: number; globalRemainingRequests?: number } {
  if (!global) return {};
  const snapshot = global.ledger.snapshot();
  return { globalRemainingDollars: Math.max(0, global.maxDollars - (snapshot.measuredCostUsd ?? 0) - (snapshot.estimatedCostUsd ?? 0) - snapshot.reservedCostUsd), ...(global.maxRequests !== undefined ? { globalRemainingRequests: Math.max(0, global.maxRequests - snapshot.requests) } : {}) };
}

/** Average cost of the run's attempts that reported one (measured, else estimated); absent when none did. */
export function avgCost(attempts: readonly OperatorScopeAttempt[]): { avgCostPerScopeUsd?: number } {
  const costs = attempts.map(attempt => attempt.usage?.measuredCostUsd ?? attempt.usage?.estimatedCostUsd).filter((value): value is number => value !== undefined);
  return costs.length ? { avgCostPerScopeUsd: costs.reduce((total, value) => total + value, 0) / costs.length } : {};
}

/** Artifact content is authoritative, so later attempts cannot rewrite a frozen preview. */
export function readArtifactScopes(store: OperatorStore, artifactRevisionId: string, attempts: OperatorScopeAttempt[] = [], options: { live?: boolean } = {}): OperatorScopeDto[] {
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
  const depthOf = (scopeId: string): number => { let depth = 0; const seen = new Set([scopeId]); let cursor = parents.get(scopeId); while (cursor && !seen.has(cursor)) { seen.add(cursor); depth += 1; cursor = parents.get(cursor); } return depth; };
  return definitions.flatMap(value => {
    const scope = object(value);
    if (typeof scope.scopeId !== "string" || typeof scope.name !== "string") return [];
    const row = byScope.get(scope.scopeId);
    const content = row?.content ?? row?.explanation;
    const explanation = object(content);
    const rows = attempts.filter(attempt => attempt.scopeId === scope.scopeId);
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
      ...(typeof scope.kind === "string" ? { kind: scope.kind } : {}), depth: depthOf(scope.scopeId),
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
      ...(rows.length ? { attempts: rows } : {}),
    }];
  });
}

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
