import type { OperatorRunBudget, OperatorScope } from './api';
import { scopeStateLabel } from './reviewState';

/**
 * Pure scope selection and batch-retry estimates (CLA-258); list search/sort/tree live in scopeList.ts (CLA-259). The workspace keeps
 * only the state; everything here is deterministic and unit-tested.
 */
type Scope = Pick<OperatorScope, 'scopeId' | 'name' | 'state' | 'stale' | 'kind' | 'depth' | 'parentScopeId'>;

export type ScopeLevel = 'container' | 'component' | 'code';
export type ScopeFilter = 'all' | 'failed' | 'stale' | 'not run' | 'accepted';
export const SCOPE_FILTERS: ReadonlyArray<{ value: ScopeFilter; label: string }> = [{ value: 'all', label: 'All' }, { value: 'failed', label: 'Failed' }, { value: 'stale', label: 'Stale' }, { value: 'not run', label: 'Not run' }, { value: 'accepted', label: 'Accepted' }];

const LEVEL: Record<string, number> = { softwareSystem: 0, externalSystem: 0, container: 1, component: 2, code: 3 };
const LEVEL_TAG: Record<string, string> = { softwareSystem: 'system', externalSystem: 'external', container: 'container', component: 'component', code: 'code' };
export function levelOf(scope: Pick<Scope, 'kind'>): number { return scope.kind !== undefined ? LEVEL[scope.kind] ?? 4 : 4; }
/** Short per-row level tag ("container", "code"…); empty when the server did not report a kind. */
export function levelTag(scope: Pick<Scope, 'kind'>): string { return scope.kind ? LEVEL_TAG[scope.kind] ?? scope.kind : ''; }
export const isBelowCap = (scope: Pick<Scope, 'state'>): boolean => scope.state === 'below cap';

/** Retry targets: never a scope that is already queued/running; below-cap ones only after the explicit opt-in toggle. */
export function selectable(scope: Pick<Scope, 'state'>, showBelowCap: boolean): boolean {
  return scope.state !== 'running' && scope.state !== 'queued' && (showBelowCap || !isBelowCap(scope));
}
const ids = (scopes: readonly Scope[], showBelowCap: boolean, keep: (scope: Scope) => boolean) => scopes.filter(scope => selectable(scope, showBelowCap) && keep(scope)).map(scope => scope.scopeId);
export const selectVisible = (visible: readonly Scope[], showBelowCap: boolean): string[] => ids(visible, showBelowCap, () => true);
export const selectByState = (scopes: readonly Scope[], state: 'failed' | 'not run' | 'stale', showBelowCap: boolean): string[] => ids(scopes, showBelowCap, scope => scopeStateLabel(scope) === state);
export const selectByLevel = (scopes: readonly Scope[], level: ScopeLevel, showBelowCap: boolean): string[] => ids(scopes, showBelowCap, scope => scope.kind === level);
/** The scope open in the inspector plus all of its descendants. */
export function selectSubtree(scopes: readonly Scope[], rootScopeId: string, showBelowCap: boolean): string[] {
  const inside = new Set([rootScopeId]); let grew = true;
  while (grew) { grew = false; for (const scope of scopes) if (scope.parentScopeId && inside.has(scope.parentScopeId) && !inside.has(scope.scopeId)) { inside.add(scope.scopeId); grew = true; } }
  return ids(scopes, showBelowCap, scope => inside.has(scope.scopeId));
}
/** True when the selection needs `includeBelowCap: true` on the batch retry. */
export function selectionIncludesBelowCap(scopes: readonly Scope[], selected: ReadonlySet<string>): boolean { return scopes.some(scope => selected.has(scope.scopeId) && isBelowCap(scope)); }

export type RetryFraction = { mode: 'all' } | { mode: 'first'; count: number } | { mode: 'fit' };
type BudgetView = Pick<OperatorRunBudget, 'maxDollars' | 'spentDollars' | 'globalRemainingDollars' | 'remainingRequests' | 'globalRemainingRequests'> & Partial<Pick<OperatorRunBudget, 'maxTokens' | 'tokens' | 'remainingTokens' | 'globalRemainingTokens' | 'maxConcurrent' | 'avgTokenReservation'>>;
/**
 * Token cap view for fit-to-budget (CLA-264): tokens left, this run's average reported tokens per scope, the average
 * admission reservation (request bytes + max output tokens) and how many requests a pass keeps in flight.
 */
