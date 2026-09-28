import type { ClaimChecksInfo, DraftDetail, OperatorScope } from './api';
import { evidenceSourceUrl } from '../explanation/explanationModel';
import { CLAIM_CHECK_CAPTION, CLAIM_STALE_REASON, claimChipText, claimCountsSummary, droppedSummary, evidenceLabel } from './claimChecks';
import { InlineMarkdown } from '../explanation/markdownLite';

/**
 * CLA-145 "Claim checks" panel for the selected scope: one row per mapped claim with its evidence, a verdict chip and
 * the reason. Report-only: it never hides prose, never marks the scope correct, and never touches publication. The
 * scope's existing "Retry this scope…" action stays in the inspector header, next to this panel.
 */
export function OperatorClaimChecks({ scope, info, source, busy, disabledHint, error, onRecheck }: { scope: OperatorScope; info?: ClaimChecksInfo; source?: DraftDetail['source']; busy: boolean; /** Why re-check is unavailable (e.g. superseded revision), if it is. */ disabledHint?: string; /** The last re-check refusal for this scope (e.g. a 422), shown inline as well as at the page top. */ error?: string; onRecheck(): void }) {
  const checks = scope.claimChecks;
  if (!info && !checks) return null;
  const enabled = info?.enabled !== false;
  const mapped = checks?.mapping === 'claims';
  // A fully stale explanation is refused by the server (claim_scopes_stale): say so here instead of offering the button.
  const stale = !!(checks?.stale || scope.stale);
  const recheckBlocked = !enabled ? info?.disabledReason ?? 'Claim checks are off on this server.' : !mapped ? 'This explanation has no claim mapping to check.' : stale ? CLAIM_STALE_REASON : disabledHint;
  return <section aria-label="Claim checks" className="operator-claim-checks" data-claim-checks={!enabled ? 'disabled' : mapped ? 'claims' : 'none'}>
    <header><h4>Claim checks</h4><div className="operator-actions"><button disabled={busy || !!recheckBlocked} onClick={onRecheck} title={recheckBlocked} type="button">{busy ? 'Queuing…' : 'Re-check claims'}</button></div></header>
    <p className="operator-muted operator-claim-caption">{CLAIM_CHECK_CAPTION}.</p>
    {error && <p className="operator-alert" data-claim-error role="alert">{error}</p>}
    {enabled && mapped && stale && <p className="operator-note" data-claim-recheck-blocked="stale" role="status">{CLAIM_STALE_REASON}</p>}
    {!enabled && <p className="operator-note" data-claim-state="disabled" role="status">{info?.disabledReason ?? 'Claim checks are off on this server.'}</p>}
    {info?.state && info.state !== 'ready' && <p className="operator-alert" role="status">Stored claim checks are {info.state}{info.file ? ` (${info.file})` : ''}; claims read as not evaluated.</p>}
    {!checks ? <p className="operator-muted" data-claim-state="not-evaluated">Not evaluated: no accepted explanation.</p>
      : checks.mapping === 'none' ? <p className="operator-muted" data-claim-state="not-evaluated">{checks.note ?? 'Not evaluated: this explanation has no claim mapping.'}</p>
      : <>
        <p className="operator-claim-counts" data-claim-counts>{claimCountsSummary(checks)}</p>
        {checks.note && <p className="operator-muted operator-note">{checks.note}</p>}
        <ol className="operator-claim-rows">{checks.rows.map(row => <li data-claim-state={row.state} data-claim-source={row.source} key={row.claimId}>
          <p className="operator-claim-text"><span className="operator-claim-origin">{row.origin === 'summary' ? 'Summary' : `Key point ${row.index + 1}`}</span> <InlineMarkdown text={row.text}/></p>
          <div className="operator-claim-meta">
            <span className="operator-claim-chip" data-claim-state={row.state}>{claimChipText(row)}</span>
            <ul className="operator-claim-evidence">{row.evidence.map((ref, index) => { const href = evidenceSourceUrl(ref, source); const label = evidenceLabel(ref); return <li data-evidence-outcome={ref.outcome} key={index}>{href ? <a href={href} rel="noreferrer" target="_blank"><code>{label}</code></a> : <code>{label}</code>}{ref.outcome !== 'ok' && <small> · {ref.outcome}</small>}</li>; })}</ul>
          </div>
          {row.reason && <p className="operator-muted operator-claim-reason">{row.source === 'code' && row.state !== 'stale' ? 'Code check: ' : ''}{row.reason}</p>}
        </li>)}</ol>
        {checks.rowsOmitted ? <p className="operator-muted operator-note">{checks.rowsOmitted} more claim rows are not shown (view limit); counts include them.</p> : null}
      </>}
    {checks?.dropped ? <details className="operator-claim-dropped" data-claim-dropped={checks.dropped}><summary>{droppedSummary(checks.dropped)}</summary>{checks.droppedNote && <p className="operator-muted"><code>{checks.droppedNote}</code></p>}</details> : null}
  </section>;
}
