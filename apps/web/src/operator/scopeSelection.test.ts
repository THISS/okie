import { describe, expect, it } from 'vitest';
import type { OperatorScope } from './api';
import { affectedAncestors, applyFraction, budgetWarning, buildRetryRequest, confirmText, defaultScope, filterScopes, fitToBudget, levelTag, nameHints, orderScopes, remainingBudgetUsd, remainingRequests, retryEstimate, selectable, selectByLevel, selectByState, selectionIncludesBelowCap, selectSubtree, selectVisible, usd } from './scopeSelection';

const s = (scopeId: string, kind: string, depth: number, state: OperatorScope['state'], parentScopeId?: string, stale = false): OperatorScope => ({ scopeId, name: scopeId, kind, depth, state, ...(parentScopeId ? { parentScopeId } : {}), ...(stale ? { stale } : {}) });
const scopes: OperatorScope[] = [
  s('sys', 'softwareSystem', 0, 'accepted'),
  s('web', 'container', 1, 'accepted', 'sys', true),
  s('api', 'container', 1, 'accepted', 'sys'),
  s('b-comp', 'component', 2, 'failed', 'web'),
  s('a-comp', 'component', 2, 'not run', 'web'),
  s('c-comp', 'component', 2, 'accepted', 'api'),
  s('fn1', 'code', 3, 'below cap', 'b-comp'),
  s('fn2', 'code', 3, 'accepted', 'b-comp'),
  s('busy', 'component', 2, 'running', 'api'),
];

describe('scope ordering and filters', () => {
  it('orders problems first (failed, stale, not run), then level, depth and name', () => {
    expect(orderScopes(scopes).map(scope => scope.scopeId)).toEqual(['b-comp', 'web', 'a-comp', 'sys', 'api', 'busy', 'c-comp', 'fn1', 'fn2']);
  });
  it('filters by visible state label and hides below-cap scopes until opted in', () => {
    expect(filterScopes(scopes, 'all', false).map(scope => scope.scopeId)).not.toContain('fn1');
    expect(filterScopes(scopes, 'all', true).map(scope => scope.scopeId)).toContain('fn1');
    expect(filterScopes(scopes, 'failed', false).map(scope => scope.scopeId)).toEqual(['b-comp']);
    expect(filterScopes(scopes, 'stale', false).map(scope => scope.scopeId)).toEqual(['web']);
    expect(filterScopes(scopes, 'not run', false).map(scope => scope.scopeId)).toEqual(['a-comp']);
    expect(filterScopes(scopes, 'accepted', false).map(scope => scope.scopeId)).toEqual(['sys', 'api', 'c-comp', 'fn2']);
    expect(levelTag({ kind: 'softwareSystem' })).toBe('system'); expect(levelTag({})).toBe('');
  });
});

describe('selection helpers', () => {
  it('selects visible, by state, by level and by subtree; running scopes are never selectable', () => {
    expect(selectable({ state: 'running' }, true)).toBe(false);
    expect(selectVisible(filterScopes(scopes, 'all', false), false)).toEqual(['sys', 'web', 'api', 'b-comp', 'a-comp', 'c-comp', 'fn2']);
    expect(selectByState(scopes, 'failed', false)).toEqual(['b-comp']);
    expect(selectByState(scopes, 'not run', false)).toEqual(['a-comp']);
    expect(selectByState(scopes, 'stale', false)).toEqual(['web']);
    expect(selectByLevel(scopes, 'container', false)).toEqual(['web', 'api']);
    expect(selectByLevel(scopes, 'component', false)).toEqual(['b-comp', 'a-comp', 'c-comp']);
    expect(selectSubtree(scopes, 'web', false)).toEqual(['web', 'b-comp', 'a-comp', 'fn2']);
  });
  it('below-cap scopes need the explicit opt-in and flag includeBelowCap', () => {
    expect(selectByLevel(scopes, 'code', false)).toEqual(['fn2']);
    expect(selectByLevel(scopes, 'code', true)).toEqual(['fn1', 'fn2']);
    expect(selectSubtree(scopes, 'b-comp', true)).toEqual(['b-comp', 'fn1', 'fn2']);
    expect(selectionIncludesBelowCap(scopes, new Set(['b-comp', 'fn2']))).toBe(false);
    expect(selectionIncludesBelowCap(scopes, new Set(['fn1']))).toBe(true);
  });
});

