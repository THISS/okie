import type { OperatorRunBudget, OperatorScope } from './api';
import { scopeStateLabel } from './reviewState';

/**
 * Pure scope-list ordering, filtering, selection and batch-retry estimates (CLA-258). The workspace keeps
 * only the state; everything here is deterministic and unit-tested.
 */
type Scope = Pick<OperatorScope, 'scopeId' | 'name' | 'state' | 'stale' | 'kind' | 'depth' | 'parentScopeId'>;

export type ScopeLevel = 'container' | 'component' | 'code';
export type ScopeFilter = 'all' | 'failed' | 'stale' | 'not run' | 'accepted';
export const SCOPE_FILTERS: ReadonlyArray<{ value: ScopeFilter; label: string }> = [{ value: 'all', label: 'All' }, { value: 'failed', label: 'Failed' }, { value: 'stale', label: 'Stale' }, { value: 'not run', label: 'Not run' }, { value: 'accepted', label: 'Accepted' }];
/** Collapsed list length; "Show all" reveals the rest (the list stays usable with ~4k scopes). */
export const SCOPE_LIST_PREVIEW = 50;

const LEVEL: Record<string, number> = { softwareSystem: 0, externalSystem: 0, container: 1, component: 2, code: 3 };
const LEVEL_TAG: Record<string, string> = { softwareSystem: 'system', externalSystem: 'external', container: 'container', component: 'component', code: 'code' };
export function levelOf(scope: Pick<Scope, 'kind'>): number { return scope.kind !== undefined ? LEVEL[scope.kind] ?? 4 : 4; }
/** Short per-row level tag ("container", "code"…); empty when the server did not report a kind. */
export function levelTag(scope: Pick<Scope, 'kind'>): string { return scope.kind ? LEVEL_TAG[scope.kind] ?? scope.kind : ''; }
export const isBelowCap = (scope: Pick<Scope, 'state'>): boolean => scope.state === 'below cap';

/** Problem states first (failed, stale, not run), then by level (system → container → component → code), depth, name. */
export function orderScopes<T extends Scope>(scopes: readonly T[]): T[] {
  const problem = (scope: Scope) => { const label = scopeStateLabel(scope); return label === 'failed' ? 0 : label === 'stale' ? 1 : label === 'not run' ? 2 : 3; };
  return [...scopes].sort((left, right) => problem(left) - problem(right) || levelOf(left) - levelOf(right) || (left.depth ?? 0) - (right.depth ?? 0) || left.name.localeCompare(right.name) || (left.scopeId < right.scopeId ? -1 : left.scopeId > right.scopeId ? 1 : 0));
}

/** Below-cap scopes are hidden unless the operator opts in; the filter matches the visible state label. */
export function filterScopes<T extends Scope>(scopes: readonly T[], filter: ScopeFilter, showBelowCap: boolean): T[] {
  return scopes.filter(scope => (showBelowCap || !isBelowCap(scope)) && (filter === 'all' || scopeStateLabel(scope) === filter));
}

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
type BudgetView = Pick<OperatorRunBudget, 'maxDollars' | 'spentDollars' | 'globalRemainingDollars' | 'remainingRequests' | 'globalRemainingRequests'>;
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
 * Largest n such that the first n plus the distinct parents they may re-reduce fit both the request cap
 * (n + parents ≤ remaining requests) and the dollars ((n + parents) × avg ≤ remaining $), over the selection in
 * list order. The total is non-decreasing in n, so the first overshoot ends the search.
 */
export function fitToBudget(orderedSelection: readonly string[], scopes: readonly Scope[], remainingUsd: number | undefined, avgCostPerScopeUsd: number | undefined, requestsLeft?: number): { count: number } | { unavailable: string } {
  if (requestsLeft !== undefined && requestsLeft <= 0) return { unavailable: 'No requests left in the run budget (request cap reached).' };
  if (avgCostPerScopeUsd === undefined || !(avgCostPerScopeUsd > 0)) return { unavailable: 'No average cost yet: no attempt in this run has reported a cost.' };
  if (remainingUsd === undefined) return { unavailable: 'No run budget information is available.' };
  const parent = new Map(scopes.map(scope => [scope.scopeId, scope.parentScopeId]));
  const chosen = new Set<string>(); const ancestors = new Set<string>(); let fit = 0;
  for (const scopeId of orderedSelection) {
    chosen.add(scopeId); ancestors.delete(scopeId);
    let cursor = parent.get(scopeId); const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) { seen.add(cursor); if (!chosen.has(cursor)) ancestors.add(cursor); cursor = parent.get(cursor); }
    const requests = chosen.size + ancestors.size;
    if (requests * avgCostPerScopeUsd > remainingUsd + 1e-12 || (requestsLeft !== undefined && requests > requestsLeft)) break;
    fit = chosen.size;
  }
  return { count: fit };
}
/** The scopes actually sent: the selection in list order, cut to the chosen fraction. */
export function applyFraction(orderedSelection: readonly string[], fraction: RetryFraction, scopes: readonly Scope[] = [], remainingUsd?: number, avgCostPerScopeUsd?: number, requestsLeft?: number): string[] {
  if (fraction.mode === 'all') return [...orderedSelection];
  if (fraction.mode === 'first') return orderedSelection.slice(0, Math.max(0, Math.floor(fraction.count)));
  const fit = fitToBudget(orderedSelection, scopes, remainingUsd, avgCostPerScopeUsd, requestsLeft);
  return 'count' in fit ? orderedSelection.slice(0, fit.count) : [];
}

/**
 * The batch-retry request the workspace sends. Below-cap scopes are only ever sent while the operator's below-cap
 * toggle is on, and then with an explicit `includeBelowCap: true`; otherwise the request is refused here.
 */
