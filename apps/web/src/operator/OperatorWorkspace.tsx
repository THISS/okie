import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExplanationView } from '../explanation/ExplanationView';
import { evidenceSourceUrl } from '../explanation/explanationModel';
import { operatorApi, OperatorApiError, type DraftDetail, type OperatorDraft, type OperatorRun, type OperatorRunDetail, type OperatorScope } from './api';
import { acceptsReviewResponse, attemptLabel, coverageIncomplete, currentRevisionTarget, followsCurrentRevision, latestClaimPassMessage, operatorEventLabel, publicationAcknowledgementAfterConflict, reviewStateLabel, runStateLabel, supersededBy, supersededRetryHint, usageDiffers, usageSummary, type StaleRevisionContext } from './reviewState';
import { OperatorAccessMessage, OperatorCoverage, OperatorErrorAlert, OperatorStoredError } from './OperatorViews';
import { failureEffect, loadReview, PUBLICATION_CONFLICT_MESSAGE, publishRevision } from './workspaceController';
import { completionBanner } from './completion';
import { OperatorCompletionBanner, OperatorRetryConfirm } from './OperatorBatchRetry';
import { OperatorScopeList } from './OperatorScopeList';
import { OperatorClaimChecks } from './OperatorClaimChecks';
import { splitActivityAttempts } from './claimChecks';
import { nextOpenScope, retryOrder, scopeLabel, scopeVisibility, type ScopeListOptions, type ScopeSort, type ScopeVisibility } from './scopeList';
import { budgetWarning, buildRetryRequest, confirmText, fitToBudget, isBelowCap, refreshLabel, remainingBudgetUsd, remainingRequests, retryEstimate, selectable, tokenBudgetOf, type RetryFraction, type ScopeFilter } from './scopeSelection';
import { initialRun, runIdFromSearch, searchWithRun } from './runUrl';
import { incrementalRunLabel, noDraftMessage, repositoryIdOf, requestUpdate, staleReasonText, updateButtonState, type UpdateOutcome } from './incremental';
import { OperatorChangelog, OperatorUpdateResult } from './OperatorIncremental';
import './operator.css';

/** Latest attempts and events shown; both scroll inside a bounded box. */
const ACTIVITY_LIMIT = 200;
const CLAIM_ACTIVITY_LIMIT = 20;
function time(value: number): string { return new Date(value).toLocaleString(); }

