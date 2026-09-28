import type { OperatorEvent, OperatorRun, OperatorRunBudget, OperatorScope, OperatorUsage } from './api';
import { scopeStateLabel, supersededLabel } from './reviewState';
import { count, retryEstimate, usd } from './scopeSelection';

/**
 * Run completion banner (CLA-258): one pure decision of what the operator should read first and do next.
 * Counts come from the loaded revision's scope states (below-cap scopes are out of scope); the outcome and
 * duration come from the latest `enrichment.finished` event, with legacy fallbacks for runs recorded before it.
 */
export type CompletionKind = 'running' | 'complete' | 'failures' | 'budget' | 'incomplete' | 'cancelled' | 'unavailable' | 'run-failed' | 'interrupted' | 'retry' | 'older';
export type CompletionAction = 'preview-publish' | 'retry-failed' | 'retry-not-run' | 'review-newer';
export interface CompletionBanner { kind: CompletionKind; title: string; detail?: string; actions: CompletionAction[]; failedScopeIds: string[]; notRunScopeIds: string[]; retryFailedLabel?: string; /** Button text for `review-newer` ("Open revision 7" when its number is known). */ reviewNewerLabel?: string; }
export interface CompletionInput {
  run: Pick<OperatorRun, 'state' | 'createdAt' | 'updatedAt'>;
  events: readonly Pick<OperatorEvent, 'type' | 'detail'>[];
  usage?: OperatorUsage;
  scopes: readonly Pick<OperatorScope, 'scopeId' | 'name' | 'state' | 'stale' | 'kind' | 'depth' | 'parentScopeId' | 'explanation'>[];
  avgCostPerScopeUsd?: number;
  budget?: OperatorRunBudget;
  progress?: { accepted: number; failed: number; inFlight: number };
  /** The displayed revision is not the run's current one: the banner says it is superseded and points at the newer one. */
  newerRevision?: boolean;
  /** The current revision's number, when known ("results are in revision 7"). */
  newerRevisionNumber?: number;
}

/** "4m 12s", "38s", "1h 2m". */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function lastOf(events: CompletionInput['events'], types: readonly string[]) { for (let index = events.length - 1; index >= 0; index -= 1) if (types.includes(events[index]!.type)) return events[index]; return undefined; }

