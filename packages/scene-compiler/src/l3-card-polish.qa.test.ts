import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASPECT_PRESET_TARGET,
  buildC4ProjectionBundle,
  c4ScanComponentCardFace,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
} from '@okie/architecture';
import { BAND_COST_HANG_GUARD_ENTITIES } from './band-cost-curve.js';
import {
  C4_PRESENTATION_AT_FOCUS,
  C4_ZOOM_BANDS,
  cardSupportCopy,
  compileC4Scene,
  NO_SUMMARY_SUPPLIED,
} from './compile-c4.js';
import { fitDisplayTextAtSize } from './display-text.js';

function entity(
  id: string,
  kind: ArchitectureEntity['kind'],
  name: string,
  parentId?: string,
  responsibility?: string,
): ArchitectureEntity {
  return {
    id,
    name,
    kind,
    sourceRefs: [{ path: `${id}.ts`, commitSha: 'c' }],
    ...(parentId ? { parentId } : {}),
    ...(responsibility !== undefined ? { responsibility } : {}),
  };
}

function fatFileSnapshot(codeCount: number, responsibility?: string): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    entity('system:okie', 'softwareSystem', 'okie'),
    entity('container:apps-web', 'container', '@okie/web', 'system:okie'),
    entity('component:file', 'component', 'src/diagnostics.rs', 'container:apps-web', responsibility),
  ];
  for (let index = 0; index < codeCount; index += 1) {
    entities.push(entity(
      `code:n${String(index).padStart(3, '0')}`,
      'code',
      `sym${index}`,
      'component:file',
    ));
  }
  return {
    schemaVersion: 1,
    id: 'snapshot:cla-121',
    repositoryId: 'repo:cla-121',
    commitSha: 'c',
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities,
    relations: [],
  };
}

function compileL3(snapshot: ArchitectureSnapshot, extras: {
  childCounts?: Readonly<Record<string, number>>;
  unpublishedChildren?: ArchitectureEntity[];
} = {}) {
  const unpublished = extras.unpublishedChildren?.map(item => ({
    id: item.id,
    kind: item.kind,
    ...(item.parentId ? { parentId: item.parentId } : {}),
  }));
  const bundle = buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'container:apps-web',
    familyId: 'f',
    maxBand: 'component',
    targetAspect: ASPECT_PRESET_TARGET.landscape,
  });
  return compileC4Scene(snapshot, bundle, {
    targetAspect: ASPECT_PRESET_TARGET.landscape,
    ...(extras.childCounts ? { childCounts: extras.childCounts } : {}),
    ...(unpublished?.length ? { unpublishedChildren: unpublished } : {}),
  });
}

function sceneTexts(compiled: ReturnType<typeof compileC4Scene>, visualId: string, band: 'component' | 'code') {
  const representation = compiled.scene.objects.find(object => object.id === visualId)!
    .representations.find(candidate => candidate.id === `${visualId}:${band}`);
  return representation?.primitives.flatMap(primitive =>
    primitive.kind === 'text' ? [primitive.content] : []) ?? [];
}

test('CLA-121: hang-guard stays 2000', () => {
  assert.equal(BAND_COST_HANG_GUARD_ENTITIES, 2000);
});

test('CLA-121: L3 file cards collapse to the compact face when L4 is not painted', () => {
  const full = fatFileSnapshot(24);
  const slim: ArchitectureSnapshot = {
    ...full,
    entities: full.entities.filter(item => item.kind !== 'code'),
  };
  const unpublished = full.entities.filter(item => item.kind === 'code');
  const childCounts = { 'component:file': 24, 'container:apps-web': 1, 'system:okie': 1 };
  const l3 = compileL3(slim, { childCounts, unpublishedChildren: unpublished });
  const face = c4ScanComponentCardFace(ASPECT_PRESET_TARGET.landscape);
  const card = l3.projections.index.boundsByEntityIdAndBand['component:file']?.component;
  assert.ok(card);
  assert.ok(Math.abs(card.width - face.width) < 1e-6, `L3 width ${card.width} must hug ${face.width}`);
  assert.ok(Math.abs(card.height - face.height) < 1e-6, `L3 height ${card.height} must hug ${face.height}`);

  const component = l3.projections.projectionById[l3.projections.family.projectionIds.component]!;
  const reserved = l3.projections.bandLayoutById[component.layoutId]?.reservedShells ?? {};
  const reservedCode = Object.keys(reserved).filter(id =>
    l3.projections.visualNodeById[id]?.kind === 'code'
    || l3.projections.index.entityIdByVisualNodeId[id]?.startsWith('code:'));
  assert.equal(reservedCode.length, 0, 'L3 must not paint hollow L4 reserved cells');

  const visualId = l3.projections.index.visualNodeIdsByEntityId['component:file']![0]!;
  const object = l3.scene.objects.find(item => item.id === visualId)!;
  const painted = object.representations.find(item => item.id === `${visualId}:component`)!;
  const rect = painted.primitives.find(primitive => primitive.kind === 'roundedRect')!;
  assert.equal(rect.kind, 'roundedRect');
  assert.ok(Math.abs(rect.rect.height - face.height) < 1e-6);
  assert.equal(rect.fill[3], 1, 'L3 file is a solid card, not a translucent cavern');
});

