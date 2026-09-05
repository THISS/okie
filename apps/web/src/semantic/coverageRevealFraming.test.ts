import { describe, expect, it } from 'vitest';
import { ASPECT_PRESET_TARGET } from '@okie/architecture';
import type { ArchitectureSnapshot } from '@okie/architecture';
import { createC4Scene } from '../renderer/goldenC4Scene';
import { ATLAS_CAMERA_BOUNDS } from '../renderer/cameraBounds';
import {
  COMPONENT_TITLE_READABLE_MIN_ZOOM,
  frameComponentPeerArrivalCamera,
  frameProjectionScope,
} from './semanticLensEngine';

// Coverage-reveal drill/rail landing (tasks #30/#33 Stage A framing). Scan mode
// used to land a large reserved owner at COVERAGE_REVEAL.full — that clamped to
// ATLAS_CAMERA_BOUNDS.minZoom over a hollow CLA-81 shell (CLA-92). Reserved L3
// owners now frame file-component peer cards at a title-readable zoom. Demo
// (no targetAspect) keeps the band-floor landing → byte-identical, bandPolicy.qa
// unchanged.

function denseContainerSnapshot(componentCount: number): ArchitectureSnapshot {
  const entities: ArchitectureSnapshot['entities'] = [
    { id: 'system:d', kind: 'softwareSystem', name: 'D', sourceRefs: [] },
    { id: 'container:c', kind: 'container', parentId: 'system:d', name: 'C', sourceRefs: [] },
  ];
  for (let index = 0; index < componentCount; index += 1) {
    const cid = `component:m${String(index).padStart(3, '0')}`;
    entities.push({ id: cid, kind: 'component', parentId: 'container:c', name: `m${index}`, sourceRefs: [] });
    entities.push({ id: `code:${cid}`, kind: 'code', parentId: cid, name: 'k', sourceRefs: [] });
  }
  return { schemaVersion: 1, id: 'snapshot:d', repositoryId: 'repo:d', commitSha: 'c', generatedAt: '2026-01-01T00:00:00.000Z', entities, relations: [] };
}

const scanScene = (componentCount: number, targetAspect?: number) => createC4Scene({
  baseSnapshot: denseContainerSnapshot(componentCount),
  rootEntityId: 'system:d',
  focusEntityId: 'container:c',
  familyId: 'f',
  sceneId: 'scan:d:c4',
  title: 'D',
  subtitle: '',
  frozenRevision: 'c',
  ...(targetAspect !== undefined ? { targetAspect } : {}),
});

const viewport = { width: 1280, height: 720 };
const safeArea = { top: 80, right: 300, bottom: 72, left: 64 };
const COMPONENT_BAND_FLOOR = 3.35;

describe('coverage-reveal drill/rail landing (scan mode)', () => {
  it('CLA-92: reserved L3 scan drill frames peer cards, not minZoom over the hollow shell', () => {
    const scene = scanScene(40, ASPECT_PRESET_TARGET.landscape);
    expect(scene.targetAspect).toBe(ASPECT_PRESET_TARGET.landscape);
    const camera = frameProjectionScope(scene, 'container:c', 'component', viewport, safeArea)!;
    expect(camera).toEqual(frameComponentPeerArrivalCamera(scene, 'container:c', viewport, safeArea));
    expect(camera.zoom).toBeGreaterThan(ATLAS_CAMERA_BOUNDS.minZoom);
    expect(camera.zoom).toBeGreaterThanOrEqual(COMPONENT_TITLE_READABLE_MIN_ZOOM - 1e-9);
    expect(camera.zoom).not.toBeCloseTo(ATLAS_CAMERA_BOUNDS.minZoom, 2);
  });

  it('rail framing (preferReadableRoot) matches Open-inside peer-card landing on a reserved L3 shell', () => {
    const scene = scanScene(40, ASPECT_PRESET_TARGET.landscape);
    const drill = frameProjectionScope(scene, 'container:c', 'component', viewport, safeArea, false, false)!;
    const rail = frameProjectionScope(scene, 'container:c', 'component', viewport, safeArea, false, true)!;
    expect(rail.zoom).toBeGreaterThan(ATLAS_CAMERA_BOUNDS.minZoom);
    expect(rail.zoom).toBeCloseTo(drill.zoom, 5);
  });

  it('demo (no targetAspect) keeps the band-floor landing — bandPolicy.qa contract preserved', () => {
    const scene = scanScene(40, undefined);
    expect(scene.targetAspect).toBeUndefined();
    const camera = frameProjectionScope(scene, 'container:c', 'component', viewport, safeArea)!;
    expect(camera.zoom).toBeGreaterThanOrEqual(COMPONENT_BAND_FLOOR - 1e-9);
  });
});
