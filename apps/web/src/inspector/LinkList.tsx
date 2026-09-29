import { useState } from 'react';
import type { ContextualOverviewLink } from './contextualOverview';

/** Bounded Overview link group: first five rows, then "Show all N". Rows open the entity. */
export function LinkList({ title, items, onOpenEntity }: { title: string; items: ContextualOverviewLink[]; onOpenEntity: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  if (!items.length) return null;
  const visible = expanded ? items : items.slice(0, 5);
  return <section className="detail-section"><div className="section-heading"><span>{title}</span><span className="detail-count">{items.length}</span></div>{items.length ? <div className="inspector-link-list">{visible.map((item) => <button key={`${item.id}:${item.relationship}`} type="button" className="inspector-link-row" onClick={() => onOpenEntity(item.id)}><span>{item.name}</span><small>{item.relationship}</small></button>)}{items.length > 5 ? <button aria-expanded={expanded} className="empty-inspector-section relations-omitted-more" onClick={() => setExpanded(value => !value)} type="button">{expanded ? 'Show fewer' : `Show all ${items.length}`}</button> : null}</div> : <p className="detail-muted">None captured.</p>}</section>;
}
