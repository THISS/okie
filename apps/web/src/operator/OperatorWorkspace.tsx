import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MermaidDiagram } from '../diagram/MermaidDiagram';
import { operatorApi, OperatorApiError, type DraftDetail, type OperatorRun, type OperatorRunDetail, type OperatorScope } from './api';
import { acceptsReviewResponse, attemptLabel, belowCapChip, classifyOperatorFailure, coverageChips, coverageIncomplete, currentRevisionTarget, draftBelongsToRun, operatorEventLabel, publicationAcknowledgementAfterConflict, runStateLabel, selectedDraftForRun, staleRevisionAfterFailure, usageDiffers, usageSummary, type StaleRevisionContext } from './reviewState';
import { OperatorAccessMessage, OperatorErrorAlert } from './OperatorViews';
import { completionBanner } from './completion';
import { OperatorCompletionBanner, OperatorRetryConfirm, OperatorScopeList } from './OperatorBatchRetry';
import { budgetWarning, buildRetryRequest, confirmText, defaultScope, filterScopes, fitToBudget, isBelowCap, orderScopes, remainingBudgetUsd, remainingRequests, retryEstimate, selectable, type RetryFraction, type ScopeFilter } from './scopeSelection';
import './operator.css';

function time(value: number): string { return new Date(value).toLocaleString(); }
function diagramSource(scope: OperatorScope): string | undefined {
  const diagram = scope.explanation?.diagram;
  if (!diagram?.nodes.length) return undefined;
  const ids = new Map(diagram.nodes.map((id, index) => [id, `n${index}`]));
  return ['flowchart LR', ...diagram.nodes.map((id, index) => `  n${index}[${JSON.stringify(id)}]`), ...diagram.edges.map(edge => `  ${ids.get(edge.from)} -->${edge.label ? `|${edge.label}|` : ''} ${ids.get(edge.to)}`)].join('\n');
}

