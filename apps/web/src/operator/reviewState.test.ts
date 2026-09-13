import { describe, expect, it } from 'vitest';
import { acceptsReviewResponse, publicationAcknowledgementAfterConflict, selectedDraftForRun } from './reviewState';

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
});
