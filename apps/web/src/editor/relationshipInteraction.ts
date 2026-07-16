import {
  expandRoutingRect,
  routeOrthogonalWithIntent,
  segmentIntersectsRectInterior,
} from '@okie/architecture';
import type { AtlasScene, Camera, SceneRelation, SemanticDetail } from '../renderer/types';

export type AuthoringPoint = { x: number; y: number };
export type AuthoringBounds = AuthoringPoint & { width: number; height: number };
export type ConnectionPort = 'top' | 'right' | 'bottom' | 'left';

export function authoringBoundsForDetail(
  scene: AtlasScene,
  entityId: string,
  detail: SemanticDetail,
): AuthoringBounds | undefined {
  const projected = scene.projection?.boundsByEntityIdAndDetail[entityId]?.[detail];
  if (projected) return { ...projected };
  const entity = scene.entities.find(candidate => candidate.id === entityId);
  return entity ? { x: entity.x, y: entity.y, width: entity.width, height: entity.height } : undefined;
}

export type RelationshipRouteGeometry = {
  source: AuthoringBounds;
  target: AuthoringBounds;
  obstacles: Array<{ id: string; bounds: AuthoringBounds }>;
  domain?: AuthoringBounds;
  clearance: number;
  laneOffset: number;
  maxPoints: number;
  maxGridNodes: number;
};

/** Reconstructs the compiler's deterministic per-band route inputs for live authoring. */
export function relationshipRouteGeometryForScene(
  scene: AtlasScene,
  relation: SceneRelation,
  detail: SemanticDetail,
): RelationshipRouteGeometry | undefined {
  const projection = scene.projection;
  if (!projection) return undefined;
  const source = authoringBoundsForDetail(scene, relation.from, detail);
  const target = authoringBoundsForDetail(scene, relation.to, detail);
  if (!source || !target) return undefined;
  const visibleIds = [...new Set(projection.entityIdsByDetail[detail])]
    .filter(id => authoringBoundsForDetail(scene, id, detail) !== undefined);
  const visible = new Set(visibleIds);
  const entityById = new Map(scene.entities.map(entity => [entity.id, entity]));
  const ancestorChain = (id: string): string[] => {
    const result: string[] = [];
    const seen = new Set<string>();
    let current: string | undefined = id;
    while (current && visible.has(current) && !seen.has(current)) {
      result.push(current);
      seen.add(current);
      current = entityById.get(current)?.parentId;
    }
    return result;
  };
  const sourceAncestors = ancestorChain(relation.from);
  const targetAncestors = new Set(ancestorChain(relation.to));
  const isEndpointAncestor = (id: string) => sourceAncestors.includes(id) || targetAncestors.has(id);
  const candidateIds = visibleIds.filter(id => id !== relation.from && id !== relation.to && !isEndpointAncestor(id));
  const candidateSet = new Set(candidateIds);
  const obstacles = candidateIds.filter(id => {
    const seen = new Set<string>();
    let parentId = entityById.get(id)?.parentId;
    while (parentId && !seen.has(parentId)) {
      if (candidateSet.has(parentId)) return false;
      seen.add(parentId);
      parentId = entityById.get(parentId)?.parentId;
    }
    return true;
  }).sort().flatMap(id => {
    const bounds = authoringBoundsForDetail(scene, id, detail);
    return bounds ? [{ id, bounds }] : [];
  });
  const focusZoom = projection.zoomPolicy?.bands.find(band => band.detail === detail)?.focusZoom ?? 1;
  const clearance = 8 / focusZoom;
  const laneSpacing = 10 / focusZoom;
  const pairKey = (candidate: SceneRelation) => [candidate.from, candidate.to].sort().join('\u0000');
  const parallel = projection.projectedRelationsByDetail[detail]
    .filter(candidate => pairKey(candidate) === pairKey(relation))
    .map(candidate => candidate.id)
    .sort();
  const laneIndex = Math.max(0, parallel.indexOf(relation.id));
  const laneOffset = (laneIndex - (Math.max(1, parallel.length) - 1) / 2) * laneSpacing;
  const lcaId = sourceAncestors.find(id => targetAncestors.has(id));
  const lcaBounds = lcaId ? authoringBoundsForDetail(scene, lcaId, detail) : undefined;
  return {
    source,
    target,
    obstacles,
    ...(lcaBounds ? { domain: expandRoutingRect(lcaBounds, clearance * 2 + 1) } : {}),
    clearance,
    laneOffset,
    maxPoints: 16,
    maxGridNodes: 20_000,
  };
}

