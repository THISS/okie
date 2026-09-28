import { describe, expect, it } from 'vitest';
import type { OperatorEvent, OperatorScope } from './api';
import { completionBanner, formatDuration } from './completion';

const run = (state: 'awaiting_review' | 'running' | 'cancelled' | 'failed' | 'interrupted' = 'awaiting_review') => ({ state, createdAt: 1_000_000, updatedAt: 1_000_000 + 252_000 });
/** Accepted fixtures carry an explanation, as the server only reports "accepted" with one. */
const scope = (scopeId: string, state: OperatorScope['state'], extra: Partial<OperatorScope> = {}): OperatorScope => ({ scopeId, name: scopeId, state, kind: 'component', depth: 1, parentScopeId: 'sys', ...(state === 'accepted' ? { explanation: { summary: 's', evidence: [] } } : {}), ...extra });
const sys = scope('sys', 'accepted', { kind: 'softwareSystem', depth: 0, parentScopeId: undefined as never });
const finished = (detail: Record<string, string | number>): Pick<OperatorEvent, 'type' | 'detail'> => ({ type: 'enrichment.finished', detail });

describe('completion banner', () => {
  it('formats durations', () => { expect(formatDuration(252_000)).toBe('4m 12s'); expect(formatDuration(38_400)).toBe('38s'); expect(formatDuration(3_720_000)).toBe('1h 2m'); });
  it('reads a legacy (CLA-254) live run as complete: no enrichment.finished, below-cap code scopes out of scope', () => {
    const scopes = [sys, ...Array.from({ length: 254 }, (_, index) => scope(`c${index}`, 'accepted')), ...Array.from({ length: 3793 }, (_, index) => scope(`code${index}`, 'below cap', { kind: 'code' }))];
    const banner = completionBanner({ run: run(), events: [{ type: 'run.state', detail: { state: 'awaiting_review' } }, { type: 'budget.settled', detail: {} }], scopes, usage: { inputTokens: 1, outputTokens: 1, measuredCostUsd: 0.33 } })!;
    expect(banner.kind).toBe('complete');
    expect(banner.title).toBe('Enrichment complete — 255/255 accepted in 4m 12s · $0.33');
    expect(banner.actions).toEqual(['preview-publish']);
  });
  it("shows the pass's own duration and cost when recorded; legacy falls back to the run's (estimated when unmeasured)", () => {
    const usage = { measuredCostUsd: 3.21 };
    expect(completionBanner({ run: run(), events: [finished({ kind: 'retry', stopped: 'complete', durationMs: 61_000, costUsd: 0.5 })], scopes: [sys], usage })!.title).toBe('Enrichment complete — 1/1 accepted in 1m 1s · $0.50');
    expect(completionBanner({ run: run(), events: [finished({ kind: 'retry', stopped: 'complete', durationMs: 61_000 })], scopes: [sys], usage })!.title).toBe('Enrichment complete — 1/1 accepted in 1m 1s');
    expect(completionBanner({ run: run(), events: [], scopes: [sys], usage: { estimatedCostUsd: 0.5 } })!.title).toBe('Enrichment complete — 1/1 accepted in 4m 12s · $0.50');
  });
  it('counts stale as stale (like the chips) and never calls a revision complete from states without explanations', () => {
    const stale = completionBanner({ run: run(), events: [], scopes: [sys, scope('a', 'accepted', { stale: true })] })!;
    expect(stale.kind).toBe('incomplete'); expect(stale.title).toBe('Enrichment finished — 1/2 accepted, 1 stale');
    const unexplained = completionBanner({ run: run(), events: [], scopes: [sys, scope('a', 'accepted', { explanation: undefined as never })] })!;
    expect(unexplained.kind).toBe('incomplete'); expect(unexplained.title).toBe('Enrichment finished — 1/2 accepted');
  });
  it('words a budget stop by what actually remains', () => {
    const failedOnly = completionBanner({ run: run(), events: [finished({ stopped: 'limit', durationMs: 1000 })], scopes: [sys, scope('a', 'failed')] })!;
    expect(failedOnly.title).toBe('Enrichment stopped at the budget limit — 1/2 accepted, 1 failed');
    expect(failedOnly.detail).toContain('Retry the failed scopes'); expect(failedOnly.detail).not.toContain('not-run');
    expect(failedOnly.actions).toEqual(['retry-failed']);
    const settled = completionBanner({ run: run(), events: [finished({ stopped: 'limit', durationMs: 1000 })], scopes: [sys] })!;
    expect(settled.title).toBe('Enrichment stopped at the budget limit — 1/1 accepted'); expect(settled.detail).toContain('Every in-scope scope settled');
  });
  it('offers "Retry all failed" with an estimate when scopes failed', () => {
    const banner = completionBanner({ run: run(), events: [finished({ stopped: 'complete', durationMs: 5000 })], scopes: [sys, scope('a', 'failed'), scope('b', 'failed'), scope('c', 'accepted')], avgCostPerScopeUsd: 0.01 })!;
    expect(banner.kind).toBe('failures');
    expect(banner.title).toBe('Enrichment finished with 2 failed — 2/4 accepted');
    expect(banner.failedScopeIds).toEqual(['a', 'b']);
    expect(banner.retryFailedLabel).toBe('Retry all failed (2) · est. $0.03');
    expect(banner.actions).toEqual(['retry-failed']);
  });
  it('explains a budget stop (new event and legacy budget_reached) with the not-run count', () => {
    const scopes = [sys, scope('a', 'accepted'), scope('b', 'not run'), scope('c', 'not run')];
    const current = completionBanner({ run: run(), events: [finished({ stopped: 'limit', durationMs: 5000 })], scopes })!;
    expect(current.kind).toBe('budget'); expect(current.title).toBe('Enrichment stopped at the budget limit — 2/4 accepted, 2 not run');
    expect(current.actions).toEqual(['retry-not-run']); expect(current.notRunScopeIds).toEqual(['b', 'c']);
    expect(completionBanner({ run: run(), events: [{ type: 'enrichment.budget_reached', detail: { accepted: 2, attempted: 2 } }], scopes })!.kind).toBe('budget');
    expect(completionBanner({ run: run(), events: [{ type: 'enrichment.budget_reached' }, finished({ stopped: 'complete', durationMs: 1 })], scopes: [sys] })!.kind).toBe('complete'); // a later completed pass wins
  });
  it('reports a retry pass that failed every selected scope honestly (previous explanation kept, nothing installed)', () => {
    const scopes = [sys, scope('a', 'accepted'), scope('b', 'accepted')];
    const banner = completionBanner({ run: run(), events: [{ type: 'enrichment.finished', detail: { kind: 'retry', stopped: 'complete', durationMs: 5000, selected: 1, retryAccepted: 0, retryFailed: 1, retryKept: 1, installed: false } } as Pick<OperatorEvent, 'type' | 'detail'>], scopes })!;
    expect(banner.kind).toBe('retry');
    expect(banner.title).toBe('Retry finished — 0 of 1 accepted, 1 failed (previous explanation kept)');
    expect(banner.detail).toContain('This revision: 3/3 accepted'); expect(banner.detail).toContain('No new revision was installed');
    const partial = completionBanner({ run: run(), events: [finished({ kind: 'retry', stopped: 'complete', durationMs: 5000, selected: 3, retryAccepted: 1, retryFailed: 2, retryKept: 0 })], scopes: [sys, scope('a', 'failed'), scope('b', 'failed')] })!;
    expect(partial.title).toBe('Retry finished — 1 of 3 accepted, 2 failed'); expect(partial.actions).toEqual(['retry-failed']);
    // A clean retry pass still reads as the revision's outcome.
    expect(completionBanner({ run: run(), events: [finished({ kind: 'retry', stopped: 'complete', durationMs: 1, selected: 1, retryAccepted: 1, retryFailed: 0 })], scopes })!.kind).toBe('complete');
  });
  it('says a superseded revision is superseded and never presents its scopes as failures to retry (CLA-264)', () => {
    const banner = completionBanner({ run: run(), events: [finished({ kind: 'retry', stopped: 'complete', durationMs: 1, selected: 1, retryAccepted: 1, retryFailed: 0 })], scopes: [sys, scope('a', 'failed'), scope('b', 'not run')], newerRevision: true, newerRevisionNumber: 7 })!;
    expect(banner.kind).toBe('older'); expect(banner.title).toBe('Superseded — results are in revision 7');
    expect(banner.detail).toBe("You are viewing an older revision of this run. Its scope states are as of that revision, not the run's results, so retry is off here; open revision 7 to review, retry and publish.");
    expect(banner.detail).not.toMatch(/failed|not run/);
    expect(banner.actions).toEqual(['review-newer']); expect(banner.reviewNewerLabel).toBe('Open revision 7');
    expect(banner.failedScopeIds).toEqual([]); expect(banner.notRunScopeIds).toEqual([]);
    const unnumbered = completionBanner({ run: run(), events: [], scopes: [sys, scope('b', 'not run')], newerRevision: true })!;
    expect(unnumbered.title).toBe('Superseded — results are in a newer revision'); expect(unnumbered.reviewNewerLabel).toBe('Review newer revision');
    // It is the one superseded notice, so it wins over the running/failed banners too (the coverage row renders nothing).
    for (const state of ['running', 'failed'] as const) expect(completionBanner({ run: run(state), events: [], scopes: [sys, scope('b', 'not run')], newerRevision: true, newerRevisionNumber: 3 })!.kind).toBe('older');
  });
  it('includes stale and not-run counts in the failed title', () => {
    expect(completionBanner({ run: run(), events: [finished({ stopped: 'complete', durationMs: 1 })], scopes: [sys, scope('a', 'failed'), scope('b', 'accepted', { stale: true }), scope('c', 'not run')] })!.title).toBe('Enrichment finished with 1 failed — 1/4 accepted, 1 not run, 1 stale');
  });
  it('covers cancelled, running, unavailable, run failure and incomplete outcomes', () => {
    expect(completionBanner({ run: run('cancelled'), events: [], scopes: [sys, scope('a', 'not run')] })!.title).toBe('Run cancelled — 1/2 accepted, 1 not run');
    expect(completionBanner({ run: run(), events: [finished({ stopped: 'cancelled', durationMs: 1 })], scopes: [sys] })!.kind).toBe('cancelled');
    const running = completionBanner({ run: run('running'), events: [], scopes: [sys, scope('a', 'not run'), scope('x', 'below cap', { kind: 'code' })], progress: { accepted: 1, failed: 0, inFlight: 1 } })!;
    expect(running.kind).toBe('running'); expect(running.title).toBe('Enriching… 1 settled · 1 in flight'); expect(running.detail).toContain('2 scopes in scope');
    expect(completionBanner({ run: run(), events: [{ type: 'enrichment.unavailable', detail: { reason: 'no gateway' } }], scopes: [scope('a', 'not run')] })!.kind).toBe('unavailable');
    expect(completionBanner({ run: run('failed'), events: [], scopes: [] })!.kind).toBe('run-failed');
    expect(completionBanner({ run: run('interrupted'), events: [], scopes: [sys, scope('a', 'not run')] })).toMatchObject({ kind: 'interrupted', actions: ['retry-not-run'] });
    expect(completionBanner({ run: run(), events: [], scopes: [sys, scope('a', 'accepted', { stale: true })] })!.title).toBe('Enrichment finished — 1/2 accepted, 1 stale');
    expect(completionBanner({ run: run(), events: [], scopes: [] })).toBeUndefined();
  });
});
