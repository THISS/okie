import { ATLAS_CAMERA_BOUNDS, ATLAS_SEMANTIC_ZOOM_BANDS, semanticDominantZoomIntervals } from '../renderer/cameraBounds';
import { frameEntities, type SafeArea, type ViewportSize } from '../storyFraming';
import type { AtlasScene, Camera, SceneEntity, SceneRelation, SemanticDetail } from '../renderer/types';

export type EntityBounds = { x: number; y: number; width: number; height: number };

export type RelationContainmentKind = 'same-parent' | 'cross-container';

export type RelationContainment = {
  /**
   * `same-parent` when the endpoints are siblings inside the same component/container
   * (or a self-relation); `cross-container` when their ancestries diverge — different
   * containers, nested endpoints, or root-level endpoints with no shared ancestor.
   */
  kind: RelationContainmentKind;
  /** Lowest common ancestor entity ID, or undefined when the endpoints share no ancestor. */
  lcaId: string | undefined;
  /** Steps from the source endpoint up to the LCA (0 when the source itself IS the LCA). */
  depthFromSource: number;
  /** Steps from the target endpoint up to the LCA. */
  depthFromTarget: number;
  /** How far the endpoint ancestries diverge — the larger of the two containment depths. */
  divergence: number;
};

export type RelationFramingPlan = {
  containment: RelationContainmentKind;
  lcaId: string | undefined;
  divergence: number;
  /** World-space union of both endpoint bounds at the resolved detail (padding is applied in screen space during the fit). */
  bounds: EntityBounds;
  sourceBounds: EntityBounds;
  targetBounds: EntityBounds;
  /** Target camera that contains both endpoints, reusing the shared frame-entities fit. */
  camera: Camera;
};

/** Screen padding for the flow frame — matches the desktop framing constant used by frameEntities/frameProjectionScope. */
export const RELATION_FRAMING_SCREEN_PADDING = 42;

const semanticDetails: readonly SemanticDetail[] = ['context', 'container', 'component', 'code'];

/** Walks the containment tree from `id` to the root, self-referential/cyclic parents guarded. */
function ancestorChain(byId: Map<string, SceneEntity>, id: string): string[] {
  const chain: string[] = [];
  const visited = new Set<string>();
  let current = byId.get(id);
  while (current && !visited.has(current.id)) {
    chain.push(current.id);
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return chain;
}

/**
 * Classifies how far apart a relation's endpoints sit in the semantic containment
 * tree. The zoom direction is derived from this: siblings frame locally, diverging
 * ancestries zoom out to a scope that contains both.
 */
export function relationContainment(scene: AtlasScene, relation: SceneRelation): RelationContainment {
  const byId = new Map(scene.entities.map(entity => [entity.id, entity]));
  const sourceChain = ancestorChain(byId, relation.from);
  const targetChain = ancestorChain(byId, relation.to);
  const sourceAncestors = new Set(sourceChain);
  const lcaId = targetChain.find(id => sourceAncestors.has(id));
  const depthFromSource = lcaId ? sourceChain.indexOf(lcaId) : sourceChain.length;
  const depthFromTarget = lcaId ? targetChain.indexOf(lcaId) : targetChain.length;
  const divergence = Math.max(depthFromSource, depthFromTarget);
  // Siblings: both endpoints are direct children of the LCA. A self-relation stays local too.
  const siblings = lcaId !== undefined && depthFromSource === 1 && depthFromTarget === 1;
  const kind: RelationContainmentKind = siblings || relation.from === relation.to
    ? 'same-parent'
    : 'cross-container';
  return { kind, lcaId, depthFromSource, depthFromTarget, divergence };
}

/** Resolves an endpoint's bounds at the given detail, falling back to its default layout geometry. */
function endpointBounds(scene: AtlasScene, entityId: string, detail: SemanticDetail): EntityBounds | undefined {
  const projected = scene.projection?.boundsByEntityIdAndDetail[entityId]?.[detail];
  if (projected) return { x: projected.x, y: projected.y, width: projected.width, height: projected.height };
  const entity = scene.entities.find(candidate => candidate.id === entityId);
  return entity ? { x: entity.x, y: entity.y, width: entity.width, height: entity.height } : undefined;
}

export function unionBounds(a: EntityBounds, b: EntityBounds): EntityBounds {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Plans the camera flight that frames a selected relationship's flow.
 *
 * Reuses the shared `frameEntities` fit (identical padding + centering to parent-level
 * navigation and story framing) over the union of both endpoint bounds. The zoom
 * envelope is derived from the containment distance:
 *   - same-parent (siblings): floored at the detail band's interval so the frame stays
 *     local and can gently zoom IN to contain both nodes.
 *   - cross-container: floored at the global minimum so the frame can zoom OUT far enough
 *     to contain both endpoints across their diverging scopes, showcasing the path.
 * Returns undefined when either endpoint has no resolvable bounds.
 */
export function relationFramingPlan(
  scene: AtlasScene,
  relation: SceneRelation,
  detail: SemanticDetail,
  viewport: ViewportSize,
  safeArea: SafeArea,
): RelationFramingPlan | undefined {
  const sourceBounds = endpointBounds(scene, relation.from, detail);
  const targetBounds = endpointBounds(scene, relation.to, detail);
  if (!sourceBounds || !targetBounds) return undefined;

  const containment = relationContainment(scene, relation);
  const bounds = unionBounds(sourceBounds, targetBounds);

  const level = Math.max(0, semanticDetails.indexOf(detail));
  const interval = semanticDominantZoomIntervals()[level]!;
  const focusZoom = ATLAS_SEMANTIC_ZOOM_BANDS[level]?.focusZoom ?? interval.max;
  // Floor both at the global minimum so the fit can always zoom out far enough to contain the pair.
  // The ceiling encodes the direction: a sibling pair may zoom IN to the band's focus for a close
  // local read; a cross-container pair is capped at the band floor so it stays zoomed OUT, keeping
  // the surrounding container context (the flow's path) visible instead of framing tightly.
  const minZoom = ATLAS_CAMERA_BOUNDS.minZoom;
  const ceiling = containment.kind === 'same-parent'
    ? Math.min(interval.max, focusZoom)
    : interval.min;
  const maxZoom = Math.max(minZoom, ceiling);

  // Fit both endpoints at their resolved bounds through the shared frame primitive.
  const entities = scene.entities.map(entity => (
    entity.id === relation.from
      ? { ...entity, ...sourceBounds }
      : entity.id === relation.to
        ? { ...entity, ...targetBounds }
        : entity
  ));
  const endpointIds = relation.from === relation.to ? [relation.from] : [relation.from, relation.to];
  const camera = frameEntities({ ...scene, entities }, endpointIds, viewport, safeArea, {
    screenPadding: RELATION_FRAMING_SCREEN_PADDING,
    minZoom,
    maxZoom,
  });
  if (!camera) return undefined;

  return {
    containment: containment.kind,
    lcaId: containment.lcaId,
    divergence: containment.divergence,
    bounds,
    sourceBounds,
    targetBounds,
    camera,
  };
}
