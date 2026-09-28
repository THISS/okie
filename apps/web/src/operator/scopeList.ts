import type { OperatorScope } from './api';
import { scopeStateLabel } from './reviewState';
import { isBelowCap, levelOf, type ScopeFilter } from './scopeSelection';

/**
 * Pure scope-list model for the operator workspace (CLA-259): search, sorting, the C4 tree (system → container →
 * component → code) and which rows are rendered. The list component keeps only UI state; everything here is
 * deterministic and unit-tested.
 *
 * Tree/filter interplay: while a state filter or search is active the tree keeps its shape — every match is shown
 * under its ancestors (non-matching ancestors render as dimmed context rows), so a match is never shown without its
 * container. Ancestors of matches auto-expand when there are at most AUTO_EXPAND_LIMIT matches; with more, nodes keep
 * their collapsed defaults and show how many matches they hold, so rendering stays bounded. Non-hierarchy sorts order
 * siblings; the tree shape never changes.
 */
type Scope = Pick<OperatorScope, 'scopeId' | 'name' | 'state' | 'stale' | 'kind' | 'depth' | 'parentScopeId' | 'path' | 'attempts' | 'metrics'>;

export type ScopeSort = 'hierarchy' | 'name' | 'state' | 'cost' | 'updated';
export const SCOPE_SORTS: ReadonlyArray<{ value: ScopeSort; label: string }> = [{ value: 'hierarchy', label: 'Hierarchy' }, { value: 'name', label: 'Name' }, { value: 'state', label: 'State' }, { value: 'cost', label: 'Cost / tokens' }, { value: 'updated', label: 'Last updated' }];
/** Filtering auto-expands the ancestors of matches only up to this many matches (rendering stays bounded). */
export const AUTO_EXPAND_LIMIT = 300;

export interface ScopeListOptions { filter: ScopeFilter; query: string; showBelowCap: boolean; sort?: ScopeSort }

export interface ScopeMetrics { costUsd?: number; tokens?: number; updatedAt?: number }
/**
 * Cost, tokens and last-updated time. Prefers the server's `metrics` summary (it also covers enriched revisions, whose
 * scopes carry no attempts); falls back to summing this revision's attempts (measured cost, else estimated).
 */
export function scopeMetrics(scope: Pick<Scope, 'attempts' | 'metrics'>): ScopeMetrics {
  if (scope.metrics) { const { costUsd, totalTokens, updatedAt } = scope.metrics; return { ...(costUsd !== undefined ? { costUsd } : {}), ...(totalTokens !== undefined ? { tokens: totalTokens } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}) }; }
  let costUsd: number | undefined; let tokens: number | undefined; let updatedAt: number | undefined;
  for (const attempt of scope.attempts ?? []) {
    const cost = attempt.usage?.measuredCostUsd ?? attempt.usage?.estimatedCostUsd;
    if (cost !== undefined) costUsd = (costUsd ?? 0) + cost;
    if (attempt.usage?.inputTokens !== undefined || attempt.usage?.outputTokens !== undefined) tokens = (tokens ?? 0) + (attempt.usage.inputTokens ?? 0) + (attempt.usage.outputTokens ?? 0);
    const at = attempt.updatedAt ?? attempt.createdAt;
    if (at !== undefined && (updatedAt === undefined || at > updatedAt)) updatedAt = at;
  }
  return { ...(costUsd !== undefined ? { costUsd } : {}), ...(tokens !== undefined ? { tokens } : {}), ...(updatedAt !== undefined ? { updatedAt } : {}) };
}

