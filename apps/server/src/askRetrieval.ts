import { readFileSync, statSync } from "node:fs";
import { parseGithubSource, scrubGithubTokens } from "@okie/scan";
import { DOGFOOD_SCAN_SLUG, resolvePublishedScanFile } from "./scanObjects.js";
import type { OperatorPublicationService } from "./operatorPublication.js";
import type { OperatorStore } from "./operatorStore.js";

/**
 * Ask Atlas whole-atlas retrieval (CLA-265). Deterministic, lexical-first:
 * one document per snapshot entity (name, symbols, paths, parent chain,
 * captured responsibility, accepted v3 explanation, source excerpt text),
 * BM25F-style scoring with typo tolerance, then graph expansion (code → file →
 * container roll-up, 1-hop relation neighbours). The selected scope only gets a
 * modest boost: the whole atlas is always searched.
 */

export const DEFAULT_ASK_BYTE_BUDGET = 24_000;
export const MAX_ASK_SECTION_BYTES = 2_000;
export const MAX_ASK_SECTIONS = 40;
const MAX_SECTION_SYMBOLS = 3;
const EXCERPT_SYMBOLS = 2;
const MIN_RELATIVE_SCORE = 0.06;
/** The lead (depth) tier: a declaration body up to this many chars, in a section up to MAX_LEAD_SECTION_BYTES. */
const BODY_EXCERPT_CHARS = 2_200;
export const MAX_LEAD_SECTION_BYTES = 3_000;
const TAPERED_EXCERPT_CHARS = 500;
/** Leading sections that carry a declaration body under MAX_LEAD_SECTION_BYTES; the rest stay under MAX_ASK_SECTION_BYTES. */
export const FULL_EXCERPT_SECTIONS = 6;
const TAPERED_EXCERPT_SECTIONS = 16;
const SUMMARY_CHARS = 600;
const KEY_POINT_CHARS = 200;
const MAX_KEY_POINTS = 5;

type FieldName = "name" | "symbol" | "path" | "summary" | "parents" | "excerpt";
const FIELD_WEIGHTS: Readonly<Record<FieldName, number>> = { name: 3, symbol: 3, path: 2, summary: 1.5, parents: 0.3, excerpt: 0.6 };
/** Length normalisation per field: short identity fields barely normalise; prose and code do. */
const FIELD_B: Readonly<Record<FieldName, number>> = { name: 0.3, symbol: 0.3, path: 0.3, summary: 0.6, parents: 0.2, excerpt: 0.75 };
const FIELDS = Object.keys(FIELD_WEIGHTS) as FieldName[];
const BM25_K1 = 1.2;
const FUZZY_EDIT_DISCOUNT = 0.6;
const FUZZY_PREFIX_DISCOUNT = 0.7;
const SELECTED_BOOST = 1.2;
const CHILD_ROLLUP = 1;
const CHILD_ROLLUP_REST = 0.1;
const CONTAINER_ROLLUP = 0.2;
const DEPENDENCY_DECAY = 0.9;
const DEPENDENT_DECAY = 0.9;
const NEIGHBOUR_SEEDS = 30;
const MAX_NEIGHBOURS = 64;
const DIVERSITY_DECAY = 0.95;

const STOPWORDS = new Set([
  "a", "about", "after", "all", "also", "an", "and", "any", "are", "as", "at", "be", "been", "before", "being", "but", "by",
  "can", "could", "did", "do", "does", "doing", "done", "each", "for", "from", "get", "gets", "had", "has", "have", "how",
  "i", "if", "in", "into", "is", "it", "its", "just", "me", "my", "no", "not", "of", "on", "or", "our", "out", "over",
  "should", "so", "some", "tell", "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "those",
  "to", "up", "us", "was", "way", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why", "will",
  "with", "would", "you", "your", "explain", "work", "works", "happen", "happens", "use", "used", "uses", "using",
  "between", "during", "via", "through", "until", "after", "become", "becomes", "became", "happened", "want", "need", "does", "okay", "please", "actually", "exactly", "really",
  // Path / language noise.
  "src", "ts", "tsx", "js", "mjs", "cjs", "rs", "json", "lib", "dist",
]);

export interface AskIndexDocument {
  id: string;
  name: string;
  kind: string;
  parentId?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  symbols: string[];
  summary?: string;
  keyPoints?: string[];
  excerpt?: { startLine: number; lines: string[] };
}

export interface AskIndex {
  /** Snapshot commit the index was built from; Ask verifies it against the atlas identity. */
  commitSha: string;
  documents: AskIndexDocument[];
  byId: Map<string, number>;
  children: Map<number, number[]>;
  /** Document index of each document's file (a code declaration's nearest non-code ancestor; else itself). */
  fileOf: number[];
  /** Cross-file relation graph per document: what it uses… */
  dependencies: Map<number, number[]>;
  /** …and what uses it. */
  dependents: Map<number, number[]>;
  /** term → postings of [docIndex, BM25F-normalised weighted tf]. */
  postings: Map<string, Array<[number, number]>>;
  /** Stemmed vocabulary bucketed by length for typo tolerance. */
  vocabByLength: Map<number, string[]>;
  /** Whole system names (joined, stemmed); a query token naming one refers to the whole atlas. */
  systemTokens: Set<string>;
  containerNames: string[];
}

export interface AskSection {
  id: string;
  name: string;
  kind: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  parentId?: string;
  summary?: string;
  keyPoints?: string[];
  excerpt?: string;
  /** First source line of `excerpt` (the excerpt is windowed around matching lines). */
  excerptStartLine?: number;
  /** Matching declarations folded into this file's section (citable ids). */
  symbols?: Array<{ id: string; name: string; startLine?: number; endLine?: number }>;
  score: number;
}

export interface AskRetrieval {
  sections: AskSection[];
  bytes: number;
  /** Query terms that matched the atlas (after stopwords / system-name folding). */
  matchedTerms: string[];
  /** True when the question only named the system itself (e.g. "What is Okie?"). */
  systemOnly: boolean;
}

