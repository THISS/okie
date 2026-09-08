import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASPECT_PRESET_TARGET,
  C4_BAND_FOCUS_ZOOM,
  C4_INTRINSIC_LAYOUT,
  C4_SCAN_L2_PEER_TILE_CHILD_COMFORT,
  buildC4ProjectionBundle,
  c4ScanContainerPeerTile,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
} from '@okie/architecture';
import { BAND_COST_HANG_GUARD_ENTITIES } from './band-cost-curve.js';
import { C4_PRESENTATION_AT_FOCUS, compileC4Scene } from './compile-c4.js';

function entity(
  id: string,
  kind: ArchitectureEntity['kind'],
  name: string,
  parentId?: string,
): ArchitectureEntity {
  return {
    id,
    name,
    kind,
    sourceRefs: [{ path: `${id}.ts`, commitSha: 'c' }],
    ...(parentId ? { parentId } : {}),
  };
}

/** Scan L2: fat `@okie/web` + thin `@okie/server`, the CLA-65 dogfood pair. */
function webServerSnapshot(webCount: number, serverCount: number): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    entity('system:okie', 'softwareSystem', 'Okie'),
    entity('container:apps-web', 'container', '@okie/web', 'system:okie'),
    entity('container:apps-server', 'container', '@okie/server', 'system:okie'),
  ];
  for (let index = 0; index < webCount; index += 1) {
    const id = `component:web-${String(index).padStart(2, '0')}`;
    entities.push(entity(id, 'component', `Web${index}`, 'container:apps-web'));
    entities.push(entity(`code:${id}`, 'code', 'k', id));
  }
  for (let index = 0; index < serverCount; index += 1) {
    const id = `component:server-${index}`;
    entities.push(entity(id, 'component', `Srv${index}`, 'container:apps-server'));
    entities.push(entity(`code:${id}`, 'code', 'k', id));
  }
  return {
    schemaVersion: 1,
    id: 'snapshot:cla-119',
    repositoryId: 'repo:cla-119',
    commitSha: 'c',
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities,
    relations: [],
  };
}

function compileL2(snapshot: ArchitectureSnapshot) {
  const bundle = buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
    familyId: 'f',
    maxBand: 'code',
    maxNodesPerBand: 50,
    pageCodeLandmarks: true,
    targetAspect: ASPECT_PRESET_TARGET.landscape,
  });
  return compileC4Scene(snapshot, bundle, { targetAspect: ASPECT_PRESET_TARGET.landscape });
}

test('CLA-119: hang-guard stays 2000', () => {
  assert.equal(BAND_COST_HANG_GUARD_ENTITIES, 2000);
  assert.equal(C4_SCAN_L2_PEER_TILE_CHILD_COMFORT, 9);
});

test('CLA-119: @okie/web L2 shell is larger than @okie/server; pills can fit titles', () => {
  const snapshot = webServerSnapshot(79, 8);
  const compiled = compileL2(snapshot);
  const web = compiled.projections.index.boundsByEntityIdAndBand['container:apps-web']?.container;
  const server = compiled.projections.index.boundsByEntityIdAndBand['container:apps-server']?.container;
  const system = compiled.projections.index.boundsByEntityIdAndBand['system:okie']?.container;
  assert.ok(web && server && system);
  const expectedWeb = c4ScanContainerPeerTile(79);
  const expectedServer = c4ScanContainerPeerTile(8);
  assert.ok(Math.abs(web.width - expectedWeb.width) < 1e-6);
  assert.ok(Math.abs(web.height - expectedWeb.height) < 1e-6);
  assert.ok(Math.abs(server.width - expectedServer.width) < 1e-6);
  assert.ok(web.width > server.width, 'fat web footprint exceeds thin server');
  assert.ok(web.height > server.height, 'fat web footprint exceeds thin server');
  assert.ok(web.width < expectedWeb.width * 2, 'web is a nested shell, not a reserved L3 interior');

  const occupied = web.width * web.height + server.width * server.height;
  assert.ok(occupied / (system.width * system.height) < 0.92, 'L2 is padded nested shells, not a full-bleed treemap');

  const pills = snapshot.entities
    .filter(item => item.parentId === 'container:apps-web' && item.kind === 'component')
    .map(item => compiled.projections.index.boundsByEntityIdAndBand[item.id]?.component)
    .filter((box): box is NonNullable<typeof box> => Boolean(box));
  assert.ok(pills.length > 0, 'resident L3 pills sit in the L2 web shell');
  const shortest = Math.min(...pills.map(box => box.height));
  const titleBaselineWorld = 50
    * (C4_PRESENTATION_AT_FOCUS.component.geometryScale / C4_BAND_FOCUS_ZOOM.component);
  assert.ok(
    shortest > titleBaselineWorld,
    `web pills ${shortest.toFixed(2)}u must clear Canvas2D title baseline ${titleBaselineWorld.toFixed(2)}u`,
  );
  const compactLeaf = C4_INTRINSIC_LAYOUT.leaf.code.height / C4_BAND_FOCUS_ZOOM.container;
  assert.ok(web.height > compactLeaf * 2, '79-child web more than doubles the old 224×112 tile');
});

test('CLA-119: L2→L3 into @okie/web still uses the reserved owner shell', () => {
  const snapshot = webServerSnapshot(79, 8);
  const l2 = compileL2(snapshot);
  const l2Web = l2.projections.index.boundsByEntityIdAndBand['container:apps-web']?.container;
  const l3Bundle = buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'container:apps-web',
    familyId: 'f',
    maxBand: 'component',
    targetAspect: ASPECT_PRESET_TARGET.landscape,
  });
  const l3 = compileC4Scene(snapshot, l3Bundle, { targetAspect: ASPECT_PRESET_TARGET.landscape });
  const l3Web = l3.projections.index.boundsByEntityIdAndBand['container:apps-web']?.component;
  assert.ok(l2Web && l3Web);
  assert.ok(l3Web.height > l2Web.height * 1.5, 'Open inside still grows into the CLA-81 reserved L3 shell');
  const cards = snapshot.entities
    .filter(item => item.parentId === 'container:apps-web' && item.kind === 'component')
    .map(item => l3.projections.index.boundsByEntityIdAndBand[item.id]?.component)
    .filter((box): box is NonNullable<typeof box> => Boolean(box));
  assert.ok(cards.length >= 6, 'L3 still packs resident file cards');
});