/** Lower-cased whitespace-separated terms; every term must match. */
export function searchTerms(query: string): string[] { return query.trim().toLowerCase().split(/\s+/).filter(Boolean); }
/** Case-insensitive match of every term against the scope's name, source path or id. */
export function matchesQuery(scope: Pick<Scope, 'scopeId' | 'name' | 'path'>, terms: readonly string[]): boolean {
  if (!terms.length) return true;
  const haystack = `${scope.name}\n${scope.path ?? ''}\n${scope.scopeId}`.toLowerCase();
  return terms.every(term => haystack.includes(term));
}
/** In the list's universe (below-cap only when opted in), matching the state filter and the search. */
export function matchesListFilters(scope: Scope, options: ScopeListOptions, terms = searchTerms(options.query)): boolean {
  return (options.showBelowCap || !isBelowCap(scope)) && (options.filter === 'all' || scopeStateLabel(scope) === options.filter) && matchesQuery(scope, terms);
}
export type ScopeVisibility = 'visible' | 'below cap' | 'context' | 'filtered';
/**
 * Where the inspector's scope stands in the list: a match ("visible"), hidden below the depth cap, a non-match shown
 * dimmed as the ancestor of matches ("context"), or a non-match that is not in the list at all ("filtered").
 */
export function scopeVisibility(scope: Scope, options: ScopeListOptions, scopes: readonly Scope[] = []): ScopeVisibility {
  if (!options.showBelowCap && isBelowCap(scope)) return 'below cap';
  const terms = searchTerms(options.query);
  if (matchesListFilters(scope, options, terms)) return 'visible';
  const lookup = new Map(scopes.map(item => [item.scopeId, item]));
  const hasAncestor = (item: Scope) => { const seen = new Set([item.scopeId]); let cursor = item.parentScopeId; while (cursor && !seen.has(cursor)) { if (cursor === scope.scopeId) return true; seen.add(cursor); cursor = lookup.get(cursor)?.parentScopeId; } return false; };
  return scopes.some(item => item.scopeId !== scope.scopeId && matchesListFilters(item, options, terms) && hasAncestor(item)) ? 'context' : 'filtered';
}

const STATE_RANK: Record<string, number> = { failed: 0, stale: 1, 'not run': 2, running: 3, queued: 4, cancelled: 5, interrupted: 6, accepted: 7, 'below cap': 8 };
/** C4 level, with the software system ahead of external systems at the top level. */
const rank = (scope: Scope) => levelOf(scope) + (scope.kind === 'externalSystem' ? 0.5 : 0);
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const byId = (left: Scope, right: Scope) => (left.scopeId < right.scopeId ? -1 : left.scopeId > right.scopeId ? 1 : 0);
/** Missing values sort last; larger first. */
const descending = (left?: number, right?: number) => (left === undefined ? (right === undefined ? 0 : 1) : right === undefined ? -1 : right - left);
/** Sibling order for a sort key; ties fall back to level (system → externals → container → component → code), then name, then id. */
export function scopeComparator(sort: ScopeSort, metrics: (scope: Scope) => ScopeMetrics = scopeMetrics): (left: Scope, right: Scope) => number {
  const natural = (left: Scope, right: Scope) => rank(left) - rank(right) || collator.compare(left.name, right.name) || byId(left, right);
  switch (sort) {
    case 'name': return (left, right) => collator.compare(left.name, right.name) || natural(left, right);
    case 'state': return (left, right) => (STATE_RANK[scopeStateLabel(left)] ?? 9) - (STATE_RANK[scopeStateLabel(right)] ?? 9) || natural(left, right);
    case 'cost': return (left, right) => { const a = metrics(left); const b = metrics(right); return descending(a.costUsd, b.costUsd) || descending(a.tokens, b.tokens) || natural(left, right); };
    case 'updated': return (left, right) => descending(metrics(left).updatedAt, metrics(right).updatedAt) || natural(left, right);
    default: return natural;
  }
}

