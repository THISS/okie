import assert from 'node:assert/strict';
import test from 'node:test';
import type { NodeLayout, Point } from './model.js';
import {
  routeC4BandEdgesDetailed,
  type BandProjection,
  type VisualEdge,
  type VisualNode,
} from './c4.js';

const entityRef = (id: string) => ({ snapshotEntityId: id, logicalId: id, lineageId: id });

const projection: BandProjection = {
  id: 'band-projection:gutter:code',
  familyId: 'view-family:gutter',
  snapshotId: 'snapshot:gutter',
  band: 'code',
  rootEntity: entityRef('system:root'),
  focusEntity: entityRef('component:file'),
  visualNodeIds: ['visual:file', 'visual:alpha', 'visual:beta'],
  visualEdgeIds: ['visual-edge:dup'],
  contextNodeIds: [],
  layoutId: 'band-layout:gutter',
};

const visualNodeById: Record<string, VisualNode> = {
  'visual:file': {
    id: 'visual:file',
    entity: entityRef('component:file'),
    kind: 'component',
    name: 'file',
    technology: [],
  },
  'visual:alpha': {
    id: 'visual:alpha',
    entity: entityRef('code:alpha'),
    kind: 'code',
    name: 'alpha',
    technology: [],
    parentVisualId: 'visual:file',
  },
  'visual:beta': {
    id: 'visual:beta',
    entity: entityRef('code:beta'),
    kind: 'code',
    name: 'beta',
    technology: [],
    parentVisualId: 'visual:file',
  },
};

const focusZoom = 13.96;
const clearance = 8 / focusZoom;
const siblingGap = 16 / focusZoom;

const packed: Record<string, NodeLayout> = {
  'visual:file': { x: -4, y: -8, width: 40, height: 24 },
  'visual:alpha': { x: 0, y: 0, width: 16, height: 8 },
  'visual:beta': { x: 16 + siblingGap, y: 0, width: 16, height: 8 },
};

function edge(kind: VisualEdge['kind']): VisualEdge {
  return {
    id: 'visual-edge:dup',
    projectionId: projection.id,
    fromVisualId: 'visual:alpha',
    toVisualId: 'visual:beta',
    kind,
    label: kind,
    relations: [{ snapshotRelationId: `relation:${kind}`, logicalId: `relation:${kind}`, lineageId: `relation:${kind}` }],
    aggregate: {
      count: 1,
      kinds: [kind],
      labels: [kind],
      technologies: [],
      optionalCount: 0,
    },
  };
}

function extent(points: readonly Point[]) {
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function route(kind: VisualEdge['kind']) {
  return routeC4BandEdgesDetailed(
    projection,
    visualNodeById,
    { 'visual-edge:dup': edge(kind) },
    packed,
    { clearance, laneSpacing: 0.7, maxPoints: 16 },
  ).edges['visual-edge:dup']!;
}

test('CLA-68: tight L4 duplicates leave the inter-card gutter instead of a 1px side hop', () => {
  const gutter = packed['visual:beta']!.x - (packed['visual:alpha']!.x + packed['visual:alpha']!.width);
  const duplicates = route('duplicates');
  const span = extent(duplicates.points);
  const left = packed['visual:alpha']!;
  const right = packed['visual:beta']!;
  const confinedToGutter = duplicates.points.every(point => (
    point.x >= left.x + left.width - 1e-6
    && point.x <= right.x + 1e-6
    && point.y >= left.y - 1e-6
    && point.y <= left.y + left.height + 1e-6
  ));

  assert.ok(duplicates.points.length >= 2);
  assert.ok(gutter <= clearance * 2 + 1e-9, 'fixture must reproduce the packed L4 gutter');
  assert.equal(confinedToGutter, false, 'duplicates stroke must leave the facing gutter slab');
  assert.ok(
    span.width > gutter * 4,
    `duplicates path must span the sibling cards, not the facing hop (width ${span.width.toFixed(3)} vs gutter ${gutter.toFixed(3)})`,
  );
});

test('CLA-68: other L4 kinds keep the existing orthogonal hop in the same packing', () => {
  const gutter = packed['visual:beta']!.x - (packed['visual:alpha']!.x + packed['visual:alpha']!.width);
  const calls = route('calls');
  const span = extent(calls.points);

  assert.ok(span.width <= gutter + clearance * 2 + 1e-9, 'calls must still use the facing corridor');
  assert.ok(span.height <= clearance * 2 + 1e-6, 'calls must not pick up the duplicates loop');
});

test('CLA-68: far-apart duplicates keep auto routing', () => {
  const far = {
    ...packed,
    'visual:file': { x: -4, y: -8, width: 80, height: 24 },
    'visual:beta': { x: 48, y: 0, width: 16, height: 8 },
  };
  const result = routeC4BandEdgesDetailed(
    projection,
    visualNodeById,
    { 'visual-edge:dup': edge('duplicates') },
    far,
    { clearance, laneSpacing: 0.7, maxPoints: 16 },
  ).edges['visual-edge:dup']!;
  const auto = routeC4BandEdgesDetailed(
    projection,
    visualNodeById,
    { 'visual-edge:dup': edge('calls') },
    far,
    { clearance, laneSpacing: 0.7, maxPoints: 16 },
  ).edges['visual-edge:dup']!;
  assert.deepEqual(result.points, auto.points);
});

test('CLA-68: stacked L4 duplicates leave the row gutter along the free side', () => {
  const stacked = {
    'visual:file': { x: -4, y: -8, width: 24, height: 40 },
    'visual:alpha': { x: 0, y: 0, width: 16, height: 8 },
    'visual:beta': { x: 0, y: 8 + siblingGap, width: 16, height: 8 },
  };
  const duplicates = routeC4BandEdgesDetailed(
    { ...projection, visualEdgeIds: ['visual-edge:dup'] },
    visualNodeById,
    { 'visual-edge:dup': edge('duplicates') },
    stacked,
    { clearance, laneSpacing: 0.7, maxPoints: 16 },
  ).edges['visual-edge:dup']!;
  const span = extent(duplicates.points);
  const confinedToGutter = duplicates.points.every(point => (
    point.y >= 8 - 1e-6
    && point.y <= 8 + siblingGap + 1e-6
    && point.x >= -1e-6
    && point.x <= 16 + 1e-6
  ));
  assert.equal(confinedToGutter, false);
  assert.ok(span.height > siblingGap * 4);
});