export function completionBanner(input: CompletionInput): CompletionBanner | undefined {
  const inScope = input.scopes.filter(scope => scope.state !== 'below cap');
  // Same labels as the chips (a stale scope counts as stale, not accepted). "accepted" also needs a pinned
  // explanation, so an accepted state without one can never make a revision look complete.
  const label = (scope: CompletionInput['scopes'][number]) => scopeStateLabel(scope);
  const accepted = inScope.filter(scope => label(scope) === 'accepted' && scope.explanation !== undefined).length;
  const failed = inScope.filter(scope => label(scope) === 'failed').map(scope => scope.scopeId);
  const notRun = inScope.filter(scope => label(scope) === 'not run').map(scope => scope.scopeId);
  const stale = inScope.filter(scope => label(scope) === 'stale').length;
  const total = inScope.length;
  const base = { failedScopeIds: failed, notRunScopeIds: notRun };
  const tally = `${count(accepted)}/${count(total)} accepted`;

  // CLA-264: a superseded revision's failed/not-run counts are not the run's results (a full run's working revision shows
  // every scope "not run"), so none are stated and no retry is offered; the only action opens the current revision. It is checked first so a
  // superseded view always gets this one notice (the coverage row then renders nothing), even while the run is active.
  if (input.newerRevision) {
    const where = input.newerRevisionNumber !== undefined ? `revision ${input.newerRevisionNumber}` : 'a newer revision';
    return { kind: 'older', title: supersededLabel(input.newerRevisionNumber !== undefined ? { revision: input.newerRevisionNumber } : {}), detail: `You are viewing an older revision of this run. Its scope states are as of that revision, not the run's results, so retry is off here; open ${where} to review, retry and publish.`, actions: ['review-newer'], reviewNewerLabel: input.newerRevisionNumber !== undefined ? `Open revision ${input.newerRevisionNumber}` : 'Review newer revision', failedScopeIds: [], notRunScopeIds: [] };
  }

  if (input.run.state === 'queued' || input.run.state === 'running') {
    const settled = input.progress ? input.progress.accepted + input.progress.failed : undefined;
    return { kind: 'running', title: settled !== undefined ? `Enriching… ${count(settled)} settled${input.progress!.inFlight ? ` · ${count(input.progress!.inFlight)} in flight` : ''}` : 'Enriching…', detail: `${count(total)} scopes in scope. This page refreshes every few seconds.`, actions: [], ...base };
  }
  if (input.run.state === 'failed') return { kind: 'run-failed', title: 'Run failed', detail: 'See the error above and the event log.', actions: [], ...base };
  if (!total) return undefined;

  // Latest completion record; legacy runs only have the stop reasons (or nothing, when they completed).
  const finished = lastOf(input.events, ['enrichment.finished']);
  const legacyStop = lastOf(input.events, ['enrichment.budget_reached', 'enrichment.unavailable']);
  const stopped = typeof finished?.detail?.stopped === 'string' ? finished.detail.stopped : legacyStop?.type === 'enrichment.budget_reached' ? 'limit' : legacyStop?.type === 'enrichment.unavailable' && legacyStop.detail?.scopeId === undefined ? 'unavailable' : 'complete';
  // A recorded pass reports its own duration and cost; legacy runs fall back to the whole run's duration and total cost.
  const durationMs = typeof finished?.detail?.durationMs === 'number' ? finished.detail.durationMs : input.run.updatedAt - input.run.createdAt;
  const cost = finished ? (typeof finished.detail?.costUsd === 'number' ? finished.detail.costUsd : undefined) : input.usage?.measuredCostUsd ?? input.usage?.estimatedCostUsd;
  const remaining = [...(failed.length ? [`${count(failed.length)} failed`] : []), ...(notRun.length ? [`${count(notRun.length)} not run`] : []), ...(stale ? [`${count(stale)} stale`] : [])];
  const tallyWithRest = [tally, ...remaining].join(', ');
  const facts = [`in ${formatDuration(durationMs)}`, ...(cost !== undefined && cost > 0 ? [usd(cost)] : [])].join(' · ');
  const failedEstimate = failed.length ? retryEstimate(input.scopes, failed, input.avgCostPerScopeUsd, input.budget) : undefined;
  const retryFailedLabel = failed.length ? `Retry all failed (${count(failed.length)})${failedEstimate?.estimatedUsd !== undefined ? ` · est. ${usd(failedEstimate.estimatedUsd)}` : ''}` : undefined;
  const withRetry = { ...base, ...(retryFailedLabel ? { retryFailedLabel } : {}) };

  if (input.run.state === 'interrupted') return { kind: 'interrupted', title: `Run interrupted — ${tally}`, detail: 'The server restarted while this run was active. Retry the scopes that did not finish.', actions: [...(failed.length ? ['retry-failed' as const] : []), ...(notRun.length ? ['retry-not-run' as const] : [])], ...withRetry };
  if (input.run.state === 'cancelled' || stopped === 'cancelled') return { kind: 'cancelled', title: `Run cancelled — ${tallyWithRest}`, actions: failed.length ? ['retry-failed'] : [], ...withRetry };
  if (stopped === 'limit') return { kind: 'budget', title: `Enrichment stopped at the budget limit — ${tallyWithRest}`, detail: `${facts}. ${notRun.length ? 'Retry the not-run scopes (fit to the remaining budget) or raise the run budget.' : failed.length ? 'Retry the failed scopes or raise the run budget.' : stale ? 'Refresh the stale parents or raise the run budget.' : 'Every in-scope scope settled before the stop.'}`, actions: [...(failed.length ? ['retry-failed' as const] : []), ...(notRun.length ? ['retry-not-run' as const] : [])], ...withRetry };
  if (stopped === 'unavailable') return { kind: 'unavailable', title: `Enrichment did not run — no gateway configured`, detail: `${tally}, ${count(notRun.length)} not run. Configure the enrichment gateway, then retry.`, actions: notRun.length ? ['retry-not-run'] : [], ...withRetry };
  // A retry pass reports its own outcome first: how many selected scopes it accepted and failed.
  const detailNumber = (key: string) => typeof finished?.detail?.[key] === 'number' ? finished.detail[key] as number : undefined;
  const retryFailed = finished?.detail?.kind === 'retry' ? detailNumber('retryFailed') : undefined;
  if (retryFailed) {
    const retryAccepted = detailNumber('retryAccepted') ?? 0; const selected = detailNumber('selected') ?? retryAccepted + retryFailed; const kept = detailNumber('retryKept');
    const keptNote = kept === undefined ? '' : kept === retryFailed ? ` (previous explanation${kept === 1 ? '' : 's'} kept)` : kept ? ` (${count(kept)} previous explanation${kept === 1 ? '' : 's'} kept)` : '';
    return { kind: 'retry', title: `Retry finished — ${count(retryAccepted)} of ${count(selected)} accepted, ${count(retryFailed)} failed${keptNote}`, detail: `${facts}. This revision: ${tallyWithRest}.${finished?.detail?.installed === false ? ' No new revision was installed because nothing changed.' : ''}`, actions: failed.length ? ['retry-failed'] : notRun.length ? ['retry-not-run'] : [], ...withRetry };
  }
  if (failed.length) return { kind: 'failures', title: `Enrichment finished with ${count(failed.length)} failed — ${[tally, ...remaining.slice(1)].join(', ')}`, detail: facts, actions: ['retry-failed'], ...withRetry };
  if (notRun.length || stale || accepted < total) return { kind: 'incomplete', title: `Enrichment finished — ${tallyWithRest}`, detail: `${facts}. Refresh stale parents or retry the not-run scopes before publishing.`, actions: notRun.length ? ['retry-not-run'] : [], ...withRetry };
  return { kind: 'complete', title: `Enrichment complete — ${tally} ${facts}`, detail: 'Next: Preview → Publish.', actions: ['preview-publish'], ...withRetry };
}
