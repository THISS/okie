import { askSignInHref } from '../ask/askAtlas';
import { OPERATOR_SESSION_EXPIRED, staleRevisionFor, type StaleRevisionContext } from './reviewState';

/** Access-denied and expired-session page: message, sign-in back to /operator, and a way home. */
export function OperatorAccessMessage({ expired = false }: { expired?: boolean }) {
  return <main className="operator-shell operator-message" role="alert"><h1>Operator workspace</h1><p>{expired ? OPERATOR_SESSION_EXPIRED : 'This workspace is available only to configured operators.'}</p><nav className="operator-message-links"><a href={askSignInHref('/api/auth/github', '/operator')}>Sign in with GitHub</a><a href="/">Return to atlas</a></nav></main>;
}

/** Action error; the "Open current revision" button only renders when the stale context belongs to the selected run. */
export function OperatorErrorAlert({ error, stale, selectedRunId, opening, onOpenCurrent }: { error: string; stale?: StaleRevisionContext; selectedRunId?: string; opening: boolean; onOpenCurrent(runId: string): void }) {
  const current = staleRevisionFor(stale, selectedRunId);
  return <div className="operator-alert" role="alert"><p>{error}</p>{current && <button disabled={opening} onClick={() => onOpenCurrent(current.runId)}>{opening ? 'Opening…' : 'Open current revision'}</button>}</div>;
}
