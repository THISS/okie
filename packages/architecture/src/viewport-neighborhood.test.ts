import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cameraWorldRect,
  expandRectByTileRing,
  selectResidentVisualNodeIds,
  tileKeysForRect,
  VIEWPORT_RESIDENT_NODES_PER_BAND,
  VIEWPORT_TILE_WORLD_SIZE,
  viewportNeighborhoodCacheKey,
} from './viewport-neighborhood.js';

test('CLA-74: tile ring is one 512-world-unit cell around the camera', () => {
  assert.equal(VIEWPORT_TILE_WORLD_SIZE, 512);
  assert.equal(VIEWPORT_RESIDENT_NODES_PER_BAND, 50);
  const camera = cameraWorldRect({ x: 1000, y: 500, zoom: 1 }, { width: 400, height: 200 });
  assert.deepEqual(camera, { x: 800, y: 400, width: 400, height: 200 });
  const ring = expandRectByTileRing(camera);
  assert.deepEqual(ring, { x: 288, y: -112, width: 1424, height: 1224 });
  assert.ok(tileKeysForRect(ring).includes('1,0'));
});

test('CLA-74: L1/L2 never page; default L3/L4 stay unwindowed', () => {
  const packed = {
    a: { x: 0, y: 0, width: 10, height: 10 },
    b: { x: 1000, y: 0, width: 10, height: 10 },
  };
  const visualNodeById = {
    a: { kind: 'component' as const, entity: { logicalId: 'component:a' } },
    b: { kind: 'component' as const, entity: { logicalId: 'component:b' } },
  };
  assert.deepEqual(
    selectResidentVisualNodeIds({
      band: 'container',
      visualNodeIds: ['a', 'b'],
      packed,
      visualNodeById,
      focusEntityId: 'component:a',
      maxNodesPerBand: 1,
    }).residentIds,
    ['a', 'b'],
  );
  assert.deepEqual(
    selectResidentVisualNodeIds({
      band: 'code',
      visualNodeIds: ['a', 'b'],
      packed,
      visualNodeById,
      focusEntityId: 'component:a',
    }).omittedIds,
    [],
  );
});

test('CLA-74: L4 cap keeps focus and omits far siblings for +N more', () => {
  const packed = {
    focus: { x: 0, y: 0, width: 10, height: 10 },
    near: { x: 20, y: 0, width: 10, height: 10 },
    far: { x: 4000, y: 0, width: 10, height: 10 },
  };
  const visualNodeById = {
    focus: { kind: 'code' as const, entity: { logicalId: 'code:focus' }, parentVisualId: 'file' },
    near: { kind: 'code' as const, entity: { logicalId: 'code:near' }, parentVisualId: 'file' },
    far: { kind: 'code' as const, entity: { logicalId: 'code:far' }, parentVisualId: 'file' },
    file: { kind: 'component' as const, entity: { logicalId: 'component:file' } },
  };
  const packedWithParent = {
    ...packed,
    file: { x: 0, y: 0, width: 4010, height: 10 },
  };
  const selection = selectResidentVisualNodeIds({
    band: 'code',
    visualNodeIds: ['far', 'file', 'focus', 'near'],
    packed: packedWithParent,
    visualNodeById,
    focusEntityId: 'code:focus',
    maxNodesPerBand: 3,
  });
  assert.ok(selection.residentIds.includes('focus'));
  assert.ok(selection.residentIds.includes('file'));
  assert.ok(selection.residentIds.includes('near'));
  assert.deepEqual(selection.omittedIds, ['far']);
});

test('CLA-74: camera window pages a sibling neighborhood without taking the far dump', () => {
  const packed = {
    file: { x: 0, y: 0, width: 5000, height: 100 },
    a: { x: 0, y: 20, width: 10, height: 10 },
    b: { x: 600, y: 20, width: 10, height: 10 },
    c: { x: 4000, y: 20, width: 10, height: 10 },
  };
  const visualNodeById = {
    file: { kind: 'component' as const, entity: { logicalId: 'component:file' } },
    a: { kind: 'code' as const, entity: { logicalId: 'code:a' }, parentVisualId: 'file' },
    b: { kind: 'code' as const, entity: { logicalId: 'code:b' }, parentVisualId: 'file' },
    c: { kind: 'code' as const, entity: { logicalId: 'code:c' }, parentVisualId: 'file' },
  };
  const left = selectResidentVisualNodeIds({
    band: 'code',
    visualNodeIds: ['a', 'b', 'c', 'file'],
    packed,
    visualNodeById,
    focusEntityId: 'component:file',
    residentWorldBounds: expandRectByTileRing({ x: 0, y: 0, width: 200, height: 200 }),
  });
  assert.ok(left.residentIds.includes('a'));
  assert.ok(left.residentIds.includes('file'));
  assert.ok(left.omittedIds.includes('c'));
  const right = selectResidentVisualNodeIds({
    band: 'code',
    visualNodeIds: ['a', 'b', 'c', 'file'],
    packed,
    visualNodeById,
    focusEntityId: 'component:file',
    residentWorldBounds: expandRectByTileRing({ x: 3900, y: 0, width: 200, height: 200 }),
  });
  assert.ok(right.residentIds.includes('c'));
  assert.ok(!left.residentIds.includes('c') || !right.residentIds.includes('a'));
});

test('CLA-74: cache key follows camera tiles, not the full graph', () => {
  const left = viewportNeighborhoodCacheKey('component:file', { x: 0, y: 0, zoom: 1 }, { width: 100, height: 100 });
  const pan = viewportNeighborhoodCacheKey('component:file', { x: 2000, y: 0, zoom: 1 }, { width: 100, height: 100 });
  const same = viewportNeighborhoodCacheKey('component:file', { x: 10, y: 0, zoom: 1 }, { width: 100, height: 100 });
  assert.notEqual(left, pan);
  assert.equal(left, same);
  assert.match(left, /^component:file@/);
});
