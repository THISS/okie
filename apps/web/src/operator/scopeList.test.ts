import { describe, expect, it } from 'vitest';
import type { OperatorScope } from './api';
import { activeToggles, AUTO_EXPAND_LIMIT, collapseAll, focusSearchOnShortcut, initialScope, isSearchShortcut, matchesQuery, nextOpenScope, orderTree, retryOrder, scopeLabel, scopeListView, scopeMetrics, scopeVisibility, searchEscapeAction, withToggles, type ExpansionState, type ScopeListOptions } from './scopeList';
import { applyFraction, fitToBudget } from './scopeSelection';

const s = (scopeId: string, kind: string, state: OperatorScope['state'], parentScopeId?: string, extra: Partial<OperatorScope> = {}): OperatorScope => ({ scopeId, name: scopeId, kind, state, ...(parentScopeId ? { parentScopeId } : {}), ...extra });
const attempt = (updatedAt: number, cost?: number, tokens?: number) => ({ attemptId: `a${updatedAt}`, scopeId: 'x', kind: 'enrichment' as const, state: 'accepted' as const, updatedAt, usage: { ...(cost !== undefined ? { measuredCostUsd: cost } : {}), ...(tokens !== undefined ? { inputTokens: tokens, outputTokens: 0 } : {}) } });
const scopes: OperatorScope[] = [
  s('fn1', 'code', 'below cap', 'b-comp'),
  s('busy', 'component', 'running', 'api'),
  s('b-comp', 'component', 'failed', 'web', { name: 'src/b.ts', path: 'apps/web/src/b.ts', attempts: [attempt(30, 0.02, 900)] }),
  s('sys', 'softwareSystem', 'accepted', undefined, { name: 'okie' }),
  s('web', 'container', 'accepted', 'sys', { stale: true, name: '@okie/web', path: 'apps/web' }),
  s('api', 'container', 'accepted', 'sys', { name: '@okie/server', path: 'apps/server' }),
  s('a-comp', 'component', 'not run', 'web', { name: 'src/a.ts', path: 'apps/web/src/a.ts' }),
  s('c-comp', 'component', 'accepted', 'api', { name: 'src/c.ts', path: 'apps/server/src/c.ts', attempts: [attempt(50, 0.05, 100), attempt(10, 0.01)] }),
  s('fn2', 'code', 'accepted', 'b-comp', { name: 'render' }),
  s('ext', 'externalSystem', 'accepted', undefined, { name: '@anthropic-ai/sdk' }),
];
const all: ScopeListOptions = { filter: 'all', query: '', showBelowCap: false };
const ids = (items: readonly { scopeId: string }[]) => items.map(item => item.scopeId);
const rowIds = (options: ScopeListOptions, expanded?: Map<string, boolean>) => scopeListView(scopes, options, expanded).rows.map(row => `${'-'.repeat(row.depth)}${row.scope.scopeId}${row.hasChildren ? (row.expanded ? 'v' : '>') : ''}`);

