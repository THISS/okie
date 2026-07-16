import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyArchitectureAuthoringCommand,
  buildC4ProjectionBundle,
  createArchitectureAuthoringDocument,
  relationRouteOverrideId,
  type C4Band,
  type C4ProjectionBundle,
  type RelationRouteOverride,
} from '@okie/architecture';
import { compileAuthoredC4Scene, compileC4Scene, type CompiledC4Scene } from './compile-c4.js';
import { goldenSnapshot } from './golden-fixture.js';

const buildOptions = {
  rootEntityId: 'system:okie',
  focusEntityId: 'system:okie',
  familyId: 'view:authoring-test',
};

function edgeIdForRelation(bundle: C4ProjectionBundle, band: C4Band, relationId: string): string | undefined {
  const projection = bundle.projectionById[bundle.family.projectionIds[band]]!;
  return projection.visualEdgeIds.find(id => bundle.visualEdgeById[id]!.relations
    .some(relation => relation.logicalId === relationId));
}

function routeForRelation(compiled: CompiledC4Scene, band: C4Band, relationId: string) {
  const projection = compiled.projections.projectionById[compiled.projections.family.projectionIds[band]]!;
  const edgeId = edgeIdForRelation(compiled.projections, band, relationId);
  assert.ok(edgeId, `${relationId} must be visible at ${band}`);
  return {
    edgeId,
    edge: compiled.projections.visualEdgeById[edgeId],
    layout: compiled.projections.bandLayoutById[projection.layoutId]!,
    route: compiled.projections.bandLayoutById[projection.layoutId]!.edges[edgeId]!,
  };
}

function pointIsOnBoundary(
  point: { x: number; y: number },
  bounds: { x: number; y: number; width: number; height: number },
  epsilon = 0.001,
): boolean {
  const withinX = point.x >= bounds.x - epsilon && point.x <= bounds.x + bounds.width + epsilon;
  const withinY = point.y >= bounds.y - epsilon && point.y <= bounds.y + bounds.height + epsilon;
  const vertical = Math.abs(point.x - bounds.x) <= epsilon
    || Math.abs(point.x - (bounds.x + bounds.width)) <= epsilon;
  const horizontal = Math.abs(point.y - bounds.y) <= epsilon
    || Math.abs(point.y - (bounds.y + bounds.height)) <= epsilon;
  return (withinY && vertical) || (withinX && horizontal);
}

function override(
  intent: RelationRouteOverride['intent'],
  visualEdgeId?: string,
): RelationRouteOverride {
  const scope = {
    viewId: buildOptions.familyId,
    detail: 'container' as const,
    relationId: 'relation:model-to-compiler',
    ...(visualEdgeId !== undefined ? { visualEdgeId } : {}),
  };
  return { ...scope, id: relationRouteOverrideId(scope), intent };
}

test('authored relation creation, reconnect, and deletion compile without mutating extracted facts', () => {
  const original = structuredClone(goldenSnapshot);
  const empty = createArchitectureAuthoringDocument(goldenSnapshot.repositoryId);
  const contextAuthored = applyArchitectureAuthoringCommand(empty, {
    type: 'put-relation',
    relation: {
      id: 'relation:user-context-peers',
      from: 'actor:developer',
      to: 'external:source-repository',
      kind: 'uses',
      label: 'authors a visible context relationship',
    },
  }).document;
  const contextCompiled = compileAuthoredC4Scene(goldenSnapshot, contextAuthored, buildOptions);
  assert.ok(edgeIdForRelation(contextCompiled.projections, 'context', 'relation:user-context-peers'),
    'relations authored between visible context peers must project even when neither endpoint is the focus');

  const created = applyArchitectureAuthoringCommand(empty, {
    type: 'put-relation',
    relation: {
      id: 'relation:user-web-model',
      from: 'container:web-app',
      to: 'container:architecture-model',
      kind: 'calls',
      label: 'authors relationship intent',
    },
  }).document;
  const first = compileAuthoredC4Scene(goldenSnapshot, created, buildOptions);
  assert.ok(edgeIdForRelation(first.projections, 'container', 'relation:user-web-model'));
  assert.deepEqual(goldenSnapshot, original);

  const reconnected = applyArchitectureAuthoringCommand(created, {
    type: 'put-relation',
    relation: {
      id: 'relation:user-web-model',
      from: 'container:web-app',
      to: 'container:scene-compiler',
      kind: 'calls',
      label: 'authors relationship intent',
    },
  }).document;
  const second = compileAuthoredC4Scene(goldenSnapshot, reconnected, buildOptions);
  const reconnectedEdgeId = edgeIdForRelation(second.projections, 'container', 'relation:user-web-model');
  assert.ok(reconnectedEdgeId);
  const reconnectedEdge = second.projections.visualEdgeById[reconnectedEdgeId]!;
  assert.equal(second.projections.index.entityIdByVisualNodeId[reconnectedEdge.toVisualId], 'container:scene-compiler');

  const deleted = applyArchitectureAuthoringCommand(reconnected, {
    type: 'delete-relation',
    relationId: 'relation:user-web-model',
  }).document;
  const third = compileAuthoredC4Scene(goldenSnapshot, deleted, buildOptions);
  assert.equal(edgeIdForRelation(third.projections, 'container', 'relation:user-web-model'), undefined);

  const extractedDeleted = applyArchitectureAuthoringCommand(empty, {
    type: 'delete-relation',
    relationId: 'relation:model-to-compiler',
  }).document;
  const withoutExtracted = compileAuthoredC4Scene(goldenSnapshot, extractedDeleted, buildOptions);
  assert.equal(edgeIdForRelation(withoutExtracted.projections, 'container', 'relation:model-to-compiler'), undefined);
});