interface Forest<T> { roots: T[]; children: Map<string, T[]> }
/** Parent links inside the given set; scopes whose parent is absent (or unreachable from any root, e.g. a cycle) are roots. */
function forest<T extends Scope>(scopes: readonly T[], sort: ScopeSort): Forest<T> {
  const ids = new Set(scopes.map(scope => scope.scopeId));
  const children = new Map<string, T[]>(); const roots: T[] = [];
  for (const scope of scopes) {
    if (scope.parentScopeId && scope.parentScopeId !== scope.scopeId && ids.has(scope.parentScopeId)) { const list = children.get(scope.parentScopeId); if (list) list.push(scope); else children.set(scope.parentScopeId, [scope]); } else roots.push(scope);
  }
  const compare = cachedComparator(sort, scopes);
  // Roots always go by level (the system before external systems), whatever the sort; the sort orders within a level.
  roots.sort((left, right) => rank(left) - rank(right) || compare(left, right)); for (const list of children.values()) list.sort(compare);
  // Cycle members never hang off a root: promote them so every scope is reachable exactly once.
  const reached = new Set<string>(); const stack = [...roots];
  while (stack.length) { const node = stack.pop()!; if (reached.has(node.scopeId)) continue; reached.add(node.scopeId); stack.push(...(children.get(node.scopeId) ?? [])); }
  if (reached.size < scopes.length) {
    for (const scope of [...scopes].sort(compare)) if (!reached.has(scope.scopeId)) {
      roots.push(scope); const pending = [scope];
      while (pending.length) { const node = pending.pop()!; if (reached.has(node.scopeId)) continue; reached.add(node.scopeId); pending.push(...(children.get(node.scopeId) ?? [])); }
    }
  }
  return { roots, children };
}
function cachedComparator(sort: ScopeSort, scopes: readonly Scope[]) {
  if (sort !== 'cost' && sort !== 'updated') return scopeComparator(sort);
  const cache = new Map(scopes.map(scope => [scope.scopeId, scopeMetrics(scope)]));
  return scopeComparator(sort, scope => cache.get(scope.scopeId) ?? scopeMetrics(scope));
}
function preorder<T extends Scope>({ roots, children }: Forest<T>, visit: (scope: T, depth: number) => boolean | void): void {
  const seen = new Set<string>();
  const walk = (scope: T, depth: number) => { if (seen.has(scope.scopeId)) return; seen.add(scope.scopeId); if (visit(scope, depth) === false) return; for (const child of children.get(scope.scopeId) ?? []) walk(child, depth + 1); };
  for (const root of roots) walk(root, 0);
}

/** Every scope in tree order (parents before children, siblings by the sort): the list order a retry selection follows. */
export function orderTree<T extends Scope>(scopes: readonly T[], sort: ScopeSort = 'hierarchy'): T[] {
  const result: T[] = []; preorder(forest(scopes, sort), scope => { result.push(scope); }); return result;
}

/**
 * The order a retry selection is cut in ("first N", fit to budget): problems first — failed, stale, not run — then
 * everything else, each group in hierarchy tree order (parents before children). Independent of the list's Sort choice.
 */
export function retryOrder<T extends Scope>(scopes: readonly T[]): T[] {
  const problem = (scope: Scope) => { const label = scopeStateLabel(scope); return label === 'failed' ? 0 : label === 'stale' ? 1 : label === 'not run' ? 2 : 3; };
  const tree = orderTree(scopes, 'hierarchy'); const position = new Map(tree.map((scope, index) => [scope.scopeId, index]));
  return tree.sort((left, right) => problem(left) - problem(right) || position.get(left.scopeId)! - position.get(right.scopeId)!);
}

export interface ScopeRow<T> { scope: T; depth: number; match: boolean; hasChildren: boolean; expanded: boolean; descendants: number; matchesBelow: number }
export interface ScopeListView<T> { rows: ScopeRow<T>[]; matches: T[]; universe: number; filtering: boolean; autoExpanded: boolean }

/**
 * The rows to render. `expanded` holds explicit user toggles; without one a node is expanded when it is a root, or
 * while filtering when it holds matches and the match count is within AUTO_EXPAND_LIMIT. Collapsed children are not
 * rendered at all, which keeps a 4k-scope draft responsive without virtualization.
 */
