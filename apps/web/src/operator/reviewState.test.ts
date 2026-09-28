import { describe, expect, it } from 'vitest';
import { OperatorApiError, type OperatorEvent } from './api';
import { acceptsReviewResponse, ACTION_RUNNING_MESSAGE, OPERATOR_SESSION_EXPIRED, attemptLabel, belowCapChip, classifyOperatorFailure, usageSummary, coverageChips, coverageIncomplete, currentRevisionTarget, draftBelongsToRun, followsCurrentRevision, humanizeEventType, isPublicationConflict, OPERATOR_NOT_OPERATOR, supersededBy, supersededLabel, money, runStateLabel, staleRevisionAfterFailure, staleRevisionFor, usageDiffers, operatorEventLabel, OperatorReviewLoader, publicationAcknowledgementAfterConflict, resetReviewForRun, scopeStateLabel, selectedDraftForRun, STALE_REVISION_MESSAGE } from './reviewState';

describe('operator review flow state', () => {
  it('keeps a selected draft pinned while polling discovers a newer run revision', () => {
    expect(selectedDraftForRun('draft-1', { draftRevisionId: 'draft-2' })).toBe('draft-1');
    expect(selectedDraftForRun(undefined, { draftRevisionId: 'draft-2' })).toBe('draft-2');
  });
  it('follows the run to its current revision unless a revision was explicitly pinned (CLA-264)', () => {
    // A full run: enrichment works on draft-1, then installs its results as draft-2. Unpinned review must move on.
    expect(followsCurrentRevision(undefined, 'draft-2', 'draft-1')).toBe(true);
    expect(followsCurrentRevision(undefined, 'draft-2', 'draft-2')).toBe(false);
    expect(followsCurrentRevision('draft-1', 'draft-2', 'draft-1')).toBe(false); // an explicit choice stays
    expect(followsCurrentRevision(undefined, undefined, 'draft-1')).toBe(false);
  });
  it('marks a displayed revision superseded, naming the current revision number when known (CLA-264)', () => {
    const displayed = { draftRevisionId: 'draft-1' }; const run = { draftRevisionId: 'draft-2' };
    expect(supersededBy(displayed, run, { draftRevisionId: 'draft-2', revision: 4 })).toEqual({ draftRevisionId: 'draft-2', revision: 4 });
    expect(supersededBy(displayed, run, { draftRevisionId: 'draft-1', revision: 3 })).toEqual({ draftRevisionId: 'draft-2' }); // a mismatched current draft never lends its number
    expect(supersededBy({ draftRevisionId: 'draft-2' }, run)).toBeUndefined();
    expect(supersededBy(displayed, { draftRevisionId: undefined })).toBeUndefined();
    expect(supersededLabel({ revision: 4 })).toBe('Superseded — results are in revision 4');
    expect(supersededLabel({})).toBe('Superseded — results are in a newer revision');
  });
  it('rejects a late response after selection changes', () => {
    expect(acceptsReviewResponse(3, 4, 'run-a', 'run-a')).toBe(false);
    expect(acceptsReviewResponse(4, 4, 'run-a', 'run-b')).toBe(false);
    expect(acceptsReviewResponse(4, 4, 'run-a', 'run-a')).toBe(true);
  });
  it('requires a fresh coverage acknowledgement after a publish conflict refresh', () => {
    expect(publicationAcknowledgementAfterConflict()).toBe(false);
  });
  it('shows accepted / failed / not run / stale coverage chips that match the scope list', () => {
    expect(coverageChips({ total: 10, accepted: 3, failed: 1, notRun: 6, stale: 1 })).toEqual(['3/10 in scope accepted', '1 failed', '6 not run', '1 stale']);
    expect(coverageChips({ total: 4, accepted: 3, failed: 1, stale: 0 })).toEqual(['3/4 in scope accepted', '1 failed', '0 not run', '0 stale']);
    expect(coverageChips({ total: 4, accepted: 3, failed: 1, stale: 0 }, [{ state: 'accepted' }, { state: 'failed' }, { state: 'not run' }, { state: 'accepted', stale: true }])).toEqual(['1/4 in scope accepted', '1 failed', '1 not run', '1 stale']);
    expect(scopeStateLabel({ state: 'not run' })).toBe('not run');
    expect(scopeStateLabel({ state: 'accepted', stale: true })).toBe('stale');
  });
  it('counts chips from the visible scope-list labels so every chip equals the labels shown', () => {
    const scopes = [{ state: 'accepted' as const }, { state: 'accepted' as const, stale: true }, { state: 'failed' as const }, { state: 'failed' as const, stale: true }, { state: 'not run' as const }, { state: 'running' as const }, { state: 'interrupted' as const }];
    const chips = coverageChips({ total: 7, accepted: 2, failed: 2, notRun: 1, stale: 2 }, scopes);
    expect(chips).toEqual(['1/7 in scope accepted', '1 failed', '1 not run', '2 stale', '1 running', '1 interrupted']);
    const labels = scopes.map(scopeStateLabel);
    for (const chip of chips.slice(1)) { const [count, ...rest] = chip.split(' '); expect(labels.filter(label => label === rest.join(' ')).length).toBe(Number(count)); }
    expect(chips.reduce((sum, chip) => sum + Number(chip.split(/[ /]/)[0]), 0)).toBe(scopes.length);
    expect(coverageChips({ total: 2, accepted: 2, failed: 0, notRun: 0, stale: 0 }, [{ state: 'accepted' }, { state: 'accepted' }])).toEqual(['2/2 in scope accepted', '0 failed', '0 not run', '0 stale']);
    expect(coverageChips({ total: 1, accepted: 0, failed: 0, notRun: 0, stale: 0 }, [{ state: 'cancelled' }])).toEqual(['0/1 in scope accepted', '0 failed', '0 not run', '0 stale', '1 cancelled']);
  });
  it('counts in-scope chips only and gives below-cap scopes a separate chip (CLA-258)', () => {
    const scopes = [{ state: 'accepted' as const }, { state: 'accepted' as const }, ...Array.from({ length: 3793 }, () => ({ state: 'below cap' as const }))];
    expect(coverageChips({ total: 3795, accepted: 2, failed: 0, notRun: 0, stale: 0, belowCap: 3793 }, scopes)).toEqual(['2/2 in scope accepted', '0 failed', '0 not run', '0 stale']);
    expect(belowCapChip(scopes)).toBe('3,793 below depth cap'); expect(belowCapChip([{ state: 'accepted' }])).toBeUndefined();
    expect(coverageChips({ total: 10, accepted: 2, failed: 0, notRun: 0, stale: 0, belowCap: 8 })).toEqual(['2/2 in scope accepted', '0 failed', '0 not run', '0 stale']);
    expect(coverageIncomplete({ total: 10, accepted: 2, failed: 0, notRun: 0, stale: 0, belowCap: 8 })).toBe(false);
    expect(coverageIncomplete({ total: 10, accepted: 1, failed: 0, notRun: 1, stale: 0, belowCap: 8 })).toBe(true);
  });
  it('keeps sub-cent money precise instead of rounding to $0.00', () => {
    expect(money(0.00076)).toBe('$0.0008'); expect(money(0.0039)).toBe('$0.0039'); expect(money(0.33)).toBe('$0.33'); expect(money(0)).toBe('$0.00'); expect(money(12.5)).toBe('$12.50');
  });
  it('hides zero usage and summarises reported usage', () => {
    expect(usageSummary(undefined)).toBeUndefined();
    expect(usageSummary({ inputTokens: 0, outputTokens: 0 })).toBeUndefined();
    expect(usageSummary({ inputTokens: 1200, outputTokens: 30, measuredCostUsd: 0.33 })).toBe(`1,200 in / 30 out tokens · measured ${money(0.33)}`);
    expect(usageSummary({ inputTokens: 5, outputTokens: 1 })).toBe('5 in / 1 out tokens · cost not reported');
    expect(operatorEventLabel({ type: 'enrichment.finished', detail: { kind: 'run', stopped: 'complete', accepted: 255, inScope: 255 } })).toBe('Enrichment finished · 255/255 in scope accepted');
    expect(operatorEventLabel({ type: 'enrichment.finished', detail: { kind: 'retry', stopped: 'limit', accepted: 3, inScope: 5 } })).toBe('Retry pass stopped at the budget limit · 3/5 in scope accepted');
  });
  it('keeps requiring acknowledgement for any not-run, failed or stale coverage', () => {
    expect(coverageIncomplete({ total: 2, accepted: 2, failed: 0, notRun: 0, stale: 0 })).toBe(false);
    expect(coverageIncomplete({ total: 2, accepted: 1, failed: 0, notRun: 1, stale: 0 })).toBe(true);
    expect(coverageIncomplete({ total: 2, accepted: 2, failed: 0, stale: 1 })).toBe(true);
    expect(coverageIncomplete({ total: 2, accepted: 1, failed: 1, stale: 0 })).toBe(true);
  });
  it('clears draft-local state when switching runs', () => {
    expect(resetReviewForRun()).toEqual({ draftRevisionId: undefined, acknowledged: false });
  });
  it('loads a newly available draft on a later active-run poll and keeps an explicit older revision', async () => {
    let polls = 0;
    const loader = new OperatorReviewLoader(async () => ({ run: { runId: 'run-1', state: 'awaiting_review', createdAt: 0, updatedAt: ++polls, draftRevisionId: polls === 1 ? 'draft-1' : 'draft-2', source: { owner: 'acme', repo: 'app', slug: 'acme__app' } } }), async id => ({ draft: { draftRevisionId: id, runId: 'run-1', revision: 1, state: 'open', coverage: { total: 1, accepted: 1, failed: 0, stale: 0 } }, source: { owner: 'acme', repo: 'app' }, scopes: [], usage: {} }));
    expect((await loader.refresh('run-1', 'run-1'))?.detail?.draft.draftRevisionId).toBe('draft-1');
    expect((await loader.refresh('run-1', 'run-1', 'draft-1'))?.detail?.draft.draftRevisionId).toBe('draft-1');
  });
  it('drops a late draft response after a newer refresh starts', async () => {
    let resolveFirst!: (value: { draft: { draftRevisionId: string; runId: string; revision: number; state: 'open'; coverage: { total: number; accepted: number; failed: number; stale: number } }; source: { owner: string; repo: string }; scopes: []; usage: {} }) => void;
    let draftCalls = 0;
    const payload = { draft: { draftRevisionId: 'draft-1', runId: 'run-1', revision: 1, state: 'open' as const, coverage: { total: 1, accepted: 1, failed: 0, stale: 0 } }, source: { owner: 'acme', repo: 'app' }, scopes: [] as [], usage: {} };
    const loader = new OperatorReviewLoader(async () => ({ run: { runId: 'run-1', state: 'awaiting_review', createdAt: 0, updatedAt: 0, draftRevisionId: 'draft-1', source: { owner: 'acme', repo: 'app', slug: 'acme__app' } } }), () => ++draftCalls === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve(payload));
    const late = loader.refresh('run-1', 'run-1');
    await Promise.resolve(); await Promise.resolve();
    const newer = loader.refresh('run-2', 'run-2');
    resolveFirst(payload);
    expect(await late).toBeUndefined();
    expect((await newer)?.detail?.draft.draftRevisionId).toBe('draft-1');
  });
});

