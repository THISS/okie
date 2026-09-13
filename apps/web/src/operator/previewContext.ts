import type { OperatorScope } from './api';

export type DraftPreviewContext = { draftRevisionId: string; explanationsByEntityId: ReadonlyMap<string, OperatorScope> };
let activePreviewContext: DraftPreviewContext | undefined;

/** Ephemeral operator-only context. It is never written to browser storage. */
export function setDraftPreviewContext(draftRevisionId: string, scopes: readonly OperatorScope[]): void {
  const explanationsByEntityId = new Map<string, OperatorScope>();
  for (const scope of scopes) if (scope.explanation) explanationsByEntityId.set(scope.scopeId, scope);
  activePreviewContext = { draftRevisionId, explanationsByEntityId };
}
export function getDraftPreviewContext(): DraftPreviewContext | undefined { return activePreviewContext; }
export function clearDraftPreviewContext(): void { activePreviewContext = undefined; }