export function worldToScreen(
  point: AuthoringPoint,
  camera: Camera,
  viewport: { width: number; height: number },
): AuthoringPoint {
  return {
    x: viewport.width / 2 + (point.x - camera.x) * camera.zoom,
    y: viewport.height / 2 + (point.y - camera.y) * camera.zoom,
  };
}

export function screenToWorld(
  point: AuthoringPoint,
  camera: Camera,
  viewport: { width: number; height: number },
): AuthoringPoint {
  return {
    x: camera.x + (point.x - viewport.width / 2) / camera.zoom,
    y: camera.y + (point.y - viewport.height / 2) / camera.zoom,
  };
}

export function connectionPortPoint(bounds: AuthoringBounds, port: ConnectionPort): AuthoringPoint {
  if (port === 'top') return { x: bounds.x + bounds.width / 2, y: bounds.y };
  if (port === 'right') return { x: bounds.x + bounds.width, y: bounds.y + bounds.height / 2 };
  if (port === 'bottom') return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height };
  return { x: bounds.x, y: bounds.y + bounds.height / 2 };
}

export function nearestConnectionPort(bounds: AuthoringBounds, point: AuthoringPoint): ConnectionPort {
  return (['top', 'right', 'bottom', 'left'] as const)
    .map(port => ({ port, point: connectionPortPoint(bounds, port) }))
    .sort((left, right) => Math.hypot(left.point.x - point.x, left.point.y - point.y)
      - Math.hypot(right.point.x - point.x, right.point.y - point.y)
      || left.port.localeCompare(right.port))[0]!.port;
}

export function automaticRelationshipRoute(
  source: AuthoringBounds,
  target: AuthoringBounds,
  obstacles: ReadonlyArray<{ id: string; bounds: AuthoringBounds }>,
  ports?: { sourcePort: ConnectionPort; targetPort: ConnectionPort },
  clearance = 8,
): AuthoringPoint[] {
  return routeOrthogonalWithIntent({
    source,
    target,
    obstacles,
    clearance,
    maxPoints: 16,
    maxGridNodes: 20_000,
  }, ports ? { ...ports, waypoints: [] } : undefined).points;
}

export function routeIsObstacleSafe(
  points: readonly AuthoringPoint[],
  obstacles: readonly AuthoringBounds[],
): boolean {
  return points.length >= 2 && points.slice(0, -1).every((point, index) => {
    const next = points[index + 1]!;
    const orthogonal = Math.abs(point.x - next.x) <= 1e-9 || Math.abs(point.y - next.y) <= 1e-9;
    return orthogonal && !obstacles.some(bounds => segmentIntersectsRectInterior(point, next, bounds));
  });
}

function containsBounds(outer: AuthoringBounds, inner: AuthoringBounds): boolean {
  return outer.x <= inner.x
    && outer.y <= inner.y
    && outer.x + outer.width >= inner.x + inner.width
    && outer.y + outer.height >= inner.y + inner.height;
}

/** Excludes endpoint boxes and their visible owner shells from route obstacles. */
export function routingObstaclesForEndpoints(
  candidates: ReadonlyArray<{ id: string; bounds: AuthoringBounds }>,
  sourceId: string,
  targetId?: string,
): Array<{ id: string; bounds: AuthoringBounds }> {
  const source = candidates.find(candidate => candidate.id === sourceId)?.bounds;
  const target = targetId ? candidates.find(candidate => candidate.id === targetId)?.bounds : undefined;
  return candidates.filter(candidate => candidate.id !== sourceId
    && candidate.id !== targetId
    && (!source || !containsBounds(candidate.bounds, source))
    && (!target || !containsBounds(candidate.bounds, target)));
}

export type OrthogonalSegmentHandle = {
  segmentIndex: number;
  orientation: 'horizontal' | 'vertical';
  point: AuthoringPoint;
};

/** Endpoint segments stay compiler-owned; authoring exposes only internal guides. */
export function orthogonalSegmentHandles(points: readonly AuthoringPoint[]): OrthogonalSegmentHandle[] {
  return points.slice(1, -2).flatMap((start, offset) => {
    const segmentIndex = offset + 1;
    const end = points[segmentIndex + 1]!;
    const horizontal = Math.abs(start.y - end.y) <= 1e-9;
    const vertical = Math.abs(start.x - end.x) <= 1e-9;
    if (!horizontal && !vertical) return [];
    return [{
      segmentIndex,
      orientation: horizontal ? 'horizontal' as const : 'vertical' as const,
      point: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 },
    }];
  });
}

export type GuidedRoutePreview = {
  points: AuthoringPoint[];
  applied: boolean;
  diagnostic: 'applied' | 'blocked';
  intent?: GuidedRelationshipRouteIntent;
};

