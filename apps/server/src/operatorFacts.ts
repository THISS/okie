import type { ArchitectureEntity, ArchitectureRelation, ArchitectureSnapshot } from "@okie/architecture";
import type { OperatorEnrichmentScope } from "./operatorEnrichment.js";

/**
 * CLA-271: the deterministic facts one operator scope is enriched from, made commit-invariant.
 *
 * The scanner stamps the commit into facts that are otherwise pure content: every code excerpt's
 * `frozenRevision`, and every exposure's `evidence.source.commitSha`. Relation ids are path-derived
 * but numbered by collision order, so an unrelated added relation can renumber them. None of those
 * are evidence the model can use, yet they changed every code scope's input hash (and prompt) on
 * every commit. They are left out here, of both the hash and the prompt. Real content stays: excerpt
 * text and line numbers, exposure kinds, paths and lines, and each relationship's (from, to, kind).
 * The scanner's portable-atlas output is unchanged.
 */
export interface OperatorScopeFacts {
  tags?: string[];
  technology?: string[];
  exposure?: unknown[];
  sourceExcerpts?: unknown[];
  relationships: Array<{ from: string; to: string; kind: string }>;
}

function withoutCommit<T extends object>(value: T, key: string): T {
  const { [key]: _dropped, ...rest } = value as Record<string, unknown>;
  return rest as T;
}

/** Facts for one entity; relationships are the relations touching it, sorted by (from, to, kind). */
export function operatorScopeFacts(entity: ArchitectureEntity, relations: readonly ArchitectureRelation[]): OperatorScopeFacts {
  const relationships = relations.filter(relation => relation.from === entity.id || relation.to === entity.id)
    .map(relation => ({ from: relation.from, to: relation.to, kind: relation.kind }))
    .sort((left, right) => compare(left.from, right.from) || compare(left.to, right.to) || compare(left.kind, right.kind));
  return {
    ...(entity.tags !== undefined ? { tags: entity.tags } : {}),
    ...(entity.technology !== undefined ? { technology: entity.technology } : {}),
    ...(entity.exposure !== undefined ? { exposure: entity.exposure.map(item => ({ ...item, evidence: { ...item.evidence, source: withoutCommit(item.evidence.source, "commitSha") } })) } : {}),
    ...(entity.sourceExcerpts !== undefined ? { sourceExcerpts: entity.sourceExcerpts.map(excerpt => withoutCommit(excerpt, "frozenRevision")) } : {}),
    relationships,
  };
}

const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** Every snapshot entity as an enrichment scope (full and incremental runs build scopes the same way). */
export function operatorScopesFromSnapshot(snapshot: ArchitectureSnapshot): OperatorEnrichmentScope[] {
  return snapshot.entities.map(entity => ({
    scopeId: entity.id, ...(entity.parentId ? { parentScopeId: entity.parentId } : {}), name: entity.name, kind: entity.kind as OperatorEnrichmentScope["kind"],
    facts: operatorScopeFacts(entity, snapshot.relations),
    allowedEvidence: entity.sourceRefs.map(ref => ({ entityId: entity.id, path: ref.path, ...(ref.startLine ? { startLine: ref.startLine } : {}), ...(ref.endLine ? { endLine: ref.endLine } : {}) })),
  }));
}
