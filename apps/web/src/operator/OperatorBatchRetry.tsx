import type { CompletionBanner } from './completion';
import { count, usd, type RetryFraction } from './scopeSelection';

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
