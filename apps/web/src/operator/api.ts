export type RunState = 'queued' | 'running' | 'awaiting_review' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
export type AttemptState = 'queued' | 'running' | 'accepted' | 'failed' | 'cancelled' | 'interrupted';

export interface OperatorUsage { inputTokens?: number; outputTokens?: number; measuredCostUsd?: number; estimatedCostUsd?: number; }
export interface OperatorRun { runId: string; state: RunState; createdAt: number; updatedAt: number; draftRevisionId?: string; error?: string; source: { owner: string; repo: string; slug: string; commitSha?: string; /** Canonical `repo:owner/name` (absent on older servers). */ repositoryId?: string; ref?: string }; /** CLA-271: absent on a full run. */ kind?: 'incremental'; incremental?: OperatorIncrementalRunInfo; }
/** How an incremental run (CLA-271) was started and the baseline it diffs against. */
export interface OperatorIncrementalRunInfo { baseline: { runId: string; draftRevisionId: string; artifactRevisionId?: string; publicationVersionId?: string; commitSha: string }; ref?: string; trigger?: 'operator' | 'cron' | 'webhook' | 'script'; autoPublish?: boolean; /** Resolved commit the run scans, once known. */ targetCommitSha?: string; /** Set when the run found nothing new: it ends complete with no draft. */ upToDate?: { commitSha: string }; }
export interface OperatorAttempt { attemptId: string; scopeId: string; kind: 'scan' | 'enrichment' | 'retry' | 'refresh'; state: AttemptState; createdAt?: number; updatedAt?: number; provider?: string; modelId?: string; usage?: OperatorUsage; stale?: boolean; error?: string; validation?: { accepted: boolean; validator: string; evidenceHash?: string; reason?: string }; /** Borrowed from an earlier revision of the run (CLA-264): shown for its error, never counted in metrics. */ inherited?: boolean; }
export interface OperatorEvent { eventId: string; at: number; type: string; detail?: Record<string, string | number | boolean | null>; }
export interface OperatorEvidenceRef { entityId?: string; path?: string; startLine?: number; endLine?: number; }
/** v1/v2 content (no `format`): still rendered by the legacy explanation renderer. */
export interface LegacyOperatorExplanation { format?: undefined; explanationVersionId?: string; summary: string; roleWithinParent?: string; interactions?: string[]; evidence: OperatorEvidenceRef[]; diagram?: { nodes: string[]; edges: Array<{ from: string; to: string; label?: string }> }; diagramError?: string; }
/** CLA-260 `operator-enrichment/v3`: markdown-lite summary, key points, optional Mermaid source and small table. */
export interface OperatorExplanationV3 { format: 'v3'; explanationVersionId?: string; summary: string; keyPoints: string[]; diagram?: string; table?: { caption?: string; columns: string[]; rows: string[][] }; evidence: OperatorEvidenceRef[]; diagramError?: string; /** CLA-145 claim mapping (prompt v4); renderers ignore it. */ claims?: Array<{ id: string; text: string; origin: 'summary' | 'keyPoint'; index: number; evidence: OperatorEvidenceRef[] }>; claimsNote?: string; }
/** CLA-145 claim-check states. Model judgments over captured excerpts, never verification. */
export type ClaimCheckState = 'supported' | 'contradicted' | 'insufficient' | 'uncertain' | 'unavailable' | 'failed-check' | 'insufficient-context' | 'not-evaluated' | 'stale';
export interface ClaimCheckRow { claimId: string; text: string; origin: 'summary' | 'keyPoint'; index: number; evidence: Array<OperatorEvidenceRef & { outcome: string }>; state: ClaimCheckState; source: 'code' | 'jev' | 'none'; reason?: string; choice?: string; confidence?: number; probabilities?: Record<string, number>; modelId?: string; }
/** `stale`: the explanation is stale (re-check refused until refreshed). `dropped`/`droppedNote`: statements whose claim mapping was dropped at write time, never evaluated. */
export interface ScopeClaimChecks { mapping: 'claims' | 'none'; note?: string; counts: Record<ClaimCheckState, number>; rows: ClaimCheckRow[]; rowsOmitted?: number; stale?: true; dropped?: number; droppedNote?: string; }
/** Absent on servers before CLA-145. */
export interface ClaimChecksInfo { enabled: boolean; disabledReason?: string; label: string; threshold: number; state: 'ready' | 'corrupt' | 'unavailable'; file?: string; }
export type OperatorExplanation = LegacyOperatorExplanation | OperatorExplanationV3;
/** CLA-271 why an incremental run marked a scope stale: a dependency changed only internally (claim re-check), or its evidence lines moved. */
export type ScopeStaleReason = 'dependency-internal' | 'moved' | 'changed' | 'pending' | 'dropped' | 'inherited';
/** Why an unfinished scope's explanation is not current (CLA-271). */
export type UnfinishedReason = 'pending' | 'dropped' | 'inherited';
/** `kind` is the C4 kind; `depth` counts ancestors (both absent on very old servers). "below cap": below the run's enrichment depth cap. `path`: primary source path (CLA-259; absent on older servers). */
export interface OperatorScope { scopeId: string; entityId?: string; parentScopeId?: string; name: string; kind?: string; path?: string; depth?: number; state: AttemptState | 'stale' | 'not run' | 'below cap'; stale?: boolean; /** CLA-271 (only on stale scopes of incremental revisions). */ staleReason?: ScopeStaleReason; explanation?: OperatorExplanation; explanationVersionId?: string; diagramError?: string; attempts?: OperatorAttempt[]; /** Operator-only summary of the attempts behind the current state (CLA-259; absent on older servers). */ metrics?: OperatorScopeMetrics; /** CLA-145 per-scope claim checks (absent on older servers). */ claimChecks?: ScopeClaimChecks; }
export interface OperatorScopeMetrics { costUsd?: number; totalTokens?: number; updatedAt?: number; }
export interface OperatorDraft { draftRevisionId: string; runId: string; revision: number; state: 'open' | 'frozen' | 'superseded'; basePublicationVersionId?: string; /** `notRun` is absent on drafts written before CLA-254; `belowCap` before CLA-258 (the server derives it for drafts it reads). */ coverage: { total: number; accepted: number; failed: number; notRun?: number; stale: number; belowCap?: number }; }
/** The run ledger: spend so far against the configured per-run limits. */
export interface OperatorRunBudget { maxDollars: number; spentDollars: number; maxRequests: number; requests: number; maxTokens: number; tokens: number; /** Only when a global operator dollar cap is configured. */ globalRemainingDollars?: number; /** Run requests left (absent on older servers). */ remainingRequests?: number; /** Only when a global request cap is configured. */ globalRemainingRequests?: number; /** Run tokens left (absent on older servers: derive maxTokens − tokens). */ remainingTokens?: number; /** Only when a global token cap is configured. */ globalRemainingTokens?: number; /** Requests a pass keeps in flight at once (absent on older servers). */ maxConcurrent?: number; /** Average tokens one admission reserved in this run (request bytes + max output tokens). */ avgTokenReservation?: number; }
export interface OperatorRunDetail { run: OperatorRun; draft?: OperatorDraft; attempts: OperatorAttempt[]; events: OperatorEvent[]; usage: OperatorUsage; budget?: OperatorRunBudget; avgCostPerScopeUsd?: number; /** Average reported tokens per attempt (CLA-264; absent until one reports usage). */ avgTokensPerScope?: number; progress?: { accepted: number; failed: number; inFlight: number }; }
export interface DraftDetail { draft: OperatorDraft; source: { owner: string; repo: string; commitSha?: string }; scopes: OperatorScope[]; usage: OperatorUsage; currentPublicationVersionId?: string; /** The live publication's draft revision (CLA-271: this draft may be it). */ currentPublicationDraftRevisionId?: string; claimChecks?: ClaimChecksInfo; /** CLA-271: only on revisions of incremental runs. */ incremental?: OperatorIncrementalRunInfo; changelog?: IncrementalChangelog; }

