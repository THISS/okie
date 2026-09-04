import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASPECT_PRESET_TARGET,
  C4_INTRINSIC_LAYOUT,
  C4_SCAN_CODE_GAP_EXTRA_PX,
  buildC4ProjectionBundle,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
} from '@okie/architecture';
import { C4_ZOOM_BANDS, compileC4Scene } from './compile-c4.js';

const evidence = [{ source: { path: 'src/icons.tsx', commitSha: 'c' } }];

/** Public export surface of apps/web/src/icons.tsx — 20 helpers, PauseIcon next to PlayIcon. */
const ICON_NAMES = [
  'ActivityIcon', 'ArrowIcon', 'CheckIcon', 'ChevronIcon', 'CloseIcon',
  'CodeIcon', 'FileIcon', 'FitIcon', 'ImageIcon', 'InfoIcon',
  'LayersIcon', 'PanelIcon', 'PauseIcon', 'PlayIcon', 'RestartIcon',
  'SearchIcon', 'ShareIcon', 'SparkIcon', 'ZoomInIcon', 'ZoomOutIcon',
] as const;

function packedFileSnapshot(names: readonly string[] = ['alpha', 'beta', 'gamma', 'delta']): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    { id: 'system:d', kind: 'softwareSystem', name: 'D', sourceRefs: [] },
    { id: 'container:c', kind: 'container', parentId: 'system:d', name: 'C', sourceRefs: [] },
    { id: 'component:icons', kind: 'component', parentId: 'container:c', name: 'icons.tsx', sourceRefs: [] },
  ];
  for (const name of names) {
    entities.push({
      id: `code:${name}`,
      kind: 'code',
      parentId: 'component:icons',
      name,
      sourceRefs: [],
    });
  }
  const [left, right] = names.includes('PauseIcon') && names.includes('PlayIcon')
    ? ['PauseIcon', 'PlayIcon'] as const
    : [names[0]!, names[1]!] as const;
  return {
    schemaVersion: 1,
    id: 'snapshot:duplicates-gutter',
    repositoryId: 'repo:duplicates-gutter',
    commitSha: 'c',
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities,
    relations: [{
      id: `relation:dup:${left}-${right}`,
      from: `code:${left}`,
      to: `code:${right}`,
      kind: 'duplicates',
      label: 'duplicates',
      evidence,
    }],
  };
}