describe('scope tree order and sorting', () => {
  it('orders the whole tree parent-first; hierarchy sorts siblings by level then name', () => {
    // The system precedes external systems at the same level; "@okie/server" sorts before "@okie/web".
    expect(ids(orderTree(scopes))).toEqual(['sys', 'api', 'busy', 'c-comp', 'web', 'a-comp', 'b-comp', 'fn1', 'fn2', 'ext']);
  });
  it('sorts siblings by name, state, cost/tokens and last updated without changing the tree shape', () => {
    // Roots stay by level (system before the external system) whatever the sort; siblings below follow it.
    expect(ids(orderTree(scopes, 'name'))).toEqual(['sys', 'api', 'busy', 'c-comp', 'web', 'a-comp', 'b-comp', 'fn1', 'fn2', 'ext']);
    expect(ids(orderTree(scopes, 'state'))).toEqual(['sys', 'web', 'b-comp', 'fn2', 'fn1', 'a-comp', 'api', 'busy', 'c-comp', 'ext']); // failed, stale, not run first; below cap last
    expect(ids(orderTree(scopes, 'cost'))).toEqual(['sys', 'api', 'c-comp', 'busy', 'web', 'b-comp', 'fn1', 'fn2', 'a-comp', 'ext']);
    expect(ids(orderTree(scopes, 'updated')).slice(0, 4)).toEqual(['sys', 'api', 'c-comp', 'busy']);
  });
  it('sums cost (measured, else estimated), tokens and the latest update per scope', () => {
    const metrics = scopeMetrics(scopes.find(item => item.scopeId === 'c-comp')!);
    expect(metrics.costUsd).toBeCloseTo(0.06); expect(metrics).toMatchObject({ tokens: 100, updatedAt: 50 });
    expect(scopeMetrics({ attempts: [{ ...attempt(5), usage: { estimatedCostUsd: 0.5 } }] })).toEqual({ costUsd: 0.5, updatedAt: 5 });
    expect(scopeMetrics({})).toEqual({});
    // The server summary wins (enriched revisions carry no attempts), mapped to the same shape.
    expect(scopeMetrics({ metrics: { costUsd: 0.2, totalTokens: 537, updatedAt: 9 }, attempts: [attempt(99, 5, 5)] })).toEqual({ costUsd: 0.2, tokens: 537, updatedAt: 9 });
    const enriched = [s('sys', 'softwareSystem', 'accepted'), s('cheap', 'component', 'accepted', 'sys', { metrics: { costUsd: 0.001, updatedAt: 5 } }), s('dear', 'component', 'accepted', 'sys', { metrics: { costUsd: 0.3, updatedAt: 1 } }), s('none', 'component', 'accepted', 'sys')];
    expect(ids(orderTree(enriched, 'cost'))).toEqual(['sys', 'dear', 'cheap', 'none']);
    expect(ids(orderTree(enriched, 'updated'))).toEqual(['sys', 'cheap', 'dear', 'none']);
  });
  it('treats scopes whose parent is missing, or in a cycle, as roots so every scope appears once', () => {
    const cyclic = [s('x', 'component', 'accepted', 'y'), s('y', 'component', 'accepted', 'x'), s('orphan', 'component', 'accepted', 'gone')];
    expect(ids(orderTree(cyclic)).sort()).toEqual(['orphan', 'x', 'y']);
  });
});