export type RelationshipEndpointBounds = {
  source: AuthoringBounds;
  target: AuthoringBounds;
};

const endpointEpsilon = 1e-9;

function pointOnBoundsBoundary(point: AuthoringPoint, bounds: AuthoringBounds): boolean {
  const withinX = point.x >= bounds.x - endpointEpsilon && point.x <= bounds.x + bounds.width + endpointEpsilon;
  const withinY = point.y >= bounds.y - endpointEpsilon && point.y <= bounds.y + bounds.height + endpointEpsilon;
  return withinX && withinY && (
    Math.abs(point.x - bounds.x) <= endpointEpsilon
    || Math.abs(point.x - bounds.x - bounds.width) <= endpointEpsilon
    || Math.abs(point.y - bounds.y) <= endpointEpsilon
    || Math.abs(point.y - bounds.y - bounds.height) <= endpointEpsilon
  );
}

function clippedOrthogonalEndpoint(
  current: AuthoringPoint,
  adjacent: AuthoringPoint,
  bounds: AuthoringBounds,
): AuthoringPoint | undefined {
  if (Math.abs(current.x - adjacent.x) <= endpointEpsilon && Math.abs(current.y - adjacent.y) <= endpointEpsilon) {
    return pointOnBoundsBoundary(current, bounds) ? { ...current } : undefined;
  }
  const horizontal = Math.abs(current.y - adjacent.y) <= endpointEpsilon;
  const vertical = Math.abs(current.x - adjacent.x) <= endpointEpsilon;
  if (horizontal) {
    if (adjacent.y < bounds.y - endpointEpsilon || adjacent.y > bounds.y + bounds.height + endpointEpsilon) return undefined;
    if (adjacent.x > bounds.x + endpointEpsilon
      && adjacent.x < bounds.x + bounds.width - endpointEpsilon) return undefined;
    return {
      x: adjacent.x >= bounds.x + bounds.width - endpointEpsilon ? bounds.x + bounds.width : bounds.x,
      y: adjacent.y,
    };
  }
  if (vertical) {
    if (adjacent.x < bounds.x - endpointEpsilon || adjacent.x > bounds.x + bounds.width + endpointEpsilon) return undefined;
    if (adjacent.y > bounds.y + endpointEpsilon
      && adjacent.y < bounds.y + bounds.height - endpointEpsilon) return undefined;
    return {
      x: adjacent.x,
      y: adjacent.y >= bounds.y + bounds.height - endpointEpsilon ? bounds.y + bounds.height : bounds.y,
    };
  }
  return undefined;
}

/**
 * Reattaches an orthogonal route to the endpoint rectangles after a live guide
 * moves. The first/last segment determines the boundary side, so dragging a
 * guide past a node switches to the opposite side instead of drawing through
 * the node or leaving a stale endpoint floating in world space. A guide inside
 * an endpoint box is rejected because no boundary-clipped safe leg exists.
 */
export function attachOrthogonalRouteEndpoints(
  points: readonly AuthoringPoint[],
  endpoints: RelationshipEndpointBounds,
): AuthoringPoint[] | undefined {
  if (points.length < 2) return undefined;
  const attached = points.map(point => ({ ...point }));
  const source = clippedOrthogonalEndpoint(attached[0]!, attached[1]!, endpoints.source);
  const lastIndex = attached.length - 1;
  const target = clippedOrthogonalEndpoint(attached[lastIndex]!, attached[lastIndex - 1]!, endpoints.target);
  if (!source || !target) return undefined;
  attached[0] = source;
  attached[lastIndex] = target;
  return attached;
}

export type GuidedRelationshipRouteIntent = {
  sourcePort: ConnectionPort;
  targetPort: ConnectionPort;
  waypoints: AuthoringPoint[];
};

function portForRouteEndpoint(
  endpoint: AuthoringPoint,
  adjacent: AuthoringPoint,
  bounds: AuthoringBounds,
): ConnectionPort | undefined {
  if (Math.abs(endpoint.y - adjacent.y) <= endpointEpsilon) {
    if (Math.abs(endpoint.x - bounds.x) <= endpointEpsilon) return 'left';
    if (Math.abs(endpoint.x - bounds.x - bounds.width) <= endpointEpsilon) return 'right';
  }
  if (Math.abs(endpoint.x - adjacent.x) <= endpointEpsilon) {
    if (Math.abs(endpoint.y - bounds.y) <= endpointEpsilon) return 'top';
    if (Math.abs(endpoint.y - bounds.y - bounds.height) <= endpointEpsilon) return 'bottom';
  }
  return undefined;
}

