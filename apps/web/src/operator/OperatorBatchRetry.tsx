import type { OperatorScope } from './api';
import type { CompletionBanner } from './completion';
import { belowCapChip, scopeStateLabel } from './reviewState';
import { count, isBelowCap, levelTag, nameHints, SCOPE_FILTERS, SCOPE_LIST_PREVIEW, selectable, selectByLevel, selectByState, selectSubtree, selectVisible, usd, type RetryFraction, type ScopeFilter } from './scopeSelection';

/** Completion banner: what happened and the next step (CLA-258). */
export function OperatorCompletionBanner({ banner, busy, onPreview, onPublish, onRetryFailed, onRetryNotRun, onReviewNewer }: { banner: CompletionBanner; busy?: string; onPreview(): void; onPublish(): void; onRetryFailed(): void; onRetryNotRun(): void; onReviewNewer?(): void }) {
  return <section aria-live="polite" className={`operator-completion operator-completion-${banner.kind}`} data-completion={banner.kind} role="status">
    <p className="operator-completion-title">{banner.title}</p>{banner.detail && <p>{banner.detail}</p>}
    {banner.actions.length > 0 && <div className="operator-actions">
      {banner.actions.includes('preview-publish') && <><button disabled={busy === 'preview'} onClick={onPreview}>Preview</button><span aria-hidden="true">→</span><button onClick={onPublish}>Publish</button></>}
      {banner.actions.includes('retry-failed') && banner.retryFailedLabel && <button onClick={onRetryFailed}>{banner.retryFailedLabel}</button>}
      {banner.actions.includes('review-newer') && <button disabled={busy === 'review'} onClick={onReviewNewer}>Review newer revision</button>}
      {banner.actions.includes('retry-not-run') && banner.notRunScopeIds.length > 0 && <button onClick={onRetryNotRun}>Retry not run ({count(banner.notRunScopeIds.length)})…</button>}
    </div>}
  </section>;
}