describe('operator run activity labels', () => {
  const names = (id: string) => ({ 'component:api': 'API' } as Record<string, string>)[id];
  it('labels every server-emitted event type without raw dotted strings', () => {
    const events: Pick<OperatorEvent, 'type' | 'detail'>[] = [
      { type: 'run.state', detail: { previous: 'queued', state: 'running' } },
      { type: 'run.state', detail: { previous: 'running', state: 'awaiting_review' } },
      { type: 'budget.reserved', detail: { requestId: 'r1', tokens: 4000, dollars: 0.05 } },
      { type: 'budget.reserved', detail: { requestId: 'r2', tokens: 100, dollars: 0.01, kind: 'judgment' } },
      { type: 'budget.settled', detail: { requestId: 'r1', inputTokens: 1200, outputTokens: 300, measuredCostUsd: 0.01 } },
      { type: 'budget.released', detail: { requestId: 'r1' } },
      { type: 'draft.conflict', detail: { reason: 'stale_retry_base', draftRevisionId: 'd1' } },
      { type: 'draft.conflict', detail: { reason: 'retry_compare_and_swap' } },
      { type: 'enrichment.retry_failed', detail: { scopeId: 'component:api' } },
      { type: 'enrichment.budget_refused', detail: { scopeId: 'component:api', ledger: 'global' } },
      { type: 'enrichment.unavailable', detail: { reason: 'no enrichment gateway configured' } },
      { type: 'enrichment.budget_reached', detail: { accepted: 3, attempted: 5, ledger: 'run' } },
      { type: 'something.new_kind' },
    ];
    const labels = events.map(event => operatorEventLabel(event, names));
    expect(labels).toEqual([
      'Run running', 'Run awaiting review', `Budget reserved · up to 4000 tokens / ${money(0.05)}`, `Judgment budget reserved · up to 100 tokens / ${money(0.01)}`,
      `Budget settled · 1200 in / 300 out tokens · ${money(0.01)}`, 'Budget released (request not sent)',
      'Draft conflict: action started from an older revision', 'Draft conflict: a newer revision was installed first',
      'Retry failed · API', 'Enrichment refused by the global budget · API', 'Enrichment unavailable: no enrichment gateway configured',
      'Enrichment stopped at the budget limit · 3 accepted of 5 attempted', 'Something new kind',
    ]);
    for (const [index, label] of labels.entries()) expect(label).not.toContain(events[index]!.type);
  });
  it('humanizes unknown event types and labels attempts', () => {
    expect(humanizeEventType('foo.bar_baz')).toBe('Foo bar baz');
    expect(humanizeEventType('')).toBe('Event');
    expect(attemptLabel({ kind: 'enrichment', state: 'failed', scopeId: 'component:api' }, names)).toBe('API: enrichment failed');
    expect(attemptLabel({ kind: 'retry', state: 'accepted', scopeId: 'component:unknown' }, names)).toBe('component:unknown: retry accepted');
    expect(runStateLabel('awaiting_review')).toBe('Awaiting review');
    expect(runStateLabel('running')).toBe('Running');
  });
});

