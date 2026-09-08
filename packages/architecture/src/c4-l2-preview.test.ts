import assert from 'node:assert/strict';
import test from 'node:test';
import {
  C4_SCAN_L2_PEER_TILE_CHILD_COMFORT,
  C4_SCAN_L2_RESIDENT_PREVIEW_PILLS,
  c4ScanContainerPeerTile,
  selectL2ResidentPreviewPills,
} from './c4.js';

test('CLA-120: L2 preview cap sits in the 8–12 landmark window', () => {
  assert.equal(C4_SCAN_L2_RESIDENT_PREVIEW_PILLS, 10);
  assert.ok(C4_SCAN_L2_RESIDENT_PREVIEW_PILLS >= 8);
  assert.ok(C4_SCAN_L2_RESIDENT_PREVIEW_PILLS <= 12);
  assert.equal(C4_SCAN_L2_PEER_TILE_CHILD_COMFORT, 9);
});

test('CLA-120: per-owner cap keeps landmarks and omits the rest for +N more', () => {
  const visualNodeById = {
    system: { kind: 'softwareSystem' as const, entity: { logicalId: 'system:okie' } },
    web: { kind: 'container' as const, entity: { logicalId: 'container:web' }, parentVisualId: 'system' },
    server: { kind: 'container' as const, entity: { logicalId: 'container:server' }, parentVisualId: 'system' },
  } as Record<string, { kind: 'softwareSystem' | 'container' | 'component' | 'code'; entity: { logicalId: string }; parentVisualId?: string }>;
  const ids = ['system', 'web', 'server'];
  for (let index = 0; index < 79; index += 1) {
    const id = `web-${String(index).padStart(2, '0')}`;
    visualNodeById[id] = { kind: 'component', entity: { logicalId: `component:${id}` }, parentVisualId: 'web' };
    visualNodeById[`code-${id}`] = { kind: 'code', entity: { logicalId: `code:${id}` }, parentVisualId: id };
    ids.push(id, `code-${id}`);
  }
  for (let index = 0; index < 8; index += 1) {
    const id = `server-${index}`;
    visualNodeById[id] = { kind: 'component', entity: { logicalId: `component:${id}` }, parentVisualId: 'server' };
    ids.push(id);
  }
  // Heavier landmark should beat a later id.
  visualNodeById['code-web-70-a'] = { kind: 'code', entity: { logicalId: 'code:heavy-a' }, parentVisualId: 'web-70' };
  visualNodeById['code-web-70-b'] = { kind: 'code', entity: { logicalId: 'code:heavy-b' }, parentVisualId: 'web-70' };
  ids.push('code-web-70-a', 'code-web-70-b');

  const selection = selectL2ResidentPreviewPills({
    visualNodeIds: ids,
    visualNodeById,
    maxPillsPerOwner: C4_SCAN_L2_RESIDENT_PREVIEW_PILLS,
  });
  const webPills = selection.residentIds.filter(id => visualNodeById[id]?.kind === 'component' && visualNodeById[id]?.parentVisualId === 'web');
  const serverPills = selection.residentIds.filter(id => visualNodeById[id]?.kind === 'component' && visualNodeById[id]?.parentVisualId === 'server');
  const omittedWeb = selection.omittedIds.filter(id => visualNodeById[id]?.parentVisualId === 'web');
  assert.equal(webPills.length, C4_SCAN_L2_RESIDENT_PREVIEW_PILLS);
  assert.equal(serverPills.length, 8);
  assert.equal(omittedWeb.length, 79 - C4_SCAN_L2_RESIDENT_PREVIEW_PILLS);
  assert.ok(webPills.includes('web-70'), 'heavier code weight outranks later ids');
  assert.ok(selection.residentIds.includes('web'));
  assert.ok(selection.residentIds.includes('server'));
  assert.equal(c4ScanContainerPeerTile(79).width > c4ScanContainerPeerTile(8).width, true);
});

test('CLA-120: default cap of 10 is a no-op when every owner is at or under the cap', () => {
  const visualNodeById = {
    box: { kind: 'container' as const, entity: { logicalId: 'container:box' } },
    a: { kind: 'component' as const, entity: { logicalId: 'component:a' }, parentVisualId: 'box' },
    b: { kind: 'component' as const, entity: { logicalId: 'component:b' }, parentVisualId: 'box' },
  };
  const selection = selectL2ResidentPreviewPills({
    visualNodeIds: ['box', 'a', 'b'],
    visualNodeById,
    maxPillsPerOwner: C4_SCAN_L2_RESIDENT_PREVIEW_PILLS,
  });
  assert.deepEqual(selection.residentIds, ['box', 'a', 'b']);
  assert.deepEqual(selection.omittedIds, []);
});
