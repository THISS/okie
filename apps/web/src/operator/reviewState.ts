import { OperatorApiError, type DraftDetail, type OperatorAttempt, type OperatorDraft, type OperatorEvent, type OperatorRun, type OperatorScope, type OperatorUsage } from './api';
import { claimCheckAttemptScope } from './claimChecks';

/** Sub-cent amounts keep four decimals ($0.0008), so a small real cost never reads as $0.00. */
export function money(value?: number): string { return value === undefined ? 'unknown' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: value !== 0 && Math.abs(value) < 0.01 ? 4 : 2 }).format(value); }
/** "awaiting_review" → "Awaiting review" for the run list and run header. */
export function runStateLabel(state: string): string { const text = state.replace(/_/g, ' ').trim(); return text ? text[0]!.toUpperCase() + text.slice(1) : 'Unknown'; }
/** The selected revision's usage is shown only when it differs from the run total (multi-revision runs). */
export function usageDiffers(run: OperatorUsage | undefined, revision: OperatorUsage | undefined): boolean { const keys = ['inputTokens', 'outputTokens', 'measuredCostUsd', 'estimatedCostUsd'] as const; return !!revision && keys.some(key => run?.[key] !== revision[key]); }

/** Provider usage as one line, or undefined when nothing was reported (zero tokens and no cost): callers show nothing. */
export function usageSummary(usage?: OperatorUsage): string | undefined {
  if (!usage) return undefined;
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0); const cost = usage.measuredCostUsd ?? usage.estimatedCostUsd;
  if (!tokens && !cost) return undefined;
  const parts = [`${(usage.inputTokens ?? 0).toLocaleString('en-US')} in / ${(usage.outputTokens ?? 0).toLocaleString('en-US')} out tokens`];
  if (usage.measuredCostUsd !== undefined) parts.push(`measured ${money(usage.measuredCostUsd)}`);
  if (usage.estimatedCostUsd !== undefined) parts.push(`estimated ${money(usage.estimatedCostUsd)}`);
  if (usage.measuredCostUsd === undefined && usage.estimatedCostUsd === undefined) parts.push('cost not reported');
  return parts.join(' · ');
}

/** Scope-list label vocabulary, in chip order. The first four always show; the rest only when non-zero. */
const CHIP_LABELS = ['accepted', 'failed', 'not run', 'stale', 'queued', 'running', 'cancelled', 'interrupted'] as const;
const fmt = (value: number) => value.toLocaleString('en-US');
/**
 * Coverage chips count exactly the labels the scope list shows (`scopeStateLabel` is the single source of truth),
 * so a stale accepted scope counts as `stale`, not `accepted`, and the chips partition the in-scope total.
 * Below-cap scopes are out of scope: they get their own quieter chip (`belowCapChip`), never a partition chip.
 * Without a scope list (never the case in the workspace) the stored coverage counts are shown as-is.
 */
export function coverageChips(coverage: OperatorDraft['coverage'], scopes?: readonly Pick<OperatorScope, 'state' | 'stale'>[]): string[] {
  if (!scopes) { const inScope = coverage.total - (coverage.belowCap ?? 0); return [`${fmt(coverage.accepted)}/${fmt(inScope)} in scope accepted`, `${fmt(coverage.failed)} failed`, `${fmt(coverage.notRun ?? Math.max(0, inScope - coverage.accepted - coverage.failed))} not run`, `${fmt(coverage.stale)} stale`]; }
  const counts = new Map<string, number>(); let inScope = 0;
  for (const scope of scopes) { if (scope.state === 'below cap') continue; inScope += 1; const label = scopeStateLabel(scope); counts.set(label, (counts.get(label) ?? 0) + 1); }
  const labels = [...CHIP_LABELS, ...[...counts.keys()].filter(label => !(CHIP_LABELS as readonly string[]).includes(label)).sort()];
  return labels.flatMap((label, index) => { const count = counts.get(label) ?? 0; if (label === 'accepted') return [`${fmt(count)}/${fmt(inScope)} in scope accepted`]; return index < 4 || count > 0 ? [`${fmt(count)} ${label}`] : []; });
}
/** "3,793 below depth cap", or undefined when no scope is below the cap. */
export function belowCapChip(scopes: readonly Pick<OperatorScope, 'state'>[]): string | undefined { const count = scopes.filter(scope => scope.state === 'below cap').length; return count ? `${fmt(count)} below depth cap` : undefined; }
/** Any failed, not-run or stale scope, or any in-scope scope not accepted, still requires publish acknowledgement. Below cap never does. */
export function coverageIncomplete(coverage: OperatorDraft['coverage']): boolean {
  return coverage.failed > 0 || (coverage.notRun ?? 0) > 0 || coverage.stale > 0 || coverage.accepted < coverage.total - (coverage.belowCap ?? 0);
}
export function scopeStateLabel(scope: Pick<OperatorScope, 'state' | 'stale'>): string { return scope.stale ? 'stale' : scope.state; }

