import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MermaidDiagram } from '../diagram/MermaidDiagram';
import { askSignInHref } from '../ask/askAtlas';
import { operatorApi, OperatorApiError, type DraftDetail, type OperatorRun, type OperatorScope, type OperatorUsage } from './api';
import { acceptsReviewResponse, publicationAcknowledgementAfterConflict, selectedDraftForRun } from './reviewState';
import './operator.css';

function money(value?: number): string { return value === undefined ? 'unknown' : new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value); }
function time(value: number): string { return new Date(value).toLocaleString(); }
function usageLine(usage?: OperatorUsage): string {
  if (!usage) return 'No provider usage reported.';
  const tokens = [usage.inputTokens, usage.outputTokens].some(value => value !== undefined) ? `${usage.inputTokens ?? 0} in / ${usage.outputTokens ?? 0} out tokens` : 'Token use unknown';
  return `${tokens} · measured ${money(usage.measuredCostUsd)} · estimated ${money(usage.estimatedCostUsd)}`;
}
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
  const [scope, setScope] = useState<OperatorScope>();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [acknowledged, setAcknowledged] = useState(false);

  const requestEpoch = useRef(0);
  const selectedRunIdRef = useRef<string | undefined>(undefined);
  selectedRunIdRef.current = selectedRun?.runId;
  const refreshRuns = useCallback(async () => { const response = await operatorApi.runs(); setRuns(response.runs); setSelectedRun(current => response.runs.find(run => run.runId === current?.runId) ?? current); return response.runs; }, []);
  const loadSelectedRun = useCallback(async (runId: string, revisionId?: string) => {
    const epoch = ++requestEpoch.current;
    const runDetail = await operatorApi.run(runId);
    if (!acceptsReviewResponse(epoch, requestEpoch.current, runId, selectedRunIdRef.current ?? runId)) return;
    setSelectedRun(runDetail.run);
    const chosen = revisionId ?? selectedDraftForRun(selectedDraftRevisionId, runDetail.run, runDetail.draft);
    if (!chosen) { setDetail(undefined); return; }
    const draft = await operatorApi.draft(chosen);
    if (!acceptsReviewResponse(epoch, requestEpoch.current, runId, selectedRunIdRef.current ?? runId)) return;
    setSelectedDraftRevisionId(chosen);
    setDetail(draft);
    setScope(current => draft.scopes.find(item => item.scopeId === current?.scopeId) ?? draft.scopes[0]);
  }, [selectedDraftRevisionId]);
  useEffect(() => { void (async () => { try { const session = await operatorApi.session(); setAllowed(session.operator); if (session.operator) { const values = await refreshRuns(); if (initialRunId) setSelectedRun(values.find(run => run.runId === initialRunId)); } } catch (cause) { setAllowed(false); setError(cause instanceof Error ? cause.message : 'Could not check operator access.'); } })(); }, [initialRunId, refreshRuns]);
  useEffect(() => {
    if (!selectedRun) return;
    void loadSelectedRun(selectedRun.runId);
    return () => { requestEpoch.current += 1; };
  }, [selectedRun?.runId]);
  useEffect(() => {
    if (!selectedRun || !['queued', 'running'].includes(selectedRun.state)) return;
    const timer = window.setInterval(() => { void loadSelectedRun(selectedRun.runId); void refreshRuns(); }, 5000);
    return () => window.clearInterval(timer);
  }, [loadSelectedRun, refreshRuns, selectedRun?.runId, selectedRun?.state]);
  const staleScopes = useMemo(() => detail?.scopes.filter(item => item.stale) ?? [], [detail]);
  const incomplete = !!detail && (detail.draft.coverage.failed > 0 || detail.draft.coverage.stale > 0 || detail.draft.coverage.accepted < detail.draft.coverage.total);
  const act = async (name: string, work: () => Promise<void>) => { setBusy(name); setError(undefined); setNotice(undefined); try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Operator action failed.'); } finally { setBusy(undefined); } };
  const reloadDraft = async () => { if (!selectedRun) return; await loadSelectedRun(selectedRun.runId, selectedDraftRevisionId); await refreshRuns(); };

  if (allowed === undefined) return <main className="operator-shell"><p role="status">Checking operator access…</p></main>;
  if (!allowed) return <main className="operator-shell operator-message" role="alert"><h1>Operator workspace</h1><p>This workspace is available only to configured operators.</p><a href={askSignInHref('/api/auth/github', '/operator')}>Sign in with GitHub</a><a href="/">Return to atlas</a></main>;
  return <main className="operator-shell">
    <header className="operator-header"><div><a className="operator-brand" href="/">Okie</a><h1>Operator review</h1></div><a href="/">Public atlas</a></header>
    {error && <p className="operator-alert" role="alert">{error}</p>}{notice && <p className="operator-notice" role="status">{notice}</p>}
    <section className="operator-start"><h2>Scan a public repository</h2><form onSubmit={event => { event.preventDefault(); void act('start', async () => { const started = await operatorApi.start(url, crypto.randomUUID()); await refreshRuns(); setSelectedRun(started.run); setUrl(''); setNotice(started.deduped ? 'Reopened the matching active run.' : 'Scan queued.'); }); }}><input aria-label="Public GitHub repository URL" placeholder="https://github.com/owner/repository" required type="url" value={url} onChange={event => setUrl(event.target.value)}/><button disabled={busy === 'start'}>{busy === 'start' ? 'Starting…' : 'Start scan'}</button></form></section>
    <div className="operator-layout"><aside><h2>Runs</h2>{runs.length === 0 ? <p className="operator-muted">No scan runs yet.</p> : <ol className="operator-runs">{runs.map(run => <li key={run.runId}><button className={selectedRun?.runId === run.runId ? 'selected' : ''} onClick={() => { setDetail(undefined); setSelectedRun(run); }}><strong>{run.source.owner}/{run.source.repo}</strong><span>{run.state} · {time(run.updatedAt)}</span></button></li>)}</ol>}</aside>
      <section className="operator-review">{!selectedRun ? <p className="operator-muted">Choose a run to inspect its durable progress and draft.</p> : <>
        <header><div><h2>{selectedRun.source.owner}/{selectedRun.source.repo}</h2><p><code>{selectedRun.runId}</code> · {selectedRun.state}{selectedRun.source.commitSha ? ` · ${selectedRun.source.commitSha.slice(0, 12)}` : ''}</p></div><div className="operator-actions"><button disabled={busy === 'reload'} onClick={() => void act('reload', async () => { await loadSelectedRun(selectedRun.runId, selectedDraftRevisionId); await refreshRuns(); })}>Refresh</button>{['queued', 'running'].includes(selectedRun.state) && <button disabled={busy === 'cancel'} onClick={() => void act('cancel', async () => { const result = await operatorApi.cancel(selectedRun.runId); setSelectedRun(result.run); await refreshRuns(); setNotice('Cancellation requested.'); })}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel run'}</button>}</div></header>
        {selectedRun.error && <p className="operator-alert">{selectedRun.error}</p>}
        {!detail ? <p className="operator-muted">Loading draft when the run creates one…</p> : <><div className="operator-coverage"><span>{detail.draft.coverage.accepted}/{detail.draft.coverage.total} accepted</span><span>{detail.draft.coverage.failed} failed</span><span>{detail.draft.coverage.stale} stale</span><small>{usageLine(detail.usage)}</small></div>{selectedRun.draftRevisionId && selectedRun.draftRevisionId !== detail.draft.draftRevisionId && <button onClick={() => { setSelectedDraftRevisionId(selectedRun.draftRevisionId); void loadSelectedRun(selectedRun.runId, selectedRun.draftRevisionId); }}>Review newer revision</button>}<div className="operator-actions"><button disabled={busy === 'preview'} onClick={() => void act('preview', async () => { await onPreview(selectedRun.runId, detail.draft.draftRevisionId, detail.scopes); })}>Preview pinned revision</button>{staleScopes.length > 0 && <button disabled={busy === 'refresh'} onClick={() => void act('refresh', async () => { const result = await operatorApi.refresh(detail.draft.draftRevisionId, staleScopes.map(item => item.scopeId)); setNotice(`Refreshing stale ancestors in ${result.draftRevisionId}.`); await reloadDraft(); })}>{busy === 'refresh' ? 'Refreshing…' : `Refresh ${staleScopes.length} stale ancestor${staleScopes.length === 1 ? '' : 's'}`}</button>}</div>
          <div className="operator-draft"><nav aria-label="Draft scopes"><h3>Scopes</h3>{detail.scopes.map(item => <button className={scope?.scopeId === item.scopeId ? 'selected' : ''} key={item.scopeId} onClick={() => setScope(item)}><span>{item.name}</span><small>{item.stale ? 'stale' : item.state}</small></button>)}</nav><ScopeInspector scope={scope} onRetry={() => scope && void act('retry', async () => { const result = await operatorApi.retry(detail.draft.draftRevisionId, scope.scopeId); setNotice(`Retry queued in ${result.draftRevisionId}; accepted siblings remain pinned.`); await reloadDraft(); })} retrying={busy === 'retry'}/></div>
          <section className="operator-publish"><h3>Publish revision {detail.draft.revision}</h3><p>{incomplete ? 'This revision has incomplete coverage. Acknowledgement is required before publishing.' : 'This revision has complete accepted coverage.'}</p>{incomplete && <label><input checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} type="checkbox"/> I acknowledge failed, missing, or stale enrichment coverage.</label>}<button disabled={busy === 'publish' || (incomplete && !acknowledged)} onClick={() => void act('publish', async () => { try { const published = await operatorApi.publish(detail.draft.draftRevisionId, detail.currentPublicationVersionId, acknowledged); setNotice(`Published ${published.publication.versionId}.`); await reloadDraft(); } catch (cause) { if (cause instanceof OperatorApiError && cause.status === 409) { setAcknowledged(publicationAcknowledgementAfterConflict()); await reloadDraft(); throw new Error('Publication changed elsewhere. Review context was refreshed; confirm and publish again.'); } throw cause; } })}>{busy === 'publish' ? 'Publishing…' : 'Publish selected revision'}</button></section>
        </>}</>}
      </section></div>
  </main>;
}