export function scopeListView<T extends Scope>(scopes: readonly T[], options: ScopeListOptions, expanded: ReadonlyMap<string, boolean> = new Map()): ScopeListView<T> {
  const universe = scopes.filter(scope => options.showBelowCap || !isBelowCap(scope));
  const terms = searchTerms(options.query);
  const filtering = options.filter !== 'all' || terms.length > 0;
  const tree = forest(universe, options.sort ?? 'hierarchy');
  const match = new Set(universe.filter(scope => matchesListFilters(scope, options, terms)).map(scope => scope.scopeId));
  const descendants = new Map<string, number>(); const matchesBelow = new Map<string, number>();
  const count = (scope: T, seen: Set<string>): void => {
    let total = 0; let matched = 0;
    for (const child of tree.children.get(scope.scopeId) ?? []) { if (seen.has(child.scopeId)) continue; seen.add(child.scopeId); count(child, seen); total += 1 + descendants.get(child.scopeId)!; matched += (match.has(child.scopeId) ? 1 : 0) + matchesBelow.get(child.scopeId)!; }
    descendants.set(scope.scopeId, total); matchesBelow.set(scope.scopeId, matched);
  };
  const seen = new Set<string>(); for (const root of tree.roots) { seen.add(root.scopeId); count(root, seen); }
  const matches: T[] = []; preorder(tree, scope => { if (match.has(scope.scopeId)) matches.push(scope); });
  const autoExpanded = filtering && matches.length <= AUTO_EXPAND_LIMIT;
  const included = (scope: T) => !filtering || match.has(scope.scopeId) || (matchesBelow.get(scope.scopeId) ?? 0) > 0;
  const rows: ScopeRow<T>[] = [];
  preorder(tree, (scope, depth) => {
    if (!included(scope)) return false;
    const below = matchesBelow.get(scope.scopeId) ?? 0;
    const hasChildren = filtering ? below > 0 : (descendants.get(scope.scopeId) ?? 0) > 0;
    const open = hasChildren && (expanded.get(scope.scopeId) ?? (depth === 0 || (autoExpanded && below > 0)));
    rows.push({ scope, depth, match: match.has(scope.scopeId), hasChildren, expanded: open, descendants: descendants.get(scope.scopeId) ?? 0, matchesBelow: below });
    return open;
  });
  return { rows, matches, universe: universe.length, filtering, autoExpanded };
}

/** Explicit toggles that collapse every non-root node with children (roots stay open, so the tree top stays visible). */
export function collapseAll(scopes: readonly Scope[]): Map<string, boolean> {
  const parent = new Map(scopes.map(scope => [scope.scopeId, scope.parentScopeId]));
  const result = new Map<string, boolean>();
  for (const scope of scopes) { const id = scope.parentScopeId; if (id && id !== scope.scopeId && parent.has(id) && parent.get(id) && parent.has(parent.get(id)!)) result.set(id, false); }
  return result;
}

/** The inspector's initial scope: the first scope in hierarchy order that the list can show — never a hidden below-cap one. */
export function initialScope<T extends Scope>(scopes: readonly T[], showBelowCap: boolean): T | undefined {
  return orderTree(scopes.filter(scope => showBelowCap || !isBelowCap(scope)), 'hierarchy')[0];
}
/**
 * The scope the inspector shows after a (re)load or poll. The current scope stays — even when a search or filter hides
 * it (the inspector says so) — unless it is gone from the revision, or it is an automatic (unpinned) choice that is now
 * below the depth cap while below-cap scopes are hidden. Search and filters never move the inspector.
 */
export function nextOpenScope<T extends Scope>(scopes: readonly T[], currentId: string | undefined, pinned: boolean, showBelowCap: boolean): T | undefined {
  const current = currentId ? scopes.find(scope => scope.scopeId === currentId) : undefined;
  if (current && (pinned || showBelowCap || !isBelowCap(current))) return current;
  return initialScope(scopes, showBelowCap);
}