/**
 * Keeps review on an explicitly pinned revision while background status changes. Without a pin the workspace follows
 * the run's current revision (`loaded` is the run detail's current draft). Only an explicit choice may pin (CLA-264):
 * pinning whatever was loaded kept a finished run on the working revision its enrichment ran on.
 */
export function selectedDraftForRun(pinnedDraftRevisionId: string | undefined, run: Pick<OperatorRun, 'draftRevisionId'>, loaded?: OperatorDraft): string | undefined {
  return pinnedDraftRevisionId ?? loaded?.draftRevisionId ?? run.draftRevisionId;
}
/** Unpinned review follows the run: reload when the run's current revision is not the one displayed (CLA-264). */
export function followsCurrentRevision(pinnedDraftRevisionId: string | undefined, currentDraftRevisionId: string | undefined, displayedDraftRevisionId: string | undefined): boolean {
  return pinnedDraftRevisionId === undefined && currentDraftRevisionId !== undefined && currentDraftRevisionId !== displayedDraftRevisionId;
}
/**
 * The displayed revision is superseded when the run's current revision is another one: `revision` is the current one's
 * number when the run detail carried it. Its scope states are as of that older revision, never the run's results.
 */
export function supersededBy(displayed: Pick<OperatorDraft, 'draftRevisionId'> | undefined, run: Pick<OperatorRun, 'draftRevisionId'> | undefined, current?: Pick<OperatorDraft, 'draftRevisionId' | 'revision'>): { draftRevisionId: string; revision?: number } | undefined {
  if (!displayed || !run?.draftRevisionId || run.draftRevisionId === displayed.draftRevisionId) return undefined;
  return { draftRevisionId: run.draftRevisionId, ...(current?.draftRevisionId === run.draftRevisionId ? { revision: current.revision } : {}) };
}
/** "Superseded — results are in revision 7": replaces the coverage chips of a superseded revision (its counts are not the run's). */
export function supersededLabel(superseded: { revision?: number }): string { return `Superseded — results are in ${superseded.revision !== undefined ? `revision ${superseded.revision}` : 'a newer revision'}`; }
/**
 * The state a scope row/inspector shows (CLA-264). On a superseded revision "not run" and "failed" are not the run's
 * results (a full run's working revision is all "not run"), so they read as a muted "superseded"; accepted, stale and
 * below-cap stay as stored.
 */
export function reviewStateLabel(scope: Pick<OperatorScope, 'state' | 'stale'>, superseded: boolean): string { const label = scopeStateLabel(scope); return superseded && (label === 'not run' || label === 'failed') ? 'superseded' : label; }
/** Why retry is unavailable on a superseded revision (the server would answer 409 draft_superseded). */
export function supersededRetryHint(superseded: { revision?: number }): string { return `This revision is superseded. Open ${superseded.revision !== undefined ? `revision ${superseded.revision}` : 'the current revision'} to retry scopes.`; }

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

