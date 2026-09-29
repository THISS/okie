import { OperatorApiError, type IncrementalStartResponse, type OperatorEvent, type OperatorRun, type ScopeStaleReason } from './api';

/**
 * CLA-271 incremental re-scans in the operator workspace: run labels, the "Update to latest commit" button state and
 * what each server response shows. Pure (the client call is injected), so the workspace only stores what these return.
 */
export function shortSha(sha: string | undefined): string | undefined { return sha ? sha.slice(0, 7) : undefined; }
const SHA = /^[0-9a-f]{7,40}$/i;

/** The route's `:repositoryId`: the server's canonical id when the run carries it, else `repo:owner/name`. */
export function repositoryIdOf(run: Pick<OperatorRun, 'source'>): string { return run.source.repositoryId ?? `repo:${run.source.owner}/${run.source.repo}`; }
function sameRepository(a: Pick<OperatorRun, 'source'>, b: Pick<OperatorRun, 'source'>): boolean { return repositoryIdOf(a).toLowerCase() === repositoryIdOf(b).toLowerCase(); }
export function isActiveRun(run: Pick<OperatorRun, 'state'>): boolean { return run.state === 'queued' || run.state === 'running'; }

/** "Update from abc1234 → def5678" for an incremental run; undefined for a full run. The target is "latest" until scanned. */
export function incrementalRunLabel(run: Pick<OperatorRun, 'kind' | 'incremental' | 'source'>): string | undefined {
  if (run.kind !== 'incremental' && !run.incremental) return undefined;
  const from = shortSha(run.incremental?.baseline.commitSha) ?? 'baseline';
  const ref = run.incremental?.ref ?? run.source.ref;
  const to = shortSha(run.source.commitSha ?? run.incremental?.targetCommitSha) ?? (ref ? (SHA.test(ref) ? shortSha(ref)! : ref) : 'latest');
  return `Update from ${from} → ${to}`;
}

/** An incremental run that found the repository already at its baseline commit: it ends complete with no draft. */
export function upToDateEvent(events: readonly Pick<OperatorEvent, 'type' | 'detail'>[] | undefined, run?: Pick<OperatorRun, 'incremental'>): { commitSha?: string } | undefined {
  if (run?.incremental?.upToDate) return { commitSha: run.incremental.upToDate.commitSha };
  const event = events?.find(item => item.type === 'incremental.up_to_date');
  if (!event) return undefined;
  const sha = event.detail?.commitSha;
  return typeof sha === 'string' ? { commitSha: sha } : {};
}

/** What the review pane says when there is no draft to show. */
export function noDraftMessage(run: Pick<OperatorRun, 'state' | 'kind' | 'incremental' | 'source' | 'draftRevisionId'>, events?: readonly Pick<OperatorEvent, 'type' | 'detail'>[], runDetailLoaded = true): string {
  if (isActiveRun(run)) return 'Loading draft when the run creates one…';
  // Never claim "no draft" before we know: the run detail is still loading, or the run has a draft that is loading.
  if (!runDetailLoaded || run.draftRevisionId) return 'Loading draft…';
  const upToDate = upToDateEvent(events, run);
  if (upToDate) { const sha = shortSha(upToDate.commitSha ?? run.source.commitSha ?? run.incremental?.baseline.commitSha); return `Already at the latest commit${sha ? ` (${sha})` : ''}. No draft was needed.`; }
  return run.state === 'complete' ? 'This run finished without a draft.' : 'This run ended without a draft.';
}

export const STALE_REASON_TEXT: Record<ScopeStaleReason, string> = {
  'dependency-internal': 'dependency changed internally — re-check claims',
  moved: 'moved lines — evidence may be off by a few lines',
  changed: 'its source changed — below the depth cap, so it was not re-explained',
  pending: 'changed; not re-enriched (budget stop or failure) — the next update retries it',
  inherited: 'out of date and not retried automatically (it was left unfinished before this update chain) — Refresh it',
  dropped: 'not re-enriched: two updates in a row failed it, so it is no longer retried automatically — Refresh it',
};
/** Short form for the scope list's state chip. */
export const STALE_REASON_SHORT: Record<ScopeStaleReason, string> = { 'dependency-internal': 're-check', moved: 'moved', changed: 'changed', pending: 'pending', dropped: 'dropped', inherited: 'refresh' };
export function staleReasonText(reason: string | undefined): string | undefined { return reason && reason in STALE_REASON_TEXT ? STALE_REASON_TEXT[reason as ScopeStaleReason] : undefined; }

/** The button is off while a request is in flight or any run of this repository is queued or running. */
export function updateButtonState(input: { run: Pick<OperatorRun, 'runId' | 'state' | 'source'>; runs: readonly Pick<OperatorRun, 'runId' | 'state' | 'source'>[]; requesting: boolean }): { disabled: boolean; label: string; title?: string; activeRunId?: string } {
  if (input.requesting) return { disabled: true, label: 'Checking for updates…' };
  const active = isActiveRun(input.run) ? input.run : input.runs.find(run => isActiveRun(run) && sameRepository(run, input.run));
  if (active) return { disabled: true, label: 'Update to latest commit', title: active.runId === input.run.runId ? 'This run is still in progress.' : 'Another run for this repository is in progress.', activeRunId: active.runId };
  return { disabled: false, label: 'Update to latest commit', title: 'Re-scan the latest commit and re-enrich only what changed.' };
}

/** What the button shows after a response: the started run is opened by the caller; the rest are inline. */
export type UpdateOutcome =
  | { kind: 'started'; runId: string; message: string }
  | { kind: 'up-to-date'; message: string }
  | { kind: 'active'; runId: string; message: string }
  | { kind: 'error'; message: string };

export function updateOutcome(response: IncrementalStartResponse): UpdateOutcome {
  if (response.status === 'started') { const from = shortSha(response.baselineCommitSha); const to = shortSha(response.commitSha); return { kind: 'started', runId: response.runId, message: `Update queued${from ? ` from ${from}` : ''}${to ? ` → ${to}` : ''}.` }; }
  if (response.status === 'up_to_date') return { kind: 'up-to-date', message: `Already at the latest commit (${shortSha(response.commitSha)}).` };
  return { kind: 'active', runId: response.runId, message: 'An update or scan is already running for this repository.' };
}

/**
 * Calls the route and maps it to an outcome. 422/502/404 become inline errors; access failures (401/403) and anything
 * unexpected are rethrown so the workspace's one failure classifier handles them (sign-in page, CSRF message).
 */
export async function requestUpdate(start: () => Promise<IncrementalStartResponse>): Promise<UpdateOutcome> {
  try { return updateOutcome(await start()); }
  catch (cause) {
    if (!(cause instanceof OperatorApiError) || cause.status === 401 || cause.status === 403) throw cause;
    const code = cause.body?.code;
    if (code === 'no_baseline') return { kind: 'error', message: 'Nothing to update yet: this repository has no draft or publication.' };
    if (cause.status === 404) return { kind: 'error', message: 'This repository is not known to the operator workspace.' };
    return { kind: 'error', message: cause.message };
  }
}