export function OperatorWorkspace({ onPreview, initialRunId, initialDraftRevisionId }: { onPreview(runId: string, draftRevisionId: string, scopes: OperatorScope[]): Promise<void>; initialRunId?: string; initialDraftRevisionId?: string }) {
  const [allowed, setAllowed] = useState<boolean>();
  const [runs, setRuns] = useState<OperatorRun[]>([]);
  const [selectedRun, setSelectedRun] = useState<OperatorRun>();
  const [selectedDraftRevisionId, setSelectedDraftRevisionId] = useState<string | undefined>(initialDraftRevisionId);
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
  const [showAllScopes, setShowAllScopes] = useState(false);
  // Batch retry (CLA-258): list filter, below-cap opt-in, selection, and the confirm step.
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [showBelowCap, setShowBelowCap] = useState(false);
  const showBelowCapRef = useRef(false);
  showBelowCapRef.current = showBelowCap;
  const [selectedScopeIds, setSelectedScopeIds] = useState<Set<string>>(() => new Set());
  const [confirming, setConfirming] = useState(false);
  const [fraction, setFraction] = useState<RetryFraction>({ mode: 'all' });
  const [firstCount, setFirstCount] = useState(10);
  const publishRef = useRef<HTMLElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const [expired, setExpired] = useState(false);
  const [staleRevision, setStaleRevision] = useState<StaleRevisionContext>();
  const staleRevisionRef = useRef<StaleRevisionContext | undefined>(undefined);
  staleRevisionRef.current = staleRevision;
  const feedbackRef = useRef<HTMLDivElement>(null);

  const requestEpoch = useRef(0);
  const selectedRunIdRef = useRef<string | undefined>(undefined);
  selectedRunIdRef.current = selectedRun?.runId;
  const refreshRuns = useCallback(async () => { const response = await operatorApi.runs(); setRuns(response.runs); setSelectedRun(current => response.runs.find(run => run.runId === current?.runId) ?? current); return response.runs; }, []);
  const loadSelectedRun = useCallback(async (runId: string, revisionId?: string) => {
    const epoch = ++requestEpoch.current;
    const runDetail = await operatorApi.run(runId);
    if (!acceptsReviewResponse(epoch, requestEpoch.current, runId, selectedRunIdRef.current ?? runId)) return;
    setSelectedRun(runDetail.run);
    const { run: _run, draft: _draft, ...activity } = runDetail; setRunActivity(activity);
    const chosen = revisionId ?? selectedDraftForRun(selectedDraftRevisionId, runDetail.run, runDetail.draft);
    if (!chosen) { setDetail(undefined); return; }
    const draft = await operatorApi.draft(chosen);
    if (!acceptsReviewResponse(epoch, requestEpoch.current, runId, selectedRunIdRef.current ?? runId)) return;
    if (!draftBelongsToRun(draft, runId)) throw new Error('That revision belongs to a different run.');
    setSelectedDraftRevisionId(chosen);
    // A different revision invalidates the selection: retries always target the loaded (current) revision.
    if (detailRef.current?.draft.draftRevisionId !== draft.draft.draftRevisionId) { setSelectedScopeIds(new Set()); setConfirming(false); }
    setDetail(draft);
    setScope(current => draft.scopes.find(item => item.scopeId === current?.scopeId) ?? defaultScope(draft.scopes, showBelowCapRef.current));
  }, [selectedDraftRevisionId]);
  const allowedRef = useRef(false);
  allowedRef.current = allowed === true;
  /** Every operator failure goes through one classifier: expired sessions, stale revisions and busy runs get their own UI. */
  const fail = useCallback(async (cause: unknown, fallback: string, runId?: string, keepStale = false) => {
    const outcome = await classifyOperatorFailure(cause, allowedRef.current, operatorApi.session, fallback);
    if (outcome.kind === 'expired') { setExpired(true); return; }
    const next = staleRevisionAfterFailure(outcome, runId, selectedRunIdRef.current, staleRevisionRef.current, keepStale);
    if (!next.apply) return; // the user switched runs before this failure arrived
    setStaleRevision(next.stale); setError(outcome.message);
  }, []);
  useEffect(() => { void (async () => { try { const session = await operatorApi.session(); setAllowed(session.operator); if (session.operator) { const values = await refreshRuns(); if (initialRunId) setSelectedRun(values.find(run => run.runId === initialRunId)); } } catch (cause) { setAllowed(false); setError(cause instanceof Error ? cause.message : 'Could not check operator access.'); } })(); }, [initialRunId, refreshRuns]);
  useEffect(() => {
    if (!selectedRun) return;
    void loadSelectedRun(selectedRun.runId).catch(cause => fail(cause, 'Could not refresh this run.'));
    return () => { requestEpoch.current += 1; };
  }, [selectedRun?.runId]);
  useEffect(() => {
    if (expired || !selectedRun || !['queued', 'running'].includes(selectedRun.state)) return;
    const timer = window.setInterval(() => { void loadSelectedRun(selectedRun.runId).catch(cause => fail(cause, 'Could not refresh this run.')); void refreshRuns().catch(cause => fail(cause, 'Could not refresh runs.')); }, 5000);
    return () => window.clearInterval(timer);
  }, [expired, fail, loadSelectedRun, refreshRuns, selectedRun?.runId, selectedRun?.state]);
  // Page scroll: bring action feedback into view when it appears (actions are often far below it).
  useEffect(() => { if (error || notice) feedbackRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [error, notice]);
  const staleScopes = useMemo(() => detail?.scopes.filter(item => item.stale) ?? [], [detail]);
  const orderedScopes = useMemo(() => orderScopes(detail?.scopes ?? []), [detail]);
  const visibleScopes = useMemo(() => filterScopes(orderedScopes, scopeFilter, showBelowCap), [orderedScopes, scopeFilter, showBelowCap]);
  const orderedSelection = useMemo(() => orderedScopes.filter(item => selectedScopeIds.has(item.scopeId)).map(item => item.scopeId), [orderedScopes, selectedScopeIds]);
  const remainingUsd = remainingBudgetUsd(runActivity?.budget);
  const requestsLeft = remainingRequests(runActivity?.budget);
  const avgCost = runActivity?.avgCostPerScopeUsd;
  // One request builder (unit-tested) decides exactly what is sent: sliced ids and the explicit below-cap opt-in.
  const retryRequest = useMemo(() => buildRetryRequest({ orderedSelection, fraction, scopes: detail?.scopes ?? [], showBelowCap, ...(remainingUsd !== undefined ? { remainingUsd } : {}), ...(avgCost !== undefined ? { avgCostPerScopeUsd: avgCost } : {}), ...(requestsLeft !== undefined ? { remainingRequests: requestsLeft } : {}) }), [orderedSelection, fraction, detail, showBelowCap, remainingUsd, avgCost, requestsLeft]);
  const retryIds = 'scopeIds' in retryRequest ? retryRequest.scopeIds : [];
  const retryEstimateNow = retryEstimate(detail?.scopes ?? [], retryIds, avgCost, runActivity?.budget);
  const newerRevision = !!selectedRun?.draftRevisionId && !!detail && selectedRun.draftRevisionId !== detail.draft.draftRevisionId;
  const banner = selectedRun && detail ? completionBanner({ run: selectedRun, events: runActivity?.events ?? [], scopes: detail.scopes, ...(runActivity?.usage ? { usage: runActivity.usage } : {}), ...(runActivity?.avgCostPerScopeUsd !== undefined ? { avgCostPerScopeUsd: runActivity.avgCostPerScopeUsd } : {}), ...(runActivity?.budget ? { budget: runActivity.budget } : {}), ...(runActivity?.progress ? { progress: runActivity.progress } : {}), ...(newerRevision ? { newerRevision } : {}) }) : undefined;
  const reviewNewer = () => { if (!selectedRun?.draftRevisionId) return; const { runId, draftRevisionId } = selectedRun; void act('review', async () => { setSelectedDraftRevisionId(draftRevisionId); await loadSelectedRun(runId, draftRevisionId); }); };
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
      await loadSelectedRun(runId, target);
      if (selectedRunIdRef.current !== runId) return;
      setAcknowledged(false); clearFeedback(); setNotice(`Opened current revision ${target}.`);
    } catch (cause) { await fail(cause, 'Could not open the current revision.', runId, true); } finally { setBusy(undefined); }
  };
  const scopeName = (scopeId: string) => detail?.scopes.find(item => item.scopeId === scopeId)?.name;

  if (expired) return <OperatorAccessMessage expired/>;
  if (allowed === undefined) return <main className="operator-shell"><p role="status">Checking operator access…</p></main>;
  if (!allowed) return <OperatorAccessMessage/>;
  return <main className="operator-shell">
    <header className="operator-header"><div><a className="operator-brand" href="/">Okie</a><h1>Operator review</h1></div><a href="/">Public atlas</a></header>
    <div className="operator-feedback" ref={feedbackRef}>{error && <OperatorErrorAlert error={error} onOpenCurrent={runId => void openCurrentRevision(runId)} opening={busy === 'open-current'} selectedRunId={selectedRun?.runId} stale={staleRevision}/>}{notice && <p className="operator-notice" role="status">{notice}</p>}</div>
    <section className="operator-start"><h2>Scan a public repository</h2><form onSubmit={event => { event.preventDefault(); void act('start', async () => { const started = await operatorApi.start(url, crypto.randomUUID()); await refreshRuns(); clearFeedback(); setSelectedDraftRevisionId(undefined); setAcknowledged(false); setDetail(undefined); setScope(undefined); setRunActivity(undefined); setSelectedRun(started.run); setUrl(''); setNotice(started.deduped ? 'Reopened the matching active run.' : 'Scan queued.'); }); }}><input aria-label="Public GitHub repository URL" placeholder="https://github.com/owner/repository" required type="url" value={url} onChange={event => setUrl(event.target.value)}/><button disabled={busy === 'start'}>{busy === 'start' ? 'Starting…' : 'Start scan'}</button></form></section>
    <div className="operator-layout"><aside><h2>Runs</h2>{runs.length === 0 ? <p className="operator-muted">No scan runs yet.</p> : <ol className="operator-runs">{runs.map(run => <li key={run.runId}><button className={selectedRun?.runId === run.runId ? 'selected' : ''} onClick={() => { clearFeedback(); setSelectedDraftRevisionId(undefined); setAcknowledged(false); setDetail(undefined); setScope(undefined); setRunActivity(undefined); setSelectedScopeIds(new Set()); setConfirming(false); setSelectedRun(run); }}><strong>{run.source.owner}/{run.source.repo}</strong><span>{runStateLabel(run.state)} · {time(run.updatedAt)}</span></button></li>)}</ol>}</aside>
      <section className="operator-review">{!selectedRun ? <p className="operator-muted">Choose a run to inspect its durable progress and draft.</p> : <>
        <header><div><h2>{selectedRun.source.owner}/{selectedRun.source.repo}</h2><p><code>{selectedRun.runId}</code> · {runStateLabel(selectedRun.state)}{selectedRun.source.commitSha ? ` · ${selectedRun.source.commitSha.slice(0, 12)}` : ''}</p></div><div className="operator-actions"><button disabled={busy === 'reload'} onClick={() => void act('reload', async () => { await loadSelectedRun(selectedRun.runId, selectedDraftRevisionId); await refreshRuns(); })}>Refresh</button>{['queued', 'running'].includes(selectedRun.state) && <button disabled={busy === 'cancel'} onClick={() => void act('cancel', async () => { const result = await operatorApi.cancel(selectedRun.runId); setSelectedRun(result.run); await refreshRuns(); setNotice('Cancellation requested.'); })}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel run'}</button>}</div></header>
        {selectedRun.error && <p className="operator-alert">{selectedRun.error}</p>}{runActivity && <section className="operator-activity"><small>{usageSummary(runActivity.usage) ? `Run usage: ${usageSummary(runActivity.usage)}` : 'No provider usage yet.'}</small>{runActivity.attempts.length ? <div className="operator-attempts"><small>Latest attempts</small><ul>{runActivity.attempts.slice(-5).map(attempt => <li key={attempt.attemptId}>{attemptLabel(attempt, scopeName)}</li>)}</ul></div> : <p>No attempts recorded.</p>}{runActivity.events.length ? <details className="operator-events"><summary>Event log · latest {Math.min(20, runActivity.events.length)} of {runActivity.events.length}</summary><ol>{runActivity.events.slice(-20).reverse().map(event => <li key={event.eventId}><time dateTime={new Date(event.at).toISOString()}>{time(event.at)}</time><span>{operatorEventLabel(event, scopeName)}</span></li>)}</ol></details> : <p className="operator-muted">No events recorded.</p>}</section>}
        {!detail ? <p className="operator-muted">Loading draft when the run creates one…</p> : <>{banner && <OperatorCompletionBanner banner={banner} busy={busy} onPreview={() => void act('preview', async () => { await onPreview(selectedRun.runId, detail.draft.draftRevisionId, detail.scopes); })} onPublish={focusPublish} onRetryFailed={() => reviewRetry(banner.failedScopeIds)} onRetryNotRun={() => reviewRetry(banner.notRunScopeIds)} onReviewNewer={reviewNewer}/>}<div className="operator-coverage">{coverageChips(detail.draft.coverage, detail.scopes).map(chip => <span key={chip}>{chip}</span>)}{belowCapChip(detail.scopes) && <span className="operator-chip-quiet">{belowCapChip(detail.scopes)}</span>}</div>{usageDiffers(runActivity?.usage, detail.usage) && usageSummary(detail.usage) && <p className="operator-muted operator-revision-usage">This revision: {usageSummary(detail.usage)}</p>}{newerRevision && !banner?.actions.includes('review-newer') && <button disabled={busy === 'review'} onClick={reviewNewer}>Review newer revision</button>}<div className="operator-actions"><button disabled={busy === 'preview'} onClick={() => void act('preview', async () => { await onPreview(selectedRun.runId, detail.draft.draftRevisionId, detail.scopes); })}>Preview pinned revision</button>{staleScopes.length > 0 && <button disabled={busy === 'refresh'} onClick={() => void act('refresh', async () => { const result = await mutateRevision(() => operatorApi.refresh(detail.draft.draftRevisionId, staleScopes.map(item => item.scopeId))); setNotice(`Refreshing stale ancestors in ${result.draftRevisionId}.`); await reloadDraft(); })}>{busy === 'refresh' ? 'Refreshing…' : `Refresh ${staleScopes.length} stale ancestor${staleScopes.length === 1 ? '' : 's'}`}</button>}</div>
          {confirming && selectedScopeIds.size > 0 && <div ref={confirmRef}><OperatorRetryConfirm avgCostPerScopeUsd={avgCost} busy={busy === 'retry-batch'} {...('error' in retryRequest && orderedSelection.length ? { error: retryRequest.error } : {})} firstCount={Math.min(firstCount, orderedSelection.length)} fit={fitToBudget(orderedSelection, detail.scopes, remainingUsd, avgCost, requestsLeft)} fraction={fraction} includesBelowCap={'includeBelowCap' in retryRequest && retryRequest.includeBelowCap} onCancel={() => setConfirming(false)} onConfirm={() => void act('retry-batch', async () => { if (!('scopeIds' in retryRequest)) throw new Error(retryRequest.error); const { scopeIds, includeBelowCap } = retryRequest; await mutateRevision(() => operatorApi.retryScopes(detail.draft.draftRevisionId, scopeIds, includeBelowCap)); setConfirming(false); setSelectedScopeIds(new Set()); setNotice(`Retrying ${scopeIds.length} scope${scopeIds.length === 1 ? '' : 's'} from revision ${detail.draft.revision}; affected parents re-reduce when a child changes. Accepted siblings remain pinned.`); await reloadDraft(); })} onFirstCount={setFirstCount} onFraction={setFraction} remainingUsd={remainingUsd} {...(requestsLeft !== undefined ? { remainingRequests: requestsLeft } : {})} selectionSize={orderedSelection.length} sendCount={retryIds.length} summary={confirmText(retryEstimateNow)} {...(budgetWarning(retryEstimateNow) ? { warning: budgetWarning(retryEstimateNow)! } : {})}/></div>}
          <div className="operator-draft"><OperatorScopeList expanded={showAllScopes} filter={scopeFilter} onExpanded={setShowAllScopes} onFilter={setScopeFilter} onOpen={setScope} onReview={() => { setFraction({ mode: 'all' }); setConfirming(true); }} onSelection={setSelectedScopeIds} onShowBelowCap={show => { setShowBelowCap(show); if (!show && scope && isBelowCap(scope)) setScope(defaultScope(detail.scopes, false)); if (!show) setSelectedScopeIds(current => new Set([...current].filter(id => !detail.scopes.some(item => item.scopeId === id && isBelowCap(item))))); }} openScopeId={scope?.scopeId} ordered={orderedScopes} scopes={detail.scopes} selected={selectedScopeIds} showBelowCap={showBelowCap} visible={visibleScopes}/><ScopeInspector canRetry={!!scope && selectable(scope, showBelowCap)} onRetry={() => scope && reviewRetry([scope.scopeId])} retrying={busy === 'retry-batch'} scope={scope}/></div>
          <section className="operator-publish" ref={publishRef} tabIndex={-1}><h3>Publish revision {detail.draft.revision}</h3><p>{incomplete ? 'This revision has incomplete coverage. Acknowledgement is required before publishing.' : 'This revision has complete accepted coverage.'}</p>{incomplete && <label><input checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} type="checkbox"/> I acknowledge failed, not run, or stale enrichment coverage.</label>}<button disabled={busy === 'publish' || (incomplete && !acknowledged)} onClick={() => void act('publish', async () => { try { const published = await operatorApi.publish(detail.draft.draftRevisionId, detail.currentPublicationVersionId, acknowledged); setNotice(`Published ${published.publication.versionId}.`); await reloadDraft(); } catch (cause) { if (cause instanceof OperatorApiError && cause.status === 409) { setAcknowledged(publicationAcknowledgementAfterConflict()); await reloadDraft(); throw new Error('Publication changed elsewhere. Review context was refreshed; confirm and publish again.'); } throw cause; } })}>{busy === 'publish' ? 'Publishing…' : 'Publish selected revision'}</button></section>
        </>}</>}
      </section></div>
  </main>;
}

