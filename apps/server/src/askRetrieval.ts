import { closeSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
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
  /**
   * Every indexed term, sorted (`[...postings.keys()].sort()`): an implicit trie for typo tolerance.
   * A prefix is a contiguous block, so fuzzy and prefix expansion walk only the blocks that can match.
   */
  vocab: string[];
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
  const vocab = [...postings.keys()].sort();
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
    vocab,
    systemTokens: systemNameKeys(entities.filter(entity => entity.kind === "softwareSystem" && typeof entity.name === "string").map(entity => entity.name as string)),
    containerNames,
  };
}

// ---------------------------------------------------------------------------
// Query

interface QueryTerm { token: string; expansions: readonly { term: string; weight: number }[] }

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

/** At most this many distinct query tokens are searched (first ones in question order); the rest are ignored. */
export const MAX_ASK_QUERY_TOKENS = 32;
/** Longer query tokens match exactly only (no typo or prefix expansion). */
export const MAX_ASK_FUZZY_TOKEN_CHARS = 40;
/** Expansions kept per query token. */
const MAX_TOKEN_EXPANSIONS = 24;
/** Memoised expansions per index (LRU). */
const EXPANSION_CACHE_ENTRIES = 4_096;
type Expansion = { term: string; weight: number };
const expansionCache = new WeakMap<AskIndex, Map<string, readonly Expansion[]>>();

/**
 * A query token's expansions: an exact hit is `[token, ...synonyms]`; otherwise typo matches (edit
 * distance ≤ fuzzyLimit, weight 0.6) ∪ prefix matches (tokens of 4+ chars, terms longer than
 * token + limit that start with it, weight 0.7) ∪ synonyms, deduped by the best weight, sorted by term,
 * first MAX_TOKEN_EXPANSIONS. Memoised per index, so repeated or hostile tokens cost one walk each.
 */
