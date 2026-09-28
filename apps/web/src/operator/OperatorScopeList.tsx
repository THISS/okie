import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { OperatorScope } from './api';
import { belowCapChip, scopeStateLabel } from './reviewState';
import { activeToggles, collapseAll, focusSearchOnShortcut, SCOPE_SORTS, scopeLabel, scopeListView, searchEscapeAction, withToggles, type ExpansionState, type ScopeSort } from './scopeList';
import { count, isBelowCap, levelTag, SCOPE_FILTERS, selectable, selectByLevel, selectByState, selectSubtree, selectVisible, type ScopeFilter } from './scopeSelection';

type Selection = ReadonlySet<string>;
export interface ScopeListProps {
  scopes: readonly OperatorScope[]; openScopeId?: string; filter: ScopeFilter; query: string; sort: ScopeSort; showBelowCap: boolean; selected: Selection;
  onOpen(scope: OperatorScope): void; onFilter(filter: ScopeFilter): void; onQuery(query: string): void; onSort(sort: ScopeSort): void; onShowBelowCap(show: boolean): void; onSelection(next: Set<string>): void; onReview(): void;
  /** Initial explicit expand/collapse toggles (tests); the list owns them afterwards. */
  initialExpanded?: ReadonlyMap<string, boolean>;
}

/**
 * Scope list (CLA-258/259): search, state filter, sort, below-cap opt-in, selection toolbar and a collapsible C4 tree
 * that scrolls inside its own bounded container. Collapsed children are not rendered.
 */