/** CLA-271 changelog lists: at most 50 `items`; `total` is the full count. */
export interface Bounded<T> { total: number; items: T[] }
export interface ChangelogEntity { id: string; kind: string; name: string }
export interface ChangelogCounts { entitiesAdded: number; entitiesRemoved: number; entitiesChanged: number; surfaceChanges: number; internalChanges: number; entitiesMoved: number; relationsAdded: number; relationsRemoved: number; removedExports: number; dirty: number; /** Re-seeded from the previous unpublished update (absent on older servers). */ carried?: number; /** Includes the unfinished scopes. */ stale: number; /** Stale scopes without a reason plus dropped ones (absent on older servers). */ unfinished?: number; reused: number; removedScopes: number }
export interface ChangelogDiff {
  counts: ChangelogCounts;
  entities: { added: Bounded<ChangelogEntity>; removed: Bounded<ChangelogEntity>; changed: Bounded<ChangelogEntity & { change: 'surface' | 'internal' }>; moved: Bounded<ChangelogEntity> };
  relations: { added: Bounded<{ from: string; to: string; kind: string }>; removed: Bounded<{ from: string; to: string; kind: string }> };
  removedExports: Bounded<ChangelogEntity & { consumerCount: number }>;
}
export interface IncrementalChangelog extends ChangelogDiff {
  schemaVersion: number; fromCommit: string; toCommit: string;
  baseline?: { runId: string; draftRevisionId: string; publicationVersionId?: string }; cap?: string;
  stale: Bounded<{ scopeId: string; reason: ScopeStaleReason }>;
  /** Commit-caused dirty scopes of this update. */
  dirty: Bounded<ChangelogEntity>;
  /** Scopes re-seeded from the previous unpublished update (absent on older servers). */
  carried?: Bounded<ChangelogEntity>;
  hashCheck?: { checked: number; mismatches: number; unknown: number };
  /** `pending` while the run's pass is still writing to this revision. */
  outcome: { state: 'pending' | 'settled'; resummarised: Bounded<ChangelogEntity>; resummarisedByKind: Record<string, number>; keptStale: Bounded<ChangelogEntity>; failed: Bounded<ChangelogEntity>; notRun: Bounded<ChangelogEntity> };
  /** This update only. */
  summary: string;
  /** The live publication under the update chain, and the unpublished updates between it and this draft. */
  publication?: { versionId: string; commitSha: string; draftRevisionId?: string };
  chain?: Array<{ runId: string; draftRevisionId: string; toCommit: string }>;
  /** Total earlier updates (`chain` holds the last 20); `chainPartial` when the chain passes through a draft older than the field. */
  chainLength?: number;
  chainPartial?: true;
  /** Scopes whose explanation is not current and that carry no stale reason: pending (not re-enriched yet) or dropped (Refresh it). */
  unfinished?: Bounded<ChangelogEntity & { reason: UnfinishedReason }>;
  /** Publication → this draft: what publishing it would ship. */
  cumulative?: ChangelogDiff & { fromCommit: string; toCommit: string; dirty: Bounded<ChangelogEntity> };
  /** Explanation provenance against the publication: reused byte-for-byte, or re-enriched by an earlier unpublished update. */
  reuse?: { fromPublication: Bounded<ChangelogEntity>; sincePublication: Bounded<ChangelogEntity> };
  cumulativeSummary?: string;
}
/** "Update to latest commit" (CLA-271). A 409 `run_active` is returned as `active` rather than thrown. */
export type IncrementalStartResponse = { status: 'started'; runId: string; baselineCommitSha: string; commitSha?: string } | { status: 'up_to_date'; commitSha: string; baselineCommitSha: string } | { status: 'active'; runId: string };

