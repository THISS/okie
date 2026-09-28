import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OperatorAccessMessage, OperatorErrorAlert } from './OperatorViews';
import { OPERATOR_SESSION_EXPIRED, STALE_REVISION_MESSAGE } from './reviewState';

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
});
