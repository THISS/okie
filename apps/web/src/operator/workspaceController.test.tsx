import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OperatorApiError, type DraftDetail, type OperatorDraft, type OperatorRunDetail } from './api';
import { completionBanner } from './completion';
import { OperatorCompletionBanner } from './OperatorBatchRetry';
import { OperatorScopeList } from './OperatorScopeList';
import { OperatorAccessMessage, OperatorCoverage } from './OperatorViews';
import { ScopeInspector } from './OperatorWorkspace';
import { OPERATOR_NOT_OPERATOR, OPERATOR_SESSION_EXPIRED } from './reviewState';
import { failureEffect, loadReview, previewReturnSelection, publishRevision, type ReviewApi } from './workspaceController';

/**
 * CLA-264: the OperatorWorkspace's decisions, driven through a mocked API. The workspace component calls exactly these
 * (loadReview for every load, failureEffect for every failure, publishRevision for publish, OperatorCoverage for the
 * coverage row), so reverting that wiring to the old inline logic removes the behaviour these tests pin.
 */
const draft = (id: string, revision: number, coverage = { total: 255, accepted: 236, failed: 19, notRun: 0, stale: 0 }): OperatorDraft => ({ draftRevisionId: id, runId: 'run-1', revision, state: 'open', coverage });
const detailOf = (value: OperatorDraft, state: 'accepted' | 'not run' = 'accepted'): DraftDetail => ({ draft: value, source: { owner: 'acme', repo: 'app' }, scopes: [{ scopeId: 'sys', name: 'System', state }], usage: {} });
const runDetail = (current: OperatorDraft): OperatorRunDetail => ({ run: { runId: 'run-1', state: 'awaiting_review', createdAt: 0, updatedAt: 1, draftRevisionId: current.draftRevisionId, source: { owner: 'acme', repo: 'app', slug: 'acme__app' } }, draft: current, attempts: [], events: [], usage: {} });
const noop = () => undefined;
/** A full run: enrichment worked on revision 1 (every scope "not run" there) and installed its results as revision 2. */
function api(): ReviewApi & { draft: ReturnType<typeof vi.fn> } {
  const working = draft('draft-1', 1, { total: 255, accepted: 0, failed: 19, notRun: 236, stale: 0 }); const enriched = draft('draft-2', 2);
  const drafts: Record<string, DraftDetail> = { 'draft-1': detailOf(working, 'not run'), 'draft-2': detailOf(enriched) };
  return { run: vi.fn(async () => runDetail(enriched)), draft: vi.fn(async (id: string) => drafts[id]!) };
}