/**
 * Stable machine-readable failure codes (CLA-264). The web decides on these, never on `error` text (which is display-only).
 * 401 `session_expired`; 403 `not_operator` | `csrf_rejected`; 409 `run_active` | `draft_superseded` | `publication_stale`.
 */
export type OperatorErrorCode = 'session_expired' | 'not_operator' | 'csrf_rejected' | 'run_active' | 'draft_superseded' | 'publication_stale' | 'claim_checks_disabled' | 'run_not_reviewable' | 'claim_scopes_stale' | 'no_baseline';
/** `body` is the parsed JSON error body when the server sent one (e.g. `currentDraftRevisionId` on a stale-revision 409). */
export type OperatorApiErrorBody = { error?: string; message?: string; code?: OperatorErrorCode | (string & {}); currentDraftRevisionId?: string; [key: string]: unknown };
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
  /** CLA-145: report-only claim checks for the given scopes (omit to check every scope with a claim mapping). */
  claimChecks: (id: string, scopeIds?: string[]) => request<{ run: string; draftRevisionId: string; scopes: number }>(`/api/operator/drafts/${encodeURIComponent(id)}/claim-checks`, { method: 'POST', body: JSON.stringify(scopeIds ? { scopeIds } : {}) }),
  /** CLA-271 "Update to latest commit": 202 started, 200 up to date; a 409 `run_active` resolves to `active` with the running run. */
  incremental: async (repositoryId: string, options: { ref?: string; autoPublish?: boolean } = {}): Promise<IncrementalStartResponse> => {
    try { return await request<IncrementalStartResponse>(`/api/operator/repositories/${encodeURIComponent(repositoryId)}/incremental`, { method: 'POST', body: JSON.stringify(options) }); }
    catch (cause) { if (cause instanceof OperatorApiError && cause.status === 409 && cause.body?.code === 'run_active' && typeof cause.body.runId === 'string') return { status: 'active', runId: cause.body.runId }; throw cause; }
  },
  publish: (id: string, expectedCurrentVersionId: string | undefined, acknowledgeCoverage: boolean) => request<{ publication: { versionId: string } }>(`/api/operator/drafts/${encodeURIComponent(id)}/publish`, { method: 'POST', body: JSON.stringify({ expectedCurrentVersionId, acknowledgeCoverage }) }),
};