export function OperatorWorkspace({ onPreview, initialRunId, initialDraftRevisionId }: { /** `pinned`: the previewed revision was an explicit choice; only then should returning from the preview pin it (CLA-264). */ onPreview(runId: string, draftRevisionId: string, scopes: OperatorScope[], pinned: boolean): Promise<void>; initialRunId?: string; /** An explicitly chosen revision to pin; without one the workspace follows the run's current revision. */ initialDraftRevisionId?: string }) {
  const [allowed, setAllowed] = useState<boolean>();
  const [runs, setRuns] = useState<OperatorRun[]>([]);
  /** CLA-145: a re-check refusal, shown inline in that scope's claim panel as well as at the page top. */
  const [claimError, setClaimError] = useState<{ scopeId: string; message: string }>();
  const [selectedRun, setSelectedRun] = useState<OperatorRun>();
  /** An explicitly chosen revision (CLA-264). Undefined = follow the run's current revision; loading never pins. */
  const [selectedDraftRevisionId, setSelectedDraftRevisionId] = useState<string | undefined>(initialDraftRevisionId);
  const pinnedRef = useRef(selectedDraftRevisionId);
  pinnedRef.current = selectedDraftRevisionId;
  /** The run's current draft as the run detail reported it (its revision number names a superseding revision). */
  const [currentDraft, setCurrentDraft] = useState<OperatorDraft>();
  const [detail, setDetail] = useState<DraftDetail>();
  const detailRef = useRef<DraftDetail | undefined>(undefined);
  detailRef.current = detail;
  const [scope, setScope] = useState<OperatorScope>();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [runActivity, setRunActivity] = useState<Omit<OperatorRunDetail, 'run' | 'draft'>>();
  // Batch retry (CLA-258): list filter, below-cap opt-in, selection, and the confirm step. Search and sort: CLA-259.
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [scopeQuery, setScopeQuery] = useState('');
  const [scopeSort, setScopeSort] = useState<ScopeSort>('hierarchy');
  const [showBelowCap, setShowBelowCap] = useState(false);
  const listOptions: ScopeListOptions = { filter: scopeFilter, query: scopeQuery, showBelowCap, sort: scopeSort };
  const showBelowCapRef = useRef(showBelowCap);
  showBelowCapRef.current = showBelowCap;
  /** True once the operator opened a scope explicitly; automatic defaults are re-chosen on every load. */
  const scopePinnedRef = useRef(false);
  const inspectorRef = useRef<HTMLElement>(null);
  const [selectedScopeIds, setSelectedScopeIds] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [fraction, setFraction] = useState<RetryFraction>({ mode: 'all' });
  const [firstCount, setFirstCount] = useState(10);
  const publishRef = useRef<HTMLElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  /** Lost access mid-session: the session is gone (`session_expired`) or the account is no longer an operator (`not_operator`). */
  const [denied, setDenied] = useState<'expired' | 'not-operator'>();
  const [staleRevision, setStaleRevision] = useState<StaleRevisionContext>();
  const staleRevisionRef = useRef<StaleRevisionContext | undefined>(undefined);
  staleRevisionRef.current = staleRevision;
  const feedbackRef = useRef<HTMLDivElement>(null);
  /** CLA-271: the last "Update to latest commit" result, shown inline under the run header it was asked from. */
  const [update, setUpdate] = useState<{ runId: string; outcome: UpdateOutcome }>();

  // Read once at mount, before the URL-sync effect below can rewrite `?run=`.
  const requestedRunId = useRef(initialRunId ?? runIdFromSearch(window.location.search));
  const requestEpoch = useRef(0);
  const selectedRunIdRef = useRef<string | undefined>(undefined);
  selectedRunIdRef.current = selectedRun?.runId;
  const refreshRuns = useCallback(async () => { const response = await operatorApi.runs(); setRuns(response.runs); setSelectedRun(current => response.runs.find(run => run.runId === current?.runId) ?? current); return response.runs; }, []);
  const loadSelectedRun = useCallback(async (runId: string, revisionId?: string) => {
    const epoch = ++requestEpoch.current;
    // loadReview (tested) decides the revision: an explicit target, else the pin, else the run's current revision.
    const loaded = await loadReview(operatorApi, runId, pinnedRef.current, revisionId, () => acceptsReviewResponse(epoch, requestEpoch.current, runId, selectedRunIdRef.current ?? runId));
    if (!loaded) return;
    const { runDetail } = loaded;
    setSelectedRun(runDetail.run); setCurrentDraft(loaded.currentDraft);
    const { run: _run, draft: _draft, ...activity } = runDetail; setRunActivity(activity);
    const draft = loaded.detail;
    if (!draft) { setDetail(undefined); return; }
    // A different revision invalidates the selection: retries always target the loaded (current) revision.
    if (detailRef.current?.draft.draftRevisionId !== draft.draft.draftRevisionId) { setSelectedScopeIds(new Set()); setConfirming(false); }
    setDetail(draft);
    setScope(current => nextOpenScope(draft.scopes, current?.scopeId, scopePinnedRef.current, showBelowCapRef.current));
  }, []);
  const allowedRef = useRef(false);
  allowedRef.current = allowed === true;
  /** Every operator failure goes through one classifier: expired sessions, stale revisions and busy runs get their own UI. */
  const fail = useCallback(async (cause: unknown, fallback: string, runId?: string, keepStale = false) => {
    const effect = await failureEffect(cause, { wasAllowed: allowedRef.current, checkSession: operatorApi.session, fallback, ...(runId !== undefined ? { failedRunId: runId } : {}), ...(selectedRunIdRef.current !== undefined ? { selectedRunId: selectedRunIdRef.current } : {}), ...(staleRevisionRef.current ? { stale: staleRevisionRef.current } : {}), keepStale });
    if ('denied' in effect) { setDenied(effect.denied); return; }
    if ('ignore' in effect) return; // the user switched runs before this failure arrived
    setStaleRevision(effect.stale); setError(effect.message);
  }, []);
  useEffect(() => { void (async () => { try { const session = await operatorApi.session(); setAllowed(session.operator); if (session.operator) { const values = await refreshRuns(); { const opened = initialRun(values, requestedRunId.current); if (opened) setSelectedRun(opened); } } } catch (cause) { setAllowed(false); setError(cause instanceof Error ? cause.message : 'Could not check operator access.'); } })(); }, [initialRunId, refreshRuns]);
  useEffect(() => {
    if (!selectedRun) return;
    void loadSelectedRun(selectedRun.runId).catch(cause => fail(cause, 'Could not refresh this run.'));
    return () => { requestEpoch.current += 1; };
  }, [selectedRun?.runId]);
  // Unpinned review follows the run (CLA-264): when the run's current revision moves on (a pass installed its results),
  // load it, so a finished run never stays on the working revision its enrichment ran on.
  useEffect(() => {
    if (!selectedRun || !detail || !followsCurrentRevision(selectedDraftRevisionId, selectedRun.draftRevisionId, detail.draft.draftRevisionId)) return;
    void loadSelectedRun(selectedRun.runId).catch(cause => fail(cause, 'Could not open the current revision.'));
  }, [selectedRun?.runId, selectedRun?.draftRevisionId, detail?.draft.draftRevisionId, selectedDraftRevisionId]);
  useEffect(() => {
    if (denied || !selectedRun || !['queued', 'running'].includes(selectedRun.state)) return;
    const timer = window.setInterval(() => { void loadSelectedRun(selectedRun.runId).catch(cause => fail(cause, 'Could not refresh this run.')); void refreshRuns().catch(cause => fail(cause, 'Could not refresh runs.')); }, 5000);
    return () => window.clearInterval(timer);
  }, [denied, fail, loadSelectedRun, refreshRuns, selectedRun?.runId, selectedRun?.state]);
  // Keep the selected run in the URL so a reload reopens it (replaceState: no extra history entries).
  useEffect(() => {
    if (allowed !== true || !selectedRun) return; // nothing selected yet: keep a requested ?run= until runs load
    const search = searchWithRun(window.location.search, selectedRun?.runId);
    if (search !== window.location.search) window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}${window.location.hash}`);
  }, [allowed, selectedRun?.runId]);
  // Page scroll: bring action feedback into view when it appears (actions are often far below it).
  useEffect(() => { if (error || notice) feedbackRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [error, notice]);
  const staleScopes = useMemo(() => detail?.scopes.filter(item => item.stale) ?? [], [detail]);
  // Retry order ("first N", fit to budget): problems first, then hierarchy tree order; independent of the list's Sort.
  const orderedScopes = useMemo(() => retryOrder(detail?.scopes ?? []), [detail]);
  const scopeLookup = useMemo(() => new Map((detail?.scopes ?? []).map(item => [item.scopeId, item])), [detail]);
  const openScope = (next: OperatorScope) => {
    scopePinnedRef.current = true; setScope(next);
    // The list is sticky and bounded; bring the inspector's top back into view if the operator had scrolled past it.
    window.requestAnimationFrame?.(() => { const top = inspectorRef.current?.getBoundingClientRect().top; if (top !== undefined && top < 0) inspectorRef.current?.scrollIntoView?.({ block: 'start' }); });
  };
  const resetScope = () => { scopePinnedRef.current = false; setScope(undefined); };
  const orderedSelection = useMemo(() => orderedScopes.filter(item => selectedScopeIds.has(item.scopeId)).map(item => item.scopeId), [orderedScopes, selectedScopeIds]);
  const remainingUsd = remainingBudgetUsd(runActivity?.budget);
  const requestsLeft = remainingRequests(runActivity?.budget);
  const avgCost = runActivity?.avgCostPerScopeUsd;
  // One request builder (unit-tested) decides exactly what is sent: sliced ids and the explicit below-cap opt-in.
  // Fit to budget respects the token cap too (CLA-264), estimated from this run's average reported tokens per scope.
  const avgTokens = runActivity?.avgTokensPerScope;
  const tokenBudget = useMemo(() => tokenBudgetOf(runActivity?.budget, avgTokens), [runActivity?.budget, avgTokens]);
  const tokensLeft = tokenBudget.remainingTokens;
  const retryRequest = useMemo(() => buildRetryRequest({ orderedSelection, fraction, scopes: detail?.scopes ?? [], showBelowCap, ...(remainingUsd !== undefined ? { remainingUsd } : {}), ...(avgCost !== undefined ? { avgCostPerScopeUsd: avgCost } : {}), ...(requestsLeft !== undefined ? { remainingRequests: requestsLeft } : {}), tokens: tokenBudget }), [orderedSelection, fraction, detail, showBelowCap, remainingUsd, avgCost, requestsLeft, tokenBudget]);
  const retryIds = 'scopeIds' in retryRequest ? retryRequest.scopeIds : [];
  const retryEstimateNow = retryEstimate(detail?.scopes ?? [], retryIds, avgCost, runActivity?.budget, avgTokens);
  const superseded = supersededBy(detail?.draft, selectedRun, currentDraft);
  const newerRevision = !!superseded;
  const banner = selectedRun && detail ? completionBanner({ run: selectedRun, events: runActivity?.events ?? [], scopes: detail.scopes, ...(runActivity?.usage ? { usage: runActivity.usage } : {}), ...(runActivity?.avgCostPerScopeUsd !== undefined ? { avgCostPerScopeUsd: runActivity.avgCostPerScopeUsd } : {}), ...(runActivity?.budget ? { budget: runActivity.budget } : {}), ...(runActivity?.progress ? { progress: runActivity.progress } : {}), ...(newerRevision ? { newerRevision } : {}), ...(superseded?.revision !== undefined ? { newerRevisionNumber: superseded.revision } : {}) }) : undefined;
  /** Opens the current revision and unpins, so review keeps following the run. */
  const reviewNewer = () => { if (!selectedRun?.draftRevisionId) return; const { runId, draftRevisionId } = selectedRun; void act('review', async () => { setSelectedDraftRevisionId(undefined); await loadSelectedRun(runId, draftRevisionId); }); };
  /** Replace the selection and open the confirm step (banner shortcuts: "Retry all failed", "Retry not run"). */
  const reviewRetry = (ids: string[]) => { setSelectedScopeIds(new Set(ids)); setFraction({ mode: 'all' }); setConfirming(true); window.setTimeout(() => confirmRef.current?.scrollIntoView?.({ block: 'nearest' }), 0); };
  const focusPublish = () => { publishRef.current?.scrollIntoView?.({ block: 'center' }); publishRef.current?.querySelector<HTMLElement>('input, button')?.focus(); };
  const incomplete = !!detail && coverageIncomplete(detail.draft.coverage);
  const act = async (name: string, work: () => Promise<void>) => { const runId = selectedRunIdRef.current; setBusy(name); setError(undefined); setNotice(undefined); setStaleRevision(undefined); try { await work(); } catch (cause) { await fail(cause, 'Operator action failed.', runId); } finally { setBusy(undefined); } };
  const clearFeedback = () => { setError(undefined); setNotice(undefined); setStaleRevision(undefined); };
  const reloadDraft = async () => { if (!selectedRun) return; await loadSelectedRun(selectedRun.runId, selectedDraftRevisionId); await refreshRuns(); };

  const mutateRevision = async <T,>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); }
    catch (cause) {
      // Refreshing the run also refreshes `selectedRun.draftRevisionId`, the fallback target for "Open current revision".
      if (cause instanceof OperatorApiError && cause.status === 409) await reloadDraft().catch(() => undefined);
      throw cause;
    }
  };

  /** Keeps the stale alert (and its button) mounted while opening; a failed jump keeps the context for another try. */
  const openCurrentRevision = async (runId: string) => {
    setBusy('open-current');
    try {
      const target = currentRevisionTarget((await refreshRuns()).find(run => run.runId === runId)?.draftRevisionId, staleRevisionRef.current?.runId === runId ? staleRevisionRef.current.currentDraftRevisionId : undefined);
      if (!target) throw new Error('No current revision is available yet. Refresh the run and try again.');
      setSelectedDraftRevisionId(undefined);
      await loadSelectedRun(runId, target);
      if (selectedRunIdRef.current !== runId) return;
      setAcknowledged(false); clearFeedback(); setNotice(`Opened current revision ${target}.`);
    } catch (cause) { await fail(cause, 'Could not open the current revision.', runId, true); } finally { setBusy(undefined); }
  };
  /** Opens a run from scratch: no pinned revision, scope, selection or feedback carries over. */
  const openRun = (run: OperatorRun) => { clearFeedback(); setSelectedDraftRevisionId(undefined); setAcknowledged(false); setDetail(undefined); resetScope(); setRunActivity(undefined); setSelectedScopeIds(new Set()); setConfirming(false); setUpdate(undefined); setSelectedRun(run); };
  const openRunById = async (runId: string) => { const listed = (await refreshRuns()).find(run => run.runId === runId); openRun(listed ?? (await operatorApi.run(runId)).run); };
  /** CLA-271 "Update to latest commit": a started run is opened (it polls like any run); other results show inline. */
  const updateToLatest = (run: OperatorRun) => void act('incremental', async () => {
    const outcome = await requestUpdate(() => operatorApi.incremental(repositoryIdOf(run)));
    if (outcome.kind === 'started') { await openRunById(outcome.runId); setNotice(outcome.message); return; }
    if (outcome.kind === 'active') await refreshRuns();
    setUpdate({ runId: run.runId, outcome });
  });
  const scopeName = (scopeId: string) => detail?.scopes.find(item => item.scopeId === scopeId)?.name;

  if (denied) return <OperatorAccessMessage expired={denied === 'expired'} revoked={denied === 'not-operator'}/>;
  if (allowed === undefined) return <main className="operator-shell"><p role="status">Checking operator access…</p></main>;
  if (!allowed) return <OperatorAccessMessage/>;
  return <main className="operator-shell">
    <header className="operator-header"><div><a className="operator-brand" href="/">Source For Atlas</a><h1>Operator review</h1></div><a href="/">Public atlas</a></header>
    <div className="operator-feedback" ref={feedbackRef}>{error && <OperatorErrorAlert error={error} onOpenCurrent={runId => void openCurrentRevision(runId)} opening={busy === 'open-current'} selectedRunId={selectedRun?.runId} stale={staleRevision}/>}{notice && <p className="operator-notice" role="status">{notice}</p>}</div>
    <section className="operator-start"><h2>Scan a public repository</h2><form onSubmit={event => { event.preventDefault(); void act('start', async () => { const started = await operatorApi.start(url, crypto.randomUUID()); await refreshRuns(); clearFeedback(); setSelectedDraftRevisionId(undefined); setAcknowledged(false); setDetail(undefined); resetScope(); setRunActivity(undefined); setSelectedRun(started.run); setUrl(''); setNotice(started.deduped ? 'Reopened the matching active run.' : 'Scan queued.'); }); }}><input aria-label="Public GitHub repository URL" placeholder="https://github.com/owner/repository" required type="url" value={url} onChange={event => setUrl(event.target.value)}/><button disabled={busy === 'start'}>{busy === 'start' ? 'Starting…' : 'Start scan'}</button></form></section>
    <div className="operator-layout"><aside><h2>Runs</h2>{runs.length === 0 ? <p className="operator-muted">No scan runs yet.</p> : <ol className="operator-runs">{runs.map(run => <li key={run.runId}><button className={selectedRun?.runId === run.runId ? 'selected' : ''} data-run-kind={run.kind ?? 'full'} onClick={() => openRun(run)}><strong>{run.source.owner}/{run.source.repo}</strong>{incrementalRunLabel(run) && <span className="operator-run-kind">{incrementalRunLabel(run)}</span>}<span>{runStateLabel(run.state)} · {time(run.updatedAt)}</span></button></li>)}</ol>}</aside>
      <section className="operator-review">{!selectedRun ? <p className="operator-muted">Choose a run to inspect its durable progress and draft.</p> : <>
        <header><div><h2>{selectedRun.source.owner}/{selectedRun.source.repo}</h2><p><code>{selectedRun.runId}</code> · {runStateLabel(selectedRun.state)}{selectedRun.source.commitSha ? ` · ${selectedRun.source.commitSha.slice(0, 12)}` : ''}</p>{incrementalRunLabel(selectedRun) && <p className="operator-run-kind" data-run-kind="incremental">{incrementalRunLabel(selectedRun)}</p>}</div><div className="operator-actions">{(() => { const state = updateButtonState({ run: selectedRun, runs, requesting: busy === 'incremental' }); return <button data-update-action disabled={state.disabled} onClick={() => updateToLatest(selectedRun)} title={state.title}>{state.label}</button>; })()}<button disabled={busy === 'reload'} onClick={() => void act('reload', async () => { await loadSelectedRun(selectedRun.runId, selectedDraftRevisionId); await refreshRuns(); })}>Refresh</button>{['queued', 'running'].includes(selectedRun.state) && <button disabled={busy === 'cancel'} onClick={() => void act('cancel', async () => { const result = await operatorApi.cancel(selectedRun.runId); setSelectedRun(result.run); await refreshRuns(); setNotice('Cancellation requested.'); })}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel run'}</button>}</div></header>
        {update?.runId === selectedRun.runId && <OperatorUpdateResult onOpenRun={runId => void act('open-run', () => openRunById(runId))} outcome={update.outcome}/>}
        {selectedRun.error && <OperatorStoredError error={selectedRun.error}/>}{runActivity && <section className="operator-activity"><small>{usageSummary(runActivity.usage) ? `Run usage: ${usageSummary(runActivity.usage)}` : 'No provider usage yet.'}</small>{(() => { const { enrichment, claimChecks } = splitActivityAttempts(runActivity.attempts); return <>{enrichment.length ? <div className="operator-attempts"><small>Latest attempts · {Math.min(ACTIVITY_LIMIT, enrichment.length)} of {enrichment.length}</small><ul>{enrichment.slice(-ACTIVITY_LIMIT).reverse().map(attempt => <li key={attempt.attemptId}>{attemptLabel(attempt, scopeName)}</li>)}</ul></div> : <p>No attempts recorded.</p>}{claimChecks.length ? <details className="operator-attempts operator-claim-attempts" data-claim-attempts={claimChecks.length}><summary>Claim-check attempts · {claimChecks.length}</summary><ul>{claimChecks.slice(-CLAIM_ACTIVITY_LIMIT).reverse().map(attempt => <li key={attempt.attemptId}>{attemptLabel(attempt, scopeName)}</li>)}</ul></details> : null}</>; })()}{runActivity.events.length ? <details className="operator-events"><summary>Event log · latest {Math.min(ACTIVITY_LIMIT, runActivity.events.length)} of {runActivity.events.length}</summary><ol>{runActivity.events.slice(-ACTIVITY_LIMIT).reverse().map(event => <li key={event.eventId}><time dateTime={new Date(event.at).toISOString()}>{time(event.at)}</time><span>{operatorEventLabel(event, scopeName)}</span></li>)}</ol></details> : <p className="operator-muted">No events recorded.</p>}</section>}
        {!detail ? <p className="operator-muted" data-no-draft>{noDraftMessage(selectedRun, runActivity?.events, runActivity !== undefined)}</p> : <>{banner && <OperatorCompletionBanner banner={banner} busy={busy} onPreview={() => void act('preview', async () => { await onPreview(selectedRun.runId, detail.draft.draftRevisionId, detail.scopes, selectedDraftRevisionId !== undefined); })} onPublish={focusPublish} onRetryFailed={() => reviewRetry(banner.failedScopeIds)} onRetryNotRun={() => reviewRetry(banner.notRunScopeIds)} onReviewNewer={reviewNewer}/>}<OperatorCoverage detail={detail} {...(superseded ? { superseded } : {})}/>{detail.changelog && <OperatorChangelog changelog={detail.changelog} scopes={detail.scopes} {...(detail.currentPublicationVersionId ? { currentPublicationVersionId: detail.currentPublicationVersionId } : {})} draftIsLive={detail.currentPublicationDraftRevisionId === detail.draft.draftRevisionId}/>}{usageDiffers(runActivity?.usage, detail.usage) && usageSummary(detail.usage) && <p className="operator-muted operator-revision-usage">This revision: {usageSummary(detail.usage)}</p>}<div className="operator-actions"><button disabled={busy === 'preview'} onClick={() => void act('preview', async () => { await onPreview(selectedRun.runId, detail.draft.draftRevisionId, detail.scopes, selectedDraftRevisionId !== undefined); })}>Preview pinned revision</button>{staleScopes.length > 0 && (() => { const refresh = refreshLabel(detail.scopes, staleScopes.map(item => item.scopeId), avgCost); return <button disabled={busy === 'refresh' || !!superseded} onClick={() => void act('refresh', async () => { const result = await mutateRevision(() => operatorApi.refresh(detail.draft.draftRevisionId, staleScopes.map(item => item.scopeId))); setNotice(`Refreshing ${staleScopes.length} stale scope${staleScopes.length === 1 ? '' : 's'} from revision ${detail.draft.revision} in one pass (${result.draftRevisionId}); shared parents re-reduce once.`); await reloadDraft(); })} title={superseded ? supersededRetryHint(superseded) : refresh.title}>{busy === 'refresh' ? 'Refreshing…' : refresh.label}</button>; })()}</div>
          {confirming && selectedScopeIds.size > 0 && <div ref={confirmRef}><OperatorRetryConfirm avgCostPerScopeUsd={avgCost} busy={busy === 'retry-batch'} {...('error' in retryRequest && orderedSelection.length ? { error: retryRequest.error } : {})} firstCount={Math.min(firstCount, orderedSelection.length)} fit={fitToBudget(orderedSelection, detail.scopes, remainingUsd, avgCost, requestsLeft, tokenBudget)} fraction={fraction} includesBelowCap={'includeBelowCap' in retryRequest && retryRequest.includeBelowCap} onCancel={() => setConfirming(false)} onConfirm={() => void act('retry-batch', async () => { if (!('scopeIds' in retryRequest)) throw new Error(retryRequest.error); const { scopeIds, includeBelowCap } = retryRequest; await mutateRevision(() => operatorApi.retryScopes(detail.draft.draftRevisionId, scopeIds, includeBelowCap)); setConfirming(false); setSelectedScopeIds(new Set()); setNotice(`Retrying ${scopeIds.length} scope${scopeIds.length === 1 ? '' : 's'} from revision ${detail.draft.revision}; affected parents re-reduce when a child changes. Accepted siblings remain pinned.`); await reloadDraft(); })} onFirstCount={setFirstCount} onFraction={setFraction} remainingUsd={remainingUsd} {...(requestsLeft !== undefined ? { remainingRequests: requestsLeft } : {})} {...(tokensLeft !== undefined && avgTokens !== undefined ? { remainingTokens: tokensLeft } : {})} selectionSize={orderedSelection.length} sendCount={retryIds.length} summary={confirmText(retryEstimateNow)} {...(budgetWarning(retryEstimateNow) ? { warning: budgetWarning(retryEstimateNow)! } : {})}/></div>}
          {latestClaimPassMessage(runActivity?.events) && <p className="operator-note" data-claim-last-pass role="status">Last claim-check pass: {latestClaimPassMessage(runActivity?.events)}</p>}
          <div className="operator-draft"><OperatorScopeList filter={scopeFilter} key={selectedRun.runId} onFilter={setScopeFilter} onOpen={openScope} onQuery={setScopeQuery} onReview={() => { setFraction({ mode: 'all' }); setConfirming(true); }} onSelection={setSelectedScopeIds} onShowBelowCap={show => { setShowBelowCap(show); if (!show && scope && isBelowCap(scope)) { scopePinnedRef.current = false; setScope(nextOpenScope(detail.scopes, scope.scopeId, false, false)); } if (!show) setSelectedScopeIds(current => new Set([...current].filter(id => !detail.scopes.some(item => item.scopeId === id && isBelowCap(item))))); }} onSort={setScopeSort} openScopeId={scope?.scopeId} query={scopeQuery} scopes={detail.scopes} selected={selectedScopeIds} showBelowCap={showBelowCap} sort={scopeSort} {...(superseded ? { superseded } : {})}/><ScopeInspector claimInfo={detail.claimChecks} {...(scope && claimError?.scopeId === scope.scopeId ? { claimError: claimError.message } : {})} onRecheck={() => scope && void act('claim-checks', async () => { setClaimError(undefined); try { await mutateRevision(() => operatorApi.claimChecks(detail.draft.draftRevisionId, [scope.scopeId])); } catch (cause) { setClaimError({ scopeId: scope.scopeId, message: cause instanceof Error ? cause.message : String(cause) }); throw cause; } setNotice(`Checking ${scope.name}'s claims against captured excerpts from revision ${detail.draft.revision}; results arrive as a new revision when the pass finishes. Report-only: nothing is hidden or blocked.`); await reloadDraft(); })} rechecking={busy === 'claim-checks'} canRetry={!!scope && selectable(scope, showBelowCap)} hidden={scope ? scopeVisibility(scope, listOptions, detail.scopes) : 'visible'} lookup={scopeLookup} source={detail.source} onRetry={() => scope && reviewRetry([scope.scopeId])} ref={inspectorRef} retrying={busy === 'retry-batch'} scope={scope} {...(superseded ? { superseded } : {})}/></div>
          <section className="operator-publish" ref={publishRef} tabIndex={-1}><h3>Publish revision {detail.draft.revision}</h3><p>{incomplete ? 'This revision has incomplete coverage. Acknowledgement is required before publishing.' : 'This revision has complete accepted coverage.'}</p>{incomplete && <label><input checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} type="checkbox"/> I acknowledge failed, not run, or stale enrichment coverage.</label>}<button disabled={busy === 'publish' || (incomplete && !acknowledged)} onClick={() => void act('publish', async () => { const result = await publishRevision(() => operatorApi.publish(detail.draft.draftRevisionId, detail.currentPublicationVersionId, acknowledged)); if ('conflict' in result) { setAcknowledged(publicationAcknowledgementAfterConflict()); await reloadDraft(); throw new Error(PUBLICATION_CONFLICT_MESSAGE); } setNotice(`Published ${result.published}.`); await reloadDraft(); })}>{busy === 'publish' ? 'Publishing…' : 'Publish selected revision'}</button></section>
        </>}</>}
      </section></div>
  </main>;
}

