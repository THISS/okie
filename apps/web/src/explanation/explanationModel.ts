import { C4_ELEMENT_TYPE_LABELS } from '@okie/architecture';
import type { OperatorEvidenceRef, OperatorExplanation } from '../operator/api';
import { validRelativeSourcePath } from '../diagram/SourceViewer';

/** Resolves an entity id to its human name; unknown ids return undefined (never displayed raw). */
export type EntityNameLookup = (entityId: string) => string | undefined;

export type ExplanationEvidence = OperatorEvidenceRef;
export interface ExplanationTable { caption?: string; columns: string[]; rows: string[][] }
export interface LegacyDiagram { nodes: string[]; edges: Array<{ from: string; to: string; label?: string }> }

/**
 * Defensive view model over stored explanation content. Published sidecars and old
 * drafts are data, not a typed contract: every field is re-checked so malformed or
 * partial content renders what it can instead of crashing the inspector.
 */
export type ExplanationViewModel =
  | { format: 'v3'; summary: string; keyPoints: string[]; diagram?: string; table?: ExplanationTable; evidence: ExplanationEvidence[]; diagramError?: string }
  | { format: 'legacy'; summary: string; roleWithinParent?: string; interactions: string[]; diagram?: LegacyDiagram; evidence: ExplanationEvidence[]; diagramError?: string };

const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
const line = (value: unknown): number | undefined => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

function evidenceList(value: unknown): ExplanationEvidence[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ExplanationEvidence[] => {
    if (!item || typeof item !== 'object') return [];
    const record = item as Record<string, unknown>;
    const entityId = text(record.entityId); const path = text(record.path); const startLine = line(record.startLine); const endLine = line(record.endLine);
    if (!entityId && !path) return [];
    return [{ ...(entityId ? { entityId } : {}), ...(path ? { path } : {}), ...(startLine ? { startLine } : {}), ...(endLine ? { endLine } : {}) }];
  });
}

function tableOf(value: unknown): ExplanationTable | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const columns = strings(record.columns);
  if (columns.length < 1 || !Array.isArray(record.rows)) return undefined;
  const rows = record.rows.filter((row): row is unknown[] => Array.isArray(row))
    .map(row => columns.map((_, index) => typeof row[index] === 'string' ? row[index] as string : ''));
  if (!rows.length) return undefined;
  const caption = text(record.caption);
  return { ...(caption ? { caption } : {}), columns, rows };
}

function legacyDiagram(value: unknown): LegacyDiagram | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const nodes = strings(record.nodes);
  if (!nodes.length) return undefined;
  const edges = Array.isArray(record.edges) ? record.edges.flatMap(edge => {
    if (!edge || typeof edge !== 'object') return [];
    const { from, to, label } = edge as Record<string, unknown>;
    return typeof from === 'string' && typeof to === 'string' ? [{ from, to, ...(text(label) ? { label: label as string } : {}) }] : [];
  }) : [];
  return { nodes, edges };
}

export function explanationViewModel(explanation: OperatorExplanation | unknown): ExplanationViewModel | undefined {
  if (!explanation || typeof explanation !== 'object') return undefined;
  const record = explanation as Record<string, unknown>;
  const summary = text(record.summary) ?? '';
  const evidence = evidenceList(record.evidence);
  const diagramError = text(record.diagramError);
  if (record.format === 'v3') {
    const diagram = text(record.diagram); const table = tableOf(record.table);
    return { format: 'v3', summary, keyPoints: strings(record.keyPoints), ...(diagram ? { diagram } : {}), ...(table ? { table } : {}), evidence, ...(diagramError ? { diagramError } : {}) };
  }
  const roleWithinParent = text(record.roleWithinParent); const diagram = legacyDiagram(record.diagram);
  return { format: 'legacy', summary, ...(roleWithinParent ? { roleWithinParent } : {}), interactions: strings(record.interactions), ...(diagram ? { diagram } : {}), evidence, ...(diagramError ? { diagramError } : {}) };
}

/** Worth leading with: a summary, key points or evidence. An empty shell falls back to the captured summary. */
export function hasExplanationContent(model: ExplanationViewModel | undefined): model is ExplanationViewModel {
  return !!model && (model.summary.trim().length > 0 || (model.format === 'v3' && model.keyPoints.length > 0) || model.evidence.length > 0);
}

/** `path:12–30`, `path:12`, `path`, or the entity's human name — never a raw entity id. */
export function evidenceLabel(evidence: ExplanationEvidence, entityName: EntityNameLookup): string {
  if (evidence.path) {
    const { startLine, endLine } = evidence;
    const lines = startLine === undefined ? '' : endLine !== undefined && endLine > startLine ? `:${startLine}–${endLine}` : `:${startLine}`;
    return `${evidence.path}${lines}`;
  }
  return (evidence.entityId ? entityName(evidence.entityId) : undefined) ?? 'Captured architecture evidence';
}

/** An immutable GitHub blob link for evidence at a pinned 40-hex commit, or undefined. */
export function evidenceSourceUrl(evidence: ExplanationEvidence, source: { owner: string; repo: string; commitSha?: string } | undefined): string | undefined {
  if (!source?.commitSha || !evidence.path || !validRelativeSourcePath(evidence.path)) return undefined;
  if (!/^[a-f0-9]{40}$/u.test(source.commitSha) || !/^[a-zA-Z0-9-]+$/u.test(source.owner) || !/^[a-zA-Z0-9_.-]+$/u.test(source.repo)) return undefined;
  const { startLine, endLine } = evidence;
  const anchor = startLine === undefined ? '' : endLine !== undefined && endLine > startLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`;
  return `https://github.com/${source.owner}/${source.repo}/blob/${source.commitSha}/${evidence.path.split('/').map(encodeURIComponent).join('/')}${anchor}`;
}

/** Human label for a C4 kind ("softwareSystem" → "Software system"). */
export function kindLabel(kind: string): string {
  const known = (C4_ELEMENT_TYPE_LABELS as Record<string, string>)[kind];
  if (known) return known;
  const words = kind.replace(/([a-z])([A-Z])/gu, '$1 $2').replace(/[-_]+/gu, ' ').trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Element';
}

/** Legacy `{nodes, edges}` → Mermaid source with human labels (unknown ids become "Entity N", never the id). */
export function legacyDiagramSource(diagram: LegacyDiagram | undefined, entityName: EntityNameLookup): string | undefined {
  if (!diagram?.nodes.length) return undefined;
  const ids = new Map(diagram.nodes.map((id, index) => [id, `n${index}`]));
  const safe = (value: string) => value.replace(/["\[\]{}|<>`#;]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 120);
  return ['flowchart LR',
    ...diagram.nodes.map((id, index) => `  n${index}["${safe(entityName(id) ?? '') || `Entity ${index + 1}`}"]`),
    ...diagram.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)).map(edge => {
      const label = edge.label ? safe(edge.label) : '';
      return `  ${ids.get(edge.from)} -->${label ? `|${label}|` : ''} ${ids.get(edge.to)}`;
    })].join('\n');
}
