import { validRelativeSourcePath } from '../diagram/SourceViewer';
import type { EntityNameLookup, ExplanationEvidence } from '../explanation/explanationModel';

/**
 * CLA-149 `blocks/v1`: the Overview as an ordered array of typed blocks.
 * Array order is display order. Each `type` maps to one hard-coded renderer
 * (see OverviewBlocks.tsx); nothing chooses components at runtime.
 * Design: docs/roadmap/overview-blocks.md.
 */
export const OVERVIEW_BLOCKS_SCHEMA = 'blocks/v1';

/**
 * Where a block's content came from. Assigned by the composer per source, never
 * read from block input.
 * - `observed`: derived from the scanned snapshot (graph, containment, captured responsibility).
 * - `enrichment`: adapted from the accepted enrichment explanation (model-authored prose).
 */
export type BlockProvenance = 'observed' | 'enrichment';

export interface BlockRef { id: string; reason: string }
export interface BlockLink { id: string; relationship: string }
export type RelationDirection = 'parent' | 'dependencies' | 'dependents';

interface BlockBase { id: string; provenance: BlockProvenance }
export type OverviewBlock = BlockBase & (
  | { type: 'markdown'; text: string }
  | { type: 'keyPoints'; title: string; items: string[] }
  | { type: 'nodeRefs'; title: string; refs: BlockRef[] }
  | { type: 'relations'; direction: RelationDirection; items: BlockLink[] }
  | { type: 'children'; items: BlockLink[] }
  | { type: 'mermaid'; title: string; source: string }
  | { type: 'table'; title: string; caption?: string; columns: string[]; rows: string[][] }
  | { type: 'evidence'; items: ExplanationEvidence[] }
);
export type BlockType = OverviewBlock['type'];
export type BlockOf<T extends BlockType> = Extract<OverviewBlock, { type: T }>;

export const BLOCK_TYPES: readonly BlockType[] = ['markdown', 'keyPoints', 'nodeRefs', 'relations', 'children', 'mermaid', 'table', 'evidence'];
/** Graph facts a model may never author: enrichment input using these types is dropped. */
export const OBSERVED_ONLY_TYPES: ReadonlySet<BlockType> = new Set(['relations', 'children']);

export const BLOCK_CAPS = {
  maxBlocks: 16,
  /** Raw entries inspected per source; anything past this is dropped unread. */
  maxInputEntries: 64,
  idChars: 64,
  /** JSON nesting allowed inside one block spec (a table block is 3 deep: block → rows → row → cell). */
  maxDepth: 5,
  titleChars: 120,
  markdownChars: 4000,
  keyPoints: 8, keyPointChars: 400,
  nodeRefs: 8, nodeRefReasonChars: 80,
  linkItems: 1000, relationshipChars: 80,
  mermaidChars: 4000, mermaidLines: 60,
  tableColumns: 6, tableRows: 20, tableCellChars: 400, tableCaptionChars: 200,
  evidence: 24,
} as const;

/** A whole block that was not rendered. */
export interface DroppedBlock { id?: string; type?: string; reason: string }
/** A block that rendered with some items left out (over a list cap, or individually invalid). */
export interface TrimmedBlock { id: string; type: string; omitted: number; reasons: string[] }
export interface BlockValidation { blocks: OverviewBlock[]; dropped: DroppedBlock[]; trimmed: TrimmedBlock[] }
export interface BlockValidationContext {
  /** Provenance stamped on every accepted block; input `provenance` fields are ignored. */
  source: BlockProvenance;
  /** Canonical entity names; an id without a non-empty string name is not a valid reference. */
  entityName: EntityNameLookup;
}

const ID = /^[a-z][A-Za-z0-9]*(?::[A-Za-z0-9][A-Za-z0-9-]*)*$/u;
const ENRICHMENT_PREFIX = 'enrichment:';
/** Neutral label for an observed link whose relationship label is missing. */
export const NEUTRAL_RELATIONSHIP = 'related';

/** Only a non-empty string counts as a canonical name (guards prototype keys and empty names). */
export function resolvedName(lookup: EntityNameLookup, id: string): string | undefined {
  const name: unknown = lookup(id);
  return typeof name === 'string' && name.trim() ? name : undefined;
}

class Invalid extends Error {}
const fail = (reason: string): never => { throw new Invalid(reason); };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const asList = (value: unknown, what: string): unknown[] => Array.isArray(value) ? value : fail(`${what} is not a list`);
const clip = (value: string, max: number) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
/** Required text: empty or non-string is structural; over-long is clipped with an ellipsis. */
const text = (value: unknown, what: string, max: number): string => typeof value === 'string' && value.trim() ? clip(value, max) : fail(`${what} is empty`);
const optionalText = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() ? clip(value, max) : undefined;
const line = (value: unknown): number | undefined => typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

function depth(value: unknown, level = 0): number {
  if (level > BLOCK_CAPS.maxDepth + 1 || !value || typeof value !== 'object') return level;
  let deepest = level;
  for (const child of Object.values(value)) deepest = Math.max(deepest, depth(child, level + 1));
  return deepest;
}