/** "enrichment.retry_failed" → "Enrichment retry failed"; never echoes the dotted raw type. */
export function humanizeEventType(type: string): string {
  const words = type.split(/[._\-\s]+/).filter(Boolean).join(' ').toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Event';
}
const runStateText = (state: unknown): string => typeof state === 'string' ? state.replace(/_/g, ' ') : 'changed';
/** One unambiguous entry per attempt: "<scope name>: enrichment failed". */
export function attemptLabel(attempt: Pick<OperatorAttempt, 'kind' | 'state' | 'scopeId'>, scopeName?: (scopeId: string) => string | undefined): string {
  if (attempt.scopeId.startsWith('claim-check:')) {
    // CLA-145: "<scope name>: claim check accepted", never the raw batch id.
    const checked = claimCheckAttemptScope(attempt.scopeId);
    const label = checked ? `${scopeName?.(checked) ?? checked}: claim check` : 'Claim check';
    return `${label} ${runStateText(attempt.state)}`;
  }
  const name = scopeName?.(attempt.scopeId) ?? attempt.scopeId;
  const action = `${humanizeEventType(String(attempt.kind)).toLowerCase()} ${runStateText(attempt.state)}`;
  return name ? `${name}: ${action}` : action[0]!.toUpperCase() + action.slice(1);
}
/** Human label for a durable run event (types emitted by apps/server operatorStore/operatorRunner/operatorBudget). */
export function operatorEventLabel(event: Pick<OperatorEvent, 'type' | 'detail'>, scopeName?: (scopeId: string) => string | undefined): string {
  const detail = event.detail ?? {};
  const scope = typeof detail.scopeId === 'string' ? ` · ${scopeName?.(detail.scopeId) ?? detail.scopeId}` : '';
  const num = (key: string) => typeof detail[key] === 'number' ? detail[key] as number : undefined;
  const budget = detail.kind === 'judgment' ? 'Judgment budget' : detail.kind === 'claim-check' ? 'Claim-check budget' : 'Budget';
  switch (event.type) {
    case 'run.state': return `Run ${runStateText(detail.state)}`;
    case 'budget.reserved': { const tokens = num('tokens'); const dollars = num('dollars'); const limits = [tokens !== undefined ? `${tokens} tokens` : '', dollars !== undefined ? money(dollars) : ''].filter(Boolean).join(' / '); return `${budget} reserved${limits ? ` · up to ${limits}` : ''}`; }
    case 'budget.settled': { const input = num('inputTokens'); const output = num('outputTokens'); const cost = num('measuredCostUsd') ?? num('estimatedCostUsd'); return `${budget} settled${input !== undefined || output !== undefined ? ` · ${input ?? 0} in / ${output ?? 0} out tokens` : ''}${cost !== undefined ? ` · ${money(cost)}` : ''}`; }
    case 'budget.released': return `${budget} released (request not sent)`;
    case 'draft.conflict': return detail.reason === 'stale_retry_base' ? 'Draft conflict: action started from an older revision' : detail.reason === 'retry_compare_and_swap' ? 'Draft conflict: a newer revision was installed first' : 'Draft conflict';
    case 'enrichment.retry_failed': return `Retry failed${scope}`;
    case 'enrichment.budget_refused': return `Enrichment refused by the ${typeof detail.ledger === 'string' ? `${detail.ledger} ` : ''}budget${scope}`;
    case 'enrichment.unavailable': return `Enrichment unavailable${scope || (typeof detail.reason === 'string' ? `: ${detail.reason}` : '')}`;
    case 'enrichment.finished': { const stopped = detail.stopped; const accepted = num('accepted'); const inScope = num('inScope'); const what = detail.kind === 'retry' ? 'Retry pass' : detail.pass === 'incremental' ? 'Update pass' : 'Enrichment'; const outcome = stopped === 'limit' ? 'stopped at the budget limit' : stopped === 'cancelled' ? 'cancelled' : stopped === 'unavailable' ? 'finished without a gateway' : 'finished'; return `${what} ${outcome}${accepted !== undefined && inScope !== undefined ? ` · ${fmt(accepted)}/${fmt(inScope)} in scope accepted` : ''}`; }
    case 'enrichment.budget_reached': { const accepted = num('accepted'); const attempted = num('attempted'); return `Enrichment stopped at the budget limit${accepted !== undefined && attempted !== undefined ? ` · ${accepted} accepted of ${attempted} attempted` : ''}`; }
    case 'claim_checks.started': { const scopes = num('scopes'); return `Claim checks started${scopes !== undefined ? ` · ${scopes} scope${scopes === 1 ? '' : 's'}` : ''} · report-only`; }
    case 'claim_checks.finished': { const claims = num('claims'); const stopped = detail.stopped; const message = claimPassMessage(event); return `Claim checks ${stopped === 'cancelled' ? 'cancelled' : stopped === 'limit' ? 'stopped at the claim-check budget' : stopped === 'unavailable' ? 'finished without Jev (code checks only)' : stopped === 'complete' || stopped === 'failed' ? 'finished' : `not run (${String(stopped)})`}${claims !== undefined ? ` · ${claims} claim${claims === 1 ? '' : 's'}` : ''} · report-only${message ? ` · ${message}` : ''}`; }
    // CLA-271 incremental updates.
    case 'incremental.up_to_date': return `Already at the latest commit${typeof detail.commitSha === 'string' ? ` (${detail.commitSha.slice(0, 7)})` : ''}`;
    case 'incremental.diff': { const sha = (key: string) => typeof detail[key] === 'string' ? (detail[key] as string).slice(0, 7) : '?'; const parts = [['dirty', 'to re-enrich'], ['reused', 'reused'], ['stale', 'stale']].flatMap(([key, word]) => num(key!) !== undefined ? [`${fmt(num(key!)!)} ${word}`] : []); return `Changes ${sha('fromCommit')} → ${sha('toCommit')}${parts.length ? ` · ${parts.join(', ')}` : ''}`; }
    case 'incremental.finished': return `Update finished${typeof detail.summary === 'string' ? ` · ${detail.summary}` : ''}`;
    case 'incremental.auto_publish': return detail.published === true ? `Auto-published${typeof detail.versionId === 'string' ? ` ${detail.versionId}` : ''}` : `Not auto-published${typeof detail.reason === 'string' ? ` (${detail.reason.replace(/_/g, ' ')})` : ''}`;
    default: return humanizeEventType(event.type);
  }
}

