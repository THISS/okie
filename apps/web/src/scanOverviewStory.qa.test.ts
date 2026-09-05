import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ASPECT_PRESET_TARGET,
  C4_CONTEXT_CARD_FACE,
  cameraWorldRect,
  type ArchitectureSnapshot,
} from '@okie/architecture';
import { C4_ZOOM_BANDS } from '@okie/scene-compiler';
import { createC4Scene, createGoldenC4Scene, goldenAppStory } from './renderer/goldenC4Scene';
import { SCAN_BAND_DEPTH_MIN_ENTITIES } from './renderer/scanFixture';
import { ATLAS_CAMERA_BOUNDS } from './renderer/cameraBounds';
import {
  CONTEXT_TITLE_READABLE_MIN_ZOOM,
  contextCardFaceBounds,
  frameStoryStepCamera,
} from './semantic/semanticLensEngine';
import { frameSemanticEntities, worldToScreen } from './storyFraming';
import { storyStepSelectedId } from './storyFocus';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('./renderer/scanFixture.ts', import.meta.url), 'utf8');

const viewport = { width: 1_280, height: 720 };
const storySafeArea = { top: 102, right: 66, bottom: 250, left: 82 };
const contextFocusZoom = C4_ZOOM_BANDS[0]!.focusZoom;

function sliceBetween(source: string, startNeedle: string, endNeedle: string, label: string) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end < 0) throw new Error(`Missing ${label}`);
  return source.slice(start, end);
}

function reservedShellContextScene() {
  const externals = Array.from({ length: 8 }, (_, index) => ({
    id: `external:npm-${String(index).padStart(2, '0')}`,
    kind: 'externalSystem' as const,
    name: `pkg-${index}`,
    sourceRefs: [],
  }));
  const unpublished: Array<{ id: string; kind: 'container' | 'component'; parentId: string }> = [];
  const childCounts: Record<string, number> = { 'system:okie': 16 };
  for (let container = 0; container < 16; container += 1) {
    const containerId = `container:reserved-${String(container).padStart(2, '0')}`;
    unpublished.push({ id: containerId, kind: 'container', parentId: 'system:okie' });
    childCounts[containerId] = 10;
    for (let component = 0; component < 10; component += 1) {
      const componentId = `component:${containerId}:${String(component).padStart(2, '0')}`;
      unpublished.push({ id: componentId, kind: 'component', parentId: containerId });
      childCounts[componentId] = 12;
    }
  }
  const snapshot: ArchitectureSnapshot = {
    schemaVersion: 1,
    id: 'snapshot:cla-84',
    repositoryId: 'repo:cla-84',
    commitSha: 'c',
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities: [
      { id: 'system:okie', kind: 'softwareSystem', name: 'okie', sourceRefs: [] },
      ...externals,
    ],
    relations: [],
  };
  return createC4Scene({
    baseSnapshot: snapshot,
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
    familyId: 'f',
    sceneId: 's',
    title: 't',
    subtitle: 's',
    frozenRevision: 'c',
    maxBand: 'container',
    targetAspect: ASPECT_PRESET_TARGET.landscape,
    childCounts,
    unpublishedChildren: unpublished,
  });
}

function cardFaceInSafeViewport(
  bounds: { x: number; y: number; width: number; height: number },
  camera: { x: number; y: number; zoom: number },
) {
  const face = contextCardFaceBounds(bounds);
  const padding = 24;
  const topLeft = worldToScreen(face.x, face.y, camera, viewport);
  const bottomRight = worldToScreen(face.x + face.width, face.y + face.height, camera, viewport);
  return topLeft.x >= storySafeArea.left + padding
    && bottomRight.x <= viewport.width - storySafeArea.right - padding
    && topLeft.y >= storySafeArea.top + padding
    && bottomRight.y <= viewport.height - storySafeArea.bottom - padding;
}