export function OperatorScopeList(props: ScopeListProps) {
  const { scopes, selected, showBelowCap } = props;
  // Browsing toggles persist; toggles made while filtering belong to that search/filter and reset when it changes, so a
  // new search always reveals its matches (auto-expansion) even after "Collapse all".
  const [expansion, setExpansion] = useState<ExpansionState>(() => ({ browse: props.initialExpanded ?? new Map(), filterKey: '', filtered: new Map() }));
  const listId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const options = { filter: props.filter, query: props.query, showBelowCap, sort: props.sort };
  const expanded = activeToggles(expansion, options);
  const setExpanded = (next: ReadonlyMap<string, boolean>) => setExpansion(current => withToggles(current, options, next));
  const view = useMemo(() => scopeListView(scopes, options, expanded), [scopes, props.filter, props.query, showBelowCap, props.sort, expanded]);
  const lookup = useMemo(() => new Map(scopes.map(scope => [scope.scopeId, scope])), [scopes]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { focusSearchOnShortcut(event, searchRef.current); };
    document.addEventListener('keydown', onKey); return () => document.removeEventListener('keydown', onKey);
  }, []);
  const belowCap = scopes.filter(isBelowCap).length; const chip = belowCapChip(scopes);
  const replace = (ids: string[]) => props.onSelection(new Set(ids));
  const toggle = (scopeId: string) => { const next = new Set(selected); if (next.has(scopeId)) next.delete(scopeId); else next.add(scopeId); props.onSelection(next); };
  const setOpen = (scopeId: string, open: boolean) => setExpanded(new Map(expanded).set(scopeId, open));
  const openScope = props.openScopeId ? lookup.get(props.openScopeId) : undefined;
  const matching = selectVisible(view.matches, showBelowCap);
  return <nav aria-label="Draft scopes" className="operator-scope-list">
    <div className="operator-scope-controls">
      <div className="operator-scope-heading"><h3>Scopes</h3><span className="operator-muted" role="status">{view.filtering ? `${count(view.matches.length)} of ${count(view.universe)}` : `${count(view.universe)} scopes`}</span></div>
      <input aria-label="Search scopes by name, path or id" aria-keyshortcuts="/" className="operator-scope-search" onChange={event => props.onQuery(event.target.value)} onKeyDown={event => { const action = searchEscapeAction({ key: event.key, isComposing: event.nativeEvent.isComposing }, props.query); if (action === 'none') return; event.preventDefault(); if (action === 'clear') props.onQuery(''); else event.currentTarget.blur(); }} placeholder="Search name, path or id  ( / )" ref={searchRef} type="search" value={props.query}/>
      <div aria-label="Filter scopes by state" className="operator-filters" role="group">{SCOPE_FILTERS.map(option => <button aria-pressed={props.filter === option.value} className={props.filter === option.value ? 'selected' : ''} key={option.value} onClick={() => props.onFilter(option.value)} type="button">{option.label}</button>)}</div>
      <div className="operator-scope-sort"><label>Sort <select aria-label="Sort scopes" onChange={event => props.onSort(event.target.value as ScopeSort)} value={props.sort}>{SCOPE_SORTS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label><button onClick={() => setExpanded(collapseAll(scopes))} type="button">Collapse all</button></div>
      {belowCap > 0 && <label className="operator-toggle"><input checked={showBelowCap} onChange={event => props.onShowBelowCap(event.target.checked)} type="checkbox"/> Show {count(belowCap)} below depth cap</label>}
      {showBelowCap && belowCap > 0 && <p className="operator-muted operator-note">{chip}: never requested because their level is below this run's enrichment depth cap. Selecting them is an explicit opt-in and adds cost.</p>}
      <div aria-label="Select scopes" className="operator-select-toolbar" role="toolbar">
        <button onClick={() => replace(matching)} type="button">{view.filtering ? 'Select matching' : 'Select all'} ({count(matching.length)})</button>
        <button onClick={() => replace(selectByState(scopes, 'failed', showBelowCap))} type="button">Failed</button>
        <button onClick={() => replace(selectByState(scopes, 'not run', showBelowCap))} type="button">Not run</button>
        <button onClick={() => replace(selectByState(scopes, 'stale', showBelowCap))} type="button">Stale</button>
        <button onClick={() => replace(selectByLevel(scopes, 'container', showBelowCap))} type="button">Containers</button>
        <button onClick={() => replace(selectByLevel(scopes, 'component', showBelowCap))} type="button">Components</button>
        <button disabled={!showBelowCap && !scopes.some(scope => scope.kind === 'code' && !isBelowCap(scope))} onClick={() => replace(selectByLevel(scopes, 'code', showBelowCap))} title={showBelowCap ? undefined : 'Turn on "Show below depth cap" to select code scopes'} type="button">Code</button>
        <button disabled={!openScope} onClick={() => openScope && replace(selectSubtree(scopes, openScope.scopeId, showBelowCap))} title={openScope ? `${openScope.name} and its descendants` : 'Open a scope first'} type="button">Subtree</button>
        <button disabled={!selected.size} onClick={() => replace([])} type="button">Clear</button>
      </div>
      {selected.size > 0 && <div className="operator-selection-bar"><span>{selectionSummary(selected, view.matches)}</span><button onClick={props.onReview} type="button">Retry selected…</button></div>}
      {view.filtering && !view.autoExpanded && view.matches.length > 0 && <p className="operator-muted operator-note">{count(view.matches.length)} matches: expand a node to see the ones it holds.</p>}
    </div>
    {view.rows.length === 0 && <p className="operator-muted operator-scope-empty">No scopes match {props.query ? 'this search' : 'this filter'}.</p>}
    <ul aria-label="Scope tree" className="operator-scope-rows" id={listId}>{view.rows.map(row => {
      const item = row.scope; const canSelect = selectable(item, showBelowCap); const label = scopeStateLabel(item); const name = scopeLabel(item, lookup);
      const badge = row.hasChildren ? (view.filtering ? `${count(row.matchesBelow)} match${row.matchesBelow === 1 ? '' : 'es'}` : count(row.descendants)) : undefined;
      return <li aria-current={props.openScopeId === item.scopeId ? 'true' : undefined} aria-level={row.depth + 1} className={[props.openScopeId === item.scopeId ? 'selected' : '', row.match || !view.filtering ? '' : 'context'].filter(Boolean).join(' ') || undefined} data-scope-id={item.scopeId} key={item.scopeId} style={{ '--depth': row.depth } as CSSProperties}>
        {row.hasChildren ? <button aria-controls={listId} aria-expanded={row.expanded} aria-label={`${row.expanded ? 'Collapse' : 'Expand'} ${name.primary}`} className="operator-tree-toggle" onClick={() => setOpen(item.scopeId, !row.expanded)} type="button">{row.expanded ? '▾' : '▸'}</button> : <span aria-hidden="true" className="operator-tree-toggle"/>}
        <input aria-label={`Select ${name.primary}`} checked={selected.has(item.scopeId)} disabled={!canSelect} onChange={() => toggle(item.scopeId)} type="checkbox"/>
        <button className="operator-scope-open" onClick={() => props.onOpen(item)} title={name.title} type="button"><span className="operator-scope-name">{name.primary}{name.secondary && <small className="operator-scope-hint">{name.secondary}</small>}</span>{badge && <small className="operator-count">{badge}</small>}{levelTag(item) && <em className="operator-level">{levelTag(item)}</em>}<small data-state={label}>{label}</small></button>
      </li>;
    })}</ul>
  </nav>;
}

/** "12 selected", or "12 selected (3 hidden by filter)" when some selected scopes are not matches of the current search/filter. */
export function selectionSummary(selected: ReadonlySet<string>, matches: readonly Pick<OperatorScope, 'scopeId'>[]): string {
  const shown = new Set(matches.map(scope => scope.scopeId)); let hidden = 0;
  for (const scopeId of selected) if (!shown.has(scopeId)) hidden += 1;
  return `${count(selected.size)} selected${hidden ? ` (${count(hidden)} hidden by filter)` : ''}`;
}