export const OPERATOR_SESSION_EXPIRED = 'Your session expired — sign in again.';
export const OPERATOR_NOT_OPERATOR = 'You are signed in, but this GitHub account is not (or is no longer) a configured operator. Sign in with an operator account or ask to be added.';
export const STALE_REVISION_MESSAGE = 'This revision is out of date: the run has a newer draft revision. Open the current revision to retry or refresh scopes.';
export const ACTION_RUNNING_MESSAGE = 'Another operator action is already running for this run. Wait for it to finish, then try again.';
export type OperatorFailure = { kind: 'expired' } | { kind: 'not-operator' } | { kind: 'stale-revision'; message: string; currentDraftRevisionId?: string } | { kind: 'action-running'; message: string } | { kind: 'error'; message: string };
/**
 * Classifies a failed operator call on the server's structured `code` (CLA-264), never on its message text:
 * `session_expired` → expired, `not_operator` (e.g. removed from the allow-list mid-session) → not an operator,
 * `draft_superseded` / `run_active` 409s get their own UI; a `csrf_rejected` 403 keeps its message. A code-less
 * 401/403 (an older server) after the workspace was allowed re-checks the session and counts as expired.
 */
export async function classifyOperatorFailure(cause: unknown, wasAllowed: boolean, checkSession: () => Promise<{ operator: boolean }>, fallback = 'Operator action failed.'): Promise<OperatorFailure> {
  const message = cause instanceof Error ? cause.message : fallback;
  if (!(cause instanceof OperatorApiError)) return { kind: 'error', message };
  // Access denials are decided by code. A code-less 401/403 (an older server or a proxy) still falls back to a session
  // re-check below. The 409 cases rely on codes only: the server and this client ship together, so no text matching.
  const code = cause.body?.code;
  if (code === 'session_expired') return { kind: 'expired' };
  if (code === 'not_operator') return { kind: 'not-operator' };
  if (code === 'csrf_rejected') return { kind: 'error', message: 'This request was refused because it did not come from this site. Reload the page and try again.' };
  if ((cause.status === 401 || cause.status === 403) && wasAllowed) {
    try { if (!(await checkSession()).operator) return { kind: 'expired' }; } catch { /* keep the original failure when the re-check itself fails */ }
    return { kind: 'error', message };
  }
  if (code === 'draft_superseded') return { kind: 'stale-revision', message: STALE_REVISION_MESSAGE, ...(typeof cause.body?.currentDraftRevisionId === 'string' ? { currentDraftRevisionId: cause.body.currentDraftRevisionId } : {}) };
  if (code === 'run_active') return { kind: 'action-running', message: ACTION_RUNNING_MESSAGE };
  return { kind: 'error', message };
}
/** A publish refused because the publication changed elsewhere (409 `publication_stale`). */
export function isPublicationConflict(cause: unknown): boolean { return cause instanceof OperatorApiError && cause.body?.code === 'publication_stale'; }
/** The revision "Open current revision" loads: the freshly refreshed run's, else the one the 409 reported. */
export function currentRevisionTarget(freshRunDraftRevisionId: string | undefined, reported: string | undefined): string | undefined { return freshRunDraftRevisionId ?? reported; }
/** Stale-revision context belongs to one run; its alert/button render only while that run is selected. */
export type StaleRevisionContext = { runId: string; currentDraftRevisionId?: string };
export function staleRevisionFor(stale: StaleRevisionContext | undefined, selectedRunId: string | undefined): StaleRevisionContext | undefined { return stale && selectedRunId !== undefined && stale.runId === selectedRunId ? stale : undefined; }
/**
 * Next stale-revision context after a classified failure of an action started for `failedRunId`.
 * `undefined` for `apply` means the failure arrived after the user switched runs and must be ignored.
 */
