import { useLayoutEffect, useRef, useState } from 'react';
import type { ContextualOverview, ContextualOverviewLink } from './contextualOverview';
import type { OperatorScope } from '../operator/api';
import { ExplanationView } from '../explanation/ExplanationView';
import { explanationViewModel, hasExplanationContent, kindLabel, type EntityNameLookup, type ExplanationEvidence } from '../explanation/explanationModel';

interface Props {
  overview?: ContextualOverview;
  onOpenEntity: (id: string) => void;
  /** Accepted operator explanation for this element (CLA-260): leads the Overview when present. */
  explanation?: OperatorScope;
  entityName?: EntityNameLookup;
  onOpenEvidence?: (evidence: ExplanationEvidence) => void;
}

function LinkList({ title, items, onOpenEntity }: { title: string; items: ContextualOverviewLink[]; onOpenEntity: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const visible = expanded ? items : items.slice(0, 5);
  return <section className="detail-section"><div className="section-heading"><span>{title}</span><span className="detail-count">{items.length}</span></div>{items.length ? <div className="inspector-link-list">{visible.map((item) => <button key={`${item.id}:${item.relationship}`} type="button" className="inspector-link-row" onClick={() => onOpenEntity(item.id)}><span>{item.name}</span><small>{item.relationship}</small></button>)}{items.length > 5 ? <button aria-expanded={expanded} className="empty-inspector-section relations-omitted-more" onClick={() => setExpanded(value => !value)} type="button">{expanded ? 'Show fewer' : `Show all ${items.length}`}</button> : null}</div> : <p className="detail-muted">None captured.</p>}</section>;
}

export function ComponentImplementation({ files, onOpenEntity }: {
  files: NonNullable<ContextualOverview['implementationFiles']>;
  onOpenEntity: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return <section className="detail-section" aria-label="Implementing files">
    <div className="section-heading"><span>Implementing files</span><span className="detail-count">{files.length}</span></div>
    <p className="detail-muted">Select a declaration to inspect its relationships and source.</p>
    {(expanded ? files : files.slice(0, 5)).map(file => <details key={file.path}>
      <summary>{file.path} · {file.code.length} declarations</summary>
      {file.code.length ? <LinkList title="Implementing code" items={file.code} onOpenEntity={onOpenEntity}/> : <p className="detail-muted">No declarations captured in this neighborhood.</p>}
    </details>)}
    {files.length > 5 && <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show fewer' : `Show all ${files.length} files`}</button>}
  </section>;
}

type ScrollHost = { scrollTop: number };
/** The inspector scroll container the Overview lives in, if any. */
export function overviewScrollHost(element: { closest(selector: string): unknown } | null | undefined): ScrollHost | undefined {
  const host = element?.closest('.details-scroll');
  return host && typeof host === 'object' && 'scrollTop' in host ? host as ScrollHost : undefined;
}
/** A new entity starts at the top so its explanation leads; re-renders of the same entity keep the reader's place. */
export function resetOverviewScroll(element: Parameters<typeof overviewScrollHost>[0]): void {
  const host = overviewScrollHost(element);
  if (host && host.scrollTop !== 0) host.scrollTop = 0;
}

export function ContextualOverviewView({ overview, onOpenEntity, explanation, entityName, onOpenEvidence }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const entityId = overview?.entity.id;
  useLayoutEffect(() => { resetOverviewScroll(rootRef.current); }, [entityId]);
  if (!overview) return <div ref={rootRef}><p className="detail-muted">Overview evidence is unavailable for this selection.</p></div>;
  const explained = explanation && hasExplanationContent(explanationViewModel(explanation.explanation)) ? explanation : undefined;
  const lookup: EntityNameLookup = entityName ?? (() => undefined);
  const placeholder = overview.parent ? `Part of ${overview.parent.name}. No description has been captured yet.` : 'No description has been captured yet.';
  return <div className="contextual-overview" ref={rootRef} data-contextual-overview={overview.entity.id} data-overview-explained={explained ? 'true' : undefined}>
    <section className="detail-section">
      <div className="overview-identity">
        <h3 className="overview-title">{overview.entity.name}</h3>
        <div className="overview-identity-meta"><span className="overview-chip">{kindLabel(overview.entity.kind)}</span>{explained?.stale && <span className="overview-chip is-stale" title="The code changed after this explanation was written.">Stale</span>}</div>
      </div>
      {explained
        ? <div className="overview-lead"><ExplanationView entityName={lookup} explanation={explained.explanation} {...(onOpenEvidence ? { onOpenEvidence } : {})} subjectName={overview.entity.name}/></div>
        : overview.entity.summary ? <p className="overview-description">{overview.entity.summary}</p> : <p className="detail-muted">{placeholder}</p>}
      {overview.componentBasis === 'authored' && <p className="detail-muted">Authored component · membership defined by an explicit scan mapping.</p>}
      {overview.componentBasis === 'file' && <p className="detail-muted">File-based component · no architectural grouping is recorded here.</p>}
    </section>
    {overview.parent && <section className="detail-section"><div className="section-heading"><span>Parent</span></div><button type="button" className="inspector-link-row" onClick={() => onOpenEntity(overview.parent!.id)}><span>{overview.parent.name}</span><small>{kindLabel(overview.parent.kind)}</small></button></section>}
    <LinkList title="Direct dependencies" items={overview.dependencies} onOpenEntity={onOpenEntity}/>
    <LinkList title="Direct dependents" items={overview.dependents} onOpenEntity={onOpenEntity}/>
    {overview.implementationFiles ? <ComponentImplementation files={overview.implementationFiles} onOpenEntity={onOpenEntity}/> : <LinkList title={overview.entity.kind === 'component' ? 'Implementing code' : 'Children'} items={overview.children} onOpenEntity={onOpenEntity}/>}
  </div>;
}
