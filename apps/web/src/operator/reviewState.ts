import type { OperatorDraft, OperatorRun } from './api';

/** Keeps review on an explicitly selected revision while background status changes. */
export function selectedDraftForRun(selectedDraftRevisionId: string | undefined, run: Pick<OperatorRun, 'draftRevisionId'>, loaded?: OperatorDraft): string | undefined {
  return selectedDraftRevisionId ?? loaded?.draftRevisionId ?? run.draftRevisionId;
}

/** A monotonically increasing request epoch makes late run/draft responses inert. */
export function acceptsReviewResponse(expectedEpoch: number, currentEpoch: number, runId: string, selectedRunId: string | undefined): boolean {
  return expectedEpoch === currentEpoch && runId === selectedRunId;
}

export function publicationAcknowledgementAfterConflict(): boolean { return false; }