describe('scope list view', () => {
  it('renders roots expanded and collapsed children not at all; below-cap scopes are out of the universe until opted in', () => {
    expect(rowIds(all)).toEqual(['sysv', '-api>', '-web>', 'ext']);
    expect(scopeListView(scopes, all).universe).toBe(9);
    expect(rowIds(all, new Map([['web', true], ['b-comp', true]]))).toEqual(['sysv', '-api>', '-webv', '--a-comp', '--b-compv', '---fn2', 'ext']);
    expect(rowIds({ ...all, showBelowCap: true }, new Map([['web', true], ['b-comp', true]]))).toContain('---fn1');
    const counts = scopeListView(scopes, all).rows.find(row => row.scope.scopeId === 'web')!;
    expect(counts).toMatchObject({ descendants: 3, matchesBelow: 3 }); // a-comp, b-comp, fn2 (fn1 is below cap)
  });
  it('search matches name, path and id (all terms), and shows matches under their ancestors as context', () => {
    expect(matchesQuery({ scopeId: 'component:x', name: 'src/b.ts', path: 'apps/web/src/b.ts' }, ['apps/web', 'b.ts'])).toBe(true);
    expect(matchesQuery({ scopeId: 'component:x', name: 'src/b.ts' }, ['component:x'])).toBe(true);
    expect(matchesQuery({ scopeId: 'x', name: 'src/b.ts' }, ['b.ts', 'nope'])).toBe(false);
    const view = scopeListView(scopes, { ...all, query: 'RENDER' });
    expect(ids(view.matches)).toEqual(['fn2']);
    expect(view.rows.map(row => [row.scope.scopeId, row.match])).toEqual([['sys', false], ['web', false], ['b-comp', false], ['fn2', true]]);
    expect(view.autoExpanded).toBe(true);
    const byPath = scopeListView(scopes, { ...all, query: 'apps/server/src' });
    expect(ids(byPath.matches)).toEqual(['c-comp']);
  });
  it('combines search with the state filter, and counts matches against the visible universe', () => {
    const view = scopeListView(scopes, { ...all, filter: 'failed', query: 'src' });
    expect(ids(view.matches)).toEqual(['b-comp']); expect(view.universe).toBe(9); expect(view.filtering).toBe(true);
    expect(ids(scopeListView(scopes, { ...all, filter: 'stale' }).matches)).toEqual(['web']);
    expect(ids(scopeListView(scopes, { ...all, filter: 'not run' }).matches)).toEqual(['a-comp']);
    expect(ids(scopeListView(scopes, { ...all, filter: 'accepted' }).matches)).toEqual(['sys', 'api', 'c-comp', 'fn2', 'ext']);
    expect(scopeListView(scopes, { ...all, query: 'nothing-matches' }).rows).toEqual([]);
  });
  it('an explicit collapse wins over auto-expansion; above the limit nodes stay collapsed with match counts', () => {
    expect(rowIds({ ...all, query: 'render' }, new Map([['web', false]]))).toEqual(['sysv', '-web>']);
    const many: OperatorScope[] = [s('root', 'softwareSystem', 'accepted'), s('box', 'container', 'accepted', 'root'), ...Array.from({ length: AUTO_EXPAND_LIMIT + 1 }, (_, index) => s(`leaf${index}`, 'component', 'failed', 'box'))];
    const view = scopeListView(many, { ...all, filter: 'failed' });
    expect(view.autoExpanded).toBe(false); expect(view.matches).toHaveLength(AUTO_EXPAND_LIMIT + 1);
    expect(view.rows.map(row => row.scope.scopeId)).toEqual(['root', 'box']); // bounded render: leaves wait for an expand
    expect(view.rows[1]).toMatchObject({ expanded: false, matchesBelow: AUTO_EXPAND_LIMIT + 1 });
  });
  it('collapse all keeps roots open and collapses every other parent', () => {
    expect([...collapseAll(scopes).entries()].sort()).toEqual([['api', false], ['b-comp', false], ['web', false]]);
  });
  it('4,048 scopes build the default view quickly and render only the expanded top', () => {
    const big: OperatorScope[] = [s('sys', 'softwareSystem', 'accepted')];
    for (let c = 0; c < 10; c += 1) { big.push(s(`c${c}`, 'container', 'accepted', 'sys')); for (let m = 0; m < 24; m += 1) big.push(s(`c${c}m${m}`, 'component', 'accepted', `c${c}`)); }
    for (let f = 0; big.length < 4048; f += 1) big.push(s(`fn${f}`, 'code', 'below cap', `c${f % 10}m${f % 24}`));
    const started = performance.now();
    const view = scopeListView(big, { ...all, showBelowCap: true, query: 'f1' });
    expect(performance.now() - started).toBeLessThan(2000); // generous: guards against quadratic blowups, not CI jitter
    expect(view.universe).toBe(4048);
    expect(scopeListView(big, { ...all, showBelowCap: true }).rows).toHaveLength(11);
  });
});

describe('retry order', () => {
  it('cuts first-N and fit-to-budget problems first (failed → stale → not run → rest), then in tree order, whatever the Sort', () => {
    expect(ids(retryOrder(scopes))).toEqual(['b-comp', 'web', 'a-comp', 'sys', 'api', 'busy', 'c-comp', 'fn1', 'fn2', 'ext']);
    const ordered = ids(retryOrder(scopes)).filter(id => ['a-comp', 'c-comp', 'web', 'b-comp'].includes(id));
    expect(applyFraction(ordered, { mode: 'first', count: 2 })).toEqual(['b-comp', 'web']);
    // b-comp (+ web, sys to re-reduce) = 3 requests; + web still 3; + a-comp = 4 × $0.004 > $0.012.
    expect(fitToBudget(ordered, scopes, 0.012, 0.004)).toEqual({ count: 2 });
    expect(applyFraction(ordered, { mode: 'fit' }, scopes, 0.012, 0.004)).toEqual(['b-comp', 'web']);
  });
});