function ScopeInspector({ scope, onRetry, retrying }: { scope?: OperatorScope; onRetry(): void; retrying: boolean }) {
  if (!scope) return <section className="operator-scope"><p>Select a scope.</p></section>;
  const explanation = scope.explanation; const source = diagramSource(scope); const latest = scope.attempts?.at(-1);
  return <section className="operator-scope"><header><div><h3>{scope.name}</h3><p>{scope.state}{scope.stale ? ' · stale' : ''}</p></div><button disabled={retrying} onClick={onRetry}>{retrying ? 'Queuing…' : 'Retry this scope'}</button></header>{latest?.error && <p className="operator-alert">{latest.error}</p>}{explanation ? <><p className="operator-summary">{explanation.summary}</p>{explanation.roleWithinParent && <p><strong>Role:</strong> {explanation.roleWithinParent}</p>}{explanation.interactions?.length ? <><h4>Important interactions</h4><ul>{explanation.interactions.map(item => <li key={item}>{item}</li>)}</ul></> : null}<h4>Evidence</h4><ul>{explanation.evidence.map((item, index) => <li key={index}>{item.entityId ?? item.path ?? 'Captured evidence'}{item.path && item.startLine ? ` · ${item.path}:${item.startLine}${item.endLine ? `-${item.endLine}` : ''}` : ''}</li>)}</ul>{source && <MermaidDiagram compact source={source} title={`${scope.name} interactions`}/>} {(scope.diagramError ?? explanation.diagramError) && <p className="operator-muted">{scope.diagramError ?? explanation.diagramError}</p>}</> : <p className="operator-muted">No accepted explanation is pinned for this scope.</p>}</section>;
}
