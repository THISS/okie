import type { AtlasScene, SceneEntity, SceneRelation, SceneSourceRef } from './renderer/types';

export type RelationDirection = 'outbound' | 'inbound' | 'self';

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