// ---------------------------------------------------------------------------
// Tokenizer

/**
 * Splits camelCase / snake / kebab / paths / dots, lowercases, drops stopwords, stems lightly.
 * `compounds` (index side) also emits the joined form of a split identifier chunk ("GitHub" → git,
 * hub, github) so it meets the same word written in lowercase elsewhere ("githubClient").
 */
export function tokenizeAskText(text: string, options: { compounds?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const chunk of text.split(/[^A-Za-z0-9]+/)) {
    if (!chunk) continue;
    const parts = splitChunk(chunk);
    for (const part of parts) pushToken(out, part);
    if (options.compounds && parts.length > 1 && chunk.length <= 16) pushToken(out, chunk.toLowerCase());
  }
  return out;
}

function splitChunk(chunk: string): string[] {
  return chunk
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
}

function pushToken(out: string[], raw: string): void {
  if (raw.length < 2 || /^\d+$/.test(raw) || STOPWORDS.has(raw)) return;
  const stemmed = stemAskToken(raw);
  if (stemmed.length >= 2 && !STOPWORDS.has(stemmed)) out.push(stemmed);
}

/**
 * Query tokens: a split identifier chunk whose joined form the atlas knows is kept whole, and two
 * adjacent words the atlas writes as one identifier ("fall back" → `fallback`) are joined.
 */
function tokenizeAskQuery(index: AskIndex, question: string): string[] {
  const out: string[] = [];
  const chunks = question.split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (let position = 0; position < chunks.length; position += 1) {
    const chunk = chunks[position]!;
    const next = chunks[position + 1];
    if (next && !STOPWORDS.has(chunk.toLowerCase()) && !STOPWORDS.has(next.toLowerCase())) {
      const pair = `${chunk}${next}`.toLowerCase();
      if (pair.length >= 6 && index.postings.has(stemAskToken(pair))) {
        pushToken(out, pair);
        for (const part of [...splitChunk(chunk), ...splitChunk(next)]) pushToken(out, part);
        position += 1;
        continue;
      }
    }
    const parts = splitChunk(chunk);
    const joined = stemAskToken(chunk.toLowerCase());
    if (parts.length > 1 && index.postings.has(joined)) { pushToken(out, chunk.toLowerCase()); continue; }
    for (const part of parts) pushToken(out, part);
  }
  return [...new Set(out)];
}

/**
 * Light suffix stemming: plural, -ing, -ed, -er, then a trailing -e — repeated to a fixed point so
 * every form of a word lands on one stem (render / renderer / renderers / rendering). Applied to
 * index and query alike.
 */
export function stemAskToken(token: string): string {
  let word = token;
  for (let pass = 0; pass < 4; pass += 1) {
    const next = stemOnce(word);
    if (next === word) break;
    word = next;
  }
  return word;
}

function stemOnce(token: string): string {
  let word = token;
  if (word.length > 4 && word.endsWith("ies")) word = `${word.slice(0, -3)}y`;
  else if (word.length > 4 && word.endsWith("sses")) word = word.slice(0, -2);
  else if (word.length > 3 && word.endsWith("s") && !/(ss|us|is)$/.test(word)) word = word.slice(0, -1);
  let suffixed = false;
  if (word.length > 5 && word.endsWith("ing")) { word = word.slice(0, -3); suffixed = true; }
  else if (word.length > 4 && word.endsWith("ed")) { word = word.slice(0, -2); suffixed = true; }
  else if (word.length > 5 && word.endsWith("er")) { word = word.slice(0, -2); suffixed = true; }
  // scanning → scan, mapped → map (but keep "fall", "pass").
  if (suffixed && word.length > 3 && /([b-df-hj-km-np-rtv-z])\1$/.test(word) && !/(ll|ss|zz)$/.test(word)) word = word.slice(0, -1);
  if (word.length > 4 && word.endsWith("e")) word = word.slice(0, -1);
  return word;
}

/** Levenshtein distance with an early exit once `max` is exceeded. */
export function boundedEditDistance(left: string, right: string, max: number): number {
  if (Math.abs(left.length - right.length) > max) return max + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let best = row;
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      const value = Math.min(previous[column]! + 1, current[column - 1]! + 1, previous[column - 1]! + cost);
      current.push(value);
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[right.length]!;
}

function fuzzyLimit(length: number): number {
  if (length >= 7) return 2;
  if (length >= 3) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Index

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const EMPTY_SUMMARY = "No summary supplied.";

/**
 * Accepted explanations from an `operator-explanations.json` sidecar, keyed by scope id. Mirrors
 * `readArtifactScopes`: a row is accepted when it exists, its scope's recorded state (if any) is
 * `accepted`, and neither the row nor the scope is stale. v3 rows contribute summary + key points; legacy rows contribute their summary only.
 */
export function acceptedAskExplanations(sidecar: unknown): Map<string, { summary?: string; keyPoints: string[] }> {
  const out = new Map<string, { summary?: string; keyPoints: string[] }>();
  if (!record(sidecar)) return out;
  const states = new Map<string, unknown>();
  const stale = new Set<unknown>(Array.isArray(sidecar.staleScopes) ? sidecar.staleScopes : []);
  for (const scope of Array.isArray(sidecar.scopes) ? sidecar.scopes : []) {
    if (!record(scope) || typeof scope.scopeId !== "string") continue;
    states.set(scope.scopeId, scope.state);
    if (scope.stale) stale.add(scope.scopeId);
  }
  for (const row of Array.isArray(sidecar.explanations) ? sidecar.explanations : []) {
    if (!record(row) || typeof row.scopeId !== "string") continue;
    const state = states.get(row.scopeId);
    if (state !== undefined && state !== "accepted") continue;
    // A stale explanation describes an older state of the code (same rule as readArtifactScopes).
    if (row.stale || stale.has(row.scopeId)) continue;
    const content = row.content ?? row.explanation;
    if (!record(content)) continue;
    const summary = text(content.summary);
    const keyPoints = content.format === "v3" && Array.isArray(content.keyPoints)
      ? content.keyPoints.map(text).filter((point): point is string => Boolean(point))
      : [];
    if (!summary && keyPoints.length === 0) continue;
    out.set(row.scopeId, { ...(summary ? { summary } : {}), keyPoints });
  }
  return out;
}

/** The atlas's own name(s), whole: "Okie" → okie, "acme-core" → acmecore (never its parts). */
function systemNameKeys(names: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const name of names) {
    const joined = name.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (joined.length >= 3) keys.add(stemAskToken(joined));
  }
  return keys;
}

