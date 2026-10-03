import type { ArchitectureEntity, ArchitectureRelation, ArchitectureSnapshot, EntityKind, RelationKind, SourceExcerpt, SourceLanguage, SourceRef } from "./model.js";
import { SOURCE_EXCERPT_LIMITS } from "./model.js";

/** Public read payload bounds. Selectors never read files or call a model. */
export const AGENT_QUERY_LIMITS = {
  defaultLimit: 20,
  maxLimit: 50,
  maxQueryCharacters: 256,
  maxIdCharacters: 512,
  maxNameCharacters: 256,
  maxExplanationCharacters: 1600,
  maxSourceRefs: 16,
  maxExcerpts: 8,
  maxTechnologyEntries: 8,
  maxKeyPoints: 8,
  maxKeyPointCharacters: 400,
} as const;

interface AgentSnapshotIdentity { snapshotId: string; commitSha: string }
export interface AgentSourceRef { path: string; commitSha: string; symbol?: string; startLine?: number; endLine?: number }
export interface AgentEntitySummary {
  id: string;
  kind: EntityKind;
  name: string;
  parentId?: string;
  sourceRefs: AgentSourceRef[];
  /** The snapshot records structure; its schema does not establish scanner provenance. */
  structureProvenance: "snapshot-recorded";
}
export interface AgentEntityDetail extends AgentEntitySummary {
  responsibility?: string;
  technology: string[];
  explanationProvenance: "origin-not-recorded" | "missing";
  understanding?: AgentUnderstanding;
}
export interface AgentUnderstandingEvidence { entityId?: string; path?: string; symbol?: string; startLine?: number; endLine?: number }
export interface AgentUnderstanding {
  format: "v3" | "legacy";
  summary: string;
  keyPoints: string[];
  evidence: AgentUnderstandingEvidence[];
  state: "accepted";
  stale: boolean | "unknown";
  provenance: "published-explanation";
  origin: "origin-not-recorded";
  explanationVersionId?: string;
  roleWithinParent?: string;
  interactions?: string[];
}
export interface AgentRelation {
  id: string;
  from: string;
  to: string;
  kind: RelationKind;
  label?: string;
  evidence: AgentSourceRef[];
  structureProvenance: "snapshot-recorded";
}
export interface AgentSourceExcerpt {
  path: string;
  symbol?: string;
  language: SourceLanguage;
  startLine: number;
  endLine: number;
  highlightLine: number;
  frozenRevision: string;
  text: string;
  /** Capture bounds or the snapshot's original range indicate omitted source. */
  partial: boolean;
}
export type AgentQueryError = "invalid-cursor" | "entity-not-found" | "invalid-query";
export interface AgentSearchResult extends AgentSnapshotIdentity { items: AgentEntitySummary[]; nextCursor?: string; error?: AgentQueryError }
export interface AgentEntityResult extends AgentSnapshotIdentity { found: boolean; entity?: AgentEntityDetail }
export interface AgentRelationsResult extends AgentSnapshotIdentity { found: boolean; items: AgentRelation[]; nextCursor?: string; error?: AgentQueryError }
export interface AgentEvidenceResult extends AgentSnapshotIdentity {
  found: boolean;
  status: "captured" | "not-captured" | "no-source-reference" | "entity-not-found";
  scanCoverage: "unknown";
  error?: "invalid-query";
  sourceRefs: AgentSourceRef[];
  excerpts: AgentSourceExcerpt[];
  truncated: boolean;
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
const ENTITY_KINDS = new Set<EntityKind>(["person", "softwareSystem", "container", "component", "code", "externalSystem", "dataStore", "queue", "boundary"]);
const RELATION_KINDS = new Set<RelationKind>(["uses", "calls", "reads", "writes", "publishes", "subscribes", "contains", "dependsOn", "returns", "duplicates"]);

/** Snapshot prose and code are untrusted data. Strip known credential and host-path shapes. */
function publicText(value: string, maximum: number): string {
  // Redact before truncating so a token crossing the boundary cannot become a visible prefix.
  return value.slice(0, Math.max(maximum * 2, 8192))
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:or-v1-|proj-)?[A-Za-z0-9_-]{16,})/g, "[redacted-token]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}/gi, "$1 [redacted-token]")
    .replace(/((?:api[_-]?key|password|client[_-]?secret|access[_-]?token)["']?\s*[=:]\s*["']?)[^\s"',;]{4,}/gi, "$1[redacted]")
    .replace(/(?:\/(?:Users|home|private|var|tmp|etc|opt|usr|root|Applications|Volumes|System|Library)\/|[A-Za-z]:\\)[^\s"'`<>),;]+/g, "[redacted-host-path]")
    .slice(0, maximum);
}

/** Reuse the same bounded public-text projection for published atlas metadata. */
export const agentPublicText = publicText;

/** Relative POSIX repository paths only, including no traversal, credentials or URL schemes. */
export function agentRepositoryPath(value: string): string | undefined {
  if (!value || value.length > SOURCE_EXCERPT_LIMITS.maxPathCharacters || /[\\\u0000-\u001f\u007f?#:%]/.test(value)) return undefined;
  if (value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === "..")) return undefined;
  if (publicText(value, value.length) !== value) return undefined;
  return value;
}

function identifier(value: string): string | undefined {
  return value && value.length <= AGENT_QUERY_LIMITS.maxIdCharacters && !/[\u0000-\u001f\u007f]|(?:^|:)\/|[A-Za-z]:[\\/]/.test(value)
    && publicText(value, value.length) === value ? value : undefined;
}

function identity(snapshot: ArchitectureSnapshot): AgentSnapshotIdentity {
  return { snapshotId: identifier(snapshot.id) ?? "[redacted-snapshot-id]", commitSha: publicText(snapshot.commitSha, 128) };
}

function positiveLine(value: number | undefined): number | undefined {
  return Number.isSafeInteger(value) && value! > 0 ? value : undefined;
}

function sourceRef(ref: SourceRef): AgentSourceRef | undefined {
  const path = agentRepositoryPath(ref.path);
  if (!path) return undefined;
  const result: AgentSourceRef = { path, commitSha: publicText(ref.commitSha, 128) };
  if (ref.symbol) result.symbol = publicText(ref.symbol, SOURCE_EXCERPT_LIMITS.maxSymbolCharacters);
  const start = positiveLine(ref.startLine);
  const end = positiveLine(ref.endLine);
  if (start) result.startLine = start;
  if (start && end && end >= start) result.endLine = end;
  return result;
}

function sourceRefs(refs: readonly SourceRef[]): AgentSourceRef[] {
  return refs.map(sourceRef).filter((ref): ref is AgentSourceRef => Boolean(ref))
    .sort((a, b) => compare(a.path, b.path) || (a.startLine ?? 0) - (b.startLine ?? 0) || compare(JSON.stringify(a), JSON.stringify(b)))
    .slice(0, AGENT_QUERY_LIMITS.maxSourceRefs);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function proseList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    .slice(0, AGENT_QUERY_LIMITS.maxKeyPoints).map(item => publicText(item, AGENT_QUERY_LIMITS.maxKeyPointCharacters)) : [];
}

/** Only a public accepted row matching this graph entity can supplement snapshot structure. */
function understanding(snapshot: ArchitectureSnapshot, entityId: string, value: unknown, knownIds?: ReadonlySet<string>): AgentUnderstanding | undefined {
  const row = record(value);
  const explanation = record(row?.explanation);
  if (!row || row.entityId !== entityId || row.state !== "accepted" || !explanation || typeof explanation.summary !== "string" || !explanation.summary.trim()) return undefined;
  if (explanation.format !== undefined && explanation.format !== "v3") return undefined;
  const format = explanation.format === "v3" ? "v3" : "legacy";
  const entities = knownIds ?? new Set(snapshot.entities.map(entity => entity.id));
  const evidence: AgentUnderstandingEvidence[] = [];
  for (const item of Array.isArray(explanation.evidence) ? explanation.evidence : []) {
    const input = record(item);
    if (!input) continue;
    const reference: AgentUnderstandingEvidence = {};
    const id = typeof input.entityId === "string" ? identifier(input.entityId) : undefined;
    const path = typeof input.path === "string" ? agentRepositoryPath(input.path) : undefined;
    if (id && entities.has(id)) reference.entityId = id;
    if (path) reference.path = path;
    if (!reference.entityId && !reference.path) continue;
    if (typeof input.symbol === "string") reference.symbol = publicText(input.symbol, SOURCE_EXCERPT_LIMITS.maxSymbolCharacters);
    const start = typeof input.startLine === "number" ? positiveLine(input.startLine) : undefined;
    const end = typeof input.endLine === "number" ? positiveLine(input.endLine) : undefined;
    if (start) reference.startLine = start;
    if (start && end && end >= start) reference.endLine = end;
    evidence.push(reference);
    if (evidence.length >= AGENT_QUERY_LIMITS.maxSourceRefs) break;
  }
  const result: AgentUnderstanding = {
    format, summary: publicText(explanation.summary, AGENT_QUERY_LIMITS.maxExplanationCharacters),
    keyPoints: format === "v3" ? proseList(explanation.keyPoints) : [], evidence,
    state: "accepted", stale: typeof row.stale === "boolean" ? row.stale : "unknown",
    provenance: "published-explanation", origin: "origin-not-recorded",
  };
  const versionId = typeof row.explanationVersionId === "string" ? identifier(row.explanationVersionId) : undefined;
  if (versionId) result.explanationVersionId = versionId;
  if (format === "legacy") {
    if (typeof explanation.roleWithinParent === "string") result.roleWithinParent = publicText(explanation.roleWithinParent, AGENT_QUERY_LIMITS.maxKeyPointCharacters);
    if (Array.isArray(explanation.interactions)) result.interactions = proseList(explanation.interactions);
  }
  return result;
}

function entitySummary(entity: ArchitectureEntity): AgentEntitySummary | undefined {
  const id = identifier(entity.id);
  if (!id || !ENTITY_KINDS.has(entity.kind)) return undefined;
  const result: AgentEntitySummary = { id, kind: entity.kind, name: publicText(entity.name, AGENT_QUERY_LIMITS.maxNameCharacters), sourceRefs: sourceRefs(entity.sourceRefs), structureProvenance: "snapshot-recorded" };
  const parentId = entity.parentId ? identifier(entity.parentId) : undefined;
  if (parentId) result.parentId = parentId;
  return result;
}

function limit(value?: number): number {
  return value === undefined ? AGENT_QUERY_LIMITS.defaultLimit : Number.isFinite(value) ? Math.min(AGENT_QUERY_LIMITS.maxLimit, Math.max(1, Math.floor(value))) : AGENT_QUERY_LIMITS.defaultLimit;
}

// Cursors are continuation hints, never authorization. Bind them to immutable identity and query.
function cursorScope(snapshot: ArchitectureSnapshot, operation: string, subject: string, root = "", namespace = ""): string {
  const known = identity(snapshot);
  return JSON.stringify([known.snapshotId, known.commitSha, operation, subject, root, namespace]);
}
function offset(cursor: string | undefined, scope: string): number | undefined {
  if (!cursor) return 0;
  if (cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return undefined;
  try {
    const binary = atob(cursor.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== 2 || JSON.stringify(parsed[0]) !== scope || !Number.isSafeInteger(parsed[1]) || parsed[1] < 0) return undefined;
    return parsed[1] as number;
  } catch { return undefined; }
}
function page<T>(items: readonly T[], start: number, count: number, scope: string): { items: T[]; nextCursor?: string } {
  const result: { items: T[]; nextCursor?: string } = { items: items.slice(start, start + count) };
  if (start + count < items.length) {
    // Preserve the full scope exactly, without percent encoding or twice-escaped JSON strings.
    const bytes = new TextEncoder().encode(JSON.stringify([JSON.parse(scope) as unknown, start + count]));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    result.nextCursor = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  return result;
}

export function agentSearch(snapshot: ArchitectureSnapshot, options: { query: string; limit?: number; cursor?: string; rootEntityId?: string; explanations?: ReadonlyMap<string, unknown>; cursorNamespace?: string }): AgentSearchResult {
  const result: AgentSearchResult = { ...identity(snapshot), items: [] };
  if (typeof options.query !== "string" || options.query.length > AGENT_QUERY_LIMITS.maxQueryCharacters) return { ...result, error: "invalid-query" };
  const query = options.query.trim().toLowerCase();
  if (!query) return { ...result, error: "invalid-query" };
  if (options.cursorNamespace !== undefined && !identifier(options.cursorNamespace)) return { ...result, error: "invalid-cursor" };
  const root = options.rootEntityId;
  const included = new Set<string>();
  if (root) {
    if (!identifier(root) || !snapshot.entities.some(entity => entity.id === root)) return { ...result, error: "entity-not-found" };
    included.add(root);
    const children = new Map<string, string[]>();
    for (const entity of snapshot.entities) if (entity.parentId) {
      const siblings = children.get(entity.parentId);
      if (siblings) siblings.push(entity.id);
      else children.set(entity.parentId, [entity.id]);
    }
    const queue = [root];
    for (let position = 0; position < queue.length; position += 1) for (const child of children.get(queue[position]!) ?? []) if (!included.has(child)) { included.add(child); queue.push(child); }
  }
  const scope = cursorScope(snapshot, "search", query, root, options.cursorNamespace);
  const start = offset(options.cursor, scope);
  if (start === undefined) return { ...result, error: "invalid-cursor" };
  const words = query.split(/\s+/);
  const knownIds = options.explanations ? new Set(snapshot.entities.map(entity => entity.id)) : undefined;
  const ranked = snapshot.entities.filter(entity => !root || included.has(entity.id)).flatMap(entity => {
    const summary = entitySummary(entity);
    if (!summary) return [];
    const name = summary.name.toLowerCase();
    const paths = summary.sourceRefs.map(ref => ref.path.toLowerCase()).join(" ");
    const accepted = understanding(snapshot, entity.id, options.explanations?.get(entity.id), knownIds);
    const description = [publicText(entity.responsibility ?? "", AGENT_QUERY_LIMITS.maxExplanationCharacters), accepted?.summary ?? "", ...(accepted?.keyPoints ?? []), accepted?.roleWithinParent ?? "", ...(accepted?.interactions ?? [])].join(" ").toLowerCase();
    if (!words.every(word => `${name} ${paths} ${description}`.includes(word))) return [];
    const score = (name === query ? 100 : 0) + words.reduce((sum, word) => sum + (name.includes(word) ? 10 : 0) + (paths.includes(word) ? 5 : 0), 0);
    return [{ summary, score }];
  }).sort((a, b) => b.score - a.score || compare(a.summary.id, b.summary.id));
  return { ...result, ...page(ranked.map(row => row.summary), start, limit(options.limit), scope) };
}

export function agentEntity(snapshot: ArchitectureSnapshot, entityId: string, explanation?: unknown): AgentEntityResult {
  const result: AgentEntityResult = { ...identity(snapshot), found: false };
  const entity = snapshot.entities.find(candidate => candidate.id === entityId);
  const summary = entity ? entitySummary(entity) : undefined;
  if (!entity || !summary) return result;
  const detail: AgentEntityDetail = { ...summary, technology: (entity.technology ?? []).slice(0, AGENT_QUERY_LIMITS.maxTechnologyEntries).map(value => publicText(value, 128)), explanationProvenance: entity.responsibility?.trim() ? "origin-not-recorded" : "missing" };
  if (entity.responsibility?.trim()) detail.responsibility = publicText(entity.responsibility, AGENT_QUERY_LIMITS.maxExplanationCharacters);
  const accepted = understanding(snapshot, entityId, explanation);
  if (accepted) {
    detail.understanding = accepted;
    detail.explanationProvenance = "origin-not-recorded";
  }
  return { ...result, found: true, entity: detail };
}

function relationSummary(relation: ArchitectureRelation): AgentRelation | undefined {
  const id = identifier(relation.id); const from = identifier(relation.from); const to = identifier(relation.to);
  if (!id || !from || !to || !RELATION_KINDS.has(relation.kind)) return undefined;
  const result: AgentRelation = { id, from, to, kind: relation.kind, evidence: sourceRefs(relation.evidence.map(item => item.source)), structureProvenance: "snapshot-recorded" };
  if (relation.label) result.label = publicText(relation.label, 512);
  return result;
}

export function agentRelations(snapshot: ArchitectureSnapshot, options: { entityId: string; limit?: number; cursor?: string; cursorNamespace?: string }): AgentRelationsResult {
  const result: AgentRelationsResult = { ...identity(snapshot), found: false, items: [] };
  if (!identifier(options.entityId) || !snapshot.entities.some(entity => entity.id === options.entityId)) return { ...result, error: "entity-not-found" };
  result.found = true;
  if (options.cursorNamespace !== undefined && !identifier(options.cursorNamespace)) return { ...result, error: "invalid-cursor" };
  const scope = cursorScope(snapshot, "relations", options.entityId, "", options.cursorNamespace);
  const start = offset(options.cursor, scope);
  if (start === undefined) return { ...result, error: "invalid-cursor" };
  const items = snapshot.relations.filter(relation => relation.from === options.entityId || relation.to === options.entityId)
    .map(relationSummary).filter((relation): relation is AgentRelation => Boolean(relation)).sort((a, b) => compare(a.id, b.id));
  return { ...result, ...page(items, start, limit(options.limit), scope) };
}

function excerptSummary(excerpt: SourceExcerpt): AgentSourceExcerpt | undefined {
  const path = agentRepositoryPath(excerpt.path);
  const start = positiveLine(excerpt.startLine);
  if (!path || !start || !positiveLine(excerpt.endLine) || excerpt.endLine < start || !["typescript", "tsx", "javascript", "rust"].includes(excerpt.language) || excerpt.lines.some(line => /[\r\n]/.test(line))) return undefined;
  const lines: string[] = [];
  let characters = 0;
  let partial = excerpt.sourceStartLine !== undefined && excerpt.sourceStartLine !== start || excerpt.sourceEndLine !== undefined && excerpt.sourceEndLine !== excerpt.endLine;
  for (const line of excerpt.lines.slice(0, SOURCE_EXCERPT_LIMITS.maxLines)) {
    const clean = publicText(line, SOURCE_EXCERPT_LIMITS.maxLineCharacters);
    const remaining = SOURCE_EXCERPT_LIMITS.maxTextCharacters - characters - (lines.length ? 1 : 0);
    if (remaining <= 0) { partial = true; break; }
    lines.push(clean.slice(0, remaining));
    characters += lines[lines.length - 1]!.length + (lines.length > 1 ? 1 : 0);
    if (clean.length !== line.length || clean.length > remaining) partial = true;
  }
  if (!lines.length) return undefined;
  const end = Math.min(excerpt.endLine, start + lines.length - 1);
  partial ||= lines.length !== excerpt.lines.length || end !== excerpt.endLine;
  const result: AgentSourceExcerpt = { path, language: excerpt.language, startLine: start, endLine: end, highlightLine: Math.min(end, Math.max(start, positiveLine(excerpt.highlightLine) ?? start)), frozenRevision: publicText(excerpt.frozenRevision, 128), text: lines.join("\n"), partial };
  if (excerpt.symbol) result.symbol = publicText(excerpt.symbol, SOURCE_EXCERPT_LIMITS.maxSymbolCharacters);
  return result;
}

/** Select only captured source. A line outside these windows never triggers a source fetch. */
export function agentEvidence(snapshot: ArchitectureSnapshot, entityId: string, selection: { sourcePath?: string; sourceLine?: number } = {}): AgentEvidenceResult {
  const result: AgentEvidenceResult = { ...identity(snapshot), found: false, status: "entity-not-found", scanCoverage: "unknown", sourceRefs: [], excerpts: [], truncated: false };
  if (selection.sourcePath !== undefined && !agentRepositoryPath(selection.sourcePath)
    || selection.sourceLine !== undefined && !positiveLine(selection.sourceLine)) return { ...result, error: "invalid-query" };
  const entity = snapshot.entities.find(candidate => candidate.id === entityId);
  if (!entity || !identifier(entity.id)) return result;
  const refs = sourceRefs(entity.sourceRefs);
  const captured = (entity.sourceExcerpts ?? []).map(excerptSummary).filter((excerpt): excerpt is AgentSourceExcerpt => Boolean(excerpt))
    .sort((a, b) => compare(a.path, b.path) || a.startLine - b.startLine || compare(JSON.stringify(a), JSON.stringify(b)));
  const matching = captured.filter(excerpt => (selection.sourcePath === undefined || excerpt.path === selection.sourcePath)
    && (selection.sourceLine === undefined || excerpt.startLine <= selection.sourceLine && excerpt.endLine >= selection.sourceLine));
  const excerpts = matching.slice(0, AGENT_QUERY_LIMITS.maxExcerpts);
  return { ...result, found: true, status: excerpts.length ? "captured" : refs.length ? "not-captured" : "no-source-reference", sourceRefs: refs, excerpts,
    truncated: captured.length > excerpts.length || entity.sourceRefs.length > refs.length || (entity.sourceExcerpts ?? []).length > captured.length || excerpts.some(excerpt => excerpt.partial) };
}
