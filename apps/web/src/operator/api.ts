export type RunState = 'queued' | 'running' | 'awaiting_review' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
export type AttemptState = 'queued' | 'running' | 'accepted' | 'failed' | 'cancelled' | 'interrupted';

export interface OperatorUsage { inputTokens?: number; outputTokens?: number; measuredCostUsd?: number; estimatedCostUsd?: number; }
export interface OperatorRun { runId: string; state: RunState; createdAt: number; updatedAt: number; draftRevisionId?: string; error?: string; source: { owner: string; repo: string; slug: string; commitSha?: string }; }
export interface OperatorAttempt { attemptId: string; scopeId: string; kind: 'scan' | 'enrichment' | 'retry' | 'refresh'; state: AttemptState; createdAt?: number; updatedAt?: number; provider?: string; modelId?: string; usage?: OperatorUsage; stale?: boolean; error?: string; validation?: { accepted: boolean; validator: string; evidenceHash?: string; reason?: string }; }
export interface OperatorEvent { eventId: string; at: number; type: string; detail?: Record<string, string | number | boolean | null>; }
export interface OperatorEvidenceRef { entityId?: string; path?: string; startLine?: number; endLine?: number; }
/** v1/v2 content (no `format`): still rendered by the legacy explanation renderer. */
export interface LegacyOperatorExplanation { format?: undefined; explanationVersionId?: string; summary: string; roleWithinParent?: string; interactions?: string[]; evidence: OperatorEvidenceRef[]; diagram?: { nodes: string[]; edges: Array<{ from: string; to: string; label?: string }> }; diagramError?: string; }
/** CLA-260 `operator-enrichment/v3`: markdown-lite summary, key points, optional Mermaid source and small table. */
export interface OperatorExplanationV3 { format: 'v3'; explanationVersionId?: string; summary: string; keyPoints: string[]; diagram?: string; table?: { caption?: string; columns: string[]; rows: string[][] }; evidence: OperatorEvidenceRef[]; diagramError?: string; }
export type OperatorExplanation = LegacyOperatorExplanation | OperatorExplanationV3;
/** `kind` is the C4 kind; `depth` counts ancestors (both absent on very old servers). "below cap": below the run's enrichment depth cap. `path`: primary source path (CLA-259; absent on older servers). */
export interface OperatorScope { scopeId: string; entityId?: string; parentScopeId?: string; name: string; kind?: string; path?: string; depth?: number; state: AttemptState | 'stale' | 'not run' | 'below cap'; stale?: boolean; explanation?: OperatorExplanation; explanationVersionId?: string; diagramError?: string; attempts?: OperatorAttempt[]; /** Operator-only summary of the attempts behind the current state (CLA-259; absent on older servers). */ metrics?: OperatorScopeMetrics; }
export interface OperatorScopeMetrics { costUsd?: number; totalTokens?: number; updatedAt?: number; }
export interface OperatorDraft { draftRevisionId: string; runId: string; revision: number; state: 'open' | 'frozen' | 'superseded'; basePublicationVersionId?: string; /** `notRun` is absent on drafts written before CLA-254; `belowCap` before CLA-258 (the server derives it for drafts it reads). */ coverage: { total: number; accepted: number; failed: number; notRun?: number; stale: number; belowCap?: number }; }
/** The run ledger: spend so far against the configured per-run limits. */
export interface OperatorRunBudget { maxDollars: number; spentDollars: number; maxRequests: number; requests: number; maxTokens: number; tokens: number; /** Only when a global operator dollar cap is configured. */ globalRemainingDollars?: number; /** Run requests left (absent on older servers). */ remainingRequests?: number; /** Only when a global request cap is configured. */ globalRemainingRequests?: number; }
export interface OperatorRunDetail { run: OperatorRun; draft?: OperatorDraft; attempts: OperatorAttempt[]; events: OperatorEvent[]; usage: OperatorUsage; budget?: OperatorRunBudget; avgCostPerScopeUsd?: number; progress?: { accepted: number; failed: number; inFlight: number }; }
export interface DraftDetail { draft: OperatorDraft; source: { owner: string; repo: string; commitSha?: string }; scopes: OperatorScope[]; usage: OperatorUsage; currentPublicationVersionId?: string; }

/** `body` is the parsed JSON error body when the server sent one (e.g. `currentDraftRevisionId` on a stale-revision 409). */
export type OperatorApiErrorBody = { error?: string; message?: string; currentDraftRevisionId?: string; [key: string]: unknown };
export class OperatorApiError extends Error { constructor(readonly status: number, message: string, readonly body?: OperatorApiErrorBody) { super(message); } }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', headers: init?.body ? { 'content-type': 'application/json', ...init.headers } : init?.headers, ...init });
  if (!response.ok) {
    let message = `Request failed (${response.status})`; let body: OperatorApiErrorBody | undefined;
    try { const parsed: unknown = await response.json(); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { body = parsed as OperatorApiErrorBody; message = (typeof body.error === 'string' ? body.error : undefined) ?? (typeof body.message === 'string' ? body.message : undefined) ?? message; } } catch { /* response body is intentionally optional */ }
    throw new OperatorApiError(response.status, message, body);
  }
  return response.json() as Promise<T>;
}

export const operatorApi = {
  session: () => request<{ operator: boolean }>('/api/operator/session'),
  runs: () => request<{ runs: OperatorRun[] }>('/api/operator/runs'),
  start: (url: string, idempotencyKey: string) => request<{ run: OperatorRun; deduped: boolean }>('/api/operator/runs', { method: 'POST', body: JSON.stringify({ url, idempotencyKey }) }),
  run: (runId: string) => request<OperatorRunDetail>(`/api/operator/runs/${encodeURIComponent(runId)}`),
  cancel: (runId: string) => request<{ run: OperatorRun }>(`/api/operator/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: '{}' }),
  draft: (id: string) => request<DraftDetail>(`/api/operator/drafts/${encodeURIComponent(id)}`),
  bundle: (id: string) => request<unknown>(`/api/operator/drafts/${encodeURIComponent(id)}/bundle`),
  /** Batch retry (CLA-258): one pass, affected ancestors re-reduced. Below-cap scopes need `includeBelowCap`. */
  retryScopes: (id: string, scopeIds: string[], includeBelowCap = false) => request<{ run: OperatorRun; draftRevisionId: string }>(`/api/operator/drafts/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify({ scopeIds, ...(includeBelowCap ? { includeBelowCap: true } : {}) }) }),
  retry: (id: string, scopeId: string) => request<{ run: OperatorRun; draftRevisionId: string }>(`/api/operator/drafts/${encodeURIComponent(id)}/retry`, { method: 'POST', body: JSON.stringify({ scopeId }) }),
  refresh: (id: string, scopeIds: string[]) => request<{ run: OperatorRun; draftRevisionId: string }>(`/api/operator/drafts/${encodeURIComponent(id)}/refresh`, { method: 'POST', body: JSON.stringify({ scopeIds }) }),
  publish: (id: string, expectedCurrentVersionId: string | undefined, acknowledgeCoverage: boolean) => request<{ publication: { versionId: string } }>(`/api/operator/drafts/${encodeURIComponent(id)}/publish`, { method: 'POST', body: JSON.stringify({ expectedCurrentVersionId, acknowledgeCoverage }) }),
};