/** "Retry this scope" opens the same confirm step as a batch; a below-cap scope is retryable only while the below-cap toggle is on. */
const HIDDEN_NOTE: Record<Exclude<ScopeVisibility, 'visible'>, string> = {
  'below cap': 'Hidden from the list: below the depth cap. Turn on "Show below depth cap" to list it.',
  context: 'Does not match the current search or state filter; shown dimmed in the list only as context for matching scopes below it.',
  filtered: 'Filtered out: this scope does not match the current search or state filter and is not in the list.',
};
/** Explanation labels resolve ids through scope names only (entity id or scope id); unknown ids are never shown raw. */
function scopeNameLookup(lookup: ReadonlyMap<string, OperatorScope>): (id: string) => string | undefined {
  const byEntity = new Map([...lookup.values()].flatMap(item => item.entityId ? [[item.entityId, item.name] as const] : []));
  return id => byEntity.get(id) ?? lookup.get(id)?.name;
}
/** Exported for render tests. */
export const ScopeInspector = forwardRef<HTMLElement, { scope?: OperatorScope; canRetry: boolean; onRetry(): void; retrying: boolean; hidden: ScopeVisibility; lookup: ReadonlyMap<string, OperatorScope>; source?: DraftDetail['source']; superseded?: { revision?: number }; /** CLA-145 (absent on older servers). */ claimInfo?: DraftDetail['claimChecks']; onRecheck?(): void; rechecking?: boolean; /** The last re-check refusal for this scope, shown inline in the panel. */ claimError?: string }>(function ScopeInspector({ scope, canRetry, onRetry, retrying, hidden, lookup, source, superseded, claimInfo, onRecheck, rechecking, claimError }, ref) {
  if (!scope) return <section className="operator-scope" ref={ref}><p>Select a scope.</p></section>;
  const explanation = scope.explanation; const latest = scope.attempts?.at(-1); const label = scopeLabel(scope, lookup);
  const shown = reviewStateLabel({ state: scope.state }, !!superseded);
  return <section className="operator-scope" ref={ref}>{hidden !== 'visible' && <p className="operator-note operator-filtered-out" role="status">{HIDDEN_NOTE[hidden]}</p>}<header><div><h3>{label.primary}</h3>{(label.secondary || scope.path) && <p className="operator-muted operator-scope-path">{label.secondary ? `in ${label.secondary}` : ''}{label.secondary && scope.path ? ' · ' : ''}{scope.path && <code>{scope.path}</code>}</p>}<p data-state={shown}>{shown}{scope.stale ? ' · stale' : ''}{scope.kind ? ` · ${scope.kind}` : ''}</p>{scope.stale && staleReasonText(scope.staleReason) && <p className="operator-muted" data-stale-reason={scope.staleReason}>Stale: {staleReasonText(scope.staleReason)}.</p>}{shown === 'superseded' && <p className="operator-muted">This revision is superseded; the run's result for this scope is in {superseded?.revision !== undefined ? `revision ${superseded.revision}` : 'the current revision'}.</p>}{shown === 'not run' && <p className="operator-muted">Not run: this in-scope scope was left unrun by a budget stop, a cancellation, or a missing gateway.</p>}{scope.state === 'below cap' && <p className="operator-muted">Below depth cap: this run's enrichment depth cap does not include this level, so no request was made. Retrying it is an explicit opt-in.</p>}</div><button disabled={retrying || !canRetry || !!superseded} onClick={onRetry} title={superseded ? supersededRetryHint(superseded) : canRetry ? undefined : scope.state === 'below cap' ? 'Turn on "Show below depth cap" to opt in to retrying this scope' : 'This scope is already running'}>{retrying ? 'Queuing…' : 'Retry this scope…'}</button></header>{latest?.error && <OperatorStoredError error={latest.error}/>}{explanation ? <ExplanationView audit entityName={scopeNameLookup(lookup)} evidenceHref={evidence => evidenceSourceUrl(evidence, source)} explanation={explanation} subjectName={label.primary} {...(scope.diagramError ? { diagramError: scope.diagramError } : {})}/> : <p className="operator-muted">No accepted explanation is pinned for this scope.</p>}{onRecheck && (claimInfo || scope.claimChecks) && <OperatorClaimChecks busy={!!rechecking} {...(superseded ? { disabledHint: supersededRetryHint(superseded) } : scope.state === 'running' || scope.state === 'queued' ? { disabledHint: 'This scope is already running' } : {})} {...(claimError ? { error: claimError } : {})} info={claimInfo} onRecheck={onRecheck} scope={scope} source={source}/>}</section>;
});
