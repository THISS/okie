import type { OperatorScope } from './api';

export type PreviewExplanationContext = { revisionId: string; explanationsByEntityId: ReadonlyMap<string, OperatorScope> };
let activePreviewContext: PreviewExplanationContext | undefined;

/** Ephemeral operator-only context. It is never written to browser storage. */
export function setDraftPreviewContext(draftRevisionId: string, scopes: readonly OperatorScope[]): void {
  const explanationsByEntityId = new Map<string, OperatorScope>();
  for (const scope of scopes) if (scope.explanation) explanationsByEntityId.set(scope.scopeId, scope);
  activePreviewContext = { revisionId: draftRevisionId, explanationsByEntityId };
}
export function setPublishedPreviewContext(versionId: string, scopes: readonly OperatorScope[]): void {
  const explanationsByEntityId = new Map<string, OperatorScope>();
  for (const scope of scopes) if (scope.explanation && scope.entityId) explanationsByEntityId.set(scope.entityId, scope);
  activePreviewContext = { revisionId: versionId, explanationsByEntityId };
}
export function getDraftPreviewContext(): PreviewExplanationContext | undefined { return activePreviewContext; }
export function clearDraftPreviewContext(): void { activePreviewContext = undefined; }