describe('initial selection and visibility', () => {
  it('opens the first visible scope in hierarchy order (the system), never a hidden below-cap scope, regardless of search', () => {
    const capped = [s('deep', 'code', 'below cap', 'sys'), s('comp', 'component', 'failed', 'sys'), s('sys', 'softwareSystem', 'accepted')];
    expect(initialScope(capped, false)?.scopeId).toBe('sys');
    expect(initialScope([s('deep', 'code', 'below cap')], false)).toBeUndefined();
    expect(initialScope(capped, true)?.scopeId).toBe('sys');
  });
  it('keeps the current scope across polls; re-picks only when it is gone or an automatic choice is now hidden below the cap', () => {
    const polled = [s('sys', 'softwareSystem', 'accepted'), s('comp', 'component', 'failed', 'sys'), s('fn', 'code', 'below cap', 'sys')];
    // An automatic (unpinned) current scope that is still listable stays put — a workspace that re-picks every poll fails here.
    expect(nextOpenScope(polled, 'comp', false, false)?.scopeId).toBe('comp');
    // Regression: an automatic default that became below cap while below-cap scopes are hidden is replaced.
    expect(nextOpenScope(polled, 'fn', false, false)?.scopeId).toBe('sys');
    expect(nextOpenScope(polled, 'fn', false, true)?.scopeId).toBe('fn');
    expect(nextOpenScope(polled, 'fn', true, false)?.scopeId).toBe('fn'); // explicit pick: the inspector says it is hidden
    expect(nextOpenScope(polled, 'gone', true, false)?.scopeId).toBe('sys');
    expect(nextOpenScope(polled, undefined, false, false)?.scopeId).toBe('sys');
  });
  it('tells a dimmed context ancestor apart from a true non-match', () => {
    expect(scopeVisibility(scopes.find(item => item.scopeId === 'fn1')!, all, scopes)).toBe('below cap');
    expect(scopeVisibility(scopes.find(item => item.scopeId === 'sys')!, all, scopes)).toBe('visible');
    expect(scopeVisibility(scopes.find(item => item.scopeId === 'web')!, { ...all, query: 'render' }, scopes)).toBe('context');
    expect(scopeVisibility(scopes.find(item => item.scopeId === 'api')!, { ...all, query: 'render' }, scopes)).toBe('filtered');
    // A below-cap match does not make its ancestor context while below-cap scopes are hidden.
    expect(scopeVisibility(scopes.find(item => item.scopeId === 'b-comp')!, { ...all, query: 'fn1' }, scopes)).toBe('filtered');
  });
});

describe('list interactions (pure handlers the component calls)', () => {
  it('"/" focuses and selects the search box; Escape clears, then leaves; both ignore IME composition', () => {
    const calls: string[] = []; let prevented = false;
    const input = { focus: () => calls.push('focus'), select: () => calls.push('select') };
    expect(focusSearchOnShortcut({ key: '/', target: { tagName: 'BUTTON' }, preventDefault: () => { prevented = true; } }, input)).toBe(true);
    expect(calls).toEqual(['focus', 'select']); expect(prevented).toBe(true);
    expect(focusSearchOnShortcut({ key: '/', target: { tagName: 'INPUT', type: 'search' }, preventDefault: () => undefined }, input)).toBe(false);
    expect(focusSearchOnShortcut({ key: '/', target: { tagName: 'BODY' }, preventDefault: () => undefined }, null)).toBe(false);
    expect(searchEscapeAction({ key: 'Escape' }, 'share')).toBe('clear');
    expect(searchEscapeAction({ key: 'Escape' }, '')).toBe('blur');
    expect(searchEscapeAction({ key: 'Escape', isComposing: true }, 'share')).toBe('none');
    expect(searchEscapeAction({ key: 'a' }, 'share')).toBe('none');
  });
  it('an expand toggle opens a node; toggles made during a search reset for the next search, browsing toggles persist', () => {
    let state: ExpansionState = { browse: new Map(), filterKey: '', filtered: new Map() };
    const toggle = (options: ScopeListOptions, id: string, open: boolean) => { state = withToggles(state, options, new Map(activeToggles(state, options)).set(id, open)); };
    const rows = (options: ScopeListOptions) => scopeListView(scopes, options, activeToggles(state, options)).rows.map(row => row.scope.scopeId);
    toggle(all, 'web', true);
    expect(rows(all)).toEqual(['sys', 'api', 'web', 'a-comp', 'b-comp', 'ext']);
    const render = { ...all, query: 'render' };
    expect(rows(render)).toEqual(['sys', 'web', 'b-comp', 'fn2']); // auto-expanded to the match
    state = withToggles(state, render, collapseAll(scopes));
    expect(rows(render)).toEqual(['sys', 'web']);
    expect(rows({ ...all, query: 'rend' })).toEqual(['sys', 'web', 'b-comp', 'fn2']); // a new search starts fresh
    expect(rows(all)).toEqual(['sys', 'api', 'web', 'a-comp', 'b-comp', 'ext']); // browsing toggles survived
  });
});

