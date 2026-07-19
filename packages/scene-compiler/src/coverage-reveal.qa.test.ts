import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASPECT_PRESET_TARGET,
  buildC4ProjectionBundle,
  C4_BANDS,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
  type C4Band,
} from '@okie/architecture';
import { C4_ZOOM_BANDS, COVERAGE_REVEAL, compileC4Scene, coverageRevealZoomWindow } from './compile-c4.js';

// Coverage-based children reveal (task #33). Opt-in via targetAspect (scan mode): a child's
// reveal LOD keys off its OWNER's on-screen coverage, so a large owner reveals its children
// EARLY (fixing "the container fills the screen but stays opaque"), while the default path
// keeps the uniform band LODs byte-identical.

function denseContainer(componentCount: number): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    { id: 'system:d', kind: 'softwareSystem', name: 'D', sourceRefs: [] },
    { id: 'container:c', kind: 'container', parentId: 'system:d', name: 'C', sourceRefs: [] },
  ];
  for (let index = 0; index < componentCount; index += 1) {
    const cid = `component:m${String(index).padStart(3, '0')}`;
    entities.push({ id: cid, kind: 'component', parentId: 'container:c', name: `m${index}`, sourceRefs: [] });
    entities.push({ id: `code:${cid}`, kind: 'code', parentId: cid, name: 'k', sourceRefs: [] });
  }
  return {
    schemaVersion: 1,
    id: 'snapshot:d',
    repositoryId: 'repo:d',
    commitSha: 'c',
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities,
    relations: [],
  };
}

const build = (snapshot: ArchitectureSnapshot, targetAspect?: number) =>
  buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:d',
    focusEntityId: 'system:d',
    familyId: 'f',
    ...(targetAspect !== undefined ? { targetAspect } : {}),
  });

const enterZoom = (band: C4Band) => C4_ZOOM_BANDS.find(candidate => candidate.detail === band)!.enterZoom;
const bandOf = (repId: string) => C4_BANDS.find(band => repId.endsWith(`:${band}`))!;
const repMinZoom = (scene: { objects: Array<{ id: string; representations: Array<{ id: string; lod: { minZoom: number } }> }> }, visualId: string, band: C4Band) =>
  scene.objects.find(object => object.id === visualId)?.representations.find(rep => rep.id === `${visualId}:${band}`)?.lod.minZoom;

test('COVERAGE_REVEAL encodes the 50/70 product contract', () => {
  assert.deepEqual(COVERAGE_REVEAL, { start: 0.5, full: 0.7, hysteresis: 0.15 });
  assert.ok(Object.isFrozen(COVERAGE_REVEAL));
});

test('default (no targetAspect) keeps every representation on its uniform band LOD', () => {
  const snapshot = denseContainer(40);
  const compiled = compileC4Scene(snapshot, build(snapshot));
  for (const object of compiled.scene.objects) {
    for (const rep of object.representations) {
      assert.equal(rep.lod.minZoom, enterZoom(bandOf(rep.id)), `${rep.id} default minZoom must equal its band enterZoom`);
    }
  }
});

test('a large container reveals its components BELOW the component band enter zoom, owner shell and child card together', () => {
  const snapshot = denseContainer(40);
  const target = ASPECT_PRESET_TARGET.landscape;
  const bundle = build(snapshot, target);
  const scene = compileC4Scene(snapshot, bundle, { targetAspect: target }).scene;

  const containerId = bundle.index.visualNodeIdsByEntityId['container:c']![0]!;
  const componentId = bundle.index.visualNodeIdsByEntityId['component:m000']![0]!;
  const ownerShell = repMinZoom(scene, containerId, 'component');
  const childCard = repMinZoom(scene, componentId, 'component');

  assert.ok(ownerShell !== undefined && ownerShell < enterZoom('component'),
    `large container must reveal components early (${ownerShell} < ${enterZoom('component')})`);
  assert.equal(childCard, ownerShell, 'a child card and its owner boundary shell reveal at the same coverage moment');
});