/**
 * Converts the authored segment into durable router intent. Only the two
 * dragged guide endpoints are persisted; compiler-owned stubs and detours must
 * never be serialized back as additional authored guides.
 */
export function guidedRelationshipRouteIntent(
  points: readonly AuthoringPoint[],
  segmentIndex: number,
  endpoints: RelationshipEndpointBounds,
): GuidedRelationshipRouteIntent | undefined {
  const attached = attachOrthogonalRouteEndpoints(points, endpoints);
  if (!attached) return undefined;
  const sourcePort = portForRouteEndpoint(attached[0]!, attached[1]!, endpoints.source);
  const lastIndex = attached.length - 1;
  const targetPort = portForRouteEndpoint(attached[lastIndex]!, attached[lastIndex - 1]!, endpoints.target);
  if (!sourcePort || !targetPort) return undefined;
  const start = attached[segmentIndex];
  const end = attached[segmentIndex + 1];
  if (!start || !end || segmentIndex <= 0 || segmentIndex >= attached.length - 2) return undefined;
  const waypoints = [start, end]
    .filter((point, index, all) => index === 0
      || Math.abs(point.x - all[index - 1]!.x) > endpointEpsilon
      || Math.abs(point.y - all[index - 1]!.y) > endpointEpsilon)
    .map(point => ({ ...point }));
  return { sourcePort, targetPort, waypoints };
}

/**
 * Moves one internal orthogonal segment while keeping endpoints canonical.
 * Invalid candidates fall back to the last committed safe route, so the live
 * preview never crosses a node.
 */
export function previewOrthogonalSegmentGuide(
  points: readonly AuthoringPoint[],
  segmentIndex: number,
  pointer: AuthoringPoint,
  obstacles: readonly AuthoringBounds[],
  endpointBounds?: RelationshipEndpointBounds,
  routingGeometry?: RelationshipRouteGeometry,
): GuidedRoutePreview {
  const endpoints = endpointBounds ?? (routingGeometry
    ? { source: routingGeometry.source, target: routingGeometry.target }
    : undefined);
  const original = endpoints
    ? attachOrthogonalRouteEndpoints(points, endpoints) ?? points.map(point => ({ ...point }))
    : points.map(point => ({ ...point }));
  if (segmentIndex <= 0 || segmentIndex >= points.length - 2) {
    return { points: original, applied: false, diagnostic: 'blocked' };
  }
  const start = points[segmentIndex]!;
  const end = points[segmentIndex + 1]!;
  const horizontal = Math.abs(start.y - end.y) <= 1e-9;
  const vertical = Math.abs(start.x - end.x) <= 1e-9;
  if (!horizontal && !vertical) {
    return { points: original, applied: false, diagnostic: 'blocked' };
  }
  const candidate = points.map(point => ({ ...point }));
  if (horizontal) {
    candidate[segmentIndex]!.y = pointer.y;
    candidate[segmentIndex + 1]!.y = pointer.y;
  } else {
    candidate[segmentIndex]!.x = pointer.x;
    candidate[segmentIndex + 1]!.x = pointer.x;
  }
  const attached = endpoints ? attachOrthogonalRouteEndpoints(candidate, endpoints) : candidate;
  const intent = attached && endpoints
    ? guidedRelationshipRouteIntent(attached, segmentIndex, endpoints)
    : undefined;
  if (routingGeometry && intent) {
    const canonical = routeOrthogonalWithIntent(routingGeometry, intent);
    return canonical.status === 'applied'
      ? { points: canonical.points, applied: true, diagnostic: 'applied', intent }
      : { points: original, applied: false, diagnostic: 'blocked' };
  }
  const safe = attached !== undefined && routeIsObstacleSafe(attached, obstacles);
  return safe
    ? { points: attached, applied: true, diagnostic: 'applied', ...(intent ? { intent } : {}) }
    : { points: original, applied: false, diagnostic: 'blocked' };
}

export function closestSegmentHandle(
  points: readonly AuthoringPoint[],
  screenPoint: AuthoringPoint,
  camera: Camera,
  viewport: { width: number; height: number },
  tolerancePx = 12,
): OrthogonalSegmentHandle | undefined {
  return orthogonalSegmentHandles(points)
    .map(handle => ({ handle, screen: worldToScreen(handle.point, camera, viewport) }))
    .map(value => ({ ...value, distance: Math.hypot(value.screen.x - screenPoint.x, value.screen.y - screenPoint.y) }))
    .filter(value => value.distance <= tolerancePx)
    .sort((left, right) => left.distance - right.distance || left.handle.segmentIndex - right.handle.segmentIndex)[0]?.handle;
}