/** "Retry this scope" opens the same confirm step as a batch; a below-cap scope is retryable only while the below-cap toggle is on. */
function ScopeInspector({ scope, canRetry, onRetry, retrying }: { scope?: OperatorScope; canRetry: boolean; onRetry(): void; retrying: boolean }) {
  if (!scope) return <section className="operator-scope"><p>Select a scope.</p></section>;
  const explanation = scope.explanation; const source = diagramSource(scope); const latest = scope.attempts?.at(-1);
  return <section className="operator-scope"><header><div><h3>{scope.name}</h3><p>{scope.state}{scope.stale ? ' · stale' : ''}{scope.kind ? ` · ${scope.kind}` : ''}</p>{scope.state === 'not run' && <p className="operator-muted">Not run: this in-scope scope was left unrun by a budget stop, a cancellation, or a missing gateway.</p>}{scope.state === 'below cap' && <p className="operator-muted">Below depth cap: this run's enrichment depth cap does not include this level, so no request was made. Retrying it is an explicit opt-in.</p>}</div><button disabled={retrying || !canRetry} onClick={onRetry} title={canRetry ? undefined : scope.state === 'below cap' ? 'Turn on "Show below depth cap" to opt in to retrying this scope' : 'This scope is already running'}>{retrying ? 'Queuing…' : 'Retry this scope…'}</button></header>{latest?.error && <p className="operator-alert">{latest.error}</p>}{explanation ? <><p className="operator-summary">{explanation.summary}</p>{explanation.roleWithinParent && <p><strong>Role:</strong> {explanation.roleWithinParent}</p>}{explanation.interactions?.length ? <><h4>Important interactions</h4><ul>{explanation.interactions.map(item => <li key={item}>{item}</li>)}</ul></> : null}<h4>Evidence</h4><ul>{explanation.evidence.map((item, index) => <li key={index}>{item.entityId ?? item.path ?? 'Captured evidence'}{item.path && item.startLine ? ` · ${item.path}:${item.startLine}${item.endLine ? `-${item.endLine}` : ''}` : ''}</li>)}</ul>{source && <MermaidDiagram compact source={source} title={`${scope.name} interactions`}/>} {(scope.diagramError ?? explanation.diagramError) && <p className="operator-muted">{scope.diagramError ?? explanation.diagramError}</p>}</> : <p className="operator-muted">No accepted explanation is pinned for this scope.</p>}</section>;
}