test('compiler consumes preferred ports and reset restores the canonical automatic route', () => {
  const baseline = compileC4Scene(
    goldenSnapshot,
    buildC4ProjectionBundle(goldenSnapshot, buildOptions),
  );
  assert.equal('routeDiagnostics' in baseline, false, 'no-override scene bytes must retain their previous shape');
  const automatic = routeForRelation(baseline, 'container', 'relation:model-to-compiler');
  const empty = createArchitectureAuthoringDocument(goldenSnapshot.repositoryId);
  const preferred = override({ sourcePort: 'bottom', targetPort: 'bottom', waypoints: [] });
  const routedDocument = applyArchitectureAuthoringCommand(empty, {
    type: 'put-route-override',
    override: preferred,
  }).document;
  const routed = compileAuthoredC4Scene(goldenSnapshot, routedDocument, buildOptions);
  const guided = routeForRelation(routed, 'container', 'relation:model-to-compiler');

  assert.notDeepEqual(guided.route.points, automatic.route.points);
  assert.deepEqual(routed.routeDiagnostics, [{
    overrideId: preferred.id,
    detail: 'container',
    status: 'applied',
    visualEdgeId: guided.edgeId,
    routerDiagnostic: 'grid',
  }]);
  assert.equal(pointIsOnBoundary(guided.route.points[0]!, guided.layout.nodes[guided.edge!.fromVisualId]!), true);
  assert.equal(pointIsOnBoundary(guided.route.points.at(-1)!, guided.layout.nodes[guided.edge!.toVisualId]!), true);

  const aggregateSpecific = override({ sourcePort: 'top', targetPort: 'top', waypoints: [] }, automatic.edgeId);
  const layeredDocument = applyArchitectureAuthoringCommand(routedDocument, {
    type: 'put-route-override',
    override: aggregateSpecific,
  }).document;
  const layered = compileAuthoredC4Scene(goldenSnapshot, layeredDocument, buildOptions);
  const layeredRoute = routeForRelation(layered, 'container', 'relation:model-to-compiler');
  assert.equal(layeredRoute.route.points[0]!.y, layeredRoute.layout.nodes[layeredRoute.edge!.fromVisualId]!.y,
    'an aggregate-specific override must take precedence over its relation-wide override');
  assert.deepEqual(layered.routeDiagnostics?.map(value => ({ id: value.overrideId, status: value.status, reason: value.reason })), [{
    id: preferred.id,
    status: 'stale',
    reason: 'superseded',
  }, {
    id: aggregateSpecific.id,
    status: 'applied',
    reason: undefined,
  }]);

  const resetDocument = applyArchitectureAuthoringCommand(routedDocument, {
    type: 'reset-route-override',
    overrideId: preferred.id,
  }).document;
  const reset = compileAuthoredC4Scene(goldenSnapshot, resetDocument, buildOptions);
  assert.deepEqual(routeForRelation(reset, 'container', 'relation:model-to-compiler').route, automatic.route);
  assert.deepEqual(reset.routeDiagnostics, []);
});

test('stale visual targets and unsafe waypoints fall back to auto routes with stable diagnostics', () => {
  const baseline = compileC4Scene(
    goldenSnapshot,
    buildC4ProjectionBundle(goldenSnapshot, buildOptions),
  );
  const automatic = routeForRelation(baseline, 'container', 'relation:model-to-compiler');
  const empty = createArchitectureAuthoringDocument(goldenSnapshot.repositoryId);

  const stale = override({ sourcePort: 'bottom', waypoints: [] }, 'visual-edge:removed-by-new-projection');
  const staleDocument = applyArchitectureAuthoringCommand(empty, {
    type: 'put-route-override',
    override: stale,
  }).document;
  const staleCompiled = compileAuthoredC4Scene(goldenSnapshot, staleDocument, buildOptions);
  assert.deepEqual(routeForRelation(staleCompiled, 'container', 'relation:model-to-compiler').route, automatic.route);
  assert.deepEqual(staleCompiled.routeDiagnostics, [{
    overrideId: stale.id,
    detail: 'container',
    status: 'stale',
    reason: 'edge-not-visible',
  }]);

  const sourceBounds = automatic.layout.nodes[automatic.edge!.fromVisualId]!;
  const unsafe = override({
    waypoints: [{
      x: sourceBounds.x + sourceBounds.width / 2,
      y: sourceBounds.y + sourceBounds.height / 2,
    }],
  });
  const unsafeDocument = applyArchitectureAuthoringCommand(empty, {
    type: 'put-route-override',
    override: unsafe,
  }).document;
  const unsafeCompiled = compileAuthoredC4Scene(goldenSnapshot, unsafeDocument, buildOptions);
  assert.deepEqual(routeForRelation(unsafeCompiled, 'container', 'relation:model-to-compiler').route, automatic.route);
  assert.deepEqual(unsafeCompiled.routeDiagnostics, [{
    overrideId: unsafe.id,
    detail: 'container',
    status: 'fallback',
    visualEdgeId: automatic.edgeId,
    reason: 'waypoint-inside-obstacle',
    routerDiagnostic: 'grid',
  }]);
});

test('authored compilation rejects invalid documents before projection', () => {
  const invalid = createArchitectureAuthoringDocument(goldenSnapshot.repositoryId);
  invalid.relations.push({
    id: 'relation:invalid',
    from: 'container:missing',
    to: 'container:web-app',
    kind: 'calls',
  });
  assert.throws(
    () => compileAuthoredC4Scene(goldenSnapshot, invalid, buildOptions),
    /Invalid architecture authoring document:\nrelations\[0\]\.from: unknown entity/,
  );
});