export interface TokenBudget { remainingTokens?: number; avgTokensPerScope?: number; tokenReservation?: number; maxConcurrent?: number; }
/** The token view of a run budget plus the run's average reported tokens per scope. */
export function tokenBudgetOf(budget: BudgetView | undefined, avgTokensPerScope?: number): TokenBudget {
  const left = remainingTokens(budget);
  return { ...(left !== undefined ? { remainingTokens: left } : {}), ...(avgTokensPerScope !== undefined ? { avgTokensPerScope } : {}), ...(budget?.avgTokenReservation !== undefined ? { tokenReservation: budget.avgTokenReservation } : {}), ...(budget?.maxConcurrent !== undefined ? { maxConcurrent: budget.maxConcurrent } : {}) };
}
/**
 * Tokens the ledger needs to admit `requests` calls, or undefined without a token average. Admission reserves a full
 * reservation per in-flight call and the first refusal halts the pass, so the worst moment is the last admission:
 * (k − c) settled calls at the average plus c = min(k, maxConcurrent) reservations held (maxConcurrent defaults to 1,
 * the reservation to the average) — always at least one reservation of headroom.
 */
export function tokensNeeded(requests: number, tokens: TokenBudget): number | undefined {
  if (tokens.avgTokensPerScope === undefined || requests <= 0) return tokens.avgTokensPerScope === undefined ? undefined : 0;
  const inFlight = Math.min(requests, Math.max(1, Math.floor(tokens.maxConcurrent ?? 1)));
  return (requests - inFlight) * tokens.avgTokensPerScope + inFlight * Math.max(tokens.avgTokensPerScope, tokens.tokenReservation ?? tokens.avgTokensPerScope);
}
/** Tokens a new pass may still use: the run's remainder (maxTokens − tokens on older servers), capped by the global one when configured. */
export function remainingTokens(budget?: BudgetView): number | undefined {
  if (!budget) return undefined;
  const run = budget.remainingTokens ?? (budget.maxTokens !== undefined && budget.tokens !== undefined ? Math.max(0, budget.maxTokens - budget.tokens) : undefined);
  if (run === undefined) return budget.globalRemainingTokens;
  return budget.globalRemainingTokens !== undefined ? Math.min(run, Math.max(0, budget.globalRemainingTokens)) : run;
}
/** Provider requests a new pass may still make: the run's remainder, capped by the global one when configured. */
export function remainingRequests(budget?: BudgetView): number | undefined {
  if (budget?.remainingRequests === undefined) return undefined;
  return budget.globalRemainingRequests !== undefined ? Math.min(budget.remainingRequests, budget.globalRemainingRequests) : budget.remainingRequests;
}
/** Dollars a new pass may still spend: the run ledger's remainder, capped by the global remainder when one is configured. */
export function remainingBudgetUsd(budget?: BudgetView): number | undefined {
  if (!budget) return undefined;
  const run = Math.max(0, budget.maxDollars - budget.spentDollars);
  return budget.globalRemainingDollars !== undefined ? Math.min(run, Math.max(0, budget.globalRemainingDollars)) : run;
}
/**
 * Largest n such that the first n plus the distinct parents they may re-reduce fit the request cap
 * (n + parents ≤ remaining requests), the dollars ((n + parents) × avg $ ≤ remaining $) and the token cap
 * (`tokensNeeded(n + parents)` ≤ remaining tokens, CLA-264: settled calls at this run's average plus the in-flight
 * reservations admission holds; skipped until an attempt has reported tokens), over the selection in retry order (`retryOrder` in scopeList.ts:
 * failed → stale → not run → the rest, each in hierarchy tree order; never the list's Sort choice). The total is
 * non-decreasing in n, so the first overshoot ends the search.
 */
