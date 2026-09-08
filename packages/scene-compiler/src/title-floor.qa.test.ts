import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildC4ProjectionBundle,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
  type C4Band,
  type EntityKind,
} from '@okie/architecture';
import { BAND_COST_HANG_GUARD_ENTITIES } from './band-cost-curve.js';
import {
  C4_LABEL_MIN_TITLE_PX,
  C4_LABEL_TITLE_SHRINK_RATIO,
  C4_PRESENTATION_AT_FOCUS,
  C4_ZOOM_BANDS,
  c4TitleFitFloor,
  compileC4Scene,
} from './compile-c4.js';
import { displayTextWidth, fitDisplayText, fitDisplayTextAtSize } from './display-text.js';

const LONG_TITLE = 'createNavigationHistoryController';

function entity(id: string, kind: EntityKind, name: string, parentId?: string): ArchitectureEntity {
  return {
    id,
    name,
    kind,
    sourceRefs: [{ path: `${id}.ts`, commitSha: 'c' }],
    ...(parentId ? { parentId } : {}),
  };
}

function titleSnapshot(): ArchitectureSnapshot {
  return {
    schemaVersion: 1,
    id: 'snapshot:cla-111',
    repositoryId: 'repo:cla-111',
    commitSha: 'c',
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities: [
      entity('system:d', 'softwareSystem', 'Dogfood'),
      entity('container:c', 'container', 'Shell', 'system:d'),
      entity('component:file', 'component', LONG_TITLE, 'container:c'),
      entity('code:file:fn', 'code', LONG_TITLE, 'component:file'),
    ],
    relations: [],
  };
}

function compiledTitle(entityId: string, band: C4Band) {
  const snapshot = titleSnapshot();
  const bundle = buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:d',
    focusEntityId: 'system:d',
    familyId: 'f',
  });
  const compiled = compileC4Scene(snapshot, bundle);
  const visualId = bundle.index.visualNodeIdsByEntityId[entityId]![0]!;
  const representation = compiled.scene.objects.find(object => object.id === visualId)!
    .representations.find(candidate => candidate.id === `${visualId}:${band}`)!;
  return representation.primitives.filter(primitive => primitive.kind === 'text')[1]!;
}

test('CLA-111: hang-guard stays 2000', () => {
  assert.equal(BAND_COST_HANG_GUARD_ENTITIES, 2000);
  assert.equal(C4_LABEL_TITLE_SHRINK_RATIO, 0.65);
});

test('CLA-111: L1/L2 keep the 12px floor; L3 joins them; L4 shrinks to 0.65× authored', () => {
  const authored = {
    context: C4_PRESENTATION_AT_FOCUS.context.titleFontSize,
    container: C4_PRESENTATION_AT_FOCUS.container.titleFontSize,
    component: C4_PRESENTATION_AT_FOCUS.component.titleFontSize,
    code: C4_PRESENTATION_AT_FOCUS.code.titleFontSize,
  };
  assert.equal(c4TitleFitFloor('context', authored.context, C4_LABEL_MIN_TITLE_PX), C4_LABEL_MIN_TITLE_PX);
  assert.equal(c4TitleFitFloor('container', authored.container, C4_LABEL_MIN_TITLE_PX), C4_LABEL_MIN_TITLE_PX);
  assert.equal(c4TitleFitFloor('component', authored.component, C4_LABEL_MIN_TITLE_PX), C4_LABEL_MIN_TITLE_PX);
  assert.ok(c4TitleFitFloor('component', authored.component, C4_LABEL_MIN_TITLE_PX) < authored.component);
  const codeFloor = c4TitleFitFloor('code', authored.code, C4_LABEL_MIN_TITLE_PX);
  assert.equal(codeFloor, authored.code * C4_LABEL_TITLE_SHRINK_RATIO);
  assert.ok(codeFloor < authored.code);
  assert.ok(codeFloor < C4_LABEL_MIN_TITLE_PX,
    'L4 authored size is below 12px, so a min-px floor cannot open a shrink path');
});

test('CLA-111: a tight identifier shrinks below authored size before ellipsis', () => {
  for (const band of ['component', 'code'] as const) {
    const authored = C4_PRESENTATION_AT_FOCUS[band].titleFontSize;
    const floor = c4TitleFitFloor(band, authored, C4_LABEL_MIN_TITLE_PX);
    const metrics = band === 'code' ? 'mono-semibold' as const : 'sans-semibold' as const;
    const fullWidth = displayTextWidth(LONG_TITLE, authored, metrics);
    const floorWidth = displayTextWidth(LONG_TITLE, floor, metrics);
    const maxWidth = (fullWidth + floorWidth) / 2;
    const truncatedAtAuthored = fitDisplayText(LONG_TITLE, maxWidth, authored, 'identifier', metrics);
    const fitted = fitDisplayTextAtSize(LONG_TITLE, maxWidth, authored, floor, 'identifier', metrics);
    assert.ok(fitted.fontSize < authored, `${band} must shrink instead of truncating immediately`);
    assert.ok(fitted.fontSize >= floor - 1e-9, `${band} must not drop below its truncation floor`);
    assert.equal(fitted.content, LONG_TITLE, `${band} must keep the full name once type has room to shrink`);
    assert.ok(truncatedAtAuthored.includes('…'), `${band} baseline at authored size still ellipsizes`);
    assert.ok(fitted.content.length > truncatedAtAuthored.length);
  }
});

test('CLA-111: compiled L3/L4 titles use the new floor, not authored size as minFontSize', () => {
  for (const sample of [
    { band: 'component' as const, entityId: 'component:file' },
    { band: 'code' as const, entityId: 'code:file:fn' },
  ]) {
    const title = compiledTitle(sample.entityId, sample.band);
    const focusZoom = C4_ZOOM_BANDS.find(candidate => candidate.detail === sample.band)!.focusZoom;
    const authoredWorld = C4_PRESENTATION_AT_FOCUS[sample.band].titleFontSize / focusZoom;
    const floorWorld = c4TitleFitFloor(sample.band, authoredWorld, C4_LABEL_MIN_TITLE_PX / focusZoom);
    const metrics = sample.band === 'code' ? 'mono-semibold' as const : 'sans-semibold' as const;
    const expected = fitDisplayTextAtSize(LONG_TITLE, title.maxWidth, authoredWorld, floorWorld, 'identifier', metrics);
    const pinnedToAuthored = fitDisplayTextAtSize(
      LONG_TITLE,
      title.maxWidth,
      authoredWorld,
      authoredWorld,
      'identifier',
      metrics,
    );
    assert.equal(title.content, expected.content);
    assert.equal(title.fontSize, expected.fontSize);
    assert.ok(floorWorld < authoredWorld);
    assert.ok(title.fontSize >= floorWorld - 1e-9);
    assert.ok(pinnedToAuthored.fontSize >= expected.fontSize - 1e-9);
  }
});