/** Builds the retrieval index for one snapshot (+ optional explanations sidecar). Pure and deterministic. */
export function buildAskIndex(snapshot: unknown, explanationsSidecar?: unknown): AskIndex {
  const root = record(snapshot) ? snapshot : {};
  const entities = (Array.isArray(root.entities) ? root.entities : [])
    .filter((entity): entity is Record<string, unknown> & { id: string; kind: string } => record(entity) && typeof entity.id === "string" && typeof entity.kind === "string");
  const relations = (Array.isArray(root.relations) ? root.relations : [])
    .filter((relation): relation is Record<string, unknown> & { from: string; to: string } => record(relation) && typeof relation.from === "string" && typeof relation.to === "string");
  const explanations = acceptedAskExplanations(explanationsSidecar);
  const byEntityId = new Map(entities.map(entity => [entity.id, entity]));

  const documents: AskIndexDocument[] = [];
  const fieldTokens: Array<Record<FieldName, string[]>> = [];
  for (const entity of entities) {
    const refs = (Array.isArray(entity.sourceRefs) ? entity.sourceRefs : []).filter(record);
    const primary = refs[0];
    const paths = [...new Set(refs.map(ref => text(ref.path)).filter((path): path is string => Boolean(path)))];
    const symbols = [...new Set(refs.map(ref => text(ref.symbol)).filter((symbol): symbol is string => Boolean(symbol)))];
    const name = text(entity.name) ?? entity.id;
    const responsibility = text(entity.responsibility);
    const explanation = explanations.get(entity.id);
    const summary = explanation?.summary ?? (responsibility && responsibility !== EMPTY_SUMMARY ? responsibility : undefined);
    const excerpts = (Array.isArray(entity.sourceExcerpts) ? entity.sourceExcerpts : []).filter(record);
    const firstExcerpt = excerpts.find(row => typeof row.text === "string" || Array.isArray(row.lines));
    const excerptLines = firstExcerpt
      ? (Array.isArray(firstExcerpt.lines) ? firstExcerpt.lines.filter((line): line is string => typeof line === "string") : String(firstExcerpt.text ?? "").split("\n"))
      : [];
    const excerptStart = firstExcerpt && typeof firstExcerpt.startLine === "number" ? firstExcerpt.startLine : 1;
    for (const excerpt of excerpts) if (typeof excerpt.symbol === "string" && excerpt.symbol.trim() && !symbols.includes(excerpt.symbol.trim())) symbols.push(excerpt.symbol.trim());
    const parents: string[] = [];
    const seen = new Set([entity.id]);
    let cursor = typeof entity.parentId === "string" ? byEntityId.get(entity.parentId) : undefined;
    while (cursor && !seen.has(cursor.id) && parents.length < 6) {
      seen.add(cursor.id);
      if (typeof cursor.name === "string") parents.push(cursor.name);
      cursor = typeof cursor.parentId === "string" ? byEntityId.get(cursor.parentId) : undefined;
    }
    const doc: AskIndexDocument = {
      id: entity.id,
      name,
      kind: entity.kind,
      ...(typeof entity.parentId === "string" ? { parentId: entity.parentId } : {}),
      ...(paths[0] ? { path: paths[0] } : {}),
      ...(primary && typeof primary.startLine === "number" ? { startLine: primary.startLine } : {}),
      ...(primary && typeof primary.endLine === "number" ? { endLine: primary.endLine } : {}),
      symbols,
      ...(summary ? { summary } : {}),
      ...(explanation?.keyPoints.length ? { keyPoints: explanation.keyPoints } : {}),
      ...(excerptLines.length ? { excerpt: { startLine: excerptStart, lines: excerptLines } } : {}),
    };
    // Captured responsibility and the accepted explanation both describe the entity; index both.
    const described = [summary, responsibility && responsibility !== summary && responsibility !== EMPTY_SUMMARY ? responsibility : undefined, ...(explanation?.keyPoints ?? [])].filter(Boolean).join("\n");
    documents.push(doc);
    fieldTokens.push({
      name: tokenizeAskText(name, { compounds: true }),
      symbol: tokenizeAskText(symbols.join(" "), { compounds: true }),
      path: tokenizeAskText(paths.join(" "), { compounds: true }),
      summary: tokenizeAskText(described, { compounds: true }),
      parents: tokenizeAskText(parents.join(" "), { compounds: true }),
      excerpt: tokenizeAskText(excerptLines.join("\n"), { compounds: true }),
    });
  }

  const byId = new Map(documents.map((doc, index) => [doc.id, index]));
  const children = new Map<number, number[]>();
  documents.forEach((doc, index) => {
    const parent = doc.parentId !== undefined ? byId.get(doc.parentId) : undefined;
    if (parent === undefined) return;
    const list = children.get(parent);
    if (list) list.push(index); else children.set(parent, [index]);
  });
  const fileOf = documents.map((_, docIndex) => {
    let cursor = docIndex;
    for (let depth = 0; depth < 8; depth += 1) {
      const doc = documents[cursor]!;
      if (doc.kind !== "code") return cursor;
      const parent = doc.parentId !== undefined ? byId.get(doc.parentId) : undefined;
      if (parent === undefined) return cursor;
      cursor = parent;
    }
    return cursor;
  });
  // Stable order so the per-file neighbour cap keeps the same neighbours whatever the input order.
  const orderedRelations = [...relations].sort((left, right) => `${left.from}\u0000${left.to}\u0000${String(left.id ?? "")}`.localeCompare(`${right.from}\u0000${right.to}\u0000${String(right.id ?? "")}`));
  const outgoing = new Map<number, Set<number>>();
  const incoming = new Map<number, Set<number>>();
  const link = (sets: Map<number, Set<number>>, left: number, right: number) => {
    const set = sets.get(left) ?? new Set<number>();
    if (set.size < MAX_NEIGHBOURS) set.add(right);
    sets.set(left, set);
  };
  for (const relation of orderedRelations) {
    if (relation.kind === "duplicates" || relation.kind === "contains") continue;
    const fromDoc = byId.get(relation.from);
    const toDoc = byId.get(relation.to);
    if (fromDoc === undefined || toDoc === undefined) continue;
    // Declaration-level edges, but only across files: a hit lifts the FILE its neighbour lives in.
    if (fileOf[fromDoc] === fileOf[toDoc]) continue;
    link(outgoing, fromDoc, toDoc);
    link(incoming, toDoc, fromDoc);
  }
  const sortedLists = (sets: Map<number, Set<number>>) => new Map([...sets].map(([key, set]) => [key, [...set].sort((left, right) => left - right)]));
  const dependencies = sortedLists(outgoing);
  const dependents = sortedLists(incoming);

  const averages = Object.fromEntries(FIELDS.map(field => {
    const total = fieldTokens.reduce((sum, tokens) => sum + tokens[field].length, 0);
    return [field, Math.max(1, total / Math.max(1, fieldTokens.length))];
  })) as Record<FieldName, number>;
  const postings = new Map<string, Array<[number, number]>>();
  fieldTokens.forEach((tokens, docIndex) => {
    const weighted = new Map<string, number>();
    for (const field of FIELDS) {
      const list = tokens[field];
      if (!list.length) continue;
      const counts = new Map<string, number>();
      for (const token of list) counts.set(token, (counts.get(token) ?? 0) + 1);
      const norm = 1 - FIELD_B[field] + FIELD_B[field] * (list.length / averages[field]);
      for (const [token, count] of counts) weighted.set(token, (weighted.get(token) ?? 0) + FIELD_WEIGHTS[field] * count / norm);
    }
    for (const [token, value] of weighted) {
      const list = postings.get(token);
      if (list) list.push([docIndex, value]); else postings.set(token, [[docIndex, value]]);
    }
  });
  const vocabByLength = new Map<number, string[]>();
  for (const term of [...postings.keys()].sort()) {
    const list = vocabByLength.get(term.length);
    if (list) list.push(term); else vocabByLength.set(term.length, [term]);
  }
  const containerNames = documents.filter(doc => doc.kind === "container").map(doc => doc.name).sort((left, right) => left.localeCompare(right));
  return {
    commitSha: typeof root.commitSha === "string" ? root.commitSha : "",
    documents,
    byId,
    children,
    fileOf,
    dependencies,
    dependents,
    postings,
    vocabByLength,
    systemTokens: systemNameKeys(entities.filter(entity => entity.kind === "softwareSystem" && typeof entity.name === "string").map(entity => entity.name as string)),
    containerNames,
  };
}