type Selection = ReadonlySet<string>;
export interface ScopeListProps {
  scopes: readonly OperatorScope[]; ordered: readonly OperatorScope[]; visible: readonly OperatorScope[]; openScopeId?: string; filter: ScopeFilter; showBelowCap: boolean; expanded: boolean; selected: Selection;
  onOpen(scope: OperatorScope): void; onFilter(filter: ScopeFilter): void; onShowBelowCap(show: boolean): void; onExpanded(expanded: boolean): void; onSelection(next: Set<string>): void; onReview(): void;
}
/** Scope list with state filter, below-cap opt-in, per-row checkbox, and the selection toolbar. */
export function OperatorScopeList(props: ScopeListProps) {
  const { scopes, visible, selected, showBelowCap } = props;
  const belowCap = scopes.filter(isBelowCap).length; const chip = belowCapChip(scopes);
  const shown = props.expanded ? visible : visible.slice(0, SCOPE_LIST_PREVIEW);
  const replace = (ids: string[]) => props.onSelection(new Set(ids));
  const toggle = (scopeId: string) => { const next = new Set(selected); if (next.has(scopeId)) next.delete(scopeId); else next.add(scopeId); props.onSelection(next); };
  const hints = nameHints(scopes);
  const openScope = props.openScopeId ? scopes.find(scope => scope.scopeId === props.openScopeId) : undefined;
  return <nav aria-label="Draft scopes" className="operator-scope-list">
    <h3>Scopes</h3>
    <div aria-label="Filter scopes by state" className="operator-filters" role="group">{SCOPE_FILTERS.map(option => <button aria-pressed={props.filter === option.value} className={props.filter === option.value ? 'selected' : ''} key={option.value} onClick={() => props.onFilter(option.value)} type="button">{option.label}</button>)}</div>
    {belowCap > 0 && <label className="operator-toggle"><input checked={showBelowCap} onChange={event => props.onShowBelowCap(event.target.checked)} type="checkbox"/> Show {count(belowCap)} below depth cap</label>}
    {showBelowCap && belowCap > 0 && <p className="operator-muted operator-note">{chip}: never requested because their level is below this run's enrichment depth cap. Selecting them is an explicit opt-in and adds cost.</p>}
    <div aria-label="Select scopes" className="operator-select-toolbar" role="toolbar">
      <button onClick={() => replace(selectVisible(visible, showBelowCap))} type="button">Select all ({count(selectVisible(visible, showBelowCap).length)})</button>
      <button onClick={() => replace(selectByState(scopes, 'failed', showBelowCap))} type="button">Failed</button>
      <button onClick={() => replace(selectByState(scopes, 'not run', showBelowCap))} type="button">Not run</button>
      <button onClick={() => replace(selectByState(scopes, 'stale', showBelowCap))} type="button">Stale</button>
      <button onClick={() => replace(selectByLevel(scopes, 'container', showBelowCap))} type="button">Containers</button>
      <button onClick={() => replace(selectByLevel(scopes, 'component', showBelowCap))} type="button">Components</button>
      <button disabled={!showBelowCap && !scopes.some(scope => scope.kind === 'code' && !isBelowCap(scope))} onClick={() => replace(selectByLevel(scopes, 'code', showBelowCap))} title={showBelowCap ? undefined : 'Turn on "Show below depth cap" to select code scopes'} type="button">Code</button>
      <button disabled={!openScope} onClick={() => openScope && replace(selectSubtree(scopes, openScope.scopeId, showBelowCap))} title={openScope ? `${openScope.name} and its descendants` : 'Open a scope first'} type="button">Subtree</button>
      <button disabled={!selected.size} onClick={() => replace([])} type="button">Clear</button>
    </div>
    {selected.size > 0 && <div className="operator-selection-bar"><span>{count(selected.size)} selected</span><button onClick={props.onReview} type="button">Retry selected…</button></div>}
    {shown.length === 0 && <p className="operator-muted">No scopes match this filter.</p>}
    <ul className="operator-scope-rows">{shown.map(item => { const canSelect = selectable(item, showBelowCap); const label = scopeStateLabel(item); return <li className={props.openScopeId === item.scopeId ? 'selected' : ''} key={item.scopeId}>
      <input aria-label={`Select ${item.name}`} checked={selected.has(item.scopeId)} disabled={!canSelect} onChange={() => toggle(item.scopeId)} type="checkbox"/>
      <button onClick={() => props.onOpen(item)} type="button"><span title={hints.has(item.scopeId) ? `${item.name} (${hints.get(item.scopeId)})` : item.name}>{item.name}{hints.has(item.scopeId) && <small className="operator-scope-hint">{hints.get(item.scopeId)}</small>}</span>{levelTag(item) && <em className="operator-level">{levelTag(item)}</em>}<small data-state={label}>{label}</small></button>
    </li>; })}</ul>
    {visible.length > SCOPE_LIST_PREVIEW && <button onClick={() => props.onExpanded(!props.expanded)} type="button">{props.expanded ? `Show first ${SCOPE_LIST_PREVIEW}` : `Show all ${count(visible.length)}`}</button>}
  </nav>;
}

/** `fit` comes from `fitToBudget`; `warning` is shown when the estimate exceeds the remaining budget; `error` blocks sending. */
export interface RetryConfirmProps { fit: { count: number } | { unavailable: string }; warning?: string; error?: string; summary: string; selectionSize: number; sendCount: number; fraction: RetryFraction; firstCount: number; remainingUsd?: number; remainingRequests?: number; avgCostPerScopeUsd?: number; includesBelowCap: boolean; busy: boolean; onFraction(fraction: RetryFraction): void; onFirstCount(value: number): void; onConfirm(): void; onCancel(): void; }
/** Confirm step: how much of the selection to run, the estimate, and an explicit send. */
export function OperatorRetryConfirm(props: RetryConfirmProps) {
  const fit = props.fit;
  const left = [...(props.remainingUsd !== undefined ? [usd(props.remainingUsd)] : []), ...(props.remainingRequests !== undefined ? [`${count(props.remainingRequests)} request${props.remainingRequests === 1 ? '' : 's'}`] : [])];
  return <section aria-label="Confirm batch retry" className="operator-retry-confirm">
    <fieldset><legend>Run</legend>
      <label><input checked={props.fraction.mode === 'all'} name="retry-fraction" onChange={() => props.onFraction({ mode: 'all' })} type="radio"/> all selected ({count(props.selectionSize)})</label>
      <label><input checked={props.fraction.mode === 'first'} name="retry-fraction" onChange={() => props.onFraction({ mode: 'first', count: props.firstCount })} type="radio"/> first <input aria-label="Number of scopes to run" max={props.selectionSize} min={1} onChange={event => { const value = Math.max(1, Math.min(props.selectionSize, Math.floor(Number(event.target.value) || 1))); props.onFirstCount(value); props.onFraction({ mode: 'first', count: value }); }} type="number" value={props.firstCount}/></label>
      <label title={'unavailable' in fit ? fit.unavailable : undefined}><input checked={props.fraction.mode === 'fit'} disabled={'unavailable' in fit} name="retry-fraction" onChange={() => props.onFraction({ mode: 'fit' })} type="radio"/> fit to remaining budget{'count' in fit ? ` (${count(fit.count)}${left.length ? ` of ${left.join(' / ')} left` : ''})` : ''}</label>
      {'unavailable' in fit && <p className="operator-muted operator-note">Fit to budget unavailable: {fit.unavailable}</p>}
    </fieldset>
    {props.includesBelowCap && <p className="operator-note operator-notice">Includes scopes below the depth cap (explicit opt-in).</p>}
    <p className="operator-retry-summary" role="status">{props.summary}</p>
    {props.warning && <p className="operator-alert" role="alert">{props.warning}</p>}
    {props.error && <p className="operator-alert" role="alert">{props.error}</p>}
    <div className="operator-actions"><button disabled={props.busy || props.sendCount === 0 || props.error !== undefined} onClick={props.onConfirm} type="button">{props.busy ? 'Queuing…' : `Retry ${count(props.sendCount)} scope${props.sendCount === 1 ? '' : 's'}`}</button><button onClick={props.onCancel} type="button">Cancel</button></div>
  </section>;
}
