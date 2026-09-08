import { describe, expect, it } from 'vitest';
import { ASPECT_PRESET_TARGET } from '@okie/architecture';
import type { ArchitectureSnapshot } from '@okie/architecture';
import { C4_ZOOM_BANDS } from '@okie/scene-compiler';
import { createC4Scene } from '../renderer/goldenC4Scene';
import { ATLAS_CAMERA_BOUNDS } from '../renderer/cameraBounds';
import {
  COMPONENT_TITLE_READABLE_MIN_ZOOM,
  CONTEXT_TITLE_READABLE_MIN_ZOOM,
  frameCodePeerArrivalCamera,
  frameComponentPeerArrivalCamera,
  frameContextArrivalCamera,
  frameProjectionScope,
} from './semanticLensEngine';

// Coverage-reveal drill/rail landing (tasks #30/#33 Stage A framing). Scan mode
// used to land a large reserved owner at COVERAGE_REVEAL.full — that clamped to
// ATLAS_CAMERA_BOUNDS.minZoom over a hollow CLA-81 shell (CLA-92/93). Reserved
// L3 owners frame file-component peer cards; reserved L1 rail Step-out frames
// the CLA-82 title-row cluster. Demo (no targetAspect) keeps the band-floor
// landing → byte-identical, bandPolicy.qa unchanged.

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
const CODE_BAND_ENTER = C4_ZOOM_BANDS[3]!.enterZoom;
const CODE_BAND_FOCUS = C4_ZOOM_BANDS[3]!.focusZoom;

function denseFileSnapshot(codeCount: number): ArchitectureSnapshot {
  const fileId = 'component:ask';
  const entities: ArchitectureSnapshot['entities'] = [
    { id: 'system:d', kind: 'softwareSystem', name: 'D', sourceRefs: [] },
    { id: 'container:c', kind: 'container', parentId: 'system:d', name: 'C', sourceRefs: [] },
    { id: fileId, kind: 'component', parentId: 'container:c', name: 'askAtlas.ts', sourceRefs: [] },
  ];
  for (let index = 0; index < codeCount; index += 1) {
    entities.push({
      id: `code:ask:${String(index).padStart(2, '0')}`,
      kind: 'code',
      parentId: fileId,
      name: `sym${index}`,
      sourceRefs: [],
    });
  }
  return {
    schemaVersion: 1,
    id: 'snapshot:ask',
    repositoryId: 'repo:ask',
    commitSha: 'c',
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities,
    relations: [],
  };
}

const scanFileScene = (codeCount: number, targetAspect?: number) => createC4Scene({
  baseSnapshot: denseFileSnapshot(codeCount),
  rootEntityId: 'component:ask',
  focusEntityId: 'component:ask',
  familyId: 'f',
  sceneId: 'scan:ask:c4',
  title: 'askAtlas.ts',
  subtitle: '',
  frozenRevision: 'c',
  maxBand: 'code',
  ...(targetAspect !== undefined ? { targetAspect } : {}),
});

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

  it('CLA-93: reserved L1 rail Step-out (preferReadableRoot=false) frames the arrival cluster, not minZoom', () => {
    const entities: ArchitectureSnapshot['entities'] = [
      { id: 'system:okie', kind: 'softwareSystem', name: 'okie', sourceRefs: [] },
    ];
    for (let index = 0; index < 8; index += 1) {
      entities.push({
        id: `external:npm-${String(index).padStart(2, '0')}`,
        kind: 'externalSystem',
        name: `pkg-${index}`,
        sourceRefs: [],
      });
    }
    const unpublished: Array<{ id: string; kind: 'container'; parentId: string }> = [];
    const childCounts: Record<string, number> = { 'system:okie': 16 };
    for (let index = 0; index < 16; index += 1) {
      unpublished.push({
        id: `container:reserved-${String(index).padStart(2, '0')}`,
        kind: 'container',
        parentId: 'system:okie',
      });
    }
    const snapshot: ArchitectureSnapshot = {
      schemaVersion: 1,
      id: 'snapshot:cla-93',
      repositoryId: 'repo:cla-93',
      commitSha: 'c',
      generatedAt: '2026-01-01T00:00:00.000Z',
      entities,
      relations: [],
    };
    const scene = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: 'system:okie',
      focusEntityId: 'system:okie',
      familyId: 'f',
      sceneId: 'scan:cla-93:c4',
      title: 'okie',
      subtitle: '',
      frozenRevision: 'c',
      targetAspect: ASPECT_PRESET_TARGET.landscape,
      childCounts,
      unpublishedChildren: unpublished,
    });
    const rail = frameProjectionScope(scene, 'system:okie', 'context', viewport, safeArea)!;
    const arrival = frameContextArrivalCamera(scene, viewport, safeArea)!;
    expect(rail).toEqual(arrival);
    expect(rail.zoom).toBeGreaterThan(ATLAS_CAMERA_BOUNDS.minZoom);
    expect(rail.zoom).toBeGreaterThanOrEqual(CONTEXT_TITLE_READABLE_MIN_ZOOM - 1e-9);
    expect(rail.zoom).not.toBeCloseTo(ATLAS_CAMERA_BOUNDS.minZoom, 2);
  });
});

describe('CLA-110: Open inside a busy file lands at code-band zoom', () => {
  it('frames L4 code peer cards at ≥ enterZoom, not coverage-reveal of the reserved file shell', () => {
    const scene = scanFileScene(52, ASPECT_PRESET_TARGET.landscape);
    expect(scene.targetAspect).toBe(ASPECT_PRESET_TARGET.landscape);
    const owner = scene.projection!.boundsByEntityIdAndDetail['component:ask']!.code!;
    expect(owner.width * owner.height).toBeGreaterThan(20 * 20);

    const camera = frameProjectionScope(scene, 'component:ask', 'code', viewport, safeArea)!;
    expect(camera).toEqual(frameCodePeerArrivalCamera(scene, 'component:ask', viewport, safeArea));
    expect(camera.zoom).toBeGreaterThanOrEqual(CODE_BAND_ENTER - 1e-9);
    expect(camera.zoom).toBeGreaterThan(ATLAS_CAMERA_BOUNDS.minZoom);
    expect(camera.zoom).toBeCloseTo(CODE_BAND_FOCUS, 0);
    expect(camera.zoom).not.toBeCloseTo(2.87, 1);
  });

  it('rail framing (preferReadableRoot) matches Open-inside code-card landing', () => {
    const scene = scanFileScene(52, ASPECT_PRESET_TARGET.landscape);
    const drill = frameProjectionScope(scene, 'component:ask', 'code', viewport, safeArea, false, false)!;
    const rail = frameProjectionScope(scene, 'component:ask', 'code', viewport, safeArea, false, true)!;
    expect(rail.zoom).toBeGreaterThanOrEqual(CODE_BAND_ENTER - 1e-9);
    expect(rail.zoom).toBeCloseTo(drill.zoom, 5);
  });

  it('demo (no targetAspect) keeps the band-floor landing — bandPolicy.qa contract preserved', () => {
    const scene = scanFileScene(52, undefined);
    expect(scene.targetAspect).toBeUndefined();
    const camera = frameProjectionScope(scene, 'component:ask', 'code', viewport, safeArea)!;
    expect(camera.zoom).toBeGreaterThanOrEqual(CODE_BAND_ENTER - 1e-9);
  });
});
