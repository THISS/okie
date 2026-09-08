import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASPECT_PRESET_TARGET,
  C4_SCAN_L2_RESIDENT_PREVIEW_PILLS,
  buildC4ProjectionBundle,
  c4ScanContainerPeerTile,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
} from '@okie/architecture';
import { BAND_COST_HANG_GUARD_ENTITIES } from './band-cost-curve.js';
import { compileC4Scene } from './compile-c4.js';

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

/** CLA-65 pair: fat `@okie/web` + thinner `@okie/server`. */
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
    id: 'snapshot:cla-120',
    repositoryId: 'repo:cla-120',
    commitSha: 'c',
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities,
    relations: [],
  };
}

function compileL2(snapshot: ArchitectureSnapshot, preview = true) {
  const bundle = buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
    familyId: 'f',
    maxBand: 'code',
    maxNodesPerBand: 50,
    pageCodeLandmarks: true,
    ...(preview ? { maxL2PreviewPillsPerOwner: C4_SCAN_L2_RESIDENT_PREVIEW_PILLS } : {}),
    targetAspect: ASPECT_PRESET_TARGET.landscape,
  });
  return compileC4Scene(snapshot, bundle, { targetAspect: ASPECT_PRESET_TARGET.landscape });
}

function componentPills(
  compiled: ReturnType<typeof compileL2>,
  parentId: string,
  snapshot: ArchitectureSnapshot,
) {
  return snapshot.entities
    .filter(item => item.parentId === parentId && item.kind === 'component')
    .map(item => compiled.projections.index.boundsByEntityIdAndBand[item.id]?.component)
    .filter((box): box is NonNullable<typeof box> => Boolean(box));
}

test('CLA-120: hang-guard stays 2000', () => {
  assert.equal(BAND_COST_HANG_GUARD_ENTITIES, 2000);
  assert.equal(C4_SCAN_L2_RESIDENT_PREVIEW_PILLS, 10);
});

test('CLA-120: fat @okie/web L2 keeps ~10 landmark pills plus +N more; server stays uncapped', () => {
  const snapshot = webServerSnapshot(79, 8);
  const compiled = compileL2(snapshot);
  const web = compiled.projections.index.boundsByEntityIdAndBand['container:apps-web']?.container;
  const server = compiled.projections.index.boundsByEntityIdAndBand['container:apps-server']?.container;
  assert.ok(web && server);
  assert.ok(Math.abs(web.width - c4ScanContainerPeerTile(79).width) < 1e-6, 'CLA-119 √N footprint unchanged');
  assert.ok(Math.abs(server.width - c4ScanContainerPeerTile(8).width) < 1e-6);

  const webPills = componentPills(compiled, 'container:apps-web', snapshot);
  const serverPills = componentPills(compiled, 'container:apps-server', snapshot);
  assert.equal(webPills.length, C4_SCAN_L2_RESIDENT_PREVIEW_PILLS);
  assert.equal(serverPills.length, 8);

  const component = compiled.projections.projectionById[compiled.projections.family.projectionIds.component]!;
  const omittedWeb = (component.omittedNodeIds ?? [])
    .map(id => compiled.projections.visualNodeById[id])
    .filter(node => node?.entity.logicalId.startsWith('component:web-'));
  assert.equal(omittedWeb.length, 79 - C4_SCAN_L2_RESIDENT_PREVIEW_PILLS);

  const webVisualId = compiled.projections.index.visualNodeIdsByEntityId['container:apps-web']?.[0];
  const remainders = compiled.projections.bandLayoutById[component.layoutId]?.remainderBadges ?? {};
  assert.ok(webVisualId);
  assert.equal(remainders[webVisualId]?.count, 79 - C4_SCAN_L2_RESIDENT_PREVIEW_PILLS);
  assert.equal(remainders[compiled.projections.index.visualNodeIdsByEntityId['container:apps-server']?.[0] ?? ''], undefined);

  const reserved = compiled.projections.bandLayoutById[component.layoutId]?.reservedShells ?? {};
  const reservedWebFiles = Object.keys(reserved).filter(id =>
    compiled.projections.visualNodeById[id]?.entity.logicalId.startsWith('component:web-'));
  assert.equal(reservedWebFiles.length, 0, 'omitted L2 pills are +N more, not hollow reserved cells');

  const badge = compiled.scene.objects
    .flatMap(object => object.representations)
    .flatMap(representation => representation.primitives)
    .some(primitive => primitive.kind === 'text' && primitive.content.includes('+69 more'));
  assert.equal(badge, true, 'canvas paints a +N more remainder chip');
});

test('CLA-120: Open inside / L2→L3 still packs the full @okie/web neighborhood', () => {
  const snapshot = webServerSnapshot(79, 8);
  const l3Bundle = buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'container:apps-web',
    familyId: 'f',
    maxBand: 'component',
    targetAspect: ASPECT_PRESET_TARGET.landscape,
  });
  const l3 = compileC4Scene(snapshot, l3Bundle, { targetAspect: ASPECT_PRESET_TARGET.landscape });
  const cards = componentPills(l3, 'container:apps-web', snapshot);
  assert.equal(cards.length, 79, 'L3 is not the L2 preview cap');
  const component = l3.projections.projectionById[l3.projections.family.projectionIds.component]!;
  assert.equal((component.omittedNodeIds ?? []).length, 0);
  assert.equal(l3.projections.bandLayoutById[component.layoutId]?.remainderBadges, undefined);
});
