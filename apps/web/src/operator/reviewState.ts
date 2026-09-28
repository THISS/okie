import type { DraftDetail, OperatorDraft, OperatorRun, OperatorScope } from './api';

/**
 * Coverage chips mirror the scope list: accepted / failed / not run partition the total; stale overlays.
 * Legacy drafts (no `notRun`) derive every count from the scope list states so chips always match it.
 */
export function coverageChips(coverage: OperatorDraft['coverage'], scopes?: readonly Pick<OperatorScope, 'state' | 'stale'>[]): string[] {
  const counts = coverage.notRun === undefined && scopes ? { total: scopes.length, accepted: scopes.filter(scope => scope.state === 'accepted').length, failed: scopes.filter(scope => scope.state === 'failed').length, notRun: scopes.filter(scope => scope.state === 'not run').length, stale: scopes.filter(scope => scope.stale).length } : { ...coverage, notRun: coverage.notRun ?? Math.max(0, coverage.total - coverage.accepted - coverage.failed) };
  return [`${counts.accepted}/${counts.total} accepted`, `${counts.failed} failed`, `${counts.notRun} not run`, `${counts.stale} stale`];
}
/** Any non-accepted or stale coverage still requires publish acknowledgement. */
export function coverageIncomplete(coverage: OperatorDraft['coverage']): boolean {
  return coverage.failed > 0 || (coverage.notRun ?? 0) > 0 || coverage.stale > 0 || coverage.accepted < coverage.total;
}
export function scopeStateLabel(scope: Pick<OperatorScope, 'state' | 'stale'>): string { return scope.stale ? 'stale' : scope.state; }

/** Keeps review on an explicitly selected revision while background status changes. */
export function selectedDraftForRun(selectedDraftRevisionId: string | undefined, run: Pick<OperatorRun, 'draftRevisionId'>, loaded?: OperatorDraft): string | undefined {
  return selectedDraftRevisionId ?? loaded?.draftRevisionId ?? run.draftRevisionId;
}

/** A monotonically increasing request epoch makes late run/draft responses inert. */
export function acceptsReviewResponse(expectedEpoch: number, currentEpoch: number, runId: string, selectedRunId: string | undefined): boolean {
  return expectedEpoch === currentEpoch && runId === selectedRunId;
}

export function publicationAcknowledgementAfterConflict(): boolean { return false; }
export function resetReviewForRun(): { draftRevisionId: undefined; acknowledged: false } { return { draftRevisionId: undefined, acknowledged: false }; }

/** Small async boundary shared by polling and manual refresh; tests exercise the
 * run→new-draft transition and late-response rejection without a browser DOM. */
export class OperatorReviewLoader {
  private epoch = 0;
  constructor(private readonly loadRun: (runId: string) => Promise<{ run: OperatorRun; draft?: OperatorDraft }>, private readonly loadDraft: (id: string) => Promise<DraftDetail>) {}
  async refresh(runId: string, selectedRunId: string | undefined, selectedDraftId?: string): Promise<{ run: OperatorRun; detail?: DraftDetail } | undefined> {
    const epoch = ++this.epoch;
    const result = await this.loadRun(runId);
    if (!acceptsReviewResponse(epoch, this.epoch, runId, selectedRunId)) return undefined;
    const revisionId = selectedDraftForRun(selectedDraftId, result.run, result.draft);
    if (!revisionId) return { run: result.run };
    const detail = await this.loadDraft(revisionId);
    return acceptsReviewResponse(epoch, this.epoch, runId, selectedRunId) ? { run: result.run, detail } : undefined;
  }
}