export function staleRevisionAfterFailure(outcome: OperatorFailure, failedRunId: string | undefined, selectedRunId: string | undefined, current: StaleRevisionContext | undefined, keepStale = false): { apply: boolean; stale: StaleRevisionContext | undefined } {
  if (failedRunId !== undefined && failedRunId !== selectedRunId) return { apply: false, stale: current };
  if (outcome.kind === 'stale-revision' && failedRunId !== undefined) return { apply: true, stale: { runId: failedRunId, ...(outcome.currentDraftRevisionId ? { currentDraftRevisionId: outcome.currentDraftRevisionId } : {}) } };
  return { apply: true, stale: keepStale ? current : undefined };
}
/** A loaded draft must belong to the run it was opened for. */
export function draftBelongsToRun(detail: Pick<DraftDetail, 'draft'>, runId: string): boolean { return detail.draft.runId === runId; }

/**
 * CLA-145: a claim-check pass reports its outcome on its `claim_checks.finished` event (never on run.error, which stays
 * the enrichment error). The message of the run's latest pass, if it has one.
 */
export function claimPassMessage(event: Pick<OperatorEvent, 'type' | 'detail'> | undefined): string | undefined {
  const message = event?.type === 'claim_checks.finished' ? event.detail?.message : undefined;
  return typeof message === 'string' && message ? message : undefined;
}
export function latestClaimPassMessage(events: readonly Pick<OperatorEvent, 'type' | 'detail'>[] | undefined): string | undefined {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) if (events![index]!.type === 'claim_checks.finished') return claimPassMessage(events![index]);
  return undefined;
}
