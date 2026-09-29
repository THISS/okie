import type { ArchitectureEntity, ArchitectureRelation, ArchitectureSnapshot } from "@okie/architecture";
import { belowEnrichmentCap, type OperatorEnrichmentCap } from "./operatorContracts.js";

/**
 * CLA-271 phase 1: a pure graph diff between two deterministic snapshots of one repository, and the
 * scopes an incremental run must re-enrich. No I/O. Entity identity is the scanner's stable id
 * (path/symbol-derived, never commit-derived); relations are compared by (from, to, kind), never by
 * their collision-numbered ids.
 *
 * - changed: excerpt text, signature, exposure (exports), or tags/technology/name/kind/parent differ.
 *   `surface` = signature or exports changed; everything else is `internal`.
 * - moved: identical content, only line positions differ.
 * - dirty (re-enrich): changed and added entities, both endpoints of every added/removed relation, the
 *   parents of removed entities, the 1-hop consumers of a changed exported surface (incoming dependency
 *   edges into the entity or its module, in the new graph; plus the old graph for removed exports), then
 *   every ancestor up to the system. Below-cap (code) entities map to their nearest in-cap ancestor.
 * - stale (claim re-check, no re-enrichment): the in-cap scope of a consumer whose dependency changed
 *   only internally (incoming dependency edges into the entity or its module, as for surface changes), and of a moved-only entity (its evidence line refs moved), when not already dirty.
 * - removed: every previous entity id that no longer exists (any kind).
 * - reused: every other in-cap scope of the new snapshot. dirty, stale and reused partition the in-cap scopes.
 */
export type ImpactChangeClass = "surface" | "internal";
/**
 * Why a scope is stale without re-enrichment: a dependency changed internally (claim re-check), its evidence lines moved,
 * or (below-cap scopes only, which the pass never re-enriches) its own source or relations changed.
 */
export type ImpactStaleReason = "dependency-internal" | "moved" | "changed";
export interface ImpactEntityRef { id: string; kind: string; name: string; }
export interface ImpactEntityChange extends ImpactEntityRef { change: ImpactChangeClass; }
export interface ImpactRelationKey { from: string; to: string; kind: string; }
/** An export that disappeared (entity removed, or its exposure dropped), with its consumers in the previous graph. */
export interface ImpactRemovedExport extends ImpactEntityRef { consumers: string[]; }
export interface IncrementalDiff {
  added: ImpactEntityRef[];
  removed: ImpactEntityRef[];
  changed: ImpactEntityChange[];
  moved: ImpactEntityRef[];
  relationsAdded: ImpactRelationKey[];
  relationsRemoved: ImpactRelationKey[];
  removedExports: ImpactRemovedExport[];
}
export interface IncrementalImpact {
  cap: OperatorEnrichmentCap;
  diff: IncrementalDiff;
  /** In-cap scopes whose own prompt input changed (before the ancestor closure): the incremental run's retry selection. */
  seeds: string[];
  dirty: string[];
  stale: Array<{ scopeId: string; reason: ImpactStaleReason }>;
  removed: string[];
  reused: string[];
  /**
   * Below-cap scopes the pass never re-enriches but whose explanation (if any) the diff invalidates: moved (`moved`);
   * changed, added/removed relation endpoints, consumers of a surface change or of a removed export (`changed`);
   * consumers of an internal change (`dependency-internal`). Sorted by scope id.
   */
  belowCap: Array<{ scopeId: string; reason: ImpactStaleReason }>;
}