test('CLA-121: empty responsibility does not paint No summary supplied', () => {
  assert.equal(cardSupportCopy(undefined), undefined);
  assert.equal(cardSupportCopy(''), undefined);
  assert.equal(cardSupportCopy('   '), undefined);
  assert.equal(cardSupportCopy(NO_SUMMARY_SUPPLIED), undefined);
  assert.equal(cardSupportCopy('Owns scan L3 file cards.'), 'Owns scan L3 file cards.');

  const empty = compileL3(fatFileSnapshot(8));
  const summarized = compileL3(fatFileSnapshot(8, 'CPU diagnostics for the atlas engine.'));
  const emptyId = empty.projections.index.visualNodeIdsByEntityId['component:file']![0]!;
  const summarizedId = summarized.projections.index.visualNodeIdsByEntityId['component:file']![0]!;
  const emptyTexts = sceneTexts(empty, emptyId, 'component');
  const summarizedTexts = sceneTexts(summarized, summarizedId, 'component');
  assert.equal(emptyTexts.includes(NO_SUMMARY_SUPPLIED), false);
  assert.equal(emptyTexts.includes('src/diagnostics.rs'), true);
  assert.equal(summarizedTexts.includes('CPU diagnostics for the atlas engine.'), true);
});

test('CLA-121: L4 opened file still uses the reserved interior', () => {
  const snapshot = fatFileSnapshot(24);
  const l3 = compileL3(snapshot);
  const l4Bundle = buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'component:file',
    familyId: 'f',
    maxBand: 'code',
    targetAspect: ASPECT_PRESET_TARGET.landscape,
  });
  const l4 = compileC4Scene(snapshot, l4Bundle, { targetAspect: ASPECT_PRESET_TARGET.landscape });
  const compact = l3.projections.index.boundsByEntityIdAndBand['component:file']?.component;
  const opened = l4.projections.index.boundsByEntityIdAndBand['component:file']?.code
    ?? l4.projections.index.boundsByEntityIdAndBand['component:file']?.component;
  assert.ok(compact && opened);
  assert.ok(opened.height > compact.height * 1.4, 'L4 owner is the reserved interior, not the L3 face');
  assert.ok(opened.width > compact.width * 1.05);
});

test('CLA-121: CLA-112 truncation stays off on an ample L3 card face', () => {
  const snapshot = fatFileSnapshot(8);
  const compiled = compileL3(snapshot);
  const visualId = compiled.projections.index.visualNodeIdsByEntityId['component:file']![0]!;
  const representation = compiled.scene.objects.find(object => object.id === visualId)!
    .representations.find(candidate => candidate.id === `${visualId}:component`)!;
  const title = representation.primitives.find(primitive =>
    primitive.kind === 'text' && primitive.content.includes('diagnostics'))!;
  assert.equal(title.kind, 'text');
  const focusZoom = C4_ZOOM_BANDS.find(candidate => candidate.detail === 'component')!.focusZoom;
  const authored = C4_PRESENTATION_AT_FOCUS.component.titleFontSize / focusZoom;
  assert.equal(title.content, 'src/diagnostics.rs');
  assert.equal(title.content.includes('…'), false);
  const fitted = fitDisplayTextAtSize(
    'src/diagnostics.rs',
    title.maxWidth,
    authored,
    authored,
    'identifier',
    'sans-semibold',
  );
  assert.equal(fitted.content, 'src/diagnostics.rs');
});
