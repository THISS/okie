import { describe, expect, it } from 'vitest';
import { routeOrthogonalWithIntent } from '@okie/architecture';
import {
  attachOrthogonalRouteEndpoints,
  automaticRelationshipRoute,
  authoringBoundsForDetail,
  connectionPortPoint,
  nearestConnectionPort,
  orthogonalSegmentHandles,
  previewOrthogonalSegmentGuide,
  type RelationshipRouteGeometry,
  routingObstaclesForEndpoints,
  screenToWorld,
  worldToScreen,
} from './relationshipInteraction';

describe('relationship authoring geometry', () => {
  it('resolves ports from the active non-context projection instead of base entity geometry', () => {
    const scene = {
      id: 'scene', title: '', subtitle: '', relations: [], regions: [],
      entities: [{ id: 'entity', name: 'Entity', kind: 'component' as const, responsibility: '', x: 1, y: 2, width: 3, height: 4 }],
      projection: {
        semanticToVisualEntityId: {}, visualToSemanticEntityId: {}, semanticToVisualRelationIds: {}, visualToSemanticRelationIds: {},
        entityIdsByDetail: { context: [], container: [], component: ['entity'], code: [] },
        relationIdsByDetail: { context: [], container: [], component: [], code: [] },
        projectedRelationsByDetail: { context: [], container: [], component: [], code: [] },
        boundsByEntityIdAndDetail: { entity: { component: { x: 40, y: 50, width: 60, height: 70 } } },
      },
    };
    expect(authoringBoundsForDetail(scene, 'entity', 'component')).toEqual({ x: 40, y: 50, width: 60, height: 70 });
  });

  it('round-trips screen and world coordinates and resolves the nearest port', () => {
    const camera = { x: 100, y: 50, zoom: 2 };
    const viewport = { width: 800, height: 600 };
    const point = { x: 130, y: 75 };
    expect(screenToWorld(worldToScreen(point, camera, viewport), camera, viewport)).toEqual(point);
    const bounds = { x: 10, y: 20, width: 100, height: 60 };
    expect(connectionPortPoint(bounds, 'right')).toEqual({ x: 110, y: 50 });
    expect(nearestConnectionPort(bounds, { x: 114, y: 48 })).toBe('right');
  });

  it('builds an obstacle-safe automatic relationship route', () => {
    const source = { x: 0, y: 0, width: 80, height: 60 };
    const target = { x: 300, y: 0, width: 80, height: 60 };
    const blocker = { x: 140, y: -20, width: 100, height: 100 };
    const points = automaticRelationshipRoute(source, target, [{ id: 'blocker', bounds: blocker }]);
    expect(points.length).toBeGreaterThanOrEqual(4);
    expect(points[0]!.x === source.x + source.width || points[0]!.y === source.y || points[0]!.y === source.y + source.height).toBe(true);
  });

  it('does not treat the endpoints or their containing owner shell as obstacles', () => {
    const candidates = [
      { id: 'owner', bounds: { x: 0, y: 0, width: 500, height: 300 } },
      { id: 'source', bounds: { x: 40, y: 80, width: 80, height: 60 } },
      { id: 'target', bounds: { x: 380, y: 80, width: 80, height: 60 } },
      { id: 'blocker', bounds: { x: 220, y: 60, width: 60, height: 100 } },
    ];
    expect(routingObstaclesForEndpoints(candidates, 'source', 'target').map(value => value.id)).toEqual(['blocker']);
  });

  it('moves one internal segment as a guide and rejects a node crossing', () => {
    const route = [
      { x: 80, y: 30 },
      { x: 100, y: 30 },
      { x: 100, y: 100 },
      { x: 280, y: 100 },
      { x: 280, y: 30 },
      { x: 300, y: 30 },
    ];
    expect(orthogonalSegmentHandles(route).map(handle => handle.segmentIndex)).toEqual([1, 2, 3]);
    const safe = previewOrthogonalSegmentGuide(route, 2, { x: 0, y: 130 }, []);
    expect(safe).toMatchObject({ applied: true, diagnostic: 'applied' });
    expect(safe.points[2]!.y).toBe(130);
    expect(safe.points[3]!.y).toBe(130);

    const blocker = { x: 130, y: 115, width: 80, height: 30 };
    expect(previewOrthogonalSegmentGuide(route, 2, { x: 0, y: 130 }, [blocker])).toEqual({
      points: route,
      applied: false,
      diagnostic: 'blocked',
    });
  });

  it('keeps live guide endpoints attached when an adjacent guide crosses a node', () => {
    const endpoints = {
      source: { x: 0, y: 0, width: 80, height: 60 },
      target: { x: 300, y: 0, width: 80, height: 60 },
    };
    const route = [
      { x: 80, y: 30 },
      { x: 100, y: 30 },
      { x: 100, y: 100 },
      { x: 280, y: 100 },
      { x: 280, y: 30 },
      { x: 300, y: 30 },
    ];

    const sourceCrossing = previewOrthogonalSegmentGuide(route, 1, { x: -20, y: 0 }, [], endpoints);
    expect(sourceCrossing).toMatchObject({ applied: true, diagnostic: 'applied' });
    expect(sourceCrossing.points).toHaveLength(route.length);
    expect(sourceCrossing.points[0]).toEqual({ x: 0, y: 30 });
    expect(sourceCrossing.points[1]).toEqual({ x: -20, y: 30 });

    const sourceInterior = previewOrthogonalSegmentGuide(route, 1, { x: 40, y: 0 }, [], endpoints);
    expect(sourceInterior).toEqual({ points: route, applied: false, diagnostic: 'blocked' });

    const targetCrossing = previewOrthogonalSegmentGuide(route, 3, { x: 400, y: 0 }, [], endpoints);
    expect(targetCrossing).toMatchObject({ applied: true, diagnostic: 'applied' });
    expect(targetCrossing.points.at(-2)).toEqual({ x: 400, y: 30 });
    expect(targetCrossing.points.at(-1)).toEqual({ x: 380, y: 30 });
    expect(attachOrthogonalRouteEndpoints(sourceCrossing.points, endpoints)).toEqual(sourceCrossing.points);
  });

  it('commits the same safe guided route represented by the live preview', () => {
    const endpoints = {
      source: { x: 0, y: 0, width: 80, height: 60 },
      target: { x: 300, y: 0, width: 80, height: 60 },
    };
    const route = [
      { x: 80, y: 30 },
      { x: 100, y: 30 },
      { x: 100, y: 100 },
      { x: 280, y: 100 },
      { x: 280, y: 30 },
      { x: 300, y: 30 },
    ];
    const geometry: RelationshipRouteGeometry = {
      source: endpoints.source,
      target: endpoints.target,
      obstacles: [],
      clearance: 20,
      laneOffset: 0,
      maxPoints: 16,
      maxGridNodes: 20_000,
    };
    const preview = previewOrthogonalSegmentGuide(route, 2, { x: 0, y: 90 }, [], endpoints, geometry);
    const committed = routeOrthogonalWithIntent(geometry, preview.intent);

    expect(preview.applied).toBe(true);
    expect(preview.intent).toEqual({
      sourcePort: 'right',
      targetPort: 'left',
      waypoints: [{ x: 100, y: 90 }, { x: 280, y: 90 }],
    });
    expect(committed.status).toBe('applied');
    expect(committed.points).toEqual(preview.points);
  });

  it('previews the canonical compiler detour for a four-point endpoint-adjacent guide', () => {
    const clearance = 1.926214;
    const endpoints = {
      source: { x: 528, y: 346.742253, width: 26.406842, height: 20 },
      target: { x: 514.309164, y: 311.358398, width: 48.97298, height: 23.282606 },
    };
    const route = [
      { x: 541.203421, y: 346.742253 },
      { x: 541.203421, y: 336.567218 },
      { x: 538.795654, y: 336.567218 },
      { x: 538.795654, y: 334.641004 },
    ];
    const geometry: RelationshipRouteGeometry = {
      source: endpoints.source,
      target: endpoints.target,
      obstacles: [],
      clearance,
      laneOffset: 0,
      maxPoints: 16,
      maxGridNodes: 20_000,
    };

    const preview = previewOrthogonalSegmentGuide(
      route,
      1,
      { x: 0, y: 306.56723 },
      [],
      endpoints,
      geometry,
    );
    const committed = routeOrthogonalWithIntent(geometry, preview.intent);

    expect(preview.intent).toEqual({
      sourcePort: 'top',
      targetPort: 'top',
      waypoints: [
        { x: 541.203421, y: 306.56723 },
        { x: 538.795654, y: 306.56723 },
      ],
    });
    const expectedPreview = [
      { x: 541.203421, y: 346.742253 },
      { x: 541.203421, y: 344.816039 },
      { x: endpoints.target.x + endpoints.target.width + clearance, y: 344.816039 },
      { x: endpoints.target.x + endpoints.target.width + clearance, y: 306.56723 },
      { x: 538.795654, y: 306.56723 },
      { x: 538.795654, y: 311.358398 },
    ];
    expect(preview.points).toHaveLength(expectedPreview.length);
    preview.points.forEach((point, index) => {
      expect(point.x).toBeCloseTo(expectedPreview[index]!.x, 9);
      expect(point.y).toBeCloseTo(expectedPreview[index]!.y, 9);
    });
    expect(committed.status).toBe('applied');
    expect(committed.points).toEqual(preview.points);
  });
});