describe('operator workspace controller', () => {
  it('follows the run to its current revision when nothing is pinned, and never shows the working revision as the result', async () => {
    const mocked = api();
    const loaded = (await loadReview(mocked, 'run-1', undefined, undefined))!;
    expect(mocked.draft).toHaveBeenCalledWith('draft-2');
    expect(loaded.detail?.draft.revision).toBe(2); expect(loaded.superseded).toBeUndefined();
    const markup = renderToStaticMarkup(<OperatorCoverage detail={loaded.detail!}/>);
    expect(markup).toContain('1/1 in scope accepted'); expect(markup).toContain('0 not run'); // chips from revision 2's scope list
    expect(markup).not.toContain('Superseded');
  });
  it('keeps an explicit pin, marks it superseded by the numbered current revision, and hides its not-run counts', async () => {
    const mocked = api();
    const loaded = (await loadReview(mocked, 'run-1', 'draft-1', undefined))!;
    expect(mocked.draft).toHaveBeenCalledWith('draft-1');
    expect(loaded.superseded).toEqual({ draftRevisionId: 'draft-2', revision: 2 });
    expect(renderToStaticMarkup(<OperatorCoverage detail={loaded.detail!} superseded={loaded.superseded!}/>)).toBe('');
    const banner = completionBanner({ run: loaded.runDetail.run, events: [], scopes: loaded.detail!.scopes, newerRevision: true, newerRevisionNumber: loaded.superseded!.revision! })!;
    const markup = renderToStaticMarkup(<OperatorCompletionBanner banner={banner} busy={undefined} onPreview={noop} onPublish={noop} onRetryFailed={noop} onRetryNotRun={noop} onReviewNewer={noop}/>);
    expect(markup.match(/Superseded — results are in revision 2/g)).toHaveLength(1); expect(markup.match(/>Open revision 2</g)).toHaveLength(1);
    expect(markup).not.toMatch(/not run|failed|Retry/);
    // An explicit one-off target (Open current revision) wins over the pin.
    expect((await loadReview(mocked, 'run-1', 'draft-1', 'draft-2'))!.detail?.draft.draftRevisionId).toBe('draft-2');
  });
  it('drops late responses and refuses a revision from another run', async () => {
    const mocked = api(); let wanted = true;
    mocked.draft.mockImplementationOnce(async () => { wanted = false; return detailOf(draft('draft-2', 2)); });
    expect(await loadReview(mocked, 'run-1', undefined, undefined, () => wanted)).toBeUndefined();
    mocked.draft.mockImplementationOnce(async () => ({ ...detailOf(draft('draft-9', 9)), draft: { ...draft('draft-9', 9), runId: 'run-2' } }));
    await expect(loadReview(mocked, 'run-1', 'draft-9', undefined)).rejects.toThrow('different run');
  });
  it('turns a 403 not_operator into the not-an-operator page and a 401 session_expired into the expired page', async () => {
    const checkSession = vi.fn(async () => ({ operator: false }));
    const revoked = await failureEffect(new OperatorApiError(403, 'operator access required', { error: 'operator access required', code: 'not_operator' }), { wasAllowed: true, checkSession, fallback: 'x' });
    expect(revoked).toEqual({ denied: 'not-operator' }); expect(checkSession).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(<OperatorAccessMessage revoked/>)).toContain(OPERATOR_NOT_OPERATOR);
    expect(await failureEffect(new OperatorApiError(401, 'operator access required', { code: 'session_expired' }), { wasAllowed: true, checkSession, fallback: 'x' })).toEqual({ denied: 'expired' });
    expect(renderToStaticMarkup(<OperatorAccessMessage expired/>)).toContain(OPERATOR_SESSION_EXPIRED);
    // A stale-revision 409 carries its context for "Open current revision"; a failure from a run the user left is ignored.
    const superseded = new OperatorApiError(409, 'draft is no longer current', { code: 'draft_superseded', currentDraftRevisionId: 'draft-2' });
    expect(await failureEffect(superseded, { wasAllowed: true, checkSession, fallback: 'x', failedRunId: 'run-1', selectedRunId: 'run-1' })).toMatchObject({ stale: { runId: 'run-1', currentDraftRevisionId: 'draft-2' } });
    expect(await failureEffect(superseded, { wasAllowed: true, checkSession, fallback: 'x', failedRunId: 'run-1', selectedRunId: 'run-2' })).toEqual({ ignore: true });
  });
  it('recognises a publication conflict by its 409 code only', async () => {
    expect(await publishRevision(async () => ({ publication: { versionId: 'publication-1' } }))).toEqual({ published: 'publication-1' });
    expect(await publishRevision(async () => { throw new OperatorApiError(409, 'stale', { code: 'publication_stale', reason: 'stale_publication' }); })).toEqual({ conflict: true });
    await expect(publishRevision(async () => { throw new OperatorApiError(409, 'operator action already running', { code: 'run_active' }); })).rejects.toThrow('already running');
    await expect(publishRevision(async () => { throw new OperatorApiError(409, 'Request failed (409)'); })).rejects.toThrow('409');
  });
  it('shows a superseded revision\'s scopes as "superseded", never "not run"/"failed", with every retry control off (CLA-264)', () => {
    const scopes = [{ scopeId: 'sys', name: 'okie', kind: 'softwareSystem', depth: 0, state: 'not run' as const }, { scopeId: 'web', name: '@okie/web', kind: 'container', depth: 1, parentScopeId: 'sys', state: 'failed' as const }, { scopeId: 'api', name: 'api', kind: 'container', depth: 1, parentScopeId: 'sys', state: 'accepted' as const, explanation: { summary: 's', evidence: [] } }];
    const list = (superseded?: { revision?: number }) => renderToStaticMarkup(<OperatorScopeList filter="all" onFilter={noop} onOpen={noop} onQuery={noop} onReview={noop} onSelection={noop} onShowBelowCap={noop} onSort={noop} query="" scopes={scopes} selected={new Set(['web'])} showBelowCap={false} sort="hierarchy" {...(superseded ? { superseded } : {})}/>);
    const old = list({ revision: 3 });
    expect(old.match(/data-state="superseded"/g)).toHaveLength(2); expect(old).toContain('data-state="accepted"'); expect(old).not.toMatch(/data-state="(?:not run|failed)"/);
    expect(old).toContain('This revision is superseded. Open revision 3 to retry scopes.'); expect(old).not.toContain('Retry selected'); expect(old).not.toContain('aria-label="Select scopes"');
    expect(old.match(/<input[^>]*type="checkbox"[^>]*>/g)!.every(box => box.includes('disabled=""'))).toBe(true);
    const current = list();
    expect(current).toContain('data-state="not run"'); expect(current).toContain('data-state="failed"'); expect(current).toContain('Retry selected');
    const inspect = (superseded?: { revision?: number }) => renderToStaticMarkup(<ScopeInspector canRetry hidden="visible" lookup={new Map(scopes.map(item => [item.scopeId, item]))} onRetry={noop} retrying={false} scope={scopes[0]!} {...(superseded ? { superseded } : {})}/>);
    const inspector = inspect({ revision: 3 });
    expect(inspector).toContain('>superseded · softwareSystem</p>'); expect(inspector).not.toContain('not run');
    expect(inspector).toMatch(/<button disabled="" title="This revision is superseded. Open revision 3 to retry scopes.">Retry this scope…<\/button>/);
    expect(inspect()).toContain('>not run · softwareSystem</p>'); expect(inspect()).toMatch(/<button>Retry this scope…<\/button>/);
  });
  it('restores a previewed revision on return only when it was an explicit pin', () => {
    expect(previewReturnSelection('run-1', 'draft-1', false)).toEqual({ runId: 'run-1' });
    expect(previewReturnSelection('run-1', 'draft-1', true)).toEqual({ runId: 'run-1', draftRevisionId: 'draft-1' });
  });
});
