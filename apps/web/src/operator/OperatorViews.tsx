import { askSignInHref } from '../ask/askAtlas';
import type { DraftDetail } from './api';
import { belowCapChip, coverageChips, OPERATOR_NOT_OPERATOR, OPERATOR_SESSION_EXPIRED, staleRevisionFor, type StaleRevisionContext } from './reviewState';

/** A stored run or attempt error (scope detail + run header). The server normalizes and scrubs it (CLA-261); shown as sent. */
export function OperatorStoredError({ error }: { error: string }) {
  return <p className="operator-alert">{error}</p>;
}

/**
 * Access-denied page: message, sign-in back to /operator, and a way home. `expired`: the session is gone (401
 * `session_expired`); `revoked`: still signed in but not an operator any more (403 `not_operator`, CLA-264).
 */
export function OperatorAccessMessage({ expired = false, revoked = false }: { expired?: boolean; revoked?: boolean }) {
  return <main className="operator-shell operator-message" data-access={expired ? 'expired' : revoked ? 'not-operator' : 'denied'} role="alert"><h1>Operator workspace</h1><p>{expired ? OPERATOR_SESSION_EXPIRED : revoked ? OPERATOR_NOT_OPERATOR : 'This workspace is available only to configured operators.'}</p><nav className="operator-message-links"><a href={askSignInHref('/api/auth/github', '/operator')}>Sign in with GitHub</a><a href="/">Return to atlas</a></nav></main>;
}

/** Action error; the "Open current revision" button only renders when the stale context belongs to the selected run. */
export function OperatorErrorAlert({ error, stale, selectedRunId, opening, onOpenCurrent }: { error: string; stale?: StaleRevisionContext; selectedRunId?: string; opening: boolean; onOpenCurrent(runId: string): void }) {
  const current = staleRevisionFor(stale, selectedRunId);
  return <div className="operator-alert" role="alert"><p>{error}</p>{current && <button disabled={opening} onClick={() => onOpenCurrent(current.runId)}>{opening ? 'Opening…' : 'Open current revision'}</button>}</div>;
}

/** Shown instead of the coverage chips when the displayed revision is superseded: its counts are not the run's results (CLA-264). */
/**
 * Coverage chips for the displayed revision. A superseded revision renders nothing: its not-run/failed counts are not the
 * run's results, and the completion banner's "Superseded" card is the one notice with the "Open revision N" action (CLA-264).
 */
export function OperatorCoverage({ detail, superseded }: { detail: Pick<DraftDetail, 'draft' | 'scopes'>; superseded?: { revision?: number } }) {
  if (superseded) return null;
  const quiet = belowCapChip(detail.scopes);
  return <div className="operator-coverage">{coverageChips(detail.draft.coverage, detail.scopes).map(chip => <span key={chip}>{chip}</span>)}{quiet && <span className="operator-chip-quiet">{quiet}</span>}</div>;
}