describe('CLA-84: scan overview story frames the step box at band focus zoom', () => {
  it('does not raise the 2000 hang-guard or rewrite lazy band compile', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(fixture).toContain('export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;');
    expect(app).toContain('scanCompileFocusForBand(');
  });

  it('wires step jumps to select the focus entity and frameStoryStepCamera', () => {
    const setStepLoaded = sliceBetween(app, 'function setStepLoaded', 'function closeStory', 'setStepLoaded');
    expect(setStepLoaded).toContain('storyStepSelectedId(step.focusEntityIds');
    expect(setStepLoaded).toContain('setSelectedId(stepSelectedId)');
    expect(setStepLoaded).toContain('selectedId: stepSelectedId');
    expect(setStepLoaded).toContain('frameStoryStepCamera(stepScene, step.focusEntityIds, step.reveal');
    expect(setStepLoaded).not.toContain('frameSemanticEntities(stepScene, step.focusEntityIds');
    expect(app).toContain('frameStoryStepCamera(scene, step.focusEntityIds, step.reveal, viewport, measureCurrentStorySafeArea())');
  });

  it('does not invent overview narration or drop honest scan copy', () => {
    expect(app).not.toContain('You are looking at');
    expect(app).not.toContain('This commit');
    expect(app).toContain('currentStory.narration');
  });

  it('raw semantic fit of a reserved L1 shell still collapses to the camera floor', () => {
    const scene = reservedShellContextScene();
    const system = scene.projection!.boundsByEntityIdAndDetail['system:okie']!.context!;
    expect(system.height).toBeGreaterThan(C4_CONTEXT_CARD_FACE.height * 2);
    const focusIds = ['system:okie', ...scene.entities.filter(entity => entity.id.startsWith('external:')).map(entity => entity.id)];
    const collapsed = frameSemanticEntities(scene, focusIds, 'context', viewport, storySafeArea);
    expect(collapsed?.zoom).toBe(ATLAS_CAMERA_BOUNDS.minZoom);
  });

  it('overview step 1 centers the system card face at context focus zoom, not z=0.32', () => {
    const scene = reservedShellContextScene();
    const system = scene.projection!.boundsByEntityIdAndDetail['system:okie']!.context!;
    const focusIds = ['system:okie', ...scene.entities.filter(entity => entity.id.startsWith('external:')).map(entity => entity.id)];
    const camera = frameStoryStepCamera(scene, focusIds, 'context', viewport, storySafeArea);
    expect(camera).toBeDefined();
    expect(camera!.zoom).toBe(contextFocusZoom);
    expect(camera!.zoom).toBeGreaterThan(ATLAS_CAMERA_BOUNDS.minZoom);
    expect(camera!.zoom).toBeGreaterThan(CONTEXT_TITLE_READABLE_MIN_ZOOM);
    expect(cardFaceInSafeViewport(system, camera!)).toBe(true);
    const world = cameraWorldRect(camera!, viewport);
    const face = contextCardFaceBounds(system);
    expect(world.x < face.x + face.width && world.x + world.width > face.x).toBe(true);
    expect(world.y < face.y + face.height && world.y + world.height > face.y).toBe(true);
    const center = worldToScreen(face.x + face.width / 2, face.y + face.height / 2, camera!, viewport);
    const safeCenter = {
      x: storySafeArea.left + (viewport.width - storySafeArea.left - storySafeArea.right) / 2,
      y: storySafeArea.top + (viewport.height - storySafeArea.top - storySafeArea.bottom) / 2,
    };
    expect(center.x).toBeCloseTo(safeCenter.x, 5);
    expect(center.y).toBeCloseTo(safeCenter.y, 5);
    expect(storyStepSelectedId(focusIds, scene.entities.map(entity => entity.id))).toBe('system:okie');
  });

  it('golden overview steps still land at each band’s focus zoom', () => {
    const scene = createGoldenC4Scene();
    for (const step of goldenAppStory.steps) {
      const camera = frameStoryStepCamera(scene, step.focusEntityIds, step.reveal, viewport, storySafeArea);
      const band = scene.projection!.zoomPolicy!.bands.find(candidate => candidate.detail === step.reveal)!;
      expect(camera).toBeDefined();
      expect(camera!.zoom).toBe(band.focusZoom);
      expect(storyStepSelectedId(step.focusEntityIds, scene.entities.map(entity => entity.id)))
        .toBe(step.focusEntityIds[0]);
    }
  });
});
