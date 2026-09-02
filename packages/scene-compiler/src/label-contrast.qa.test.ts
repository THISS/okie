import assert from 'node:assert/strict';
import test from 'node:test';
import { ASPECT_PRESET_TARGET, buildC4ProjectionBundle, type ArchitectureEntity, type ArchitectureSnapshot } from '@okie/architecture';
import {
  C4_BOUNDARY_STROKE_ALPHA,
  C4_CAMERA_LIMITS,
  C4_LABEL_MIN_TITLE_PX,
  C4_ZOOM_BANDS,
  compileC4Scene,
} from './compile-c4.js';
import { displayMetricsForFontFamily, displayTextWidth } from './display-text.js';

const EMPTY_SUMMARY = 'No summary supplied.';

function scanDogfoodLabels(): ArchitectureSnapshot {
  const externals: ArchitectureEntity[] = [
    { id: 'external:react', kind: 'externalSystem', name: 'react', sourceRefs: [] },
    { id: 'external:fontsource', kind: 'externalSystem', name: '@fontsource/ibm-plex-sans', sourceRefs: [] },
    { id: 'external:dompurify', kind: 'externalSystem', name: 'dompurify', sourceRefs: [] },
  ];
  return {
    schemaVersion: 1,
    id: 'snapshot:cla-53-labels',
    repositoryId: 'repo:cla-53',
    commitSha: 'c',
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities: [
      { id: 'system:okie', kind: 'softwareSystem', name: 'okie', responsibility: 'Spatial architecture atlas.', sourceRefs: [] },
      { id: 'container:web', kind: 'container', parentId: 'system:okie', name: '@okie/web', responsibility: 'React shell.', sourceRefs: [] },
      { id: 'container:scan', kind: 'container', parentId: 'system:okie', name: '@okie/scan', sourceRefs: [] },
      ...externals,
    ],
    relations: [],
  };
}

function relativeLuminance(color: readonly [number, number, number, number]): number {
  const channel = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
}

function contrastRatio(
  foreground: readonly [number, number, number, number],
  background: readonly [number, number, number, number],
): number {
  const left = relativeLuminance(foreground);
  const right = relativeLuminance(background);
  const brighter = Math.max(left, right);
  const darker = Math.min(left, right);
  return (brighter + 0.05) / (darker + 0.05);
}

function compiledTitle(snapshot: ArchitectureSnapshot, entityId: string, band: 'context' | 'container') {
  const bundle = buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
    familyId: 'view-family:cla-53',
    targetAspect: ASPECT_PRESET_TARGET.landscape,
  });
  const compiled = compileC4Scene(snapshot, bundle, { targetAspect: ASPECT_PRESET_TARGET.landscape });
  const visualId = bundle.index.visualNodeIdsByEntityId[entityId]![0]!;
  const representation = compiled.scene.objects.find(object => object.id === visualId)!
    .representations.find(candidate => candidate.id === `${visualId}:${band}`)!;
  const texts = representation.primitives.filter(primitive => primitive.kind === 'text');
  const fill = representation.primitives.find(primitive => primitive.kind === 'roundedRect')!;
  return { bundle, compiled, representation, kicker: texts[0]!, title: texts[1]!, support: texts[2], fill };
}

test('CLA-53: L1/L2 dogfood labels stay readable without invented summaries', () => {
  const snapshot = scanDogfoodLabels();
  const names = ['react', '@fontsource/ibm-plex-sans', 'dompurify'] as const;
  const ids = ['external:react', 'external:fontsource', 'external:dompurify'] as const;

  for (const band of ['context', 'container'] as const) {
    const focusZoom = C4_ZOOM_BANDS.find(candidate => candidate.detail === band)!.focusZoom;
    for (const [index, entityId] of ids.entries()) {
      const sample = compiledTitle(snapshot, entityId, band);
      const name = names[index]!;
      assert.ok(sample.title.content === name || sample.title.content.endsWith('ibm-plex-sans'),
        `${band} ${name} must keep its distinctive tail (${sample.title.content})`);
      assert.equal(sample.title.content.includes('@fontsource/ibm-') && !sample.title.content.includes('plex-sans'), false,
        `${band} must not brutally prefix-truncate scoped npm names`);
      assert.ok(
        displayTextWidth(sample.title.content, sample.title.fontSize, displayMetricsForFontFamily(sample.title.fontFamily))
          <= sample.title.maxWidth,
        `${band} ${name} must fit its card`,
      );
      assert.ok(sample.title.fontSize * focusZoom >= C4_LABEL_MIN_TITLE_PX - 1e-6,
        `${band} ${name} title must meet the 12px truncation floor at focus`);
      if (band === 'context') {
        assert.ok(sample.title.fontSize * C4_CAMERA_LIMITS.minZoom >= 8,
          `${name} L1 title must remain a real glyph at the camera floor`);
      }
      assert.equal(sample.fill.kind, 'roundedRect');
      assert.ok(contrastRatio(sample.title.color, sample.fill.fill) >= 4.5,
        `${band} ${name} title contrast must hold against the unselected card fill`);
      assert.equal(sample.support, undefined, `${band} ${name} must not invent canvas copy when responsibility is absent`);
    }
  }

  const fontsource = snapshot.entities.find(entity => entity.id === 'external:fontsource')!;
  assert.equal(fontsource.responsibility, undefined);
  assert.notEqual(fontsource.responsibility, EMPTY_SUMMARY);
});

test('CLA-53 does not lower the CLA-45 owner-shell stroke floor', () => {
  assert.equal(C4_BOUNDARY_STROKE_ALPHA, 0.88);
});
