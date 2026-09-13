import type { DraftDetail, OperatorDraft, OperatorRun } from './api';

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