/** Explicit expand/collapse toggles: browsing toggles persist; toggles made while filtering belong to that filter key. */
export interface ExpansionState { browse: ReadonlyMap<string, boolean>; filterKey: string; filtered: ReadonlyMap<string, boolean> }
const NO_TOGGLES: ReadonlyMap<string, boolean> = new Map();
export const expansionKey = (options: ScopeListOptions): string => `${options.filter}\u0000${searchTerms(options.query).join(' ')}\u0000${options.showBelowCap}`;
const isFiltering = (options: ScopeListOptions) => options.filter !== 'all' || searchTerms(options.query).length > 0;
/** The toggles in effect: a new search or filter starts from none, so auto-expansion reveals its matches. */
export function activeToggles(state: ExpansionState, options: ScopeListOptions): ReadonlyMap<string, boolean> {
  if (!isFiltering(options)) return state.browse;
  return state.filterKey === expansionKey(options) ? state.filtered : NO_TOGGLES;
}
/** Replace the toggles of the current mode (browse, or this search/filter). */
export function withToggles(state: ExpansionState, options: ScopeListOptions, toggles: ReadonlyMap<string, boolean>): ExpansionState {
  return isFiltering(options) ? { ...state, filterKey: expansionKey(options), filtered: toggles } : { ...state, browse: toggles };
}

/** What Escape does in the search box: clear a query, else leave the box; nothing while an IME is composing. */
export function searchEscapeAction(event: { key: string; isComposing?: boolean }, query: string): 'clear' | 'blur' | 'none' {
  if (event.key !== 'Escape' || event.isComposing) return 'none';
  return query ? 'clear' : 'blur';
}

export interface ScopeLabel { primary: string; secondary?: string; title: string }
/**
 * Display names: a component shows its source path relative to its container (e.g. "api/share.ts") with the container
 * as a secondary label ("@okie/web"), so duplicate file names in different containers are never ambiguous; code shows
 * its name with the file as the secondary label. The tooltip carries the full path.
 */
export function scopeLabel(scope: Scope, lookup: ReadonlyMap<string, Scope>): ScopeLabel {
  const ancestor = (kind: string): Scope | undefined => { const seen = new Set([scope.scopeId]); let cursor = scope.parentScopeId; while (cursor && !seen.has(cursor)) { seen.add(cursor); const parent = lookup.get(cursor); if (!parent) return undefined; if (parent.kind === kind) return parent; cursor = parent.parentScopeId; } return undefined; };
  const container = scope.kind === 'component' || scope.kind === 'code' ? ancestor('container') : undefined;
  const relative = (path: string | undefined, base: string | undefined) => (path && base && path.startsWith(`${base.replace(/\/$/, '')}/`) ? path.slice(base.replace(/\/$/, '').length + 1) : undefined);
  let primary = scope.name; let secondary: string | undefined;
  if (scope.kind === 'component') { primary = relative(scope.path, container?.path) ?? scope.name; secondary = container?.name; }
  if (scope.kind === 'code') { const file = ancestor('component'); secondary = file ? (relative(file.path, container?.path) ?? file.name) : undefined; }
  const where = [scope.kind === 'code' ? secondary : undefined, container?.name].filter(Boolean).join(' · ');
  const title = `${scope.kind === 'code' ? scope.name : scope.path ?? scope.name}${where ? ` (in ${where})` : ''}${scope.kind === 'code' && scope.path ? ` — ${scope.path}` : ''}`;
  return { primary, ...(secondary ? { secondary } : {}), title };
}

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'number', 'password', 'tel', 'date', 'datetime-local', 'month', 'time', 'week']);
/** `/` focuses the scope search unless the operator is typing in a text field (checkboxes, radios and buttons don't count). */
export function isSearchShortcut(event: { key: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; isComposing?: boolean; defaultPrevented?: boolean; target?: unknown }): boolean {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || event.isComposing || event.defaultPrevented) return false;
  const target = event.target as { tagName?: string; type?: string; isContentEditable?: boolean } | null | undefined;
  const tag = target?.tagName?.toUpperCase();
  if (target?.isContentEditable || tag === 'TEXTAREA' || tag === 'SELECT') return false;
  return !(tag === 'INPUT' && TEXT_INPUT_TYPES.has((target?.type ?? '').toLowerCase()));
}
/** The document keydown handler: `/` focuses and selects the search box (see isSearchShortcut). */
export function focusSearchOnShortcut(event: Parameters<typeof isSearchShortcut>[0] & { preventDefault(): void }, input: { focus(): void; select(): void } | null | undefined): boolean {
  if (!input || !isSearchShortcut(event)) return false;
  event.preventDefault(); input.focus(); input.select(); return true;
}
