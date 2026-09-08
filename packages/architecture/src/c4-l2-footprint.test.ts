import assert from 'node:assert/strict';
import test from 'node:test';
import {
  C4_BAND_FOCUS_ZOOM,
  C4_INTRINSIC_LAYOUT,
  C4_SCAN_L2_PEER_TILE_CHILD_COMFORT,
  c4ScanContainerPeerTile,
  c4ScanContainerPeerTileBase,
} from './c4.js';

test('CLA-119: compact L2 peer tile is the 224×112 leaf at container focus', () => {
  const base = c4ScanContainerPeerTileBase();
  assert.equal(base.width, C4_INTRINSIC_LAYOUT.leaf.code.width / C4_BAND_FOCUS_ZOOM.container);
  assert.equal(base.height, C4_INTRINSIC_LAYOUT.leaf.code.height / C4_BAND_FOCUS_ZOOM.container);
  assert.equal(C4_SCAN_L2_PEER_TILE_CHILD_COMFORT, 9);
});

test('CLA-119: thin containers stay at the compact leaf', () => {
  const base = c4ScanContainerPeerTileBase();
  for (const n of [0, 1, 4, 9]) {
    const tile = c4ScanContainerPeerTile(n);
    assert.equal(tile.width, base.width, `N=${n} width stays compact`);
    assert.equal(tile.height, base.height, `N=${n} height stays compact`);
  }
});

test('CLA-119: fat containers get larger footprints than thin ones (edge ∝ √N)', () => {
  const thin = c4ScanContainerPeerTile(4);
  const server = c4ScanContainerPeerTile(8);
  const web = c4ScanContainerPeerTile(79);
  const base = c4ScanContainerPeerTileBase();
  assert.equal(thin.width, base.width);
  assert.ok(web.width > server.width, `@okie/web (79) must be wider than @okie/server (8)`);
  assert.ok(web.height > server.height, `@okie/web (79) must be taller than @okie/server (8)`);
  const expectedScale = Math.sqrt(79 / C4_SCAN_L2_PEER_TILE_CHILD_COMFORT);
  assert.ok(Math.abs(web.width / base.width - expectedScale) < 1e-9);
  assert.ok(Math.abs(web.height / base.height - expectedScale) < 1e-9);
  assert.ok(web.width / base.width < 4, 'soft √N, not a full treemap of 79 full-size cards');
  assert.ok(web.height > thin.height * 2, '79 children more than doubles the compact leaf');
});

test('CLA-119: equal child counts stay equal; scale is deterministic', () => {
  const a = c4ScanContainerPeerTile(24);
  const b = c4ScanContainerPeerTile(24);
  assert.deepEqual(a, b);
  const twice = c4ScanContainerPeerTile(36);
  const once = c4ScanContainerPeerTile(9);
  assert.ok(Math.abs(twice.width / once.width - Math.sqrt(36 / 9)) < 1e-9);
});