describe('labels and keyboard', () => {
  it('shows a component path relative to its container with the container as a secondary label; duplicates stay distinct', () => {
    const tree: OperatorScope[] = [
      s('sys', 'softwareSystem', 'accepted', undefined, { name: 'okie' }),
      s('tooling', 'container', 'accepted', 'sys', { name: 'Build & fixture tooling', path: 'scripts' }),
      s('web', 'container', 'accepted', 'sys', { name: '@okie/web', path: 'apps/web' }),
      s('share-root', 'component', 'accepted', 'tooling', { name: 'api/share.ts', path: 'api/share.ts' }),
      s('share-web', 'component', 'accepted', 'web', { name: 'api/share.ts', path: 'apps/web/api/share.ts' }),
      s('fn', 'code', 'accepted', 'share-web', { name: 'handler', path: 'apps/web/api/share.ts' }),
    ];
    const lookup = new Map(tree.map(item => [item.scopeId, item]));
    expect(scopeLabel(tree[4]!, lookup)).toEqual({ primary: 'api/share.ts', secondary: '@okie/web', title: 'apps/web/api/share.ts (in @okie/web)' });
    expect(scopeLabel(tree[3]!, lookup)).toEqual({ primary: 'api/share.ts', secondary: 'Build & fixture tooling', title: 'api/share.ts (in Build & fixture tooling)' });
    expect(scopeLabel(tree[5]!, lookup)).toEqual({ primary: 'handler', secondary: 'api/share.ts', title: 'handler (in api/share.ts · @okie/web) — apps/web/api/share.ts' });
    expect(scopeLabel(tree[2]!, lookup)).toEqual({ primary: '@okie/web', title: 'apps/web' });
  });
  it('"/" focuses search unless typing in another field', () => {
    expect(isSearchShortcut({ key: '/', target: { tagName: 'BODY' } })).toBe(true);
    expect(isSearchShortcut({ key: '/', target: { tagName: 'INPUT' } })).toBe(false);
    expect(isSearchShortcut({ key: '/', target: { tagName: 'INPUT', type: 'text' } })).toBe(false);
    expect(isSearchShortcut({ key: '/', target: { tagName: 'INPUT', type: 'number' } })).toBe(false);
    expect(isSearchShortcut({ key: '/', target: { tagName: 'INPUT', type: 'checkbox' } })).toBe(true);
    expect(isSearchShortcut({ key: '/', target: { tagName: 'INPUT', type: 'radio' } })).toBe(true);
    expect(isSearchShortcut({ key: '/', target: { tagName: 'BUTTON' } })).toBe(true);
    expect(isSearchShortcut({ key: '/', target: { tagName: 'TEXTAREA' } })).toBe(false);
    expect(isSearchShortcut({ key: '/', target: { tagName: 'SELECT' } })).toBe(false);
    expect(isSearchShortcut({ key: '/', isComposing: true, target: { tagName: 'BODY' } })).toBe(false);
    expect(isSearchShortcut({ key: '/', defaultPrevented: true, target: { tagName: 'BODY' } })).toBe(false);
    expect(isSearchShortcut({ key: '/', target: { tagName: 'DIV', isContentEditable: true } })).toBe(false);
    expect(isSearchShortcut({ key: '/', ctrlKey: true, target: null })).toBe(false);
    expect(isSearchShortcut({ key: 'a', target: null })).toBe(false);
  });
});