export function buildRetryRequest(input: { orderedSelection: readonly string[]; fraction: RetryFraction; scopes: readonly Scope[]; showBelowCap: boolean; remainingUsd?: number; avgCostPerScopeUsd?: number; remainingRequests?: number }): { scopeIds: string[]; includeBelowCap: boolean } | { error: string } {
  const scopeIds = applyFraction(input.orderedSelection, input.fraction, input.scopes, input.remainingUsd, input.avgCostPerScopeUsd, input.remainingRequests);
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

export interface RetryEstimate { scopes: number; ancestors: number; avgCostPerScopeUsd?: number; estimatedUsd?: number; remainingUsd?: number; remainingRequests?: number; }
/** Why the pass would stop at the budget limit (requests and/or dollars), or undefined when it fits or is unknown. */
export function budgetWarning(estimate: RetryEstimate): string | undefined {
  const requests = estimate.scopes + estimate.ancestors;
  const overRequests = estimate.remainingRequests !== undefined && requests > estimate.remainingRequests;
  const overDollars = estimate.estimatedUsd !== undefined && estimate.remainingUsd !== undefined && estimate.estimatedUsd > estimate.remainingUsd + 1e-12;
  if (!overRequests && !overDollars) return undefined;
  const reasons = [...(overRequests ? [`up to ${count(requests)} requests but only ${count(estimate.remainingRequests!)} left`] : []), ...(overDollars ? [`est. ${usd(estimate.estimatedUsd!)} but only ${usd(estimate.remainingUsd!)} left`] : [])];
  return `This exceeds the remaining budget (${reasons.join('; ')}): the pass will stop at the budget limit. Run fewer scopes or fit to the remaining budget.`;
}
/** Estimated cost = (scopes + ancestors that may re-reduce) × this run's average cost per scope. */
export function retryEstimate(scopes: readonly Scope[], scopeIds: readonly string[], avgCostPerScopeUsd?: number, budget?: BudgetView): RetryEstimate {
  const ancestors = affectedAncestors(scopes, scopeIds).length; const remainingUsd = remainingBudgetUsd(budget); const requestsLeft = remainingRequests(budget);
  return { scopes: scopeIds.length, ancestors, ...(avgCostPerScopeUsd !== undefined ? { avgCostPerScopeUsd, estimatedUsd: (scopeIds.length + ancestors) * avgCostPerScopeUsd } : {}), ...(remainingUsd !== undefined ? { remainingUsd } : {}), ...(requestsLeft !== undefined ? { remainingRequests: requestsLeft } : {}) };
}
/** "Retry 12 scopes (+ up to 3 parents re-reduced) · est. $0.02 (avg $0.0013/scope this run) · remaining budget $4.67". */
export function confirmText(estimate: RetryEstimate): string {
  const head = `Retry ${count(estimate.scopes)} scope${estimate.scopes === 1 ? '' : 's'}${estimate.ancestors ? ` (+ up to ${count(estimate.ancestors)} parent${estimate.ancestors === 1 ? '' : 's'} re-reduced)` : ''}`;
  const cost = estimate.estimatedUsd !== undefined && estimate.avgCostPerScopeUsd !== undefined ? ` · est. ${usd(estimate.estimatedUsd)} (avg ${usd(estimate.avgCostPerScopeUsd)}/scope this run)` : ' · cost estimate unavailable (no cost reported yet)';
  return `${head}${cost}${estimate.remainingUsd !== undefined ? ` · remaining budget ${usd(estimate.remainingUsd)}` : ''}${estimate.remainingRequests !== undefined ? ` · ${count(estimate.remainingRequests)} request${estimate.remainingRequests === 1 ? '' : 's'} left` : ''}`;
}

/** The inspector's default scope: the first visible one in list order (never a hidden below-cap scope). */
export function defaultScope<T extends Scope>(scopes: readonly T[], showBelowCap: boolean): T | undefined { return orderScopes(filterScopes(scopes, 'all', showBelowCap))[0]; }
/**
 * Disambiguating hints for rows whose names collide (e.g. two "geometry.rs"): the parent's name, then more ancestors
 * ("in src/geometry.rs · atlas-engine") until the hints differ. A raw scope id is never shown: when the ancestry
 * cannot tell them apart, the hint gets an ordinal ("… · 2 of 2"). Scopes with unique names get no hint.
 */
export function nameHints(scopes: readonly Scope[]): Map<string, string> {
  const byId = new Map(scopes.map(scope => [scope.scopeId, scope]));
  const ancestry = (scope: Scope): string[] => { const names: string[] = []; const seen = new Set([scope.scopeId]); let cursor = scope.parentScopeId; while (cursor && !seen.has(cursor)) { seen.add(cursor); const parent = byId.get(cursor); if (!parent) break; names.push(parent.name); cursor = parent.parentScopeId; } return names; };
  const byName = new Map<string, Scope[]>(); for (const scope of scopes) byName.set(scope.name, [...(byName.get(scope.name) ?? []), scope]);
  const hints = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const chains = group.map(ancestry); const deepest = Math.max(0, ...chains.map(chain => chain.length));
    let labels = chains.map(() => '');
    for (let length = 1; length <= deepest; length += 1) { labels = chains.map(chain => chain.slice(0, length).join(' · ')); if (new Set(labels).size === group.length) break; }
    const unique = new Set(labels).size === group.length;
    group.forEach((scope, index) => {
      const ordinal = unique ? '' : `${index + 1} of ${group.length}`;
      hints.set(scope.scopeId, labels[index] ? `in ${labels[index]}${ordinal ? ` · ${ordinal}` : ''}` : ordinal);
    });
  }
  return hints;
}
