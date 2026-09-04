import { describe, expect, it } from 'vitest';
import { denseNeighborhoodSnapshot, compileC4Scene } from '@okie/scene-compiler';
import { buildC4ProjectionBundle } from '@okie/architecture';
import { createC4Scene, resolveOmittedNodes } from './goldenC4Scene';
import { SCAN_BAND_DEPTH_MIN_ENTITIES, SCAN_RESIDENT_NODES_PER_BAND } from './scanFixture';

describe('CLA-74: camera-resident L4 compile', () => {
  const snapshot = denseNeighborhoodSnapshot('code', 80);

  it('does not compile every off-camera code card when the file is fat', () => {
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
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
    });
    const codeIds = scene.projection?.entityIdsByDetail.code ?? [];
    expect(codeIds.length).toBeLessThan(80);
    expect(scene.omittedNodes?.length ?? 0).toBeGreaterThan(0);
    expect(codeIds.length + (scene.omittedNodes?.filter(node => node.detail === 'code').length ?? 0))
      .toBeGreaterThanOrEqual(80);
    const protocol = scene.protocolSnapshot as { objects: unknown[] };
    expect(protocol.objects.length).toBeLessThan(90);
  });

  it('Open inside without a camera window still keeps near-focus children', () => {
    const inherited = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: 'system:d',
      focusEntityId: 'component:c',
      familyId: 'f',
      sceneId: 's',
      title: 't',
      subtitle: 's',
      frozenRevision: 'c',
      maxBand: 'code',
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      residentWorldBounds: { x: 1_000_000, y: 1_000_000, width: 10, height: 10 },
    });
    const opened = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: 'system:d',
      focusEntityId: 'component:c',
      familyId: 'f',
      sceneId: 's',
      title: 't',
      subtitle: 's',
      frozenRevision: 'c',
      maxBand: 'code',
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
    });
    expect((opened.projection?.entityIdsByDetail.code ?? []).length).toBeGreaterThan(
      (inherited.projection?.entityIdsByDetail.code ?? []).length,
    );
    expect((opened.projection?.entityIdsByDetail.code ?? []).length).toBeGreaterThan(0);
  });

  it('panning the camera window compiles a sibling tile without a full-graph compile', () => {
    const left = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: 'system:d',
      focusEntityId: 'component:c',
      familyId: 'f',
      sceneId: 's',
      title: 't',
      subtitle: 's',
      frozenRevision: 'c',
      maxBand: 'code',
      residentWorldBounds: { x: 0, y: 0, width: 2_000, height: 800 },
    });
    const right = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: 'system:d',
      focusEntityId: 'component:c',
      familyId: 'f',
      sceneId: 's',
      title: 't',
      subtitle: 's',
      frozenRevision: 'c',
      maxBand: 'code',
      residentWorldBounds: { x: 0, y: 3_000, width: 2_000, height: 800 },
    });
    expect(left.projection?.entityIdsByDetail.code).not.toEqual(right.projection?.entityIdsByDetail.code);
    expect((left.projection?.entityIdsByDetail.code ?? []).length).toBeLessThan(80);
  });

  it('keeps omitted nodes enumerable for inspector +N more', () => {
    const bundle = buildC4ProjectionBundle(snapshot, {
      rootEntityId: 'system:d',
      focusEntityId: 'component:c',
      familyId: 'f',
      maxBand: 'code',
      maxNodesPerBand: 12,
    });
    const omitted = resolveOmittedNodes(bundle, snapshot);
    expect(omitted.length).toBeGreaterThan(0);
    expect(omitted.every(node => node.name && node.entityId)).toBe(true);
    expect(compileC4Scene(snapshot, bundle).scene.objects.length).toBeLessThan(80);
  });

  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
  });
});