// ---------------------------------------------------------------------------
// Query

interface QueryTerm { token: string; expansions: Array<{ term: string; weight: number }> }

/**
 * A deliberately small software-vocabulary bridge (stemmed forms) for words people ask with that
 * code rarely spells out: "sign in" is `auth`/`oauth`/`session`, "choose" is `select`/`fallback`.
 */
const ASK_SYNONYM_WORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  // Authentication vocabulary.
  ["sign", ["auth", "oauth", "login", "session"]],
  ["signin", ["auth", "oauth", "login", "session"]],
  ["login", ["auth", "oauth", "session", "signin"]],
  ["auth", ["oauth", "login", "session"]],
  ["authenticate", ["auth", "oauth", "login"]],
  ["authorize", ["auth", "access", "permission"]],
  ["permission", ["access", "authorize"]],
  // Choice verbs.
  ["choose", ["select", "pick"]],
  ["pick", ["select", "choose"]],
  ["select", ["choose", "pick"]],
  // Money.
  ["spend", ["cost", "budget"]],
  ["cost", ["spend", "budget"]],
  ["money", ["cost", "budget", "spend"]],
  // Short forms.
  ["repo", ["repository"]],
  ["repository", ["repo"]],
];
const ASK_SYNONYMS: ReadonlyMap<string, readonly string[]> = new Map(
  ASK_SYNONYM_WORDS.map(([word, synonyms]) => [stemAskToken(word), synonyms.map(stemAskToken)] as const),
);
const SYNONYM_DISCOUNT = 0.5;

function expandToken(index: AskIndex, token: string): Array<{ term: string; weight: number }> {
  const synonyms = (ASK_SYNONYMS.get(token) ?? []).filter(term => term !== token && index.postings.has(term)).map(term => ({ term, weight: SYNONYM_DISCOUNT }));
  if (index.postings.has(token)) return [{ term: token, weight: 1 }, ...synonyms];
  const limit = fuzzyLimit(token.length);
  if (limit === 0) return synonyms;
  const out: Array<{ term: string; weight: number }> = [];
  for (let length = token.length - limit; length <= token.length + limit; length += 1) {
    for (const term of index.vocabByLength.get(length) ?? []) {
      if (boundedEditDistance(token, term, limit) <= limit) out.push({ term, weight: FUZZY_EDIT_DISCOUNT });
    }
  }
  if (token.length >= 4) {
    for (const [length, terms] of index.vocabByLength) {
      if (length <= token.length + limit) continue;
      for (const term of terms) if (term.startsWith(token)) out.push({ term, weight: FUZZY_PREFIX_DISCOUNT });
    }
  }
  const best = new Map<string, number>();
  for (const { term, weight } of out) best.set(term, Math.max(best.get(term) ?? 0, weight));
  for (const { term, weight } of synonyms) best.set(term, Math.max(best.get(term) ?? 0, weight));
  return [...best].map(([term, weight]) => ({ term, weight })).sort((left, right) => left.term.localeCompare(right.term)).slice(0, 24);
}