function expandToken(index: AskIndex, token: string): readonly Expansion[] {
  let cache = expansionCache.get(index);
  if (!cache) { cache = new Map(); expansionCache.set(index, cache); }
  const hit = cache.get(token);
  if (hit) { cache.delete(token); cache.set(token, hit); return hit; }
  const value = expandTokenUncached(index, token);
  cache.set(token, value);
  while (cache.size > EXPANSION_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  return value;
}

function expandTokenUncached(index: AskIndex, token: string): readonly Expansion[] {
  const synonyms = (ASK_SYNONYMS.get(token) ?? []).filter(term => term !== token && index.postings.has(term)).map(term => ({ term, weight: SYNONYM_DISCOUNT }));
  if (index.postings.has(token)) return [{ term: token, weight: 1 }, ...synonyms];
  const limit = fuzzyLimit(token.length);
  if (limit === 0 || token.length > MAX_ASK_FUZZY_TOKEN_CHARS) return synonyms;
  // The result is the MAX_TOKEN_EXPANSIONS smallest terms of the union, and fuzzy terms (length ≤
  // token + limit) and prefix terms (length > token + limit) are disjoint, so the first
  // MAX_TOKEN_EXPANSIONS of each source in sorted order are all that can survive the final slice.
  const out: Expansion[] = fuzzyVocabTerms(index.vocab, token, limit, MAX_TOKEN_EXPANSIONS).map(term => ({ term, weight: FUZZY_EDIT_DISCOUNT }));
  if (token.length >= 4) for (const term of prefixVocabTerms(index.vocab, token, token.length + limit, MAX_TOKEN_EXPANSIONS)) out.push({ term, weight: FUZZY_PREFIX_DISCOUNT });
  const best = new Map<string, number>();
  for (const { term, weight } of out) best.set(term, Math.max(best.get(term) ?? 0, weight));
  for (const { term, weight } of synonyms) best.set(term, Math.max(best.get(term) ?? 0, weight));
  // Code-unit order, the vocabulary's own order (identical to the old localeCompare on these [a-z0-9] terms).
  return [...best].map(([term, weight]) => ({ term, weight })).sort((left, right) => left.term < right.term ? -1 : left.term > right.term ? 1 : 0).slice(0, MAX_TOKEN_EXPANSIONS);
}

/**
 * Test seam: vocabulary work done by uncached expansions since load (trie nodes visited plus prefix-block
 * terms scanned; each node also costs one O(log vocab) child split). The pre-CLA-304 scan touched every
 * term of the vocabulary per token.
 */
let expansionWork = 0;
export function askExpansionWork(): number { return expansionWork; }

/** Test seam: the memoised expansion of one (stemmed) query token. */
export { expandToken as expandAskToken, tokenizeAskQuery as askQueryTokens };

/** First index in sorted `vocab[lo, hi)` whose term is ≥ `prefix`. */
function lowerBound(vocab: readonly string[], prefix: string, lo = 0, hi = vocab.length): number {
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (vocab[mid]! < prefix) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * Hard bound on terms skipped by the prefix walk. Skipped terms start with the token and are at most
 * `limit` (≤ 2) chars longer, so with a 36-char alphabet there are at most 1 + 36 + 36² = 1,333 of
 * them: the cap never binds, it only makes the bound explicit.
 */
const PREFIX_SCAN_CAP = 4_096;

/** Terms that start with `token` and are longer than `minExclusiveLength`, in sorted order, at most `max`. */
function prefixVocabTerms(vocab: readonly string[], token: string, minExclusiveLength: number, max: number): string[] {
  const out: string[] = [];
  let scanned = 0;
  for (let at = lowerBound(vocab, token); at < vocab.length && out.length < max && scanned < PREFIX_SCAN_CAP; at += 1) {
    const term = vocab[at]!;
    expansionWork += 1;
    if (!term.startsWith(token)) break;
    if (term.length > minExclusiveLength) out.push(term); else scanned += 1;
  }
  return out;
}

/**
 * Terms within Levenshtein distance `limit` of `token`, in sorted order, at most `max`: a walk over the
 * sorted vocabulary as an implicit trie. A node is the block of terms sharing a prefix of length
 * `depth`; its children are split by the character at `depth` (binary search). Each node carries only
 * the Ukkonen band of its DP row (columns |column − depth| ≤ limit; the rest are > limit anyway), so a
 * node costs O(limit), and a subtree is pruned once every band cell exceeds `limit`.
 */
function fuzzyVocabTerms(vocab: readonly string[], token: string, limit: number, max: number): string[] {
  const out: string[] = [];
  const width = 2 * limit + 1;
  const n = token.length;
  const far = limit + 1;
  // band[k] = distance(prefix of length depth, token[0, depth − limit + k)).
  const initial = new Array<number>(width);
  for (let k = 0; k < width; k += 1) { const column = k - limit; initial[k] = column >= 0 && column <= n ? column : far; }
  const walk = (lo: number, hi: number, depth: number, band: readonly number[]): void => {
    expansionWork += 1;
    let start = lo;
    if (vocab[lo]!.length === depth) {
      // The block's first term is the prefix itself.
      const k = n - depth + limit;
      if (k >= 0 && k < width && band[k]! <= limit) out.push(vocab[lo]!);
      start += 1;
    }
    if (depth >= n + limit) return;
    while (start < hi && out.length < max) {
      const char = vocab[start]![depth]!;
      const end = lowerBound(vocab, vocab[start]!.slice(0, depth) + String.fromCharCode(char.charCodeAt(0) + 1), start, hi);
      const next = new Array<number>(width);
      let best = far;
      for (let k = 0; k < width; k += 1) {
        const column = depth + 1 - limit + k;
        let value = far;
        if (column === 0) value = depth + 1;
        else if (column > 0 && column <= n) {
          const diagonal = band[k]! + (token[column - 1] === char ? 0 : 1);
          const up = k + 1 < width ? band[k + 1]! + 1 : far;
          const left = k > 0 ? next[k - 1]! + 1 : far;
          value = Math.min(diagonal, up, left, far);
        }
        next[k] = value;
        if (value < best) best = value;
      }
      if (best <= limit) walk(start, end, depth + 1, next);
      start = end;
    }
  };
  if (vocab.length) walk(0, vocab.length, 0, initial);
  return out;
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
  // A hostile question cannot multiply work: at most MAX_ASK_QUERY_TOKENS distinct tokens are searched.
  const rawTokens = tokenizeAskQuery(index, question).slice(0, MAX_ASK_QUERY_TOKENS);
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
/** ~3x this repo's 22 MB self-scan; bigger snapshots are never read (Ask answers scope-only). */
export const MAX_ASK_SNAPSHOT_BYTES = 64 * 1024 * 1024;
/** A larger `operator-explanations.json` sidecar is skipped (the index is built without explanations). */
export const MAX_ASK_SIDECAR_BYTES = 16 * 1024 * 1024;

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

/** A published snapshot Ask may search, located without reading it. */
export interface AskCorpusLocation {
  /** Cache key: the artifact revision, or the legacy file + mtime + size. */
  key: string;
  source: "publication" | "scan";
  snapshotPath: string;
  sidecarPath?: string;
  /** Snapshot bytes at locate time (always ≤ the snapshot cap). */
  size: number;
}

export interface AskCorpusLookup { slug?: string; owner: string; repo: string; commitSha: string }

export interface AskCorpusSource {
  /**
   * Candidate snapshots for an Ask atlas, in resolution order, deduplicated by key. Cheap and safe on the
   * request thread: publication metadata and `stat` only, never a snapshot read or parse. The commit is
   * verified where the snapshot is parsed (the Ask retrieval worker).
   */
  locate(input: AskCorpusLookup): AskCorpusLocation[];
}

/** The snapshot's commit equals the requested one, or one is a (7+ char) prefix of the other. */
export function commitMatches(snapshotSha: string, requested: string): boolean {
  if (!snapshotSha || !requested) return false;
  if (snapshotSha === requested) return true;
  const shorter = snapshotSha.length < requested.length ? snapshotSha : requested;
  const longer = shorter === snapshotSha ? requested : snapshotSha;
  return shorter.length >= 7 && longer.startsWith(shorter);
}

const boundedSize = (path: string, max: number): number | undefined => {
  const stat = statSync(path);
  return stat.isFile() && stat.size <= max ? stat.size : undefined;
};

/**
 * Locates the published snapshot for an Ask atlas the same way `/scan/*` resolves it: the current
 * operator publication for the slug (plus its `operator-explanations.json`), else the legacy scan-root
 * slot. Stat before read: an oversized snapshot is never located, so it is never read. A known
 * publication never falls back to mutable legacy bytes.
 */
export function createAskCorpusSource(options: {
  scanRoot: string;
  publications?: OperatorPublicationService;
  store?: OperatorStore;
  maxSnapshotBytes?: number;
  maxSidecarBytes?: number;
}): AskCorpusSource {
  const maxSnapshotBytes = options.maxSnapshotBytes ?? MAX_ASK_SNAPSHOT_BYTES;
  const maxSidecarBytes = options.maxSidecarBytes ?? MAX_ASK_SIDECAR_BYTES;
  const fromSlug = (slug: string, commitSha: string): AskCorpusLocation | undefined => {
    if (slug && options.publications && options.store) {
      // One operator-state read resolves the slug's current publication and its artifact revision.
      const current = options.publications.currentWithArtifactForSlug(slug);
      if (current) {
        const { publication, artifact } = current;
        // A publication whose artifact records its commit is only a candidate for that commit: a
        // wrong-commit request never reaches the worker, so it can never trigger a build.
        if (artifact?.sourceCommitSha && !commitMatches(artifact.sourceCommitSha, commitSha)) return undefined;
        const snapshotPath = options.store.artifactFilePath(publication.artifactRevisionId, "snapshot.json");
        const size = snapshotPath ? boundedSize(snapshotPath, maxSnapshotBytes) : undefined;
        if (!snapshotPath || size === undefined) return undefined;
        const sidecar = options.store.artifactFilePath(publication.artifactRevisionId, "operator-explanations.json");
        let sidecarPath: string | undefined;
        try { sidecarPath = sidecar && boundedSize(sidecar, maxSidecarBytes) !== undefined ? sidecar : undefined; } catch { sidecarPath = undefined; }
        return { key: `artifact:${publication.artifactRevisionId}`, source: "publication", snapshotPath, ...(sidecarPath ? { sidecarPath } : {}), size };
      }
    }
    const file = resolvePublishedScanFile(options.scanRoot, slug ? `/scan/${slug}/snapshot.json` : "/scan/snapshot.json");
    if (!file) return undefined;
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > maxSnapshotBytes) return undefined;
    return { key: `file:${file}:${stat.mtimeMs}:${stat.size}`, source: "scan", snapshotPath: file, size: stat.size };
  };
  return {
    locate(input) {
      // A slug must belong to the atlas identity: owner__repo (as the scanner slugs it), or the
      // scan-root slot ("") only for the THISS/okie self-scan stand-in.
      const ownSlug = parseGithubSource(`gh:${input.owner}/${input.repo}`)?.dirSlug.toLowerCase();
      const dogfood = `${input.owner}__${input.repo}`.toLowerCase() === DOGFOOD_SCAN_SLUG;
      const allowed = (slug: string) => slug === "" ? dogfood : slug.toLowerCase() === ownSlug;
      const candidates = input.slug !== undefined ? [input.slug] : [...new Set([ownSlug ?? "", ""])];
      const out: AskCorpusLocation[] = [];
      for (const slug of candidates) {
        if (sanitizeAskSlug(slug) === undefined || !allowed(slug)) continue;
        // A vanished or unreadable file means "no corpus" for this slug: Ask answers scope-only.
        let location: AskCorpusLocation | undefined;
        try { location = fromSlug(slug.toLowerCase(), input.commitSha); } catch { location = undefined; }
        if (location && !out.some(row => row.key === location.key)) out.push(location);
      }
      return out;
    },
  };
}

/** Reads a file only when it is at most `max` bytes (checked on the open descriptor). */
function readBoundedFile(path: string, max: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size > max) throw new Error("file exceeds the Ask size cap");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/** Parses a located snapshot (+ sidecar) and builds its index. Throws on any read/parse failure. */
export function loadAskIndex(location: Pick<AskCorpusLocation, "snapshotPath" | "sidecarPath">, limits: { maxSnapshotBytes?: number; maxSidecarBytes?: number } = {}): AskIndex {
  const snapshot = JSON.parse(readBoundedFile(location.snapshotPath, limits.maxSnapshotBytes ?? MAX_ASK_SNAPSHOT_BYTES).toString("utf8")) as unknown;
  let sidecar: unknown;
  // An unreadable or malformed sidecar only drops the explanations (same as before CLA-304).
  try { sidecar = location.sidecarPath ? JSON.parse(readBoundedFile(location.sidecarPath, limits.maxSidecarBytes ?? MAX_ASK_SIDECAR_BYTES).toString("utf8")) : undefined; } catch { sidecar = undefined; }
  return buildAskIndex(snapshot, sidecar);
}

/**
 * Built indexes, a small LRU keyed by location key (default 4). Lives in the Ask retrieval worker; the
 * request thread never holds one. Failures are not cached here: the coordinator keeps the negative cache.
 */
export function createAskIndexCache(options: { maxIndexes?: number; maxSnapshotBytes?: number; maxSidecarBytes?: number } = {}) {
  const maxIndexes = options.maxIndexes ?? 4;
  const cache = new Map<string, AskIndex>();
  let indexBuilds = 0;
  return {
    /** True when `key` is built (no LRU touch). */
    has: (key: string): boolean => cache.has(key),
    /** The cached index for `location.key`, else a fresh build (which throws on failure); `beforeBuild` runs just before one. */
    load(location: Pick<AskCorpusLocation, "key" | "snapshotPath" | "sidecarPath">, beforeBuild?: () => void): { index: AskIndex; built: boolean } {
      const hit = cache.get(location.key);
      if (hit) { cache.delete(location.key); cache.set(location.key, hit); return { index: hit, built: false }; }
      // Evict first so at most `maxIndexes` indexes are ever alive, even while the next one builds.
      while (cache.size >= maxIndexes) cache.delete(cache.keys().next().value!);
      beforeBuild?.();
      const index = loadAskIndex(location, options);
      indexBuilds += 1;
      cache.set(location.key, index);
      return { index, built: true };
    },
    keys: (): string[] => [...cache.keys()],
    stats: () => ({ indexBuilds }),
  };
}
export type AskIndexCache = ReturnType<typeof createAskIndexCache>;
