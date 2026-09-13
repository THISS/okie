export type RunState = 'queued' | 'running' | 'awaiting_review' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
export type AttemptState = 'queued' | 'running' | 'accepted' | 'failed' | 'cancelled' | 'interrupted';

export interface OperatorUsage { inputTokens?: number; outputTokens?: number; measuredCostUsd?: number; estimatedCostUsd?: number; }
export interface OperatorRun { runId: string; state: RunState; createdAt: number; updatedAt: number; draftRevisionId?: string; error?: string; source: { owner: string; repo: string; slug: string; commitSha?: string }; }
export interface OperatorAttempt { attemptId: string; scopeId: string; kind: 'scan' | 'enrichment' | 'retry' | 'refresh'; state: AttemptState; provider?: string; modelId?: string; usage?: OperatorUsage; stale?: boolean; error?: string; validation?: { accepted: boolean; validator: string; evidenceHash?: string; reason?: string }; }
export interface OperatorEvent { eventId: string; at: number; type: string; detail?: Record<string, string | number | boolean | null>; }
export interface OperatorExplanation { explanationVersionId?: string; summary: string; roleWithinParent?: string; interactions?: string[]; evidence: Array<{ entityId?: string; path?: string; startLine?: number; endLine?: number }>; diagram?: { nodes: string[]; edges: Array<{ from: string; to: string; label?: string }> }; diagramError?: string; }
export interface OperatorScope { scopeId: string; parentScopeId?: string; name: string; state: AttemptState | 'stale'; stale?: boolean; explanation?: OperatorExplanation; explanationVersionId?: string; diagramError?: string; attempts?: OperatorAttempt[]; }
export interface OperatorDraft { draftRevisionId: string; runId: string; revision: number; state: 'open' | 'frozen' | 'superseded'; basePublicationVersionId?: string; coverage: { total: number; accepted: number; failed: number; stale: number }; }
export interface DraftDetail { draft: OperatorDraft; source: { owner: string; repo: string; commitSha?: string }; scopes: OperatorScope[]; usage: OperatorUsage; currentPublicationVersionId?: string; }

export class OperatorApiError extends Error { constructor(readonly status: number, message: string) { super(message); } }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers, ...init });
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { const body = await response.json() as { error?: string; message?: string }; message = body.error ?? body.message ?? message; } catch { /* response body is intentionally optional */ }
    throw new OperatorApiError(response.status, message);
  }
  return response.json() as Promise<T>;
}

export const operatorApi = {
  session: () => request<{ operator: boolean }>('/api/operator/session'),
  runs: () => request<{ runs: OperatorRun[] }>('/api/operator/runs'),
  start: (url: string, idempotencyKey: string) => request<{ run: OperatorRun; deduped: boolean }>('/api/operator/runs', { method: 'POST', body: JSON.stringify({ url, idempotencyKey }) }),
  run: (runId: string) => request<{ run: OperatorRun; draft?: OperatorDraft; attempts: OperatorAttempt[]; events: OperatorEvent[]; usage: OperatorUsage }>(`/api/operator/runs/${encodeURIComponent(runId)}`),
  cancel: (runId: string) => request<{ run: OperatorRun }>(`/api/operator/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: '{}' }),
  draft: (id: string) => request<DraftDetail>(`/api/operator/drafts/${encodeURIComponent(id)}`),
  bundle: (id: string) => request<unknown>(`/api/operator/drafts/${encodeURIComponent(id)}/bundle`),
  retry: (id: string, scopeId: string) => request<{ run: OperatorRun; draftRevisionId: string }>(`/api/operator/drafts/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify({ scopeId }) }),
  refresh: (id: string, scopeIds: string[]) => request<{ run: OperatorRun; draftRevisionId: string }>(`/api/operator/drafts/${encodeURIComponent(id)}/refresh`, { method: 'POST', body: JSON.stringify({ scopeIds }) }),
  publish: (id: string, expectedCurrentVersionId: string | undefined, acknowledgeCoverage: boolean) => request<{ publication: { versionId: string } }>(`/api/operator/drafts/${encodeURIComponent(id)}/publish`, { method: 'POST', body: JSON.stringify({ expectedCurrentVersionId, acknowledgeCoverage }) }),
};