/**
 * True when a query token names the atlas itself: the WHOLE system/repo name exactly, or — only for a
 * token that is not itself a word in the index — a near-miss spelling: within one edit for names of
 * 5+ characters, a truncation ("oki" → okie) for shorter names. Parts of a multi-word name ("core" in
 * acme-core) and real indexed words ("code" vs repo core, "span" vs repo scan) are never folded.
 */
function namesSystem(index: AskIndex, systemNames: ReadonlySet<string>, token: string): boolean {
  if (token.length < 3) return false;
  const indexed = index.postings.has(token);
  for (const name of systemNames) {
    if (token === name) return true;
    if (indexed) continue;
    if (name.length >= 5 ? boundedEditDistance(token, name, 1) <= 1 : token.length === name.length - 1 && name.startsWith(token)) return true;
  }
  return false;
}

function idf(index: AskIndex, term: string): number {
  const df = index.postings.get(term)?.length ?? 0;
  const n = index.documents.length;
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

function lexicalScores(index: AskIndex, terms: readonly QueryTerm[]): Map<number, number> {
  const scores = new Map<number, number>();
  const matched = new Map<number, number>();
  for (const query of terms) {
    const best = new Map<number, number>();
    for (const { term, weight } of query.expansions) {
      const termIdf = idf(index, term);
      for (const [doc, tf] of index.postings.get(term) ?? []) {
        const value = weight * termIdf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1);
        if (value > (best.get(doc) ?? 0)) best.set(doc, value);
      }
    }
    for (const [doc, value] of best) {
      scores.set(doc, (scores.get(doc) ?? 0) + value);
      matched.set(doc, (matched.get(doc) ?? 0) + 1);
    }
  }
  // Coordination: a document matching more of the question's distinct terms outranks a one-term hit.
  if (terms.length > 1) for (const [doc, value] of scores) scores.set(doc, value * (0.5 + 0.5 * (matched.get(doc) ?? 0) / terms.length));
  return scores;
}

export interface AskRetrieveOptions {
  selectedIds?: readonly string[];
  /** Extra whole names for the atlas (e.g. the GitHub repo name) that fold like the system name. */
  systemNames?: readonly string[];
  byteBudget?: number;
}

