import type { DraftDetail, OperatorDraft, OperatorRunDetail } from './api';
import { classifyOperatorFailure, draftBelongsToRun, isPublicationConflict, selectedDraftForRun, staleRevisionAfterFailure, supersededBy, type StaleRevisionContext } from './reviewState';

/**
 * The OperatorWorkspace's async decisions (CLA-264), kept out of the component so they are tested with a mocked API:
 * which revision a load shows (follow the run unless explicitly pinned) and whether it is superseded, what a failure
 * does to the page (lost access, stale revision, plain error), and how a publish conflict is recognised (by code).
 * The component only stores what these return.
 */
export interface ReviewApi { run(runId: string): Promise<OperatorRunDetail>; draft(draftRevisionId: string): Promise<DraftDetail>; }
export interface ReviewLoad { runDetail: OperatorRunDetail; currentDraft?: OperatorDraft; detail?: DraftDetail; superseded?: { draftRevisionId: string; revision?: number }; }

/**
 * Loads a run and the revision to review: `explicit` (a one-off target such as "Open current revision"), else the pinned
 * revision, else the run's current one. `stillWanted` is checked after each response; a late one returns undefined.
 */
export async function loadReview(api: ReviewApi, runId: string, pinned: string | undefined, explicit: string | undefined, stillWanted: () => boolean = () => true): Promise<ReviewLoad | undefined> {
  const runDetail = await api.run(runId);
  if (!stillWanted()) return undefined;
  const chosen = explicit ?? selectedDraftForRun(pinned, runDetail.run, runDetail.draft);
  const base = { runDetail, ...(runDetail.draft ? { currentDraft: runDetail.draft } : {}) };
  if (!chosen) return base;
  const detail = await api.draft(chosen);
  if (!stillWanted()) return undefined;
  if (!draftBelongsToRun(detail, runId)) throw new Error('That revision belongs to a different run.');
  const superseded = supersededBy(detail.draft, runDetail.run, runDetail.draft);
  return { ...base, detail, ...(superseded ? { superseded } : {}) };
}

export type FailureEffect = { denied: 'expired' | 'not-operator' } | { ignore: true } | { message: string; stale: StaleRevisionContext | undefined };
/** What a failed action does to the page: the access page (by 401/403 code), nothing (the user switched runs), or an alert. */
export async function failureEffect(cause: unknown, input: { wasAllowed: boolean; checkSession: () => Promise<{ operator: boolean }>; fallback: string; failedRunId?: string; selectedRunId?: string; stale?: StaleRevisionContext; keepStale?: boolean }): Promise<FailureEffect> {
  const outcome = await classifyOperatorFailure(cause, input.wasAllowed, input.checkSession, input.fallback);
  if (outcome.kind === 'expired' || outcome.kind === 'not-operator') return { denied: outcome.kind };
  const next = staleRevisionAfterFailure(outcome, input.failedRunId, input.selectedRunId, input.stale, input.keepStale);
  return next.apply ? { message: outcome.message, stale: next.stale } : { ignore: true };
}

export const PUBLICATION_CONFLICT_MESSAGE = 'Publication changed elsewhere. Review context was refreshed; confirm and publish again.';
/** Publishes; a 409 `publication_stale` becomes `conflict` (the caller resets acknowledgement and reloads); anything else throws. */
export async function publishRevision(publish: () => Promise<{ publication: { versionId: string } }>): Promise<{ published: string } | { conflict: true }> {
  try { return { published: (await publish()).publication.versionId }; } catch (cause) { if (isPublicationConflict(cause)) return { conflict: true }; throw cause; }
}

/** What returning from a draft preview restores: the run, and the revision only when it was an explicit pin (CLA-264). */
export function previewReturnSelection(runId: string, draftRevisionId: string, pinned: boolean): { runId: string; draftRevisionId?: string } {
  return { runId, ...(pinned ? { draftRevisionId } : {}) };
}