test('coverage reveal is never LATER than the band enter zoom (crossfade overlap preserved)', () => {
  const snapshot = denseContainer(40);
  const target = ASPECT_PRESET_TARGET.landscape;
  const scene = compileC4Scene(snapshot, build(snapshot, target), { targetAspect: target }).scene;
  for (const object of scene.objects) {
    for (const rep of object.representations) {
      assert.ok(rep.lod.minZoom <= enterZoom(bandOf(rep.id)) + 1e-9,
        `${rep.id} reveal must not fall later than its band enter (${rep.lod.minZoom} vs ${enterZoom(bandOf(rep.id))})`);
      assert.ok(rep.lod.fadeWidth > 0 && (rep.lod.hysteresis ?? 0) >= 0, `${rep.id} must keep a positive fade window`);
    }
  }
});

test('coverage reveal is deterministic under reversed entity order', () => {
  const snapshot = denseContainer(40);
  const target = ASPECT_PRESET_TARGET.landscape;
  const forward = compileC4Scene(snapshot, build(snapshot, target), { targetAspect: target }).scene;
  const reversedSnapshot = { ...snapshot, entities: [...snapshot.entities].reverse() };
  const reversed = compileC4Scene(reversedSnapshot, build(reversedSnapshot, target), { targetAspect: target }).scene;
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed), 'reveal LODs must be insertion-order invariant');
});

test('coverageRevealZoomWindow is the single reveal moment shared with the compiled LOD', () => {
  const snapshot = denseContainer(40);
  const target = ASPECT_PRESET_TARGET.landscape;
  const compiled = compileC4Scene(snapshot, build(snapshot, target), { targetAspect: target });

  // The window must be computed from the NORMALIZED projections the compile returns
  // (persistent owner shells + intrinsic geometry), not the stage-1 input bundle.
  const containerId = compiled.projections.index.visualNodeIdsByEntityId['container:c']![0]!;
  const ownerBounds = compiled.projections.index.boundsByEntityIdAndBand['container:c']!.component!;
  const window = coverageRevealZoomWindow(ownerBounds, 'component', target);

  assert.equal(repMinZoom(compiled.scene, containerId, 'component'), window.minZoom,
    'the shared window must start exactly where the owner shell reveal LOD starts');
  assert.ok(window.minZoom < window.fullZoom, 'the reveal window must have positive width');
  const band = C4_ZOOM_BANDS.find(candidate => candidate.detail === 'component')!;
  assert.ok(window.minZoom <= band.enterZoom + 1e-9 && window.fullZoom <= band.enterZoom + band.fadeWidth + 1e-9,
    'the window must never fall later than the band enter/fade runway');
});

test('a taller owner reveals its children earlier than a shorter one (coverage monotonic in size)', () => {
  // portrait packs the same container taller → larger height coverage → children reveal earlier.
  const snapshot = denseContainer(40);
  const containerEntity = 'container:c';
  const landscape = compileC4Scene(snapshot, build(snapshot, ASPECT_PRESET_TARGET.landscape), { targetAspect: ASPECT_PRESET_TARGET.landscape });
  const portrait = compileC4Scene(snapshot, build(snapshot, ASPECT_PRESET_TARGET.portrait), { targetAspect: ASPECT_PRESET_TARGET.portrait });
  const lId = landscape.projections.index.visualNodeIdsByEntityId[containerEntity]![0]!;
  const pId = portrait.projections.index.visualNodeIdsByEntityId[containerEntity]![0]!;
  const lReveal = repMinZoom(landscape.scene, lId, 'component')!;
  const pReveal = repMinZoom(portrait.scene, pId, 'component')!;
  assert.ok(pReveal <= lReveal, `the taller (portrait) container reveals components no later than landscape (${pReveal} <= ${lReveal})`);
});
