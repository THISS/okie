import { useEffect, useRef, useState } from 'react';
import { MermaidDiagram } from '../diagram/MermaidDiagram';
import type { OperatorExplanation } from '../operator/api';
import { BlockMarkdown, InlineMarkdown } from './markdownLite';
import { evidenceLabel, explanationViewModel, legacyDiagramSource, type EntityNameLookup, type ExplanationEvidence, type ExplanationTable as TableModel } from './explanationModel';
import './explanation.css';

export interface ExplanationViewProps {
  explanation: OperatorExplanation | unknown;
  /** The explained element's human name: diagram and table dialog titles. */
  subjectName: string;
  entityName: EntityNameLookup;
  /** Atlas: opens the cited source inside the app. */
  onOpenEvidence?: (evidence: ExplanationEvidence) => void;
  /** Operator: an external immutable source link for the evidence row (takes precedence). */
  evidenceHref?: (evidence: ExplanationEvidence) => string | undefined;
  /**
   * Operator review shows what a reader would not need: legacy `roleWithinParent` /
   * `interactions` (collapsed) and why a diagram was dropped. The atlas omits both.
   */
  audit?: boolean;
  /** Server-side diagram rejection recorded on the scope (audit only). */
  diagramError?: string;
}

export function EvidenceRow({ evidence, entityName, onOpenEvidence, evidenceHref }: { evidence: ExplanationEvidence } & Pick<ExplanationViewProps, 'entityName' | 'onOpenEvidence' | 'evidenceHref'>) {
  const label = evidenceLabel(evidence, entityName);
  const owner = evidence.entityId ? entityName(evidence.entityId) : undefined;
  const hint = owner && evidence.path ? owner : undefined;
  const href = evidenceHref?.(evidence);
  const body = <><code>{label}</code>{hint && <small>{hint}</small>}</>;
  if (href) return <li><a className="explanation-evidence-link" href={href} rel="noopener noreferrer" target="_blank" title={`Open ${label} at the scanned commit`}>{body}</a></li>;
  if (onOpenEvidence) return <li><button className="explanation-evidence-link" onClick={() => onOpenEvidence(evidence)} title={`Open source: ${label}`} type="button">{body}</button></li>;
  return <li><span className="explanation-evidence-link is-static">{body}</span></li>;
}

function TableGrid({ table }: { table: TableModel }) {
  return <table>
    <thead><tr>{table.columns.map((column, index) => <th key={index} scope="col"><InlineMarkdown text={column}/></th>)}</tr></thead>
    <tbody>{table.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, index) => <td key={index}><InlineMarkdown text={cell}/></td>)}</tr>)}</tbody>
  </table>;
}

/** Compact inline table; "Expand table" opens a modal viewer modelled on the Mermaid expand dialog. */
export function ExplanationTable({ table, title }: { table: TableModel; title: string }) {
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    // showModal: native focus containment, inert background and Esc (→ onClose).
    if (!dialog.open) dialog.showModal?.();
    return () => { if (dialog.open) dialog.close(); expandButtonRef.current?.focus(); };
  }, [expanded]);
  const heading = table.caption ?? title;
  return <figure className="explanation-table">
    {table.caption && <figcaption><InlineMarkdown text={table.caption}/></figcaption>}
    <div className="explanation-table-scroll"><TableGrid table={table}/></div>
    <button className="explanation-table-expand" onClick={() => setExpanded(true)} ref={expandButtonRef} type="button" aria-label={`Expand table: ${heading}`}>Expand table ↗</button>
    <dialog aria-label={heading} aria-modal="true" className="semantic-mermaid-viewer explanation-table-viewer" onClick={event => { if (event.target === event.currentTarget) setExpanded(false); }} onClose={() => setExpanded(false)} onKeyDown={event => event.stopPropagation()} ref={dialogRef}>
      <header>
        <h2>{heading}</h2>
        <div className="semantic-mermaid-viewer-controls"><button aria-label="Close expanded table" onClick={() => setExpanded(false)} type="button">Close</button></div>
      </header>
      <div className="semantic-mermaid-viewer-scroll explanation-table-viewer-scroll">{expanded && <TableGrid table={table}/>}</div>
    </dialog>
  </figure>;
}

/** Shared explanation renderer (atlas Overview + operator scope detail). v3 by `format`, legacy otherwise. */
export function ExplanationView({ explanation, subjectName, entityName, onOpenEvidence, evidenceHref, audit = false, diagramError }: ExplanationViewProps) {
  const model = explanationViewModel(explanation);
  if (!model) return null;
  const legacySource = model.format === 'legacy' ? legacyDiagramSource(model.diagram, entityName) : undefined;
  const diagram = model.format === 'v3' ? model.diagram : legacySource;
  const dropped = audit ? diagramError ?? model.diagramError : undefined;
  return <div className="explanation-view" data-explanation-format={model.format}>
    {model.summary && <BlockMarkdown className="explanation-summary" text={model.summary}/>}
    {model.format === 'v3' && model.keyPoints.length > 0 && <section aria-label="Worth a look" className="explanation-key-points">
      <h4>Worth a look</h4>
      <ul>{model.keyPoints.map((point, index) => <li key={index}><InlineMarkdown text={point}/></li>)}</ul>
    </section>}
    {diagram && <div className="explanation-diagram"><MermaidDiagram compact fallbackNote="The explanation text and evidence are still available." source={diagram} title={model.format === 'v3' ? `${subjectName} at a glance` : `${subjectName} and its neighbours`}/></div>}
    {model.format === 'v3' && model.table && <ExplanationTable table={model.table} title={`${subjectName} details`}/>}
    {dropped && <p className="explanation-note">Optional diagram/table omitted: {dropped}</p>}
    {model.evidence.length > 0 && <section aria-label="Evidence" className="explanation-evidence">
      <h4>Evidence</h4>
      <ul>{model.evidence.map((item, index) => <EvidenceRow entityName={entityName} evidence={item} evidenceHref={evidenceHref} key={index} onOpenEvidence={onOpenEvidence}/>)}</ul>
    </section>}
    {audit && model.format === 'legacy' && (model.roleWithinParent || model.interactions.length > 0) && <details className="explanation-legacy-notes">
      <summary>Legacy notes (pre-v3 explanation)</summary>
      {model.roleWithinParent && <p><strong>Role within parent:</strong> {model.roleWithinParent}</p>}
      {model.interactions.length > 0 && <ul>{model.interactions.map((item, index) => <li key={index}>{item}</li>)}</ul>}
    </details>}
  </div>;
}
