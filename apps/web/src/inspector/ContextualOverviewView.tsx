import { useState } from 'react';
import type { ContextualOverview, ContextualOverviewLink } from './contextualOverview';

interface Props { overview?: ContextualOverview; onOpenEntity: (id: string) => void; }

function LinkList({ title, items, onOpenEntity }: { title: string; items: ContextualOverviewLink[]; onOpenEntity: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const visible = expanded ? items : items.slice(0, 5);
  return <section className="detail-section"><div className="section-heading"><span>{title}</span><span className="detail-count">{items.length}</span></div>{items.length ? <div className="inspector-link-list">{visible.map((item) => <button key={`${item.id}:${item.relationship}`} type="button" className="inspector-link-row" onClick={() => onOpenEntity(item.id)}><span>{item.name}</span><small>{item.relationship}</small></button>)}{items.length > 5 ? <button aria-expanded={expanded} className="empty-inspector-section relations-omitted-more" onClick={() => setExpanded(value => !value)} type="button">{expanded ? 'Show fewer' : `Show all ${items.length}`}</button> : null}</div> : <p className="detail-muted">None captured.</p>}</section>;
}

export function ContextualOverviewView({ overview, onOpenEntity }: Props) {
  if (!overview) return <p className="detail-muted">Overview evidence is unavailable for this selection.</p>;
  return <div className="contextual-overview" data-contextual-overview={overview.entity.id}><section className="detail-section"><p className="eyebrow">{overview.entity.kind}</p><h3>{overview.entity.name}</h3><p className="detail-muted">{overview.entity.summary ?? `${overview.entity.name} is a ${overview.entity.kind}${overview.parent ? ` within ${overview.parent.name}` : ' in this snapshot'}.`}</p></section>{overview.parent ? <section className="detail-section"><div className="section-heading"><span>Parent</span></div><button type="button" className="inspector-link-row" onClick={() => onOpenEntity(overview.parent!.id)}><span>{overview.parent.name}</span><small>{overview.parent.kind}</small></button></section> : null}{!overview.dependencies.length && !overview.dependents.length ? <p className="detail-muted">No relationships captured.</p> : null}<LinkList title="Direct dependencies" items={overview.dependencies} onOpenEntity={onOpenEntity} /><LinkList title="Direct dependents" items={overview.dependents} onOpenEntity={onOpenEntity} /><LinkList title="Children" items={overview.children} onOpenEntity={onOpenEntity} /></div>;
}