/** Collects item-level omissions for one block while it is parsed. */
class Omissions {
  count = 0;
  readonly reasons: string[] = [];
  add(reason: string, count = 1) { if (count > 0) { this.count += count; if (!this.reasons.includes(reason)) this.reasons.push(reason); } }
  /** Keeps the first `max` items and counts the rest. */
  cap<T>(items: T[], max: number, what: string): T[] { this.add(`${what} over the ${max}-item cap`, items.length - max); return items.slice(0, max); }
}

function links(value: unknown, fallback: string, ctx: BlockValidationContext, out: Omissions): BlockLink[] {
  const items = out.cap(asList(value, 'items'), BLOCK_CAPS.linkItems, 'items').flatMap(raw => {
    const item = isRecord(raw) ? raw : {};
    const id = typeof item.id === 'string' ? item.id : undefined;
    if (!id || !resolvedName(ctx.entityName, id)) { out.add('item references an unknown entity'); return []; }
    return [{ id, relationship: optionalText(item.relationship, BLOCK_CAPS.relationshipChars) ?? fallback }];
  });
  return items.length ? items : fail('no item references a known entity');
}

function evidenceItem(input: unknown, ctx: BlockValidationContext, out: Omissions): ExplanationEvidence | undefined {
  if (!isRecord(input)) { out.add('evidence item is not an object'); return undefined; }
  const raw = input;
  const entityId = typeof raw.entityId === 'string' && resolvedName(ctx.entityName, raw.entityId) ? raw.entityId : undefined;
  const rawPath = typeof raw.path === 'string' && raw.path ? raw.path : undefined;
  // An unsafe path is removed; the citation survives only if it still names a known entity.
  const path = rawPath && validRelativeSourcePath(rawPath) ? rawPath : undefined;
  // App resolves excerpts by entity id, so an unknown id alongside a safe path is kept as a lookup key only.
  const lookupId = entityId ?? (path && typeof raw.entityId === 'string' && raw.entityId ? raw.entityId : undefined);
  if (!path && !entityId) { out.add('evidence cites neither a known entity nor a safe source path'); return undefined; }
  const startLine = path ? line(raw.startLine) : undefined; const endLine = path ? line(raw.endLine) : undefined;
  return { ...(lookupId ? { entityId: lookupId } : {}), ...(path ? { path } : {}), ...(startLine ? { startLine } : {}), ...(startLine && endLine && endLine >= startLine ? { endLine } : {}) };
}

/**
 * Rebuilds one block from untrusted input. Only whitelisted props are copied, so
 * anything else (`href`, `onClick`, `html`, `url`, `action`, `provenance`, …) is ignored.
 * Structural problems throw (whole block dropped); cap overruns and bad items trim.
 */
function parseBlock(raw: Record<string, unknown>, type: BlockType, id: string, ctx: BlockValidationContext, out: Omissions): OverviewBlock {
  const base = { id, provenance: ctx.source };
  switch (type) {
    case 'markdown': return { ...base, type, text: text(raw.text, 'text', BLOCK_CAPS.markdownChars) };
    case 'keyPoints': {
      const items = out.cap(asList(raw.items, 'items'), BLOCK_CAPS.keyPoints, 'key points').flatMap(item => {
        const value = optionalText(item, BLOCK_CAPS.keyPointChars);
        if (value === undefined) out.add('key point is empty');
        return value ?? [];
      });
      return items.length ? { ...base, type, title: text(raw.title, 'title', BLOCK_CAPS.titleChars), items } : fail('items is empty');
    }
    case 'nodeRefs': {
      const seen = new Set<string>();
      const refs = out.cap(asList(raw.refs, 'refs'), BLOCK_CAPS.nodeRefs, 'refs').flatMap(ref => {
        const refId = isRecord(ref) && typeof ref.id === 'string' ? ref.id : undefined;
        const reason = isRecord(ref) ? optionalText(ref.reason, BLOCK_CAPS.nodeRefReasonChars) : undefined;
        if (!refId || !resolvedName(ctx.entityName, refId)) { out.add('ref names an unknown entity'); return []; }
        if (seen.has(refId)) { out.add('ref repeats an entity'); return []; }
        if (!reason) { out.add('ref has no reason'); return []; }
        seen.add(refId);
        // Only the id and a short reason survive; the chip label always comes from the canonical name.
        return [{ id: refId, reason }];
      });
      return refs.length ? { ...base, type, title: text(raw.title, 'title', BLOCK_CAPS.titleChars), refs } : fail('no ref names a known entity');
    }
    case 'relations': {
      const direction = raw.direction === 'parent' || raw.direction === 'dependencies' || raw.direction === 'dependents' ? raw.direction : fail('direction is not parent, dependencies or dependents');
      const items = links(raw.items, NEUTRAL_RELATIONSHIP, ctx, out);
      return direction === 'parent' && items.length !== 1 ? fail('a parent relation has exactly one item') : { ...base, type, direction, items };
    }
    case 'children': return { ...base, type, items: links(raw.items, NEUTRAL_RELATIONSHIP, ctx, out) };
    case 'mermaid': {
      const source = typeof raw.source === 'string' && raw.source.trim() ? raw.source : fail('source is empty');
      // Diagrams cannot be cut safely: over either cap drops the block.
      if (source.length > BLOCK_CAPS.mermaidChars) fail(`source is ${source.length} characters (limit ${BLOCK_CAPS.mermaidChars})`);
      if (source.split('\n').length > BLOCK_CAPS.mermaidLines) fail(`source has more than ${BLOCK_CAPS.mermaidLines} lines`);
      return { ...base, type, title: text(raw.title, 'title', BLOCK_CAPS.titleChars), source };
    }
    case 'table': {
      const rawColumns = asList(raw.columns, 'columns');
      if (!rawColumns.length) fail('columns is empty');
      if (rawColumns.length > BLOCK_CAPS.tableColumns) fail(`columns has ${rawColumns.length} items (limit ${BLOCK_CAPS.tableColumns})`);
      const columns = rawColumns.map((cell, index) => text(cell, `columns[${index}]`, BLOCK_CAPS.tableCellChars));
      const rows = out.cap(asList(raw.rows, 'rows'), BLOCK_CAPS.tableRows, 'rows').map((rawRow, rowIndex) => {
        const row = asList(rawRow, `rows[${rowIndex}]`);
        // Short rows pad with empty cells (as the CLA-260 renderer does); extra cells are ignored; cells must be text.
        return columns.map((_, index) => {
          const cell = row[index] ?? '';
          return typeof cell === 'string' ? clip(cell, BLOCK_CAPS.tableCellChars) : fail(`rows[${rowIndex}][${index}] is not text`);
        });
      });
      if (!rows.length) fail('rows is empty');
      const caption = optionalText(raw.caption, BLOCK_CAPS.tableCaptionChars);
      return { ...base, type, title: text(raw.title, 'title', BLOCK_CAPS.titleChars), ...(caption ? { caption } : {}), columns, rows };
    }
    case 'evidence': {
      const items = out.cap(asList(raw.items, 'items'), BLOCK_CAPS.evidence, 'evidence items').flatMap(item => evidenceItem(item, ctx, out) ?? []);
      return items.length ? { ...base, type, items } : fail('no evidence item cites a known entity or a safe source path');
    }
  }
}