const EXPORT_KINDS = new Set(["moduleExport", "publicApi", "entryPoint"]);
/** Structural edges never make one entity a consumer of another. */
const NON_DEPENDENCY = new Set(["contains", "duplicates"]);
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const sorted = (values: Iterable<string>) => [...new Set(values)].sort(compare);
const ref = (entity: ArchitectureEntity): ImpactEntityRef => ({ id: entity.id, kind: entity.kind, name: entity.name });

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();
/** Leading comment, doc, attribute and decorator lines before a declaration. */
const PREAMBLE = /^\s*(?:$|\/\/|\/\*|\*|#!?\[|@)/;
const TS_FUNCTION = /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\b/;
const RUST_FUNCTION = /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:(?:const|async|unsafe|default|extern(?:\s+"[^"]*")?)\s+)*fn\s/;
const TS_FUNCTION_VALUE = /^(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]*)?=\s*(?:async\s+)?(?:function\b|\(|<)/;
const METHOD = /^(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set|declare)\s+)*\*?(?!(?:if|for|while|switch|return|catch|new|typeof|await|yield)\b)[\w$#]+\??\s*[<(]/;
/** Tokens after which a `{` opens a type (object type), not a body. A `,` is not one: a Rust `where …,` ends right before the body. */
const TYPE_POSITION = /(?:[:|&([?]|[^=]=|\bextends|\bkeyof|\breadonly|\bimpl|\bdyn)$/;

/**
 * End of one function declaration head in `text` from `from`: the body `{` at bracket and angle depth 0 after the
 * parameter list closes (a `{` right after a type-position token such as `:` or `|` is an object return type; inside a
 * Rust `where` clause every depth-0 `{` is the body), or a `;` there (an overload or a bodiless trait method).
 * `<`/`>` are tracked throughout (never the `>` of `=>` or `->`), so `Promise<{ … }>` stays a type.
 * Undefined when no parameter list or no block body is found (an expression-bodied arrow).
 */
function functionHeadEnd(text: string, rust: boolean, from = 0): { end: number; terminator: "{" | ";" } | undefined {
  let depth = 0; let angle = 0; let paramsOpened = false; let paramsClosed = false; let whereClause = false;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]!; const next = text[index + 1];
    if (char === "/" && next === "/") { const newline = text.indexOf("\n", index); if (newline < 0) return undefined; index = newline; continue; }
    if (char === "/" && next === "*") { const close = text.indexOf("*/", index + 2); if (close < 0) return undefined; index = close + 1; continue; }
    if (char === "\"" || char === "`" || (char === "'" && (!rust || /^'(?:\\.|[^\\'])'/.test(text.slice(index, index + 4))))) {
      let cursor = index + 1; while (cursor < text.length && text[cursor] !== char) cursor += text[cursor] === "\\" ? 2 : 1;
      index = cursor; continue;
    }
    if (char === "<") { angle += 1; continue; }
    if (char === ">") { if (angle > 0 && text[index - 1] !== "=" && text[index - 1] !== "-") angle -= 1; continue; }
    if (rust && char === "e" && paramsClosed && depth === 0 && angle === 0 && text.slice(index - 4, index + 1) === "where" && !/\w/.test(text[index - 5] ?? "") && !/\w/.test(next ?? "")) { whereClause = true; continue; }
    if (char === "(" || char === "[" || char === "{") {
      if (char === "(" && depth === 0 && angle === 0 && !paramsOpened) paramsOpened = true;
      else if (char === "{" && depth === 0 && angle === 0 && paramsClosed && (whereClause || !TYPE_POSITION.test(text.slice(from, index).trimEnd()))) return { end: index + 1, terminator: "{" };
      depth += 1; continue;
    }
    if (char === ")" || char === "]" || char === "}") { depth = Math.max(0, depth - 1); if (depth === 0 && paramsOpened && char === ")") paramsClosed = true; continue; }
    if (char === ";" && depth === 0 && angle === 0 && paramsClosed) return { end: index + 1, terminator: ";" };
  }
  return undefined;
}
const isFunctionStart = (head: string) => RUST_FUNCTION.test(head) || TS_FUNCTION.test(head) || TS_FUNCTION_VALUE.test(head) || METHOD.test(head);
/**
 * Every declaration head of a function excerpt: overload signatures (`…;`) are followed by the next declaration until
 * the implementation's body `{`, so a change to any overload is a surface change. Undefined: compare the whole text.
 */
function functionHeads(text: string, rust: boolean): string | undefined {
  const heads: string[] = []; let from = 0;
  for (;;) {
    const found = functionHeadEnd(text, rust, from);
    if (!found) return undefined;
    heads.push(text.slice(from, found.end));
    if (found.terminator === "{") return heads.join("\n");
    const rest = text.slice(found.end); const skipped = rest.length - rest.trimStart().length;
    if (!isFunctionStart(rest.trimStart())) return heads.join("\n");
    from = found.end + skipped;
  }
}

/**
 * The exported surface of a code entity's declaration, compared across the diff (a changed signature is a `surface`
 * change; anything else is `internal`). Deterministic and text-only (the scan records no symbol kind):
 * - a function (TS `function`, a `const f = (…) =>`/`function` value, a class method, a Rust `fn`): its declaration
 *   head from the first code line through the body `{` at bracket and angle depth 0 after the parameter list closes —
 *   so a generic `<T extends {…}>`, multi-line parameters, a return type on later lines and a Rust `where` clause are all
 *   surface, the body is not; every overload signature before the implementation counts;
 * - anything else (interface, type alias, enum, class, struct, trait, impl, object literal, expression-bodied arrow):
 *   the whole excerpt text, since every member is surface;
 * - a non-code entity: undefined. Its surface is its exposure (see exportsKey) and its code children's signatures.
 * Limitation: excerpts are capped at 48 lines, so a change below the cap is invisible to the diff.
 */
export function entitySignature(entity: ArchitectureEntity): string | undefined {
  if (entity.kind !== "code") return undefined;
  const text = entity.sourceExcerpts?.[0]?.text;
  if (text === undefined) return undefined;
  const lines = text.split("\n"); let first = 0;
  while (first < lines.length - 1 && PREAMBLE.test(lines[first]!)) first += 1;
  const declaration = lines.slice(first).join("\n"); const head = declaration.trimStart();
  const rust = RUST_FUNCTION.test(head) || /\.rs$/.test(entity.sourceExcerpts?.[0]?.path ?? "");
  const heads = isFunctionStart(head) ? functionHeads(declaration, rust) : undefined;
  return collapse(lines.slice(0, first).join("\n") + "\n" + (heads ?? declaration));
}
/** Export kinds with their declaring path and reason; lines and commit are position, not surface. */
function exportsKey(entity: ArchitectureEntity | undefined): string {
  return JSON.stringify(sorted((entity?.exposure ?? []).map(item => `${item.kind}|${item.evidence.source.path}|${item.evidence.reason ?? ""}`)));
}
function exportKinds(entity: ArchitectureEntity | undefined): Set<string> { return new Set((entity?.exposure ?? []).map(item => item.kind).filter(kind => EXPORT_KINDS.has(kind))); }
function contentKey(entity: ArchitectureEntity): string {
  return JSON.stringify({ name: entity.name, kind: entity.kind, parentId: entity.parentId ?? null, tags: entity.tags ?? null, technology: entity.technology ?? null, exports: exportsKey(entity), excerpts: (entity.sourceExcerpts ?? []).map(excerpt => excerpt.text), paths: entity.sourceRefs.map(item => item.path) });
}
function positionKey(entity: ArchitectureEntity): string {
  return JSON.stringify({ refs: entity.sourceRefs.map(item => [item.startLine ?? null, item.endLine ?? null]), excerpts: (entity.sourceExcerpts ?? []).map(excerpt => [excerpt.startLine, excerpt.endLine, excerpt.sourceStartLine ?? null, excerpt.sourceEndLine ?? null, excerpt.highlightLine]), exposure: (entity.exposure ?? []).map(item => [item.evidence.source.startLine ?? null, item.evidence.source.endLine ?? null]) });
}
const relationKey = (relation: Pick<ArchitectureRelation, "from" | "to" | "kind">) => `${relation.from}\u0000${relation.to}\u0000${relation.kind}`;
const keyToRelation = (key: string): ImpactRelationKey => { const [from, to, kind] = key.split("\u0000") as [string, string, string]; return { from, to, kind }; };

/** Sources of incoming dependency edges into any of `targets` (self-edges excluded). */
function consumersOf(relations: readonly ArchitectureRelation[], targets: ReadonlySet<string>): string[] {
  return relations.filter(relation => !NON_DEPENDENCY.has(relation.kind) && targets.has(relation.to) && !targets.has(relation.from)).map(relation => relation.from);
}
/** An entity and, for a code symbol, its module (the import target of the file that declares it). */
function surfaceTargets(entity: ArchitectureEntity): Set<string> { return new Set([entity.id, ...(entity.kind === "code" && entity.parentId ? [entity.parentId] : [])]); }

export function computeIncrementalImpact(input: { previous: ArchitectureSnapshot; next: ArchitectureSnapshot; cap: OperatorEnrichmentCap }): IncrementalImpact {
  const { previous, next, cap } = input;
  const before = new Map(previous.entities.map(entity => [entity.id, entity]));
  const after = new Map(next.entities.map(entity => [entity.id, entity]));
  const inCap = (entity: ArchitectureEntity) => !belowEnrichmentCap(entity.kind, cap);
  /** Nearest in-cap entity of the new snapshot at or above `id`; a removed entity walks up its previous parents. */
  const capScope = (id: string): string | undefined => {
    const seen = new Set<string>(); let cursor: string | undefined = id;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const current = after.get(cursor);
      if (current && inCap(current)) return cursor;
      cursor = (current ?? before.get(cursor))?.parentId;
    }
    return undefined;
  };

  const added = next.entities.filter(entity => !before.has(entity.id));
  const removed = previous.entities.filter(entity => !after.has(entity.id));
  const changed: ImpactEntityChange[] = []; const moved: ImpactEntityRef[] = [];
  const reparented: string[] = [];
  for (const entity of next.entities) {
    const prior = before.get(entity.id);
    if (!prior) continue;
    if (contentKey(prior) !== contentKey(entity)) {
      const surface = entitySignature(prior) !== entitySignature(entity) || exportsKey(prior) !== exportsKey(entity);
      changed.push({ ...ref(entity), change: surface ? "surface" : "internal" });
      if ((prior.parentId ?? "") !== (entity.parentId ?? "") && prior.parentId) reparented.push(prior.parentId);
    } else if (positionKey(prior) !== positionKey(entity)) moved.push(ref(entity));
  }
  const beforeRelations = new Set(previous.relations.map(relationKey)); const afterRelations = new Set(next.relations.map(relationKey));
  const relationsAdded = sorted([...afterRelations].filter(key => !beforeRelations.has(key)));
  const relationsRemoved = sorted([...beforeRelations].filter(key => !afterRelations.has(key)));

  // Exports that disappeared: a removed entity that exported something, or a kept entity that lost an export kind.
  const removedExports: ImpactRemovedExport[] = [];
  for (const entity of previous.entities) {
    const lost = [...exportKinds(entity)].filter(kind => !exportKinds(after.get(entity.id)).has(kind));
    if (!lost.length) continue;
    removedExports.push({ ...ref(entity), consumers: sorted(consumersOf(previous.relations, surfaceTargets(entity))) });
  }

  const seedIds: string[] = [];
  seedIds.push(...added.map(entity => entity.id), ...removed.map(entity => entity.id), ...changed.map(entity => entity.id), ...reparented);
  for (const key of [...relationsAdded, ...relationsRemoved]) { const { from, to } = keyToRelation(key); seedIds.push(from, to); }
  for (const change of changed.filter(item => item.change === "surface")) seedIds.push(...consumersOf(next.relations, surfaceTargets(after.get(change.id)!)));
  for (const lost of removedExports) seedIds.push(...lost.consumers);
  const seeds = sorted(seedIds.map(capScope).filter((id): id is string => id !== undefined));

  const dirtySet = new Set<string>();
  for (const seed of seeds) { let cursor: string | undefined = seed; while (cursor && !dirtySet.has(cursor)) { dirtySet.add(cursor); cursor = after.get(cursor)?.parentId; } }

  const staleReasons = new Map<string, ImpactStaleReason>();
  const markStale = (id: string | undefined, reason: ImpactStaleReason) => { if (id && !dirtySet.has(id) && !staleReasons.has(id)) staleReasons.set(id, reason); };
  for (const change of changed.filter(item => item.change === "internal")) for (const consumer of sorted(consumersOf(next.relations, surfaceTargets(after.get(change.id)!)))) markStale(capScope(consumer), "dependency-internal");
  for (const entity of moved) markStale(capScope(entity.id), "moved");

  const belowCapReasons = new Map<string, ImpactStaleReason>();
  const below = (id: string) => { const entity = after.get(id); return entity !== undefined && !inCap(entity); };
  const markBelow = (id: string, reason: ImpactStaleReason) => {
    if (!below(id)) return;
    const current = belowCapReasons.get(id);
    // "changed" wins over "moved"/"dependency-internal": the scope's own input changed.
    if (!current || (reason === "changed" && current !== "changed")) belowCapReasons.set(id, reason);
  };
  for (const entity of moved) markBelow(entity.id, "moved");
  for (const change of changed) markBelow(change.id, "changed");
  for (const key of [...relationsAdded, ...relationsRemoved]) { const { from, to } = keyToRelation(key); markBelow(from, "changed"); markBelow(to, "changed"); }
  for (const lost of removedExports) for (const consumer of lost.consumers) markBelow(consumer, "changed");
  for (const change of changed) for (const consumer of consumersOf(next.relations, surfaceTargets(after.get(change.id)!))) markBelow(consumer, change.change === "surface" ? "changed" : "dependency-internal");

  const universe = next.entities.filter(inCap).map(entity => entity.id);
  return {
    cap,
    diff: {
      added: added.map(ref).sort((left, right) => compare(left.id, right.id)),
      removed: removed.map(ref).sort((left, right) => compare(left.id, right.id)),
      changed: changed.sort((left, right) => compare(left.id, right.id)),
      moved: moved.sort((left, right) => compare(left.id, right.id)),
      relationsAdded: relationsAdded.map(keyToRelation),
      relationsRemoved: relationsRemoved.map(keyToRelation),
      removedExports: removedExports.sort((left, right) => compare(left.id, right.id)),
    },
    seeds,
    dirty: sorted(dirtySet),
    stale: [...staleReasons].map(([scopeId, reason]) => ({ scopeId, reason })).sort((left, right) => compare(left.scopeId, right.scopeId)),
    removed: sorted(removed.map(entity => entity.id)),
    reused: sorted(universe.filter(id => !dirtySet.has(id) && !staleReasons.has(id))),
    belowCap: [...belowCapReasons].map(([scopeId, reason]) => ({ scopeId, reason })).sort((left, right) => compare(left.scopeId, right.scopeId)),
  };
}