describe('fraction and estimates', () => {
  const ordered = ['a', 'b', 'c', 'd', 'e'];
  it('runs all, the first N, or what fits the remaining budget', () => {
    expect(applyFraction(ordered, { mode: 'all' })).toEqual(ordered);
    expect(applyFraction(ordered, { mode: 'first', count: 2 })).toEqual(['a', 'b']);
    expect(applyFraction(ordered, { mode: 'first', count: 9 })).toEqual(ordered);
    expect(fitToBudget(ordered, [], 0.01, 0.003)).toEqual({ count: 3 });
    expect(fitToBudget(['a', 'b'], [], 4.67, 0.0013)).toEqual({ count: 2 }); // capped by the selection
    expect(fitToBudget(ordered, [], 0.006, 0.002)).toEqual({ count: 3 }); // floating-point safe at exact multiples
    expect(applyFraction(ordered, { mode: 'fit' }, [], 0.01, 0.003)).toEqual(['a', 'b', 'c']);
    expect(fitToBudget(ordered, [], 1, undefined)).toHaveProperty('unavailable');
    expect(fitToBudget(ordered, [], undefined, 0.01)).toHaveProperty('unavailable');
    expect(applyFraction(ordered, { mode: 'fit' }, [], undefined, 0.01)).toEqual([]);
  });
  it('fits (n + distinct parents the first n may re-reduce) × avg within min(run, global) remaining', () => {
    const selection = ['b-comp', 'a-comp', 'c-comp']; // totals with parents: 3 (web, sys), 4, 6 (api)
    expect(fitToBudget(selection, scopes, 4, 1)).toEqual({ count: 2 });
    expect(fitToBudget(selection, scopes, 3.5, 1)).toEqual({ count: 1 });
    expect(fitToBudget(selection, scopes, 2.9, 1)).toEqual({ count: 0 });
    expect(fitToBudget(selection, scopes, 6, 1)).toEqual({ count: 3 });
    expect(remainingBudgetUsd({ maxDollars: 5, spentDollars: 0.33, globalRemainingDollars: 1 })).toBe(1);
    expect(remainingBudgetUsd({ maxDollars: 5, spentDollars: 4.5, globalRemainingDollars: 1 })).toBeCloseTo(0.5);
    expect(remainingBudgetUsd({ maxDollars: 5, spentDollars: 0.33 })).toBeCloseTo(4.67);
    expect(remainingBudgetUsd({ maxDollars: 1, spentDollars: 2 })).toBe(0);
  });
  it('builds the exact request body: first-N slices, below-cap only with the toggle and then with includeBelowCap', () => {
    const orderedSelection = ['b-comp', 'a-comp', 'fn1'];
    expect(buildRetryRequest({ orderedSelection, fraction: { mode: 'first', count: 2 }, scopes, showBelowCap: true })).toEqual({ scopeIds: ['b-comp', 'a-comp'], includeBelowCap: false });
    expect(buildRetryRequest({ orderedSelection, fraction: { mode: 'all' }, scopes, showBelowCap: true })).toEqual({ scopeIds: orderedSelection, includeBelowCap: true });
    expect(buildRetryRequest({ orderedSelection, fraction: { mode: 'all' }, scopes, showBelowCap: false })).toHaveProperty('error');
    expect(buildRetryRequest({ orderedSelection: ['b-comp', 'a-comp'], fraction: { mode: 'fit' }, scopes, showBelowCap: false, remainingUsd: 3, avgCostPerScopeUsd: 1 })).toEqual({ scopeIds: ['b-comp'], includeBelowCap: false });
    expect(buildRetryRequest({ orderedSelection: ['b-comp'], fraction: { mode: 'fit' }, scopes, showBelowCap: false })).toHaveProperty('error');
  });
  it('flags an estimate above the remaining budget', () => {
    expect(budgetWarning(retryEstimate(scopes, ['b-comp', 'a-comp'], 1, { maxDollars: 3, spentDollars: 0 }))).toContain('est. $4.00 but only $3.00 left');
    expect(budgetWarning(retryEstimate(scopes, ['b-comp', 'a-comp'], 1, { maxDollars: 4, spentDollars: 0 }))).toBeUndefined();
    expect(budgetWarning(retryEstimate(scopes, ['b-comp'], undefined, { maxDollars: 1, spentDollars: 0 }))).toBeUndefined();
  });
  it('respects the request cap: fit, warning, confirm line and 0-left (QA: cheap runs hit the request cap first)', () => {
    const selection = ['b-comp', 'a-comp', 'c-comp']; // requests with parents: 3 (web, sys), 4, 6 (api)
    // Plenty of dollars, but only 4 requests left: n + parents ≤ 4 → 2.
    expect(fitToBudget(selection, scopes, 100, 0.001, 4)).toEqual({ count: 2 });
    expect(fitToBudget(selection, scopes, 100, 0.001, 3)).toEqual({ count: 1 });
    expect(fitToBudget(selection, scopes, 100, 0.001, 2)).toEqual({ count: 0 });
    expect(fitToBudget(selection, scopes, 3, 1, 100)).toEqual({ count: 1 }); // the dollar fit still holds
    expect(fitToBudget(selection, scopes, 100, 0.001, 0)).toEqual({ unavailable: 'No requests left in the run budget (request cap reached).' });
    expect(buildRetryRequest({ orderedSelection: selection, fraction: { mode: 'fit' }, scopes, showBelowCap: false, remainingUsd: 100, avgCostPerScopeUsd: 0.001, remainingRequests: 4 })).toEqual({ scopeIds: ['b-comp', 'a-comp'], includeBelowCap: false });
    expect(remainingRequests({ maxDollars: 5, spentDollars: 0, remainingRequests: 12 })).toBe(12);
    expect(remainingRequests({ maxDollars: 5, spentDollars: 0, remainingRequests: 12, globalRemainingRequests: 3 })).toBe(3);
    expect(remainingRequests({ maxDollars: 5, spentDollars: 0 })).toBeUndefined();
    const cheap = retryEstimate(scopes, selection, 0.001, { maxDollars: 5, spentDollars: 0, remainingRequests: 4 });
    expect(cheap.remainingRequests).toBe(4);
    expect(budgetWarning(cheap)).toBe('This exceeds the remaining budget (up to 6 requests but only 4 left): the pass will stop at the budget limit. Run fewer scopes or fit to the remaining budget.');
    expect(confirmText(cheap)).toContain('· remaining budget $5.00 · 4 requests left');
    expect(budgetWarning(retryEstimate(scopes, ['b-comp'], 0.001, { maxDollars: 5, spentDollars: 0, remainingRequests: 3 }))).toBeUndefined();
  });
  it('defaults the inspector to the first visible scope, never a hidden below-cap one', () => {
    const capped = [s('deep', 'code', 3, 'below cap', 'sys'), s('sys', 'softwareSystem', 0, 'accepted')];
    expect(defaultScope(capped, false)?.scopeId).toBe('sys');
    expect(defaultScope([s('deep', 'code', 3, 'below cap')], false)).toBeUndefined();
    expect(defaultScope(capped, true)?.scopeId).toBe('sys');
  });
  it('disambiguates duplicate scope names with the parent name, then ancestors, never a raw scope id', () => {
    const named = (scopeId: string, name: string, parentScopeId?: string): OperatorScope => ({ ...s(scopeId, 'code', 3, 'accepted', parentScopeId), name });
    const hints = nameHints([named('p1', 'web'), named('p2', 'api'), named('x1', 'index.ts', 'p1'), named('x2', 'index.ts', 'p2'), named('u', 'unique.ts', 'p1')]);
    expect(hints.get('x1')).toBe('in web'); expect(hints.get('x2')).toBe('in api'); expect(hints.has('u')).toBe(false);
    // Parents collide too (two src/geometry.rs): climb to the grandparent; never a raw scope id.
    const clash = nameHints([named('engine', 'atlas-engine'), named('gpu', 'atlas-gpu'), named('p1', 'src/geometry.rs', 'engine'), named('p2', 'src/geometry.rs', 'gpu'), named('x1', 'area', 'p1'), named('x2', 'area', 'p2')]);
    expect(clash.get('x1')).toBe('in src/geometry.rs · atlas-engine'); expect(clash.get('x2')).toBe('in src/geometry.rs · atlas-gpu');
    expect(clash.get('p1')).toBe('in atlas-engine');
    // Indistinguishable ancestry falls back to an ordinal, not an id.
    const twins = nameHints([named('root', 'sys'), named('t1', 'a.ts', 'root'), named('t2', 'a.ts', 'root'), named('o1', 'x'), named('o2', 'x')]);
    expect(twins.get('t1')).toBe('in sys · 1 of 2'); expect(twins.get('t2')).toBe('in sys · 2 of 2');
    expect(twins.get('o1')).toBe('1 of 2');
    for (const hint of [...clash.values(), ...twins.values()]) expect(hint).not.toMatch(/\b(x1|x2|p1|p2|t1|t2|o1|o2)\b/);
  });
  it('estimates (scopes + ancestors that may re-reduce) × the run average and renders the confirm line', () => {
    expect(affectedAncestors(scopes, ['b-comp', 'a-comp']).sort()).toEqual(['sys', 'web']);
    expect(affectedAncestors(scopes, ['web', 'b-comp'])).toEqual(['sys']); // a selected ancestor is not counted twice
    const estimate = retryEstimate(scopes, ['b-comp', 'a-comp', 'c-comp'], 0.0013, { maxDollars: 5, spentDollars: 0.33 });
    expect(estimate).toMatchObject({ scopes: 3, ancestors: 3, avgCostPerScopeUsd: 0.0013 });
    expect(estimate.estimatedUsd).toBeCloseTo(0.0078);
    expect(confirmText(estimate)).toBe('Retry 3 scopes (+ up to 3 parents re-reduced) · est. $0.0078 (avg $0.0013/scope this run) · remaining budget $4.67');
    expect(confirmText(retryEstimate(scopes, ['sys']))).toBe('Retry 1 scope · cost estimate unavailable (no cost reported yet)');
    expect(usd(0.33)).toBe('$0.33'); expect(usd(0.0013)).toBe('$0.0013'); expect(usd(0)).toBe('$0.00');
  });
});