export function fitToBudget(orderedSelection: readonly string[], scopes: readonly Scope[], remainingUsd: number | undefined, avgCostPerScopeUsd: number | undefined, requestsLeft?: number, tokens: TokenBudget = {}): { count: number } | { unavailable: string } {
  if (requestsLeft !== undefined && requestsLeft <= 0) return { unavailable: 'No requests left in the run budget (request cap reached).' };
  if (tokens.remainingTokens !== undefined && tokens.remainingTokens <= 0) return { unavailable: 'No tokens left in the run budget (token cap reached).' };
  if (avgCostPerScopeUsd === undefined || !(avgCostPerScopeUsd > 0)) return { unavailable: 'No average cost yet: no attempt in this run has reported a cost.' };
  if (remainingUsd === undefined) return { unavailable: 'No run budget information is available.' };
  const parent = new Map(scopes.map(scope => [scope.scopeId, scope.parentScopeId]));
  const chosen = new Set<string>(); const ancestors = new Set<string>(); let fit = 0;
  for (const scopeId of orderedSelection) {
    chosen.add(scopeId); ancestors.delete(scopeId);
    let cursor = parent.get(scopeId); const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) { seen.add(cursor); if (!chosen.has(cursor)) ancestors.add(cursor); cursor = parent.get(cursor); }
    const requests = chosen.size + ancestors.size;
    if (requests * avgCostPerScopeUsd > remainingUsd + 1e-12 || (requestsLeft !== undefined && requests > requestsLeft) || (tokens.remainingTokens !== undefined && (tokensNeeded(requests, tokens) ?? 0) > tokens.remainingTokens)) break;
    fit = chosen.size;
  }
  return { count: fit };
}
/** The scopes actually sent: the selection in retry order (problems first, then tree order), cut to the chosen fraction. */
export function applyFraction(orderedSelection: readonly string[], fraction: RetryFraction, scopes: readonly Scope[] = [], remainingUsd?: number, avgCostPerScopeUsd?: number, requestsLeft?: number, tokens: TokenBudget = {}): string[] {
  if (fraction.mode === 'all') return [...orderedSelection];
  if (fraction.mode === 'first') return orderedSelection.slice(0, Math.max(0, Math.floor(fraction.count)));
  const fit = fitToBudget(orderedSelection, scopes, remainingUsd, avgCostPerScopeUsd, requestsLeft, tokens);
  return 'count' in fit ? orderedSelection.slice(0, fit.count) : [];
}

/**
 * The batch-retry request the workspace sends. Below-cap scopes are only ever sent while the operator's below-cap
 * toggle is on, and then with an explicit `includeBelowCap: true`; otherwise the request is refused here.
 */
export function buildRetryRequest(input: { orderedSelection: readonly string[]; fraction: RetryFraction; scopes: readonly Scope[]; showBelowCap: boolean; remainingUsd?: number; avgCostPerScopeUsd?: number; remainingRequests?: number; tokens?: TokenBudget }): { scopeIds: string[]; includeBelowCap: boolean } | { error: string } {
  const scopeIds = applyFraction(input.orderedSelection, input.fraction, input.scopes, input.remainingUsd, input.avgCostPerScopeUsd, input.remainingRequests, input.tokens);
  if (!scopeIds.length) return { error: 'Nothing to retry: the chosen fraction selects no scopes.' };
  const includeBelowCap = selectionIncludesBelowCap(input.scopes, new Set(scopeIds));
  if (includeBelowCap && !input.showBelowCap) return { error: 'Below-cap scopes are selected: turn on "Show below depth cap" to opt in explicitly.' };
  return { scopeIds, includeBelowCap };
}

/** Unselected ancestors of the selection: the parents a batch retry may re-reduce. */
export function affectedAncestors(scopes: readonly Scope[], scopeIds: readonly string[]): string[] {
  const parent = new Map(scopes.map(scope => [scope.scopeId, scope.parentScopeId]));
  const chosen = new Set(scopeIds); const result = new Set<string>();
  for (const scopeId of scopeIds) { let cursor = parent.get(scopeId); const seen = new Set<string>(); while (cursor && !seen.has(cursor)) { seen.add(cursor); if (!chosen.has(cursor)) result.add(cursor); cursor = parent.get(cursor); } }
  return [...result];
}

/** USD with enough precision for per-scope averages ($0.0013) and plain cents otherwise. */
export function usd(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: value !== 0 && Math.abs(value) < 0.01 ? 4 : 2 }).format(value);
}
export const count = (value: number): string => new Intl.NumberFormat('en-US').format(value);