/** Ranks the whole atlas for `question` and packs the top sections into `byteBudget`. Deterministic. */
export function retrieveAskSections(index: AskIndex, question: string, options: AskRetrieveOptions = {}): AskRetrieval {
  const byteBudget = Math.max(0, options.byteBudget ?? DEFAULT_ASK_BYTE_BUDGET);
  const rawTokens = tokenizeAskQuery(index, question);
  const systemNames = new Set([...index.systemTokens, ...systemNameKeys(options.systemNames ?? [])]);
  const systemNamed = rawTokens.filter(token => namesSystem(index, systemNames, token));
  const contentTokens = rawTokens.filter(token => !systemNamed.includes(token));
  const terms: QueryTerm[] = contentTokens
    .map(token => ({ token, expansions: expandToken(index, token) }))
    .filter(term => term.expansions.length > 0);
  const systemOnly = terms.length === 0 && systemNamed.length > 0;

  const base = lexicalScores(index, terms);
  if (systemOnly) {
    index.documents.forEach((doc, docIndex) => {
      if (doc.kind === "softwareSystem") base.set(docIndex, 1);
      else if (doc.kind === "container") base.set(docIndex, 0.5);
    });
  }
  const selected = new Set<number>();
  for (const id of options.selectedIds ?? []) { const docIndex = index.byId.get(id); if (docIndex !== undefined) selected.add(docIndex); }
  for (const docIndex of selected) { const value = base.get(docIndex); if (value) base.set(docIndex, value * SELECTED_BOOST); }

  // Roll-up: files from their code children, containers from their files.
  const scores = new Map(base);
  const rollUp = (docIndex: number, factor: number, restFactor: number) => {
    const childScores = (index.children.get(docIndex) ?? []).map(child => scores.get(child) ?? 0).filter(value => value > 0).sort((left, right) => right - left);
    if (!childScores.length) return;
    const rest = childScores.slice(1, 6).reduce((sum, value) => sum + value, 0);
    scores.set(docIndex, (scores.get(docIndex) ?? 0) + factor * childScores[0]! + restFactor * rest);
  };
  index.documents.forEach((doc, docIndex) => { if (doc.kind === "component") rollUp(docIndex, CHILD_ROLLUP, CHILD_ROLLUP_REST); });
  index.documents.forEach((doc, docIndex) => { if (doc.kind === "container") rollUp(docIndex, CONTAINER_ROLLUP, 0); });

  // One section per file: declarations fold into their file's section (top symbols' excerpts), so
  // many small code hits cannot crowd distinct files out of the budget. A file's score already
  // carries its children's roll-up; a declaration with no file stands alone.
  const groupScores = new Map<number, number>();
  const groupSymbols = new Map<number, number[]>();
  for (const [docIndex, score] of scores) {
    if (score <= 0) continue;
    const group = index.fileOf[docIndex]!;
    if (group === docIndex) groupScores.set(docIndex, score);
    else if ((base.get(docIndex) ?? 0) > 0) {
      const list = groupSymbols.get(group) ?? [];
      list.push(docIndex);
      groupSymbols.set(group, list);
    }
  }
  for (const group of groupSymbols.keys()) if (!groupScores.has(group)) groupScores.set(group, 0);

  // Graph expansion: the strongest matching declarations/files lift the FILES of their 1-hop
  // neighbours by a decayed share, spread over the seed's degree (PageRank-style) so a hub does not
  // lift everything it touches. Max over seeds, never summed.
  const seeds = rankOrder(base, index).filter(docIndex => index.documents[docIndex]!.kind !== "container" && index.documents[docIndex]!.kind !== "softwareSystem").slice(0, NEIGHBOUR_SEEDS);
  const lift = new Map<number, number>();
  for (const seed of seeds) {
    const score = base.get(seed) ?? 0;
    // What a match uses is usually part of the mechanism; what uses it, its context.
    for (const [neighbours, decay] of [[index.dependencies.get(seed), DEPENDENCY_DECAY], [index.dependents.get(seed), DEPENDENT_DECAY]] as const) {
      if (!neighbours?.length) continue;
      const value = score * decay / Math.sqrt(neighbours.length);
      for (const neighbour of neighbours) {
        const file = index.fileOf[neighbour]!;
        if (file === index.fileOf[seed]) continue;
        if (value > (lift.get(file) ?? 0)) lift.set(file, value);
      }
    }
  }
  for (const [docIndex, value] of lift) groupScores.set(docIndex, (groupScores.get(docIndex) ?? 0) + value);

  // Soft diversity: each further file from the same container is discounted, so a cross-cutting
  // question is not answered from one container's near-duplicates alone.
  const containerOf = (docIndex: number): string => {
    let cursor: AskIndexDocument | undefined = index.documents[docIndex];
    for (let depth = 0; cursor && depth < 8; depth += 1) {
      if (cursor.kind === "container" || !cursor.parentId) return cursor.id;
      const parent = index.byId.get(cursor.parentId);
      cursor = parent === undefined ? undefined : index.documents[parent];
    }
    return "";
  };
  const perContainer = new Map<string, number>();
  for (const docIndex of rankOrder(groupScores, index)) {
    const container = containerOf(docIndex);
    const seen = perContainer.get(container) ?? 0;
    perContainer.set(container, seen + 1);
    groupScores.set(docIndex, groupScores.get(docIndex)! * DIVERSITY_DECAY ** seen);
  }

  const matchTerms = new Set(terms.flatMap(term => term.expansions.map(expansion => expansion.term)));
  const ranked = rankOrder(groupScores, index);
  const top = ranked.length ? groupScores.get(ranked[0]!) ?? 0 : 0;
  const sections: AskSection[] = [];
  let bytes = 0;
  for (const docIndex of ranked) {
    if (sections.length >= MAX_ASK_SECTIONS) break;
    const score = groupScores.get(docIndex) ?? 0;
    if (score <= 0 || score < top * MIN_RELATIVE_SCORE) break;
    const doc = index.documents[docIndex]!;
    if (doc.kind === "softwareSystem" && !systemOnly && !selected.has(docIndex)) continue;
    const symbols = rankSymbols(index, groupSymbols.get(docIndex) ?? [], base, matchTerms);
    // Depth for the leading files (the best declaration's body from its first line), breadth
    // after: short windows around matching lines, then path + summary + symbol names only.
    const tier: ExcerptTier = sections.length < FULL_EXCERPT_SECTIONS ? "body" : sections.length < TAPERED_EXCERPT_SECTIONS ? "window" : "none";
    const section = sectionFor(doc, score, matchTerms, symbols, tier);
    const size = Buffer.byteLength(JSON.stringify(section));
    if (bytes + size > byteBudget) {
      if (byteBudget - bytes < 200) break;
      continue;
    }
    sections.push(section);
    bytes += size;
  }
  return { sections, bytes, matchedTerms: [...new Set(terms.map(term => term.token))].sort(), systemOnly };
}

function rankOrder(scores: ReadonlyMap<number, number>, index: AskIndex): number[] {
  return [...scores.keys()]
    .filter(docIndex => (scores.get(docIndex) ?? 0) > 0)
    .sort((left, right) => (scores.get(right)! - scores.get(left)!) || index.documents[left]!.id.localeCompare(index.documents[right]!.id));
}