function pathExtent(points: readonly { x: number; y: number }[]) {
  const xs = points.map(point => point.x);
  const ys = points.map(point => point.y);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

test('CLA-68: compiled L4 sibling duplicates leave the packed code-card gutter', () => {
  const snapshot = packedFileSnapshot();
  const targetAspect = ASPECT_PRESET_TARGET.landscape;
  const bundle = buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:d',
    focusEntityId: 'component:icons',
    familyId: 'view-family:duplicates-gutter',
    targetAspect,
  });
  const compiled = compileC4Scene(snapshot, bundle, { targetAspect });
  const layout = compiled.projections.bandLayoutById[
    compiled.projections.projectionById[compiled.projections.family.projectionIds.code]!.layoutId
  ]!;
  const alphaId = compiled.projections.index.visualNodeIdsByEntityId['code:alpha']![0]!;
  const betaId = compiled.projections.index.visualNodeIdsByEntityId['code:beta']![0]!;
  const edgeId = compiled.projections.index.visualEdgeIdsByRelationId['relation:dup:alpha-beta']![0]!;
  const alpha = layout.nodes[alphaId]!;
  const beta = layout.nodes[betaId]!;
  const route = layout.edges[edgeId]!;
  const clearance = 8 / C4_ZOOM_BANDS[3]!.focusZoom;
  const dx = (beta.x + beta.width / 2) - (alpha.x + alpha.width / 2);
  const dy = (beta.y + beta.height / 2) - (alpha.y + alpha.height / 2);
  const horizontalGap = dx >= 0 ? beta.x - (alpha.x + alpha.width) : alpha.x - (beta.x + beta.width);
  const verticalGap = dy >= 0 ? beta.y - (alpha.y + alpha.height) : alpha.y - (beta.y + beta.height);
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const facing = horizontal ? horizontalGap : verticalGap;
  const confinedToGutter = horizontal
    ? route.points.every(point => (
      point.x >= Math.min(alpha.x + alpha.width, beta.x + beta.width) - 1e-6
      && point.x <= Math.max(alpha.x, beta.x) + 1e-6
      && point.y >= Math.max(alpha.y, beta.y) - 1e-6
      && point.y <= Math.min(alpha.y + alpha.height, beta.y + beta.height) + 1e-6
    ))
    : route.points.every(point => (
      point.y >= Math.min(alpha.y + alpha.height, beta.y + beta.height) - 1e-6
      && point.y <= Math.max(alpha.y, beta.y) + 1e-6
      && point.x >= Math.max(alpha.x, beta.x) - 1e-6
      && point.x <= Math.min(alpha.x + alpha.width, beta.x + beta.width) + 1e-6
    ));
  const span = pathExtent(route.points);
  const longSpan = horizontal ? span.width : span.height;
  const loopSpan = horizontal ? span.height : span.width;
  const packedGutter = (C4_INTRINSIC_LAYOUT.gap + C4_SCAN_CODE_GAP_EXTRA_PX) / C4_ZOOM_BANDS[3]!.focusZoom;

  assert.ok(facing > 0, 'clone siblings must remain separate cards');
  assert.ok(facing <= packedGutter + 1e-6, `packed L4 gutter should stay the scan code gap (${facing.toFixed(3)} world)`);
  assert.equal(confinedToGutter, false, 'compiled duplicates stroke must leave the facing gutter');
  assert.ok(
    longSpan > facing * 2,
    `duplicates stroke must span the sibling cards (extent ${span.width.toFixed(3)}×${span.height.toFixed(3)}, gutter ${facing.toFixed(3)})`,
  );
  assert.ok(
    loopSpan >= clearance - 1e-6,
    `duplicates U must leave the packed gutter on the free axis (extent ${span.width.toFixed(3)}×${span.height.toFixed(3)}, gutter ${facing.toFixed(3)})`,
  );
  const across = route.points
    .slice(0, -1)
    .map((point, index) => ({ start: point, end: route.points[index + 1]! }))
    .filter(segment => (
      horizontal
        ? Math.abs(segment.start.y - segment.end.y) <= 1e-6
        : Math.abs(segment.start.x - segment.end.x) <= 1e-6
    ))
    .map(segment => ({
      along: horizontal ? segment.start.y : segment.start.x,
      length: horizontal
        ? Math.abs(segment.end.x - segment.start.x)
        : Math.abs(segment.end.y - segment.start.y),
    }))
    .sort((left, right) => right.length - left.length)[0];
  const pairOuter = horizontal
    ? Math.max(alpha.y + alpha.height, beta.y + beta.height)
    : Math.max(alpha.x + alpha.width, beta.x + beta.width);
  assert.ok(across, 'compiled duplicates U must have an across segment');
  assert.ok(
    Math.abs(across.along - pairOuter) <= packedGutter + 1e-6,
    `compiled duplicates across must stay next to the pair (along ${across.along.toFixed(3)} vs pair ${pairOuter.toFixed(3)})`,
  );
  assert.notEqual(compiled.projections.visualEdgeById[edgeId]!.kind, 'calls');
  assert.equal(
    snapshot.entities.filter(entity => entity.kind === 'code').length,
    4,
    'clone overlay must not mint extra code nodes',
  );
});

