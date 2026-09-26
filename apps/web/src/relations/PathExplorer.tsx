import type { PathEvidenceView, PathExplorationView, PathHopView } from './pathExploration';

export type PathExplorerProps = {
  view: PathExplorationView;
  /** True when a scan host can fetch excerpts for evidence not yet resident. */
  canLoadExcerpts?: boolean;
  onSwap: () => void;
  onClear: () => void;
  onToggleKind: (kind: string) => void;
  onToggleContainment: () => void;
  onToggleScope: () => void;
  onShowHop: (hop: PathHopView) => void;
  onOpenEvidence: (hop: PathHopView, evidence: PathEvidenceView) => void;
};

function EndpointRow({ label, endpoint, resolved }: { label: string; endpoint?: PathExplorationView['from']; resolved?: PathExplorationView['from'] }) {
  return <div>
    <dt>{label}</dt>
    <dd data-path-endpoint={label.toLowerCase()}>
      {endpoint ? <><strong>{endpoint.name}</strong>{endpoint.known ? null : <> · not in this snapshot</>}</> : <span className="detail-muted">Not chosen</span>}
      {resolved && endpoint ? <><br/><span data-path-resolved-endpoint={resolved.id}>via {resolved.name}, inside {endpoint.name}</span></> : null}
    </dd>
  </div>;
}

function Evidence({ hop, evidence, canLoadExcerpts, onOpenEvidence }: { hop: PathHopView; evidence: PathEvidenceView; canLoadExcerpts: boolean; onOpenEvidence: PathExplorerProps['onOpenEvidence'] }) {
  const openable = Boolean(evidence.excerpt) || canLoadExcerpts;
  return <li className="path-evidence" data-path-evidence-source={openable ? 'openable' : 'unavailable'}>
    {evidence.reason ? <span>{evidence.reason}</span> : <span className="detail-muted">No reason recorded</span>}
    <code>{evidence.location}</code>
    {openable
      ? <button className="secondary-detail-action" data-testid="path-evidence-open" onClick={() => onOpenEvidence(hop, evidence)} type="button">Open source</button>
      : <small className="detail-muted">No frozen source excerpt was captured for this evidence.</small>}
  </li>;
}

function Hop({ hop, canLoadExcerpts, onShowHop, onOpenEvidence }: { hop: PathHopView; canLoadExcerpts: boolean; onShowHop: PathExplorerProps['onShowHop']; onOpenEvidence: PathExplorerProps['onOpenEvidence'] }) {
  return <li className="path-hop" data-path-hop-index={hop.index} data-path-hop-via={hop.via} data-testid="path-hop" {...(hop.relationId ? { 'data-path-hop-relation-id': hop.relationId } : {})}>
    <p className="path-hop-route"><strong>{hop.from.name}</strong><span aria-hidden="true"> → </span><span className="sr-only"> to </span><strong>{hop.to.name}</strong></p>
    <div className="entity-metadata">
      <span>{hop.kind}</span>
      <span>{hop.viaLabel}</span>
      <span>Confidence {hop.confidenceLabel}</span>
      {hop.parallelCount > 0 ? <span>+{hop.parallelCount} parallel</span> : null}
      {hop.limits.map(limit => <span className="signal" data-path-hop-limit={limit.code} key={limit.code}>{limit.label}</span>)}
    </div>
    {hop.label ? <p className="detail-muted">{hop.label}</p> : null}
    {hop.evidence.length
      ? <ul className="path-evidence-list">{hop.evidence.map((item, index) => <Evidence canLoadExcerpts={canLoadExcerpts} evidence={item} hop={hop} key={`${item.location}:${index}`} onOpenEvidence={onOpenEvidence}/>)}</ul>
      : null}
    {hop.mapNote
      ? <p className="detail-muted" data-path-hop-map-note="">{hop.mapNote}</p>
      : <button aria-label={`Show ${hop.from.name} ${hop.kind} ${hop.to.name} on map`} className="secondary-detail-action" data-testid="path-hop-show" onClick={() => onShowHop(hop)} type="button">Show on map</button>}
  </li>;
}

/** CLA-208: path exploration panel. Selection-driven; framing only on explicit "Show on map". */
export function PathExplorer({ view, canLoadExcerpts = false, onSwap, onClear, onToggleKind, onToggleContainment, onToggleScope, onShowHop, onOpenEvidence }: PathExplorerProps) {
  const ran = view.state === 'found' || view.state === 'unreachable' || view.state === 'unavailable';
  return <section aria-label="Path exploration" className="detail-section path-explorer" data-path-coverage={view.coverage} data-testid="path-explorer">
    <div className="section-title"><h3>Path</h3><span>{view.hops.length}</span></div>
    <dl className="relation-facts">
      <EndpointRow endpoint={view.from} label="From" {...(view.resolvedFrom ? { resolved: view.resolvedFrom } : {})}/>
      <EndpointRow endpoint={view.to} label="To" {...(view.resolvedTo ? { resolved: view.resolvedTo } : {})}/>
    </dl>
    <div className="detail-actions" role="group" aria-label="Path endpoints">
      <button className="secondary-detail-action" data-testid="path-swap" disabled={!view.from && !view.to} onClick={onSwap} type="button">Swap</button>
      <button className="secondary-detail-action" data-testid="path-clear" onClick={onClear} type="button">Clear path</button>
    </div>
    <fieldset className="path-options">
      <legend>Follow relation kinds</legend>
      {view.kinds.length ? view.kinds.map(option => <label data-path-kind={option.kind} key={option.kind}>
        <input checked={option.checked} onChange={() => onToggleKind(option.kind)} type="checkbox"/>
        {' '}{option.kind}{!option.known ? ' (unrecognised)' : !option.present ? ' (none in snapshot)' : ''}
      </label>) : <p className="detail-muted">This snapshot has no relations.</p>}
      <label data-path-option="containment"><input checked={view.containment} onChange={onToggleContainment} type="checkbox"/> Parent containment (parent → child)</label>
      <label data-path-option="scope"><input checked={view.scope === 'subtree'} onChange={onToggleScope} type="checkbox"/> Match parts inside endpoints</label>
    </fieldset>
    <div className="path-status" data-path-status={view.state} data-testid="path-status" role="status" {...(view.reason ? { 'data-path-reason': view.reason } : {})}>
      <strong>{view.title}</strong>
      <p>{view.message}</p>
      {view.notes.map(note => <p className="detail-muted" data-path-note="" key={note}>{note}</p>)}
    </div>
    {view.hops.length ? <ol className="path-hops">{view.hops.map(hop => <Hop canLoadExcerpts={canLoadExcerpts} hop={hop} key={hop.index} onOpenEvidence={onOpenEvidence} onShowHop={onShowHop}/>)}</ol> : null}
    {ran || view.state === 'snapshotMismatch' || view.state === 'unknownKinds'
      ? <p className="relation-evidence-note" data-testid="path-disclaimer">{view.disclaimer}</p>
      : null}
  </section>;
}