describe('operator failure classification', () => {
  const operator = async () => ({ operator: true });
  const notOperator = async () => ({ operator: false });
  it('treats 401/403 after access was allowed as an expired session when the re-check says not operator', async () => {
    expect(await classifyOperatorFailure(new OperatorApiError(401, 'operator access required'), true, notOperator)).toEqual({ kind: 'expired' });
    expect(await classifyOperatorFailure(new OperatorApiError(403, 'operator access required'), true, notOperator)).toEqual({ kind: 'expired' });
  });
  it('keeps the original error when the session is still valid, the re-check fails, or access was never allowed', async () => {
    expect(await classifyOperatorFailure(new OperatorApiError(403, 'operator access required'), true, operator)).toEqual({ kind: 'error', message: 'operator access required' });
    expect(await classifyOperatorFailure(new OperatorApiError(401, 'operator access required'), true, async () => { throw new Error('offline'); })).toEqual({ kind: 'error', message: 'operator access required' });
    let checks = 0;
    expect(await classifyOperatorFailure(new OperatorApiError(401, 'operator access required'), false, async () => { checks += 1; return { operator: false }; })).toEqual({ kind: 'error', message: 'operator access required' });
    expect(checks).toBe(0);
    expect(await classifyOperatorFailure(new Error('boom'), true, notOperator)).toEqual({ kind: 'error', message: 'boom' });
  });
  it('distinguishes a stale revision 409 from an action already running by code, never by message text (CLA-264)', async () => {
    expect(await classifyOperatorFailure(new OperatorApiError(409, 'draft is no longer current', { error: 'draft is no longer current', code: 'draft_superseded', currentDraftRevisionId: 'draft-2' }), true, operator)).toEqual({ kind: 'stale-revision', message: STALE_REVISION_MESSAGE, currentDraftRevisionId: 'draft-2' });
    expect(await classifyOperatorFailure(new OperatorApiError(409, 'reworded by the server', { error: 'reworded by the server', code: 'draft_superseded' }), true, operator)).toEqual({ kind: 'stale-revision', message: STALE_REVISION_MESSAGE });
    expect(await classifyOperatorFailure(new OperatorApiError(409, 'operator action already running', { error: 'operator action already running', code: 'run_active' }), true, operator)).toEqual({ kind: 'action-running', message: ACTION_RUNNING_MESSAGE });
    expect(await classifyOperatorFailure(new OperatorApiError(409, 'operator action already running', { error: 'operator action already running' }), true, operator)).toEqual({ kind: 'error', message: 'operator action already running' }); // text alone is display-only
    expect(await classifyOperatorFailure(new OperatorApiError(409, 'Request failed (409)'), true, operator)).toEqual({ kind: 'error', message: 'Request failed (409)' });
    expect(isPublicationConflict(new OperatorApiError(409, 'stale', { code: 'publication_stale', reason: 'stale_publication' }))).toBe(true);
    expect(isPublicationConflict(new OperatorApiError(409, 'operator action already running', { code: 'run_active' }))).toBe(false);
    expect(isPublicationConflict(new Error('publication_stale'))).toBe(false);
  });
  it('tells a removed operator apart from an expired session by the 401/403 code, without a session re-check (CLA-264)', async () => {
    let checks = 0; const counted = async () => { checks += 1; return { operator: false }; };
    expect(await classifyOperatorFailure(new OperatorApiError(403, 'operator access required', { error: 'operator access required', code: 'not_operator' }), true, counted)).toEqual({ kind: 'not-operator' });
    expect(await classifyOperatorFailure(new OperatorApiError(401, 'operator access required', { error: 'operator access required', code: 'session_expired' }), true, counted)).toEqual({ kind: 'expired' });
    const csrf = await classifyOperatorFailure(new OperatorApiError(403, 'operator access required', { error: 'operator access required', code: 'csrf_rejected' }), true, counted);
    expect(csrf.kind).toBe('error'); expect(checks).toBe(0);
    expect(OPERATOR_NOT_OPERATOR).not.toBe(OPERATOR_SESSION_EXPIRED);
  });
  it('opens the freshly refreshed run revision, falling back to the 409-reported one', () => {
    expect(currentRevisionTarget('draft-3', 'draft-2')).toBe('draft-3');
    expect(currentRevisionTarget(undefined, 'draft-2')).toBe('draft-2');
    expect(currentRevisionTarget(undefined, undefined)).toBeUndefined();
  });
  it('scopes stale-revision context to the run whose action failed', () => {
    const stale = { kind: 'stale-revision' as const, message: STALE_REVISION_MESSAGE, currentDraftRevisionId: 'draft-2' };
    expect(staleRevisionAfterFailure(stale, 'run-a', 'run-a', undefined)).toEqual({ apply: true, stale: { runId: 'run-a', currentDraftRevisionId: 'draft-2' } });
    expect(staleRevisionAfterFailure(stale, 'run-a', 'run-b', undefined)).toEqual({ apply: false, stale: undefined });
    const previous = { runId: 'run-a', currentDraftRevisionId: 'draft-2' };
    expect(staleRevisionAfterFailure({ kind: 'error', message: 'boom' }, 'run-a', 'run-a', previous)).toEqual({ apply: true, stale: undefined });
    expect(staleRevisionAfterFailure({ kind: 'error', message: 'boom' }, 'run-a', 'run-a', previous, true)).toEqual({ apply: true, stale: previous });
    expect(staleRevisionFor(previous, 'run-a')).toBe(previous);
    expect(staleRevisionFor(previous, 'run-b')).toBeUndefined();
    expect(staleRevisionFor(previous, undefined)).toBeUndefined();
    expect(draftBelongsToRun({ draft: { draftRevisionId: 'draft-2', runId: 'run-a', revision: 2, state: 'open', coverage: { total: 0, accepted: 0, failed: 0, stale: 0 } } }, 'run-b')).toBe(false);
    expect(draftBelongsToRun({ draft: { draftRevisionId: 'draft-2', runId: 'run-a', revision: 2, state: 'open', coverage: { total: 0, accepted: 0, failed: 0, stale: 0 } } }, 'run-a')).toBe(true);
  });
  it('shows revision usage only when it differs from the run total', () => {
    expect(usageDiffers({ inputTokens: 10, outputTokens: 2, measuredCostUsd: 0.1 }, { inputTokens: 10, outputTokens: 2, measuredCostUsd: 0.1 })).toBe(false);
    expect(usageDiffers({ inputTokens: 20, outputTokens: 4 }, { inputTokens: 10, outputTokens: 2 })).toBe(true);
    expect(usageDiffers({ inputTokens: 1 }, undefined)).toBe(false);
  });
});
