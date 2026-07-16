import type { AtlasScene, ProjectionObjectOverride, ProjectionOverride, SceneRelation, SemanticDetail } from '../renderer/types';

export type RelationFocusPresentation = {
  /** Canonical semantic endpoints temporarily promoted for selection presentation. */
  endpointIds: Set<string>;
  /** Canonical semantic relationship IDs temporarily promoted for selection presentation. */
  relationIds: Set<string>;
  /** Lens ownership with presentation opacity promoted only for already-retained objects and paths. */
  projectionOverride?: ProjectionOverride;
};

export type SelectedProjectedRelation = {
  detail: SemanticDetail;
  relation: SceneRelation;
  opacity: number;
};

const semanticDetails: readonly SemanticDetail[] = ['context', 'container', 'component', 'code'];

function retainedObjectSide(
  object: ProjectionObjectOverride,
  side: 'source' | 'target',
) {
  const representationId = side === 'source'
    ? object.sourceRepresentationId
    : object.targetRepresentationId;
  const opacity = side === 'source' ? object.sourceOpacity : object.targetOpacity;
  return Boolean(representationId) && (opacity ?? 1) > .001;
}

function promoteObject(object: ProjectionObjectOverride): ProjectionObjectOverride {
  const sourceRetained = retainedObjectSide(object, 'source');
  const targetRetained = retainedObjectSide(object, 'target');
  return {
    ...object,
    ...(sourceRetained ? { sourceOpacity: 1, sourceContentOpacity: 1 } : {}),
    ...(targetRetained ? { targetOpacity: 1, targetContentOpacity: 1 } : {}),
  };
}

function relationForId(scene: AtlasScene, relationId: string | undefined): SceneRelation | undefined {
  if (!relationId) return undefined;
  return scene.relations.find(relation => relation.id === relationId || relation.semanticIds?.includes(relationId));
}

/** Resolves one selected semantic relation to the retained projected route that currently presents it. */
export function selectedProjectedRelationForFocus(
  scene: AtlasScene,
  relationId: string | undefined,
  projectionOverride: ProjectionOverride | undefined,
  preferredDetail: SemanticDetail,
): SelectedProjectedRelation | undefined {
  const relation = relationForId(scene, relationId);
  const projection = scene.projection;
  if (!relation || !projection) return undefined;
  const visualIds = new Set([
    relation.id,
    ...(projection.semanticToVisualRelationIds[relation.id] ?? []),
  ]);
  const progress = Math.max(0, Math.min(1, projectionOverride?.progress ?? 1));
  const opacityByPathId = new Map((projectionOverride?.paths ?? []).map(path => [
    path.pathId,
    path.sourceOpacity + (path.targetOpacity - path.sourceOpacity) * progress,
  ]));
  const concreteCodeEndpointIds = new Set([relation.from, relation.to].filter(id => (
    scene.entities.find(entity => entity.id === id)?.detail === 'code'
  )));
  const preferConcreteCodeEndpoints = preferredDetail === 'code' && concreteCodeEndpointIds.size > 0;
  const retainsConcreteCodeEndpoints = (candidate: SelectedProjectedRelation) => candidate.detail === 'code'
    && [...concreteCodeEndpointIds].every(id => candidate.relation.from === id || candidate.relation.to === id);

  return semanticDetails.flatMap(detail => projection.projectedRelationsByDetail[detail]
    .filter(projected => projected.routePoints && projected.routePoints.length >= 2)
    .filter(projected => visualIds.has(projected.id) || projected.semanticIds?.includes(relation.id))
    .map(projected => ({
      detail,
      relation: projected,
      opacity: opacityByPathId.get(projected.id) ?? 1,
    })))
    .filter(candidate => candidate.opacity > .001)
    .sort((left, right) => (preferConcreteCodeEndpoints
      ? Number(retainsConcreteCodeEndpoints(right)) - Number(retainsConcreteCodeEndpoints(left))
      : 0)
      || right.opacity - left.opacity
      || Number(right.detail === preferredDetail) - Number(left.detail === preferredDetail)
      || semanticDetails.indexOf(left.detail) - semanticDetails.indexOf(right.detail)
      || left.relation.id.localeCompare(right.relation.id))[0];
}

/**
 * Composes temporary relationship-selection focus after semantic-lens ownership.
 *
 * Representation IDs and zero-opacity ownership slots are left untouched, so
 * this cannot move the canonical lens to another branch. It only restores full
 * presentation weight for the selected path and endpoints that the lens already
 * retained as primary or ghost context.
 */
export function selectedRelationFocusPresentation(
  scene: AtlasScene,
  relationId: string | undefined,
  projectionOverride: ProjectionOverride | undefined,
): RelationFocusPresentation {
  const relation = relationForId(scene, relationId);
  if (!relation) {
    return { endpointIds: new Set(), relationIds: new Set(), projectionOverride };
  }

  const endpointIds = new Set([relation.from, relation.to]);
  const relationIds = new Set([relation.id]);
  if (!projectionOverride || !scene.projection) {
    return { endpointIds, relationIds, projectionOverride };
  }

  const visualEndpointIds = new Set([...endpointIds]
    .flatMap(id => scene.projection?.semanticToVisualEntityId[id] ?? []));
  const visualRelationIds = new Set(scene.projection.semanticToVisualRelationIds[relation.id] ?? [relation.id]);
  const relationLabelIds = new Set([...visualRelationIds].map(id => `relation-label:${id}`));

  const objects = projectionOverride.objects.map(object => {
    if (!visualEndpointIds.has(object.objectId) && !relationLabelIds.has(object.objectId)) return object;
    return promoteObject(object);
  });
  const paths = projectionOverride.paths.map(path => {
    if (!visualRelationIds.has(path.pathId)) return path;
    return {
      ...path,
      sourceOpacity: path.sourceOpacity > .001 ? 1 : path.sourceOpacity,
      targetOpacity: path.targetOpacity > .001 ? 1 : path.targetOpacity,
    };
  });

  return {
    endpointIds,
    relationIds,
    projectionOverride: {
      ...projectionOverride,
      id: `${projectionOverride.id}:relation-focus:${relation.id}`,
      objects,
      paths,
    },
  };
}
