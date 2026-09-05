import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ASPECT_PRESET_TARGET, buildC4ProjectionBundle, computeContainmentLayout } from '@okie/architecture';
import { compileC4Scene } from '@okie/scene-compiler';
import { SCAN_BAND_DEPTH_MIN_ENTITIES } from './renderer/scanFixture';
import { createC4Scene } from './renderer/goldenC4Scene';
import { denseNeighborhoodSnapshot } from '@okie/scene-compiler';

const fixture = readFileSync(new URL('./renderer/scanFixture.ts', import.meta.url), 'utf8');

describe('CLA-81: shape-first atlas reserves containment geometry', () => {
  it('does not raise the 2000 hang-guard or replace lazy band compile', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(fixture).toContain('export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;');
    expect(fixture).toContain("maxBand: 'container'");
    expect(fixture).toContain('childCounts');
    expect(fixture).not.toMatch(/SCAN_BAND_DEPTH_MIN_ENTITIES = [3-9]\d{3}/);
  });

  it('omitted L4 cards keep blank reserved shells without invented summaries', () => {
    const snapshot = denseNeighborhoodSnapshot('code', 40);
    const scene = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: 'system:d',
      focusEntityId: 'component:c',
      familyId: 'f',
      sceneId: 's',
      title: 't',
      subtitle: 's',
      frozenRevision: 'c',
      maxBand: 'code',
      maxNodesPerBand: 12,
      targetAspect: ASPECT_PRESET_TARGET.landscape,
    });
    expect((scene.omittedNodes?.length ?? 0)).toBeGreaterThan(0);
    expect((scene.projection?.entityIdsByDetail.code ?? []).length).toBeLessThan(40);
    const protocol = scene.protocolSnapshot as { objects: Array<{ id: string }> };
    const omittedVisual = new Set((scene.omittedNodes ?? []).map(node => `visual-node:${node.entityId}`));
    expect(protocol.objects.some(object => omittedVisual.has(object.id))).toBe(false);
    expect(protocol.objects.length).toBeLessThan(40);
    const owner = (scene.protocolSnapshot as {
      objects: Array<{ id: string; representations: Array<{ primitives: Array<{ kind: string }> }> }>;
    }).objects.find(object => object.id === 'visual-node:component:c');
    expect(owner).toBeDefined();
    const reservedRects = owner!.representations.flatMap(representation =>
      representation.primitives.filter(primitive => primitive.kind === 'roundedRect'),
    );
    expect(reservedRects.length).toBeGreaterThan(scene.omittedNodes!.length);
  });

  it('containment layout from childCounts is a committed size hint', () => {
    const snapshot = denseNeighborhoodSnapshot('code', 8);
    const layout = computeContainmentLayout(
      snapshot.entities.map(entity => ({
        id: entity.id,
        kind: entity.kind,
        ...(entity.parentId ? { parentId: entity.parentId } : {}),
      })),
      { targetAspect: ASPECT_PRESET_TARGET.landscape },
    );
    const file = layout['component:c'];
    expect(file).toBeDefined();
    expect(file!.width).toBeGreaterThan(1);
    expect(file!.height).toBeGreaterThan(1);
    const bundle = buildC4ProjectionBundle(snapshot, {
      rootEntityId: 'system:d',
      focusEntityId: 'component:c',
      familyId: 'f',
      maxBand: 'code',
      targetAspect: ASPECT_PRESET_TARGET.landscape,
    });
    const compiled = compileC4Scene(snapshot, bundle, { targetAspect: ASPECT_PRESET_TARGET.landscape });
    const opened = compiled.projections.index.boundsByEntityIdAndBand['component:c']?.code
      ?? compiled.projections.index.boundsByEntityIdAndBand['component:c']?.component;
    expect(opened).toBeDefined();
    expect(opened!.width).toBeGreaterThan(1);
    expect(opened!.height).toBeGreaterThan(1);
    expect(opened!.width).toBeGreaterThanOrEqual(file!.width * 0.9);
  });
});
