import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cameraWorldRect,
  sliceArchitectureNeighborhood,
  ASPECT_PRESET_TARGET,
  C4_CONTEXT_CARD_FACE,
  type ArchitectureSnapshot,
  type ArchitectureView,
} from '@okie/architecture';
import { denseNeighborhoodSnapshot } from '@okie/scene-compiler';
import demoSnapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../../fixtures/architecture/demo-story.json';
import { explorerEntitiesForView } from '../entityExplorer';
import { createC4Scene, createGoldenC4Scene } from '../renderer/goldenC4Scene';
import { scanCompileFocusForBand } from '../renderer/lazyBandCompile';
import { compileScanNeighborhoodFixture, SCAN_BAND_DEPTH_MIN_ENTITIES, SCAN_RESIDENT_NODES_PER_BAND } from '../renderer/scanFixture';
import { idleSemanticLensSession, semanticLensSessionVisibleEntityIds } from './semanticLens';
import {
  CONTEXT_TITLE_READABLE_MIN_ZOOM,
  contextCardFaceBounds,
  contextTitleCssPx,
  frameContextArrivalCamera,
  frameProjectionScope,
  frameVisibleProjection,
  projectedEntitiesFitSafeViewport,
  residentVisibleProjectionEntityIds,
  semanticLevelSession,
} from './semanticLensEngine';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

/** Inspector-open desktop chrome, matching the atlas crop used when shooting L1. */
const viewport = { width: 1_280, height: 720 };
const chromeSafeArea = { top: 80, right: 300, bottom: 72, left: 64 };

const GOLDEN_L1_IDS = [
  'actor:developer',
  'external:browser-graphics',
  'external:source-repository',
  'system:okie',
] as const;

describe('CLA-44: Fit frames the visible projection, not the root scope', () => {
  it('golden L1 Fit shows every painted context peer after one Fit', () => {
    const scene = createGoldenC4Scene();
    const visibleIds = semanticLensSessionVisibleEntityIds(scene, idleSemanticLensSession('context'));
    expect(visibleIds).toEqual([...GOLDEN_L1_IDS].sort());
    expect(visibleIds).toEqual([...scene.projection!.entityIdsByDetail.context].sort());

    const camera = frameVisibleProjection(scene, visibleIds, 'context', viewport, chromeSafeArea);
    expect(camera).toBeDefined();
    expect(projectedEntitiesFitSafeViewport(
      scene,
      visibleIds,
      'context',
      camera!,
      viewport,
      chromeSafeArea,
    )).toBe(true);
  });

  it('root-scope readable Fit leaves L1 context peers outside the safe viewport', () => {
    const scene = createGoldenC4Scene();
    const visibleIds = semanticLensSessionVisibleEntityIds(scene, idleSemanticLensSession('context'));
    const cropped = frameProjectionScope(
      scene,
      'system:okie',
      'context',
      viewport,
      chromeSafeArea,
      false,
      true,
    )!;
    expect(projectedEntitiesFitSafeViewport(
      scene,
      visibleIds,
      'context',
      cropped,
      viewport,
      chromeSafeArea,
    )).toBe(false);
  });

  it('Fit architecture to view wires the visible projection and stays a user gesture', () => {
    const fitStart = app.indexOf('aria-label="Fit architecture to view"');
    const fitEnd = app.indexOf('><FitIcon/></button>', fitStart);
    const fit = app.slice(fitStart, fitEnd);
    expect(fit).toContain('frameVisibleProjection(scene, activeProjectionEntityIds, activeDetail, viewport, measureCurrentMapSafeArea()) ?? camera');
    expect(fit).not.toContain('?? defaultCamera');
    expect(fit).not.toContain('navigationIdentity.rootEntityId');
    expect(fit).not.toContain('false, true');

    const autoFitStart = app.indexOf('const requiresFit = !initialMapFitAppliedRef.current;');
    const autoFitEnd = app.indexOf('}, [detailsOpen, navigationIdentity.rootEntityId, query.fixture, safeAreaEpoch, scene, storyStep, viewport.height, viewport.width]);');
    const autoFit = app.slice(autoFitStart, autoFitEnd);
    expect(autoFit).toContain('if (!requiresFit) return;');
    expect(autoFit).toContain('frameProjectionScope(scene, navigationIdentity.rootEntityId, activeDetail, viewport, safeArea, false, true)');
    expect(autoFit).not.toContain('frameVisibleProjection(');
  });
});

function rectsOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number },
) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function boundsUnion(
  scene: {
    projection?: {
      boundsByEntityIdAndDetail?: Record<string, Partial<Record<'code', { x: number; y: number; width: number; height: number }>>>;
    };
  },
  ids: readonly string[],
  detail: 'code',
) {
  const boxes = ids.flatMap(id => {
    const bounds = scene.projection?.boundsByEntityIdAndDetail?.[id]?.[detail];
    return bounds ? [bounds] : [];
  });
  if (!boxes.length) return undefined;
  const left = Math.min(...boxes.map(box => box.x));
  const top = Math.min(...boxes.map(box => box.y));
  const right = Math.max(...boxes.map(box => box.x + box.width));
  const bottom = Math.max(...boxes.map(box => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function rectCenter(bounds: { x: number; y: number; width: number; height: number }) {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function distance(
  left: { x: number; y: number },
  right: { x: number; y: number },
) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function cardFaceInSafeViewport(
  bounds: { x: number; y: number; width: number; height: number },
  camera: { x: number; y: number; zoom: number },
  view: { width: number; height: number },
  safeArea: { top: number; right: number; bottom: number; left: number },
) {
  const face = contextCardFaceBounds(bounds);
  const padding = 24;
  const left = view.width / 2 + (face.x - camera.x) * camera.zoom;
  const top = view.height / 2 + (face.y - camera.y) * camera.zoom;
  const right = left + face.width * camera.zoom;
  const bottom = top + face.height * camera.zoom;
  return left >= safeArea.left + padding
    && right <= view.width - safeArea.right - padding
    && top >= safeArea.top + padding
    && bottom <= view.height - safeArea.bottom - padding;
}

/** World point Fit aims at (safe-viewport center), not the raw camera origin. */
function fitAim(camera: { x: number; y: number; zoom: number }) {
  const safeWidth = viewport.width - chromeSafeArea.left - chromeSafeArea.right;
  const safeHeight = viewport.height - chromeSafeArea.top - chromeSafeArea.bottom;
  return {
    x: camera.x + (chromeSafeArea.left + safeWidth / 2 - viewport.width / 2) / camera.zoom,
    y: camera.y + (chromeSafeArea.top + safeHeight / 2 - viewport.height / 2) / camera.zoom,
  };
}

describe('CLA-79: Fit after Code rail frames resident L4 cards', () => {
  it('does not raise the 2000 hang-guard', () => {
    expect(readFileSync(new URL('../renderer/scanFixture.ts', import.meta.url), 'utf8'))
      .toContain('export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;');
    expect(SCAN_RESIDENT_NODES_PER_BAND).toBe(50);
  });

  it('at L4 with explorer code rows, Fit leaves a compiled code card in camera bounds', () => {
    const scene = createC4Scene({
      baseSnapshot: denseNeighborhoodSnapshot('code', 80),
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
    const selected = scene.entities.find(entity => entity.id === 'container:c');
    expect(selected).toBeDefined();
    const session = semanticLevelSession(scene, 'code', ['container:c', 'component:c']);
    const visibleIds = semanticLensSessionVisibleEntityIds(scene, session);
    const codeIds = scene.projection?.entityIdsByDetail.code ?? [];
    expect(codeIds.length).toBeGreaterThan(0);
    const rows = explorerEntitiesForView(scene, {
      detail: 'code',
      selected: selected!,
      settledTargetIds: session.settled.map(entry => entry.targetId),
      visibleIds,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(entity => entity.detail === 'code' && codeIds.includes(entity.id))).toBe(true);

    const residentIds = residentVisibleProjectionEntityIds(scene, visibleIds, 'code');
    expect(residentIds.length).toBeGreaterThan(0);
    expect(residentIds.every(id => codeIds.includes(id))).toBe(true);
    expect(residentIds.every(id => scene.entities.find(entity => entity.id === id)?.detail === 'code')).toBe(true);
    expect(visibleIds.some(id => scene.entities.find(entity => entity.id === id)?.detail !== 'code')).toBe(true);
    expect(residentIds).not.toContain('system:d');
    expect(residentIds).not.toContain('container:c');

    const camera = frameVisibleProjection(scene, visibleIds, 'code', viewport, chromeSafeArea);
    expect(camera).toBeDefined();
    const world = cameraWorldRect(camera!, viewport);
    const inView = residentIds.filter(id => {
      const bounds = scene.projection?.boundsByEntityIdAndDetail[id]?.code;
      return bounds ? rectsOverlap(world, bounds) : false;
    });
    expect(inView.length).toBeGreaterThan(0);

    const ancestorUnion = boundsUnion(scene, visibleIds, 'code');
    const residentUnion = boundsUnion(scene, residentIds, 'code');
    expect(ancestorUnion).toBeDefined();
    expect(residentUnion).toBeDefined();
    const aim = fitAim(camera!);
    const split = distance(rectCenter(residentUnion!), rectCenter(ancestorUnion!));
    if (split > 1) {
      expect(distance(aim, rectCenter(residentUnion!))).toBeLessThan(distance(aim, rectCenter(ancestorUnion!)));
    }
  });

  it('Code-rail explorer rows at L4 stay inside the Fit camera on a container neighborhood', async () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        snapshot,
        view,
        { focusEntityId: focus || 'system:okie' },
      ),
      loadExcerpts: async () => undefined,
      loadStory: async () => demoStory,
    };
    const l1 = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: 'system:okie' });
    const fixture = compileScanNeighborhoodFixture(l1, demoStory, host);
    await fixture.ensureNeighborhood('container:web-app');
    const l4Focus = scanCompileFocusForBand(
      fixture.snapshot,
      'container:web-app',
      'code',
      fixture.navigation.rootEntityId,
    );
    await fixture.ensureNeighborhood(l4Focus);
    const l4 = fixture.createScene(l4Focus);
    const selected = l4.entities.find(entity => entity.id === 'container:web-app');
    expect(selected).toBeDefined();
    const session = semanticLevelSession(l4, 'code', ['container:web-app']);
    const visibleIds = semanticLensSessionVisibleEntityIds(l4, session);
    const rows = explorerEntitiesForView(l4, {
      detail: 'code',
      selected: selected!,
      settledTargetIds: session.settled.map(entry => entry.targetId),
      visibleIds,
    });
    expect(rows.some(entity => entity.detail === 'code')).toBe(true);
    expect(visibleIds).toContain('system:okie');
    const camera = frameVisibleProjection(l4, visibleIds, 'code', viewport, chromeSafeArea);
    expect(camera).toBeDefined();
    const world = cameraWorldRect(camera!, viewport);
    const codeRows = rows.filter(entity => entity.detail === 'code');
    expect(codeRows.length).toBeGreaterThan(0);
    expect(codeRows.every(entity => {
      const bounds = l4.projection?.boundsByEntityIdAndDetail[entity.id]?.code;
      return bounds ? rectsOverlap(world, bounds) : false;
    })).toBe(true);

    const ancestorUnion = boundsUnion(l4, visibleIds, 'code');
    const residentUnion = boundsUnion(
      l4,
      residentVisibleProjectionEntityIds(l4, visibleIds, 'code'),
      'code',
    );
    expect(ancestorUnion).toBeDefined();
    expect(residentUnion).toBeDefined();
    expect(ancestorUnion!.width).toBeGreaterThan(residentUnion!.width * 2);
    const aim = fitAim(camera!);
    expect(distance(aim, rectCenter(residentUnion!)))
      .toBeLessThan(distance(aim, rectCenter(ancestorUnion!)));
  });

  it('does not restore ancestor shells when the native code set is empty', () => {
    const scene = createGoldenC4Scene();
    const ancestors = ['system:okie', 'container:web-app', 'component:web-shell'];
    expect(residentVisibleProjectionEntityIds(scene, ancestors, 'code')).toEqual([]);
    expect(frameVisibleProjection(
      scene,
      ancestors,
      'code',
      viewport,
      chromeSafeArea,
    )).toBeUndefined();
  });
});

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
    id: 'snapshot:cla-82',
    repositoryId: 'repo:cla-82',
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

describe('CLA-82: scan L1 first paint and Fit frame readable card faces', () => {
  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(readFileSync(new URL('../renderer/scanFixture.ts', import.meta.url), 'utf8'))
      .toContain('export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;');
  });

  it('scan boot uses card-face arrival, not the golden toy camera', () => {
    expect(app).toContain('camera: scanFixture ? (frameContextArrivalCamera(goldenScene) ?? defaultCamera) : defaultCamera');
    expect(app).toContain('const defaultCamera: Camera = { x: 1_080, y: 375, zoom: levels[0]!.zoom };');
    const autoFitStart = app.indexOf('const requiresFit = !initialMapFitAppliedRef.current;');
    const autoFitEnd = app.indexOf('}, [detailsOpen, navigationIdentity.rootEntityId, query.fixture, safeAreaEpoch, scene, storyStep, viewport.height, viewport.width]);');
    const autoFit = app.slice(autoFitStart, autoFitEnd);
    expect(autoFit).toContain('if (!requiresFit) return;');
    expect(autoFit).toContain('frameProjectionScope(scene, navigationIdentity.rootEntityId, activeDetail, viewport, safeArea, false, true)');
    expect(autoFit).not.toContain('frameVisibleProjection(');
    expect(autoFit).not.toContain('frameContextArrivalCamera(');
  });

  it('golden L1 Fit still shows every painted context peer', () => {
    const scene = createGoldenC4Scene();
    const visibleIds = semanticLensSessionVisibleEntityIds(scene, idleSemanticLensSession('context'));
    const camera = frameVisibleProjection(scene, visibleIds, 'context', viewport, chromeSafeArea);
    expect(camera).toBeDefined();
    expect(projectedEntitiesFitSafeViewport(
      scene,
      visibleIds,
      'context',
      camera!,
      viewport,
      chromeSafeArea,
    )).toBe(true);
  });

  it('Fit at L1 does not collapse to z=0.32 over a reserved shell', () => {
    const scene = reservedShellContextScene();
    const system = scene.projection!.boundsByEntityIdAndDetail['system:okie']!.context!;
    expect(system.height).toBeGreaterThan(C4_CONTEXT_CARD_FACE.height * 2);
    expect(system.width).toBeGreaterThan(C4_CONTEXT_CARD_FACE.width * 1.5);

    const visibleIds = semanticLensSessionVisibleEntityIds(scene, idleSemanticLensSession('context'));
    expect(visibleIds.some(id => id.startsWith('external:'))).toBe(true);

    const camera = frameVisibleProjection(scene, visibleIds, 'context', viewport, chromeSafeArea);
    expect(camera).toBeDefined();
    expect(camera!.zoom).toBeGreaterThan(0.32);
    expect(camera!.zoom).toBeGreaterThan(CONTEXT_TITLE_READABLE_MIN_ZOOM - 1e-9);
    expect(contextTitleCssPx(camera!.zoom)).toBeGreaterThanOrEqual(12);

    const world = cameraWorldRect(camera!, viewport);
    const face = contextCardFaceBounds(system);
    expect(rectsOverlap(world, face)).toBe(true);
    expect(cardFaceInSafeViewport(system, camera!, viewport, chromeSafeArea)).toBe(true);
    const hollow = { x: system.x, y: system.y, width: system.width, height: system.height };
    const aim = fitAim(camera!);
    expect(distance(aim, rectCenter(face)))
      .toBeLessThan(distance(aim, rectCenter(hollow)));
    const nearbyPeers = visibleIds.filter(id => id.startsWith('external:'));
    expect(nearbyPeers.some(id => {
      const bounds = scene.projection?.boundsByEntityIdAndDetail[id]?.context;
      return bounds ? cardFaceInSafeViewport(bounds, camera!, viewport, chromeSafeArea) : false;
    })).toBe(true);
  });

  it('scan L1 arrival camera frames the title-row cluster, not the golden default', () => {
    const scene = reservedShellContextScene();
    const camera = frameContextArrivalCamera(scene, viewport, chromeSafeArea);
    expect(camera).toBeDefined();
    expect(camera).not.toEqual({ x: 1_080, y: 375, zoom: 0.75 });
    expect(camera!.zoom).toBeGreaterThan(CONTEXT_TITLE_READABLE_MIN_ZOOM - 1e-9);
    expect(contextTitleCssPx(camera!.zoom)).toBeGreaterThanOrEqual(12);
    const system = scene.projection!.boundsByEntityIdAndDetail['system:okie']!.context!;
    expect(rectsOverlap(cameraWorldRect(camera!, viewport), contextCardFaceBounds(system))).toBe(true);
    expect(cardFaceInSafeViewport(system, camera!, viewport, chromeSafeArea)).toBe(true);
    const visibleIds = semanticLensSessionVisibleEntityIds(scene, idleSemanticLensSession('context'));
    expect(visibleIds.filter(id => id.startsWith('external:')).some(id => {
      const bounds = scene.projection?.boundsByEntityIdAndDetail[id]?.context;
      return bounds ? cardFaceInSafeViewport(bounds, camera!, viewport, chromeSafeArea) : false;
    })).toBe(true);
  });

  it('initialize readable-root at L1 frames the same nearby cluster, not the hollow shell', () => {
    const scene = reservedShellContextScene();
    const camera = frameProjectionScope(
      scene,
      'system:okie',
      'context',
      viewport,
      chromeSafeArea,
      false,
      true,
    );
    expect(camera).toBeDefined();
    expect(camera!.zoom).toBeGreaterThan(CONTEXT_TITLE_READABLE_MIN_ZOOM - 1e-9);
    expect(contextTitleCssPx(camera!.zoom)).toBeGreaterThanOrEqual(12);
    const system = scene.projection!.boundsByEntityIdAndDetail['system:okie']!.context!;
    expect(cardFaceInSafeViewport(system, camera!, viewport, chromeSafeArea)).toBe(true);
    const visibleIds = semanticLensSessionVisibleEntityIds(scene, idleSemanticLensSession('context'));
    expect(visibleIds.filter(id => id.startsWith('external:')).some(id => {
      const bounds = scene.projection?.boundsByEntityIdAndDetail[id]?.context;
      return bounds ? cardFaceInSafeViewport(bounds, camera!, viewport, chromeSafeArea) : false;
    })).toBe(true);
    const fit = frameVisibleProjection(scene, visibleIds, 'context', viewport, chromeSafeArea);
    expect(fit).toEqual(camera);
  });

  it('CLA-93: rail Step-out (preferReadableRoot=false) matches L1 Fit/boot, not z=0.32', () => {
    const scene = reservedShellContextScene();
    const rail = frameProjectionScope(scene, 'system:okie', 'context', viewport, chromeSafeArea);
    const boot = frameProjectionScope(
      scene,
      'system:okie',
      'context',
      viewport,
      chromeSafeArea,
      false,
      true,
    );
    const arrival = frameContextArrivalCamera(scene, viewport, chromeSafeArea);
    expect(rail).toEqual(arrival);
    expect(rail).toEqual(boot);
    expect(rail).toBeDefined();
    expect(rail!.zoom).toBeGreaterThan(0.32);
    expect(rail!.zoom).toBeGreaterThan(CONTEXT_TITLE_READABLE_MIN_ZOOM - 1e-9);
    expect(contextTitleCssPx(rail!.zoom)).toBeGreaterThanOrEqual(12);
    const system = scene.projection!.boundsByEntityIdAndDetail['system:okie']!.context!;
    expect(cardFaceInSafeViewport(system, rail!, viewport, chromeSafeArea)).toBe(true);
    const visibleIds = semanticLensSessionVisibleEntityIds(scene, idleSemanticLensSession('context'));
    expect(visibleIds.filter(id => id.startsWith('external:')).some(id => {
      const bounds = scene.projection?.boundsByEntityIdAndDetail[id]?.context;
      return bounds ? cardFaceInSafeViewport(bounds, rail!, viewport, chromeSafeArea) : false;
    })).toBe(true);
  });
});