test('CLA-68: compiled icons.tsx packing keeps a readable U between abutting PauseIcon and PlayIcon', () => {
  const snapshot = packedFileSnapshot(ICON_NAMES);
  const targetAspect = ASPECT_PRESET_TARGET.landscape;
  const bundle = buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:d',
    focusEntityId: 'component:icons',
    familyId: 'view-family:duplicates-gutter-icons',
    targetAspect,
  });
  const compiled = compileC4Scene(snapshot, bundle, { targetAspect });
  const layout = compiled.projections.bandLayoutById[
    compiled.projections.projectionById[compiled.projections.family.projectionIds.code]!.layoutId
  ]!;
  const pauseId = compiled.projections.index.visualNodeIdsByEntityId['code:PauseIcon']![0]!;
  const playId = compiled.projections.index.visualNodeIdsByEntityId['code:PlayIcon']![0]!;
  const edgeId = compiled.projections.index.visualEdgeIdsByRelationId['relation:dup:PauseIcon-PlayIcon']![0]!;
  const pause = layout.nodes[pauseId]!;
  const play = layout.nodes[playId]!;
  const route = layout.edges[edgeId]!;
  const enterZoom = C4_ZOOM_BANDS[3]!.enterZoom;
  const dx = (play.x + play.width / 2) - (pause.x + pause.width / 2);
  const dy = (play.y + play.height / 2) - (pause.y + pause.height / 2);
  const horizontal = Math.abs(dx) >= Math.abs(dy);
  const facing = horizontal
    ? (dx >= 0 ? play.x - (pause.x + pause.width) : pause.x - (play.x + play.width))
    : (dy >= 0 ? play.y - (pause.y + pause.height) : pause.y - (play.y + play.height));
  const confinedToGutter = horizontal
    ? route.points.every(point => (
      point.x >= Math.min(pause.x + pause.width, play.x + play.width) - 1e-6
      && point.x <= Math.max(pause.x, play.x) + 1e-6
      && point.y >= Math.max(pause.y, play.y) - 1e-6
      && point.y <= Math.min(pause.y + pause.height, play.y + play.height) + 1e-6
    ))
    : false;
  const span = pathExtent(route.points);
  const loopCssEnter = (horizontal ? span.height : span.width) * enterZoom;

  assert.equal(horizontal, true, 'PauseIcon and PlayIcon must sit on the same packed row');
  assert.ok(facing > 0, 'clone siblings must remain separate cards');
  assert.equal(confinedToGutter, false, 'duplicates stroke must leave the 1px facing gutter');
  assert.ok(
    loopCssEnter >= 16,
    `duplicates U must survive 6px corner rounding (${loopCssEnter.toFixed(1)}px at code enter ${enterZoom})`,
  );
  assert.equal(
    snapshot.entities.filter(entity => entity.kind === 'code').length,
    ICON_NAMES.length,
    'clone overlay must not mint extra code nodes',
  );
});

test('CLA-68: code-band edge budget keeps sibling duplicates ahead of uses', () => {
  const snapshot = packedFileSnapshot();
  const names = ['alpha', 'beta', 'gamma', 'delta'];
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      snapshot.relations.push({
        id: `relation:uses:${names[i]}-${names[j]}`,
        from: `code:${names[i]}`,
        to: `code:${names[j]}`,
        kind: 'uses',
        label: 'uses',
        evidence,
      });
    }
  }
  const targetAspect = ASPECT_PRESET_TARGET.landscape;
  const bundle = buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:d',
    focusEntityId: 'component:icons',
    familyId: 'view-family:duplicates-gutter-budget',
    targetAspect,
    maxEdgesPerBand: 1,
  });
  const code = bundle.projectionById[bundle.family.projectionIds.code]!;
  const dupId = bundle.index.visualEdgeIdsByRelationId['relation:dup:alpha-beta']![0]!;
  assert.ok(code.visualEdgeIds.includes(dupId), 'duplicates must remain routed under a tight code-band budget');
  assert.equal(code.visualEdgeIds.length, 1);
  assert.equal(bundle.visualEdgeById[dupId]!.kind, 'duplicates');
});

test('CLA-68: heavier uses still outrank a count-1 duplicates pair under the code-band budget', () => {
  const snapshot = packedFileSnapshot();
  snapshot.relations.push(
    {
      id: 'relation:uses:gamma-delta-a',
      from: 'code:gamma',
      to: 'code:delta',
      kind: 'uses',
      label: 'uses',
      evidence,
    },
    {
      id: 'relation:uses:gamma-delta-b',
      from: 'code:gamma',
      to: 'code:delta',
      kind: 'uses',
      label: 'uses',
      evidence,
    },
  );
  const targetAspect = ASPECT_PRESET_TARGET.landscape;
  const bundle = buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:d',
    focusEntityId: 'component:icons',
    familyId: 'view-family:duplicates-gutter-budget-count',
    targetAspect,
    maxEdgesPerBand: 1,
  });
  const code = bundle.projectionById[bundle.family.projectionIds.code]!;
  const usesId = bundle.index.visualEdgeIdsByRelationId['relation:uses:gamma-delta-a']![0]!;
  const dupId = bundle.index.visualEdgeIdsByRelationId['relation:dup:alpha-beta']![0]!;
  assert.ok(code.visualEdgeIds.includes(usesId), 'count-2 uses must keep the last budget slot');
  assert.equal(code.visualEdgeIds.includes(dupId), false, 'count-1 duplicates must not beat heavier uses');
  assert.equal(code.visualEdgeIds.length, 1);
  assert.equal(bundle.visualEdgeById[usesId]!.kind, 'uses');
  assert.equal(bundle.visualEdgeById[usesId]!.aggregate.count, 2);
});
