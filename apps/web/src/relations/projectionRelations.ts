import type { AtlasScene, SceneEntity, SceneRelation, SceneSourceRef, SemanticDetail } from '../renderer/types';

export type RelationDirection = 'outbound' | 'inbound' | 'self';

const SEMANTIC_DETAILS: readonly SemanticDetail[] = ['context', 'container', 'component', 'code'];

function detailRank(detail: SemanticDetail | undefined): number {
  const index = detail ? SEMANTIC_DETAILS.indexOf(detail) : -1;
  return index < 0 ? 0 : index;
}

export type SelectedRelationPresentation = {
  id: string;
  relation: SceneRelation;
  source: SceneEntity;
  target: SceneEntity;
  counterpart: SceneEntity;
  direction: RelationDirection;
  directionLabel: 'OUT' | 'IN' | 'SELF';
  label: string;
  kindLabel?: string;
  protocol?: string;
  evidence: {
    /** Stable semantic IDs suitable for joining against canonical relation evidence. */
    relationIds: string[];
    /** Endpoint evidence is kept separate so it is not mistaken for relation evidence. */
    sourceEntityRefs: SceneSourceRef[];
    targetEntityRefs: SceneSourceRef[];
    frozenRevision?: string;
  };
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function copiedRefs(entity: SceneEntity): SceneSourceRef[] {
  return (entity.sourceRefs ?? []).map(ref => ({ ...ref }));
}

/**
 * Resolves renderer-visible edge IDs to canonical semantic SceneRelation rows.
 *
 * Projection bundles can collapse several semantic relations into one visual
 * edge, and the same semantic relation can be represented by multiple visual
 * edges. Filtering the canonical scene order after collecting IDs makes the
 * result both deduplicated and independent of visual-edge input order.
 * Scenes without a projection retain direct relation-ID compatibility.
 */
export function semanticRelationsForVisibleProjection(
  scene: AtlasScene,
  visibleVisualRelationIds: readonly string[],
): SceneRelation[] {
  const canonicalIds = new Set(scene.relations.map(relation => relation.id));
  const visibleSemanticIds = new Set<string>();
  const visualToSemantic = scene.projection?.visualToSemanticRelationIds;

  for (const visualId of visibleVisualRelationIds) {
    const mapped = visualToSemantic?.[visualId];
    if (mapped?.length) {
      for (const semanticId of mapped) visibleSemanticIds.add(semanticId);
    } else if (canonicalIds.has(visualId)) {
      visibleSemanticIds.add(visualId);
    }
  }

  return scene.relations.filter(relation => visibleSemanticIds.has(relation.id));
}

export function visibleSemanticRelationsForEntity(
  scene: AtlasScene,
  visibleVisualRelationIds: readonly string[],
  selectedEntityId: string,
): SceneRelation[] {
  return semanticRelationsForVisibleProjection(scene, visibleVisualRelationIds)
    .filter(relation => relation.from === selectedEntityId || relation.to === selectedEntityId);
}

/** Builds the inspector-facing view of one canonical relation. */
export function selectedRelationPresentation(
  scene: AtlasScene,
  relation: SceneRelation,
  selectedEntityId: string,
): SelectedRelationPresentation | undefined {
  if (relation.from !== selectedEntityId && relation.to !== selectedEntityId) return undefined;
  const byId = new Map(scene.entities.map(entity => [entity.id, entity]));
  const source = byId.get(relation.from);
  const target = byId.get(relation.to);
  if (!source || !target) return undefined;

  const direction: RelationDirection = relation.from === selectedEntityId && relation.to === selectedEntityId
    ? 'self'
    : relation.from === selectedEntityId
      ? 'outbound'
      : 'inbound';
  const kindLabel = relation.kindLabel?.trim() || undefined;
  const protocol = relation.protocol?.trim() || undefined;
  const label = relation.label?.trim() || kindLabel || 'Relationship';

  return {
    id: relation.id,
    relation,
    source,
    target,
    counterpart: direction === 'inbound' ? source : target,
    direction,
    directionLabel: direction === 'outbound' ? 'OUT' : direction === 'inbound' ? 'IN' : 'SELF',
    label,
    ...(kindLabel ? { kindLabel } : {}),
    ...(protocol ? { protocol } : {}),
    evidence: {
      relationIds: unique([relation.id, ...(relation.semanticIds ?? [])]),
      sourceEntityRefs: copiedRefs(source),
      targetEntityRefs: copiedRefs(target),
      ...(scene.frozenRevision ? { frozenRevision: scene.frozenRevision } : {}),
    },
  };
}

export function selectedRelationPresentations(
  scene: AtlasScene,
  visibleVisualRelationIds: readonly string[],
  selectedEntityId: string,
): SelectedRelationPresentation[] {
  return visibleSemanticRelationsForEntity(scene, visibleVisualRelationIds, selectedEntityId)
    .flatMap(relation => {
      const presentation = selectedRelationPresentation(scene, relation, selectedEntityId);
      return presentation ? [presentation] : [];
    });
}

/** One inspector row per edge the canvas draws on the selected card. */
export type CanvasRelationRow = {
  /** Visual-edge identity: the row is the edge, not one of its collapsed relations. */
  id: string;
  /** Representative canonical relation — the same one a canvas pick on this edge returns. */
  relationId: string;
  direction: Exclude<RelationDirection, 'self'>;
  directionLabel: 'OUT' | 'IN';
  counterpart: SceneEntity;
  /** Collapsed edge label (`3 calls` when the underlying labels disagree). */
  label: string;
  kindLabel?: string;
  protocol?: string;
  /** Canonical relations collapsed into this edge (≥ 1). */
  count: number;
  semanticIds: string[];
};

export type CanvasRelationsPresentation = {
  rows: CanvasRelationRow[];
  /**
   * Relations whose endpoints both project onto the selected node at this band.
   * The canvas suppresses the resulting self-edge, so this is the only count the
   * inspector may honestly report as hidden.
   */
  hiddenInternalCount: number;
  /** Edges a scoped compile kept out of routing, so the canvas never drew them. */
  omittedEdgeCount: number;
  /** Canonical relations collapsed into those unrouted edges. */
  omittedRelationCount: number;
};

/**
 * Resolves the visible visual edges touching one entity.
 *
 * The inspector follows the canvas: a band projects descendant relations onto
 * their nearest visible ancestor, so canonical `from`/`to` filtering would drop
 * every projected edge the band actually draws. Rows are therefore keyed by
 * visual edge and carry the collapsed label plus the underlying relation count.
 * Scenes without a projection fall back to canonical relation identity.
 */
export function canvasRelationRowsForEntity(
  scene: AtlasScene,
  visibleVisualRelationIds: readonly string[],
  selectedEntityId: string,
): CanvasRelationRow[] {
  const entityById = new Map(scene.entities.map(entity => [entity.id, entity]));
  const canonicalById = new Map(scene.relations.map(relation => [relation.id, relation]));
  const visible = new Set(visibleVisualRelationIds);
  const projected = scene.projection?.projectedRelationsByDetail;
  const edges = projected
    ? SEMANTIC_DETAILS.flatMap(detail => (projected[detail] ?? []).filter(edge => visible.has(edge.id)))
    : scene.relations.filter(relation => visible.has(relation.id));

  const rows: CanvasRelationRow[] = [];
  const seen = new Set<string>();
  for (const edge of edges) {
    if (seen.has(edge.id)) continue;
    // A self-edge is never drawn; its relations are reported as hidden internals.
    if (edge.from === edge.to) continue;
    if (edge.from !== selectedEntityId && edge.to !== selectedEntityId) continue;
    const outbound = edge.from === selectedEntityId;
    const counterpart = entityById.get(outbound ? edge.to : edge.from);
    if (!counterpart) continue;
    seen.add(edge.id);
    const semanticIds = edge.semanticIds?.length ? [...edge.semanticIds] : [edge.id];
    const only = semanticIds.length === 1 ? canonicalById.get(semanticIds[0]!) : undefined;
    const kindLabel = (edge.kindLabel ?? only?.kindLabel)?.trim() || undefined;
    const label = edge.label?.trim() || only?.label?.trim() || kindLabel || 'Relationship';
    const protocol = (edge.protocol ?? only?.protocol)?.trim() || undefined;
    rows.push({
      id: edge.id,
      relationId: only?.id ?? semanticIds[0]!,
      direction: outbound ? 'outbound' : 'inbound',
      directionLabel: outbound ? 'OUT' : 'IN',
      counterpart,
      label,
      ...(kindLabel ? { kindLabel } : {}),
      ...(protocol ? { protocol } : {}),
      count: semanticIds.length,
      semanticIds,
    });
  }
  return rows;
}

/** Mirrors the projection's nearest-visible-ancestor rule for one endpoint. */
export function projectedEntityIdForDetail(
  entityById: ReadonlyMap<string, SceneEntity>,
  entityId: string,
  detail: SemanticDetail,
): string | undefined {
  const rank = detailRank(detail);
  let current = entityById.get(entityId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (detailRank(current.detail) <= rank) return current.id;
    visited.add(current.id);
    current = current.parentId ? entityById.get(current.parentId) : undefined;
  }
  return current?.id;
}

/**
 * Counts the relations the band collapsed into a suppressed self-edge on this
 * node — the compiler drops a projected edge whose endpoints resolve to the same
 * visible entity. Nothing else may be reported as hidden: every other relation is
 * either drawn (a row) or unrouted (`+N more`).
 */
export function selfProjectedRelationCount(
  scene: AtlasScene,
  selectedEntityId: string,
  detail: SemanticDetail,
): number {
  const entityById = new Map(scene.entities.map(entity => [entity.id, entity]));
  const rank = detailRank(detail);
  const projectedCache = new Map<string, string | undefined>();
  const projectedId = (entityId: string) => {
    if (!projectedCache.has(entityId)) {
      projectedCache.set(entityId, projectedEntityIdForDetail(entityById, entityId, detail));
    }
    return projectedCache.get(entityId);
  };

  let count = 0;
  for (const relation of scene.relations) {
    const from = entityById.get(relation.from);
    const to = entityById.get(relation.to);
    if (!from || !to) continue;
    // Coarser authored summaries never reach a finer band, so they cannot be
    // hidden by it either.
    if (Math.max(detailRank(from.detail), detailRank(to.detail)) < rank) continue;
    if (projectedId(relation.from) !== selectedEntityId) continue;
    if (projectedId(relation.to) !== selectedEntityId) continue;
    count += 1;
  }
  return count;
}

/** The inspector's Relationships section for one selected entity. */
export function canvasRelationsForEntity(
  scene: AtlasScene,
  visibleVisualRelationIds: readonly string[],
  selectedEntityId: string,
  detail: SemanticDetail,
): CanvasRelationsPresentation {
  // Band-scoped: "+N more" claims what this zoom failed to route, and an edge
  // omitted in several bands must not be counted several times.
  const omitted = (scene.omittedEdges ?? []).filter(edge => edge.detail === detail
    && (edge.fromId === selectedEntityId || edge.toId === selectedEntityId));
  return {
    rows: canvasRelationRowsForEntity(scene, visibleVisualRelationIds, selectedEntityId),
    hiddenInternalCount: selfProjectedRelationCount(scene, selectedEntityId, detail),
    omittedEdgeCount: omitted.length,
    omittedRelationCount: omitted.reduce((total, edge) => total + edge.relationCount, 0),
  };
}
