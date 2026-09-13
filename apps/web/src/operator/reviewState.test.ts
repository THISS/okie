import { describe, expect, it } from 'vitest';
import { acceptsReviewResponse, OperatorReviewLoader, publicationAcknowledgementAfterConflict, selectedDraftForRun } from './reviewState';

describe('operator review flow state', () => {
  it('keeps a selected draft pinned while polling discovers a newer run revision', () => {
    expect(selectedDraftForRun('draft-1', { draftRevisionId: 'draft-2' })).toBe('draft-1');
    expect(selectedDraftForRun(undefined, { draftRevisionId: 'draft-2' })).toBe('draft-2');
  });
  it('rejects a late response after selection changes', () => {
    expect(acceptsReviewResponse(3, 4, 'run-a', 'run-a')).toBe(false);
    expect(acceptsReviewResponse(4, 4, 'run-a', 'run-b')).toBe(false);
    expect(acceptsReviewResponse(4, 4, 'run-a', 'run-a')).toBe(true);
  });
  it('requires a fresh coverage acknowledgement after a publish conflict refresh', () => {
    expect(publicationAcknowledgementAfterConflict()).toBe(false);
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