const clip = (value: string, max: number) => {
  const clean = scrubGithubTokens(value);
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

type ExcerptTier = "body" | "window" | "none";

/**
 * Order a file's matching declarations: a NAME that matches the question beats a body that merely
 * mentions a term; then the file's primary (same-named) declaration; then more matching body
 * tokens; then lexical score; then id (deterministic).
 */
function rankSymbols(index: AskIndex, members: readonly number[], base: ReadonlyMap<number, number>, matchTerms: ReadonlySet<string>): AskIndexDocument[] {
  const facts = new Map(members.map(member => {
    const doc = index.documents[member]!;
    const nameHits = new Set(tokenizeAskText(doc.name, { compounds: true }).filter(token => matchTerms.has(token))).size;
    const bodyHits = doc.excerpt ? tokenizeAskText(doc.excerpt.lines.join("\n")).filter(token => matchTerms.has(token)).length : 0;
    // The declaration named after its file (createRenderer in createRenderer.ts) is the file's primary one.
    const stem = doc.path?.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "";
    const primary = stem && tokenizeAskText(doc.name).join(" ") === tokenizeAskText(stem).join(" ") ? 1 : 0;
    return [member, { nameHits, primary, bodyHits }] as const;
  }));
  return [...members]
    .sort((left, right) => (facts.get(right)!.nameHits - facts.get(left)!.nameHits)
      || (facts.get(right)!.primary - facts.get(left)!.primary)
      || (facts.get(right)!.bodyHits - facts.get(left)!.bodyHits)
      || ((base.get(right) ?? 0) - (base.get(left) ?? 0))
      || index.documents[left]!.id.localeCompare(index.documents[right]!.id))
    .map(member => index.documents[member]!);
}

function sectionFor(doc: AskIndexDocument, score: number, matchTerms: ReadonlySet<string>, symbols: readonly AskIndexDocument[] = [], tier: ExcerptTier = "body"): AskSection {
  const cap = tier === "body" ? MAX_LEAD_SECTION_BYTES : MAX_ASK_SECTION_BYTES;
  const section: AskSection = {
    id: doc.id,
    name: clip(doc.name, 200),
    kind: doc.kind,
    ...(doc.path ? { path: clip(doc.path, 300) } : {}),
    ...(doc.startLine !== undefined ? { startLine: doc.startLine } : {}),
    ...(doc.endLine !== undefined ? { endLine: doc.endLine } : {}),
    ...(doc.parentId ? { parentId: doc.parentId } : {}),
    ...(doc.summary ? { summary: clip(doc.summary, SUMMARY_CHARS) } : {}),
    ...(doc.keyPoints?.length ? { keyPoints: doc.keyPoints.slice(0, MAX_KEY_POINTS).map(point => clip(point, KEY_POINT_CHARS)) } : {}),
    ...(symbols.length ? {
      symbols: symbols.slice(0, MAX_SECTION_SYMBOLS).map(symbol => ({
        id: symbol.id,
        name: clip(symbol.name, 120),
        ...(symbol.startLine !== undefined ? { startLine: symbol.startLine } : {}),
        ...(symbol.endLine !== undefined ? { endLine: symbol.endLine } : {}),
      })),
    } : {}),
    score: Math.round(score * 1000) / 1000,
  };
  const fits = (candidate: AskSection) => Buffer.byteLength(JSON.stringify(candidate)) <= cap;
  // Enforce the per-section cap even before any excerpt: fewer symbols, fewer key points, shorter prose.
  if (!fits(section) && section.symbols) section.symbols = section.symbols.slice(0, 1);
  if (!fits(section) && section.keyPoints) section.keyPoints = section.keyPoints.slice(0, 2);
  if (!fits(section) && section.summary) section.summary = clip(section.summary, 240);
  if (!fits(section)) { delete section.keyPoints; delete section.symbols; }
  if (!fits(section)) { section.name = clip(section.name, 80); if (section.path) section.path = clip(section.path, 120); delete section.summary; }
  if (tier === "none") return section;
  const withExcerpt = symbols.filter(symbol => symbol.excerpt);
  if (tier === "body") {
    // The best declaration's body from its first line, as much as the lead cap allows.
    const lead = doc.excerpt ? { excerpt: doc.excerpt, label: undefined as string | undefined } : withExcerpt[0] ? { excerpt: withExcerpt[0].excerpt!, label: withExcerpt[0].name } : undefined;
    if (!lead) return section;
    for (let budget = BODY_EXCERPT_CHARS; budget >= 160; budget = Math.floor(budget * 0.85)) {
      const body = excerptFromStart(lead.excerpt, budget);
      const text = lead.label ? `// ${lead.label} (from line ${body.startLine})\n${body.text}` : body.text;
      const candidate: AskSection = { ...section, excerpt: text, excerptStartLine: body.startLine };
      if (fits(candidate)) return candidate;
    }
    return section;
  }
  // The file's own excerpt, else windows from its best-matching declarations (up to two).
  const sources = doc.excerpt
    ? [{ excerpt: doc.excerpt, label: undefined as string | undefined }]
    : withExcerpt.slice(0, EXCERPT_SYMBOLS).map(symbol => ({ excerpt: symbol.excerpt!, label: symbol.name }));
  for (let budget = TAPERED_EXCERPT_CHARS; sources.length && budget >= 160; budget = Math.floor(budget * 0.7)) {
    const each = Math.floor(budget / sources.length);
    const windows = sources.map(source => ({ ...excerptWindow(source.excerpt, matchTerms, each), label: source.label }));
    const text = windows.map(window => window.label ? `// ${window.label} (from line ${window.startLine})\n${window.text}` : window.text).join("\n\n");
    const candidate: AskSection = { ...section, excerpt: text, excerptStartLine: windows[0]!.startLine };
    if (fits(candidate)) return candidate;
  }
  return section;
}

/** Leading lines of an excerpt (a declaration's signature and body) up to `maxChars`. */
function excerptFromStart(excerpt: { startLine: number; lines: string[] }, maxChars: number): { text: string; startLine: number } {
  const out: string[] = [];
  let size = 0;
  for (const raw of excerpt.lines) {
    const line = raw.length > 240 ? `${raw.slice(0, 239)}…` : raw;
    if (out.length && size + line.length + 1 > maxChars) break;
    out.push(line);
    size += line.length + 1;
  }
  return { text: scrubGithubTokens(out.join("\n")), startLine: excerpt.startLine };
}

/** Window of excerpt lines centred on the line with the most matching query terms (first wins). */
function excerptWindow(excerpt: { startLine: number; lines: string[] }, matchTerms: ReadonlySet<string>, maxChars: number): { text: string; startLine: number } {
  const lines = excerpt.lines.map(line => line.length > 240 ? `${line.slice(0, 239)}…` : line);
  let center = 0;
  let best = 0;
  lines.forEach((line, lineIndex) => {
    const hits = tokenizeAskText(line).filter(token => matchTerms.has(token)).length;
    if (hits > best) { best = hits; center = lineIndex; }
  });
  let start = center;
  let end = center;
  let size = lines[center]?.length ?? 0;
  for (;;) {
    const before = start > 0 ? lines[start - 1]!.length + 1 : Infinity;
    const after = end < lines.length - 1 ? lines[end + 1]!.length + 1 : Infinity;
    const grow = Math.min(before, after);
    if (grow === Infinity || size + grow > maxChars) break;
    if (before <= after) start -= 1; else end += 1;
    size += grow;
  }
  return { text: scrubGithubTokens(lines.slice(start, end + 1).join("\n")), startLine: excerpt.startLine + start };
}

/** Name/kind/path/lines for an id the index knows. */
export function askCitationDetail(index: AskIndex | undefined, id: string): { id: string; name: string; kind: string; path?: string; startLine?: number; endLine?: number } | undefined {
  const docIndex = index?.byId.get(id);
  if (docIndex === undefined) return undefined;
  const doc = index!.documents[docIndex]!;
  return {
    id: doc.id,
    name: doc.name,
    kind: doc.kind,
    ...(doc.path ? { path: doc.path } : {}),
    ...(doc.startLine !== undefined ? { startLine: doc.startLine } : {}),
    ...(doc.endLine !== undefined ? { endLine: doc.endLine } : {}),
  };
}

// ---------------------------------------------------------------------------
// Corpus resolution

const SLUG = /^[A-Za-z0-9._-]{0,200}$/;
/** ~3x this repo's 22 MB self-scan; bigger snapshots are not parsed synchronously on the request path. */
export const MAX_ASK_SNAPSHOT_BYTES = 64 * 1024 * 1024;

/** Route slug / `scanRepo` (owner__repo) / "" for the scan root. `undefined` when malformed. */
export function sanitizeAskSlug(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const slug = raw.trim();
  if (!SLUG.test(slug) || slug.includes("..") || slug.startsWith(".")) return undefined;
  return slug;
}

export interface AskCorpus {
  index: AskIndex;
  /** Where the corpus came from; never a filesystem path. */
  source: "publication" | "scan";
}

export interface AskCorpusSource {
  resolve(input: { slug?: string; owner: string; repo: string; commitSha: string }): AskCorpus | undefined;
  stats(): { indexBuilds: number };
}

function commitMatches(snapshotSha: string, requested: string): boolean {
  if (!snapshotSha || !requested) return false;
  if (snapshotSha === requested) return true;
  const shorter = snapshotSha.length < requested.length ? snapshotSha : requested;
  const longer = shorter === snapshotSha ? requested : snapshotSha;
  return shorter.length >= 7 && longer.startsWith(shorter);
}

/**
 * Resolves the published snapshot for an Ask atlas the same way `/scan/*` does: the current operator
 * publication for the slug (plus its `operator-explanations.json`), else the legacy scan-root slot.
 * Built indexes are cached (small LRU keyed by artifact revision or file + mtime).
 */
export function createAskCorpusSource(options: {
  scanRoot: string;
  publications?: OperatorPublicationService;
  store?: OperatorStore;
  maxIndexes?: number;
  /** Larger snapshots are not parsed on the request path; Ask answers scope-only instead. */
  maxSnapshotBytes?: number;
}): AskCorpusSource {
  const maxIndexes = options.maxIndexes ?? 4;
  const maxSnapshotBytes = options.maxSnapshotBytes ?? MAX_ASK_SNAPSHOT_BYTES;
  const cache = new Map<string, AskIndex | null>();
  let indexBuilds = 0;
  const cached = (key: string, build: () => AskIndex | undefined): AskIndex | undefined => {
    if (cache.has(key)) {
      const hit = cache.get(key)!;
      cache.delete(key);
      cache.set(key, hit);
      return hit ?? undefined;
    }
    let built: AskIndex | undefined;
    try { built = build(); } catch { built = undefined; }
    if (built) indexBuilds += 1;
    cache.set(key, built ?? null);
    while (cache.size > maxIndexes) cache.delete(cache.keys().next().value!);
    return built;
  };
  const fromSlug = (slug: string): AskCorpus | undefined => {
    if (slug && options.publications && options.store) {
      const repositoryId = options.publications.repositoryIdForSlug(slug);
      const publication = repositoryId ? options.publications.currentPublication(repositoryId) : undefined;
      if (repositoryId && publication) {
        const store = options.store;
        const index = cached(`artifact:${publication.artifactRevisionId}`, () => {
          const bytes = store.readArtifactFile(publication.artifactRevisionId, "snapshot.json");
          if (!bytes || bytes.length > maxSnapshotBytes) return undefined;
          const explanations = store.readArtifactFile(publication.artifactRevisionId, "operator-explanations.json");
          let sidecar: unknown;
          try { sidecar = explanations ? JSON.parse(explanations.toString("utf8")) : undefined; } catch { sidecar = undefined; }
          return buildAskIndex(JSON.parse(bytes.toString("utf8")), sidecar);
        });
        // A known publication never falls back to mutable legacy bytes.
        return index ? { index, source: "publication" } : undefined;
      }
    }
    const file = resolvePublishedScanFile(options.scanRoot, slug ? `/scan/${slug}/snapshot.json` : "/scan/snapshot.json");
    if (!file) return undefined;
    const stat = statSync(file);
    const index = cached(`file:${file}:${stat.mtimeMs}:${stat.size}`, () => stat.size > maxSnapshotBytes ? undefined : buildAskIndex(JSON.parse(readFileSync(file, "utf8"))));
    return index ? { index, source: "scan" } : undefined;
  };
  return {
    resolve(input) {
      // A slug must belong to the atlas identity: owner__repo (as the scanner slugs it), or the
      // scan-root slot ("") only for the THISS/okie self-scan stand-in.
      const ownSlug = parseGithubSource(`gh:${input.owner}/${input.repo}`)?.dirSlug.toLowerCase();
      const dogfood = `${input.owner}__${input.repo}`.toLowerCase() === DOGFOOD_SCAN_SLUG;
      const allowed = (slug: string) => slug === "" ? dogfood : slug.toLowerCase() === ownSlug;
      const candidates = input.slug !== undefined ? [input.slug] : [...new Set([ownSlug ?? "", ""])];
      for (const slug of candidates) {
        if (sanitizeAskSlug(slug) === undefined || !allowed(slug)) continue;
        // Any read/parse/build failure (corrupt, oversized, vanished file) means "no corpus": Ask
        // answers scope-only rather than failing the request. Failures are cached per key too.
        let corpus: AskCorpus | undefined;
        try { corpus = fromSlug(slug.toLowerCase()); } catch { corpus = undefined; }
        if (corpus && commitMatches(corpus.index.commitSha, input.commitSha)) return corpus;
      }
      return undefined;
    },
    stats: () => ({ indexBuilds }),
  };
}
