import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OperatorAccessMessage, OperatorCoverage, OperatorErrorAlert, OperatorStoredError } from './OperatorViews';
import { OPERATOR_NOT_OPERATOR, OPERATOR_SESSION_EXPIRED, STALE_REVISION_MESSAGE } from './reviewState';

const noop = () => undefined;

describe('operator access and stale-revision views', () => {
  it('renders the expired-session page with a sign-in link back to /operator', () => {
    const markup = renderToStaticMarkup(<OperatorAccessMessage expired/>);
    expect(markup).toContain(OPERATOR_SESSION_EXPIRED);
    expect(markup).toContain(`href="/api/auth/github?return=${encodeURIComponent('/operator')}"`);
    expect(markup).toContain('href="/"');
    expect(renderToStaticMarkup(<OperatorAccessMessage/>)).toContain('available only to configured operators');
    expect(renderToStaticMarkup(<OperatorAccessMessage/>)).not.toContain('session expired');
  });
  it('shows a removed operator a distinct not-an-operator page, not "session expired" (CLA-264)', () => {
    const revoked = renderToStaticMarkup(<OperatorAccessMessage revoked/>);
    expect(revoked).toContain(OPERATOR_NOT_OPERATOR); expect(revoked).not.toContain(OPERATOR_SESSION_EXPIRED); expect(revoked).toContain('data-access="not-operator"');
    expect(renderToStaticMarkup(<OperatorAccessMessage expired/>)).toContain('data-access="expired"');
    expect(revoked).toContain(`href="/api/auth/github?return=${encodeURIComponent('/operator')}"`);
  });
  it('renders no coverage row for a superseded revision: the completion banner is its one notice (CLA-264)', () => {
    const detail = { draft: { draftRevisionId: 'draft-1', runId: 'run-1', revision: 1, state: 'open' as const, coverage: { total: 2, accepted: 0, failed: 1, notRun: 1, stale: 0 } }, scopes: [{ scopeId: 'a', name: 'A', state: 'not run' as const }, { scopeId: 'b', name: 'B', state: 'failed' as const }] };
    expect(renderToStaticMarkup(<OperatorCoverage detail={detail} superseded={{ revision: 4 }}/>)).toBe('');
    expect(renderToStaticMarkup(<OperatorCoverage detail={detail}/>)).toContain('not run');
  });
  it('shows "Open current revision" only when the stale context belongs to the selected run', () => {
    const stale = { runId: 'run-a', currentDraftRevisionId: 'draft-2' };
    const matching = renderToStaticMarkup(<OperatorErrorAlert error={STALE_REVISION_MESSAGE} onOpenCurrent={noop} opening={false} selectedRunId="run-a" stale={stale}/>);
    expect(matching).toContain(STALE_REVISION_MESSAGE);
    expect(matching).toContain('Open current revision');
    expect(renderToStaticMarkup(<OperatorErrorAlert error="x" onOpenCurrent={noop} opening={false} selectedRunId="run-b" stale={stale}/>)).not.toContain('<button');
    expect(renderToStaticMarkup(<OperatorErrorAlert error="x" onOpenCurrent={noop} opening={false} selectedRunId="run-a"/>)).not.toContain('<button');
  });
  it('keeps the button mounted (disabled) while opening', () => {
    const markup = renderToStaticMarkup(<OperatorErrorAlert error={STALE_REVISION_MESSAGE} onOpenCurrent={noop} opening selectedRunId="run-a" stale={{ runId: 'run-a' }}/>);
    expect(markup).toContain('Opening…');
    expect(markup).toContain('disabled');
  });
  it('renders a stored run/attempt error as sent (the server normalizes and scrubs it, CLA-261)', () => {
    const normalized = 'llm gateway 400: fake/model is not a valid model ID';
    const markup = renderToStaticMarkup(<OperatorStoredError error={normalized}/>);
    expect(markup).toBe(`<p class="operator-alert">${normalized}</p>`);
  });
});