const isBlockType = (value: unknown): value is BlockType => typeof value === 'string' && (BLOCK_TYPES as readonly string[]).includes(value);

/**
 * Per-block validation: a structurally invalid block is dropped with a reason, never
 * the whole overview; cap overruns and invalid items are trimmed and counted.
 * Enforces the block cap, id shape/namespace/uniqueness, the type whitelist,
 * observed-only types, entity references and per-type caps.
 */
export function validateBlocks(raw: unknown, ctx: BlockValidationContext): BlockValidation {
  if (!Array.isArray(raw)) return { blocks: [], dropped: raw === undefined || raw === null ? [] : [{ reason: 'block list is not an array' }], trimmed: [] };
  const blocks: OverviewBlock[] = [];
  const dropped: DroppedBlock[] = [];
  const trimmed: TrimmedBlock[] = [];
  const ids = new Set<string>();
  raw.slice(0, BLOCK_CAPS.maxInputEntries).forEach(entry => {
    const spec = isRecord(entry) ? entry : undefined;
    const id = typeof spec?.id === 'string' ? spec.id.slice(0, BLOCK_CAPS.idChars) : undefined;
    const type = typeof spec?.type === 'string' ? spec.type.slice(0, 32) : undefined;
    const drop = (reason: string) => { dropped.push({ ...(id ? { id } : {}), ...(type ? { type } : {}), reason }); };
    if (!spec) return drop('block is not an object');
    if (!id || spec.id !== id || !ID.test(id)) return drop('block id is missing or malformed');
    if (ids.has(id)) return drop('duplicate block id');
    if ((ctx.source === 'enrichment') !== id.startsWith(ENRICHMENT_PREFIX)) return drop(`${ctx.source} block id is outside its namespace`);
    if (!isBlockType(spec.type)) return drop('unknown block type');
    if (ctx.source === 'enrichment' && OBSERVED_ONLY_TYPES.has(spec.type)) return drop(`${spec.type} blocks are observed facts only`);
    if (depth(spec) > BLOCK_CAPS.maxDepth) return drop('block is nested too deeply');
    if (blocks.length >= BLOCK_CAPS.maxBlocks) return drop(`over the ${BLOCK_CAPS.maxBlocks}-block cap`);
    const out = new Omissions();
    try {
      blocks.push(parseBlock(spec, spec.type, id, ctx, out));
      ids.add(id);
      if (out.count) trimmed.push({ id, type: spec.type, omitted: out.count, reasons: out.reasons });
    } catch (error) {
      if (!(error instanceof Invalid)) throw error;
      drop(error.message);
    }
  });
  if (raw.length > BLOCK_CAPS.maxInputEntries) dropped.push({ reason: `${raw.length - BLOCK_CAPS.maxInputEntries} entries past the input cap were not read` });
  return { blocks, dropped, trimmed };
}