export interface RetryEstimate { scopes: number; ancestors: number; avgCostPerScopeUsd?: number; estimatedUsd?: number; remainingUsd?: number; remainingRequests?: number; /** CLA-264: `tokensNeeded(scopes + ancestors)` (settled average plus in-flight reservations). */ estimatedTokens?: number; remainingTokens?: number; }
/** Why the pass would stop at the budget limit (requests, dollars and/or tokens), or undefined when it fits or is unknown. */
export function budgetWarning(estimate: RetryEstimate): string | undefined {
  const requests = estimate.scopes + estimate.ancestors;
  const overRequests = estimate.remainingRequests !== undefined && requests > estimate.remainingRequests;
  const overDollars = estimate.estimatedUsd !== undefined && estimate.remainingUsd !== undefined && estimate.estimatedUsd > estimate.remainingUsd + 1e-12;
  const overTokens = estimate.estimatedTokens !== undefined && estimate.remainingTokens !== undefined && estimate.estimatedTokens > estimate.remainingTokens;
  if (!overRequests && !overDollars && !overTokens) return undefined;
  const reasons = [...(overRequests ? [`up to ${count(requests)} requests but only ${count(estimate.remainingRequests!)} left`] : []), ...(overDollars ? [`est. ${usd(estimate.estimatedUsd!)} but only ${usd(estimate.remainingUsd!)} left`] : []), ...(overTokens ? [`est. ${count(Math.round(estimate.estimatedTokens!))} tokens but only ${count(estimate.remainingTokens!)} left`] : [])];
  return `This exceeds the remaining budget (${reasons.join('; ')}): the pass will stop at the budget limit. Run fewer scopes or fit to the remaining budget.`;
}
/** Estimated cost = (scopes + ancestors that may re-reduce) × this run's average cost per scope; tokens via `tokensNeeded` (CLA-264). */
export function retryEstimate(scopes: readonly Scope[], scopeIds: readonly string[], avgCostPerScopeUsd?: number, budget?: BudgetView, avgTokensPerScope?: number): RetryEstimate {
  const ancestors = affectedAncestors(scopes, scopeIds).length; const remainingUsd = remainingBudgetUsd(budget); const requestsLeft = remainingRequests(budget); const tokensLeft = remainingTokens(budget);
  return { scopes: scopeIds.length, ancestors, ...(avgCostPerScopeUsd !== undefined ? { avgCostPerScopeUsd, estimatedUsd: (scopeIds.length + ancestors) * avgCostPerScopeUsd } : {}), ...(remainingUsd !== undefined ? { remainingUsd } : {}), ...(requestsLeft !== undefined ? { remainingRequests: requestsLeft } : {}), ...(avgTokensPerScope !== undefined ? { estimatedTokens: tokensNeeded(scopeIds.length + ancestors, tokenBudgetOf(budget, avgTokensPerScope))!, ...(tokensLeft !== undefined ? { remainingTokens: tokensLeft } : {}) } : {}) };
}
/** "Retry 12 scopes (+ up to 3 parents re-reduced) · est. $0.02 (avg $0.0013/scope this run) · remaining budget $4.67". */
export function confirmText(estimate: RetryEstimate): string {
  const head = `Retry ${count(estimate.scopes)} scope${estimate.scopes === 1 ? '' : 's'}${estimate.ancestors ? ` (+ up to ${count(estimate.ancestors)} parent${estimate.ancestors === 1 ? '' : 's'} re-reduced)` : ''}`;
  const cost = estimate.estimatedUsd !== undefined && estimate.avgCostPerScopeUsd !== undefined ? ` · est. ${usd(estimate.estimatedUsd)} (avg ${usd(estimate.avgCostPerScopeUsd)}/scope this run)` : ' · cost estimate unavailable (no cost reported yet)';
  const tokens = estimate.estimatedTokens !== undefined ? ` · est. ${count(Math.round(estimate.estimatedTokens))} tokens${estimate.remainingTokens !== undefined ? ` of ${count(estimate.remainingTokens)} left` : ''}` : '';
  return `${head}${cost}${estimate.remainingUsd !== undefined ? ` · remaining budget ${usd(estimate.remainingUsd)}` : ''}${estimate.remainingRequests !== undefined ? ` · ${count(estimate.remainingRequests)} request${estimate.remainingRequests === 1 ? '' : 's'} left` : ''}${tokens}`;
}
/**
 * Refresh button text (CLA-264): refresh is one batch pass, so ancestors of the stale scopes may re-reduce too and the
 * request ceiling is stale scopes + those ancestors. `title` adds the cost estimate when this run has one.
 */
export function refreshLabel(scopes: readonly Scope[], staleIds: readonly string[], avgCostPerScopeUsd?: number): { label: string; title: string } {
  const ancestors = affectedAncestors(scopes, staleIds).length; const ceiling = staleIds.length + ancestors;
  const label = `Refresh ${count(staleIds.length)} stale scope${staleIds.length === 1 ? '' : 's'} · up to ${count(ceiling)} request${ceiling === 1 ? '' : 's'}`;
  const parents = ancestors ? ` (+ up to ${count(ancestors)} parent${ancestors === 1 ? '' : 's'} re-reduced once)` : '';
  return { label, title: `One pass over ${count(staleIds.length)} stale scope${staleIds.length === 1 ? '' : 's'}${parents}${avgCostPerScopeUsd !== undefined ? ` · est. up to ${usd(ceiling * avgCostPerScopeUsd)}` : ''}` };
}
