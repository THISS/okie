import { describe, expect, it } from 'vitest';
import { compensateSemanticInspectorFlightCamera, getLevel, retargetCameraForSemanticBand, semanticEntityFrameCamera, semanticInspectorFlightKind, semanticInspectorFlightProgress, semanticInspectorFlightSession, semanticInspectorHierarchyPlan, semanticInspectorRawCameraTarget, semanticLevelSession, semanticOpenNextLayer, semanticPanFocusPlan, semanticSourceSession } from './App';
import { createGoldenC4Scene } from './renderer/goldenC4Scene';
import { ATLAS_CAMERA_BOUNDS, semanticDominantZoomIntervals, semanticFocusZooms, semanticLevelAtZoom } from './renderer/cameraBounds';
import { zoomCameraAt } from './renderer/cameraController';
import { inspectorTabForEntity } from './inspectorPanel';
import { semanticLensSessionDetail, semanticLensSessionGhostEntities, semanticLensSessionProjectionOverride, semanticLensSessionVisibleEntityIds } from './semantic/semanticLens';
import type { Camera } from './renderer/types';

const presets = [0.75, 1.99, 5.27, 13.96] as const;

describe('explicit C4 level selection', () => {
  it('maps every forced rail preset to its intended semantic level', () => {
    expect(presets.map(zoom => getLevel(zoom))).toEqual([0, 1, 2, 3]);
  });

  it('provides four separated plateaus with one authored handoff between each pair', () => {
    const bands = createGoldenC4Scene().projection!.zoomPolicy!.bands;
    expect(bands.map(band => ({
      detail: band.detail,
      enter: band.enterZoom,
      full: Math.round(Math.min(ATLAS_CAMERA_BOUNDS.maxZoom, band.enterZoom + band.fadeWidth) * 100) / 100,
      focus: band.focusZoom,
    }))).toEqual([
      { detail: 'context', enter: 0, full: 0.14, focus: 0.75 },
      { detail: 'container', enter: 1.16, full: 1.30, focus: 1.99 },
      { detail: 'component', enter: 3.35, full: 3.75, focus: 5.27 },
      { detail: 'code', enter: 7.10, full: 7.95, focus: 13.96 },
    ]);
    expect(semanticFocusZooms(bands)).toEqual(presets);
    expect(semanticDominantZoomIntervals(bands)).toEqual([
      { min: .32, max: 1.159 },
      { min: 1.16, max: 3.349 },
      { min: 3.35, max: 7.099 },
      { min: 7.10, max: 32 },
    ]);
    for (const [index, zoom] of presets.slice(1).entries()) {
      expect(zoom / presets[index]!).toBeCloseTo(2.65, 2);
    }
    expect(presets.map(zoom => semanticLevelAtZoom(zoom, undefined, bands))).toEqual([0, 1, 2, 3]);
    expect([1.159, 1.16, 3.349, 3.35, 7.099, 7.10].map(zoom => getLevel(zoom)))
      .toEqual([0, 1, 1, 2, 2, 3]);
    expect(3.35 / 1.30).toBeGreaterThan(2.5);
    expect(7.10 / 3.75).toBeGreaterThan(1.8);
  });

  it('crosses the four handoff windows on the authored real-wheel cadence', () => {
    const viewport = { width: 1_280, height: 720 };
    const wheelZooms = (start: number, deltaY: number, count: number) => {
      let camera: Camera = { x: 0, y: 0, zoom: start };
      return Array.from({ length: count }, () => {
        camera = zoomCameraAt(camera, viewport.width / 2, viewport.height / 2, viewport, deltaY);
        return camera.zoom;
      });
    };
    const firstAtOrAbove = (zooms: number[], threshold: number) => zooms.findIndex(zoom => zoom >= threshold) + 1;
    const firstAtOrBelow = (zooms: number[], threshold: number) => zooms.findIndex(zoom => zoom <= threshold) + 1;

    const inward = wheelZooms(.75, -100, 25);
    expect([1.16, 1.30, 3.35, 3.75, 7.10, 7.95, 13.96].map(threshold => firstAtOrAbove(inward, threshold)))
      .toEqual([4, 5, 13, 14, 19, 20, 25]);

    const outward = wheelZooms(13.96, 100, 25);
    expect([7.95, 7.10, 3.75, 3.35, 1.30, 1.16, .75].map(threshold => firstAtOrBelow(outward, threshold)))
      .toEqual([5, 6, 11, 12, 20, 21, 25]);
  });

  it('makes every rail choice own one valid nested branch instead of only changing zoom', () => {
    const scene = createGoldenC4Scene();
    for (const [depth, detail] of (['context', 'container', 'component', 'code'] as const).entries()) {
      const session = semanticLevelSession(scene, detail, ['system:okie']);
      expect(session.active.phase).toBe('idle');
      expect(session.settled).toHaveLength(depth);
      expect(semanticLensSessionDetail(session)).toBe(detail);
      expect(semanticLensSessionVisibleEntityIds(scene, session).length)
        .toBeLessThanOrEqual(scene.projection!.entityIdsByDetail[detail].length);
      expect(semanticLensSessionProjectionOverride(scene, session)?.id).toContain(`semantic-path:context:`);
    }
    expect(semanticLevelSession(scene, 'container', ['system:okie']).settled.map(entry => entry.targetId))
      .toEqual(['system:okie']);
    expect(semanticLevelSession(scene, 'component', ['system:okie']).settled.map(entry => entry.targetId))
      .toEqual(['system:okie', 'container:architecture-model']);
    expect(semanticLevelSession(scene, 'code', ['system:okie']).settled.map(entry => entry.targetId))
      .toEqual(['system:okie', 'container:architecture-model', 'component:model-normalized']);
  });

  it('retargets an explicitly opened L4 source to its owning semantic branch without changing root', () => {
    const scene = createGoldenC4Scene();
    const current = semanticLevelSession(scene, 'code', ['component:model-normalized']);
    const selectedId = 'code:model-schema:snapshot';
    const next = semanticSourceSession(scene, current, selectedId);

    expect(current.settled.map(entry => entry.targetId)).toEqual([
      'system:okie',
      'container:architecture-model',
      'component:model-normalized',
    ]);
    expect(next.settled.map(entry => entry.targetId)).toEqual([
      'system:okie',
      'container:architecture-model',
      'component:model-schema',
    ]);
    expect(scene.rootEntityId).toBe('system:okie');
    expect(semanticLensSessionVisibleEntityIds(scene, next)).toContain(selectedId);
    expect(semanticSourceSession(scene, next, 'component:model-schema')).toBe(next);
  });

  it('lets L4 horizontal pan transfer the owner branch without replacing explicit source selection', () => {
    const scene = createGoldenC4Scene();
    const selectedId = 'code:model-schema:snapshot';
    const current = semanticSourceSession(
      scene,
      semanticLevelSession(scene, 'code', ['component:model-normalized']),
      selectedId,
    );
    const ghost = semanticLensSessionGhostEntities(scene, current)
      .find(candidate => candidate.id === 'component:model-normalized' && candidate.opacity === .24)!;
    const bounds = scene.projection!.boundsByEntityIdAndDetail[ghost.id]![ghost.detail]!;
    const plan = semanticPanFocusPlan(
      scene,
      current,
      selectedId,
      { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom: 14 },
      { width: 1_280, height: 720 },
      { top: 0, right: 0, bottom: 0, left: 0 },
      160,
    );

    expect(plan.session.focusTransfer).toMatchObject({
      targetId: 'component:model-normalized',
      depth: 2,
    });
    expect(plan.selectedId).toBe(selectedId);
    expect(scene.rootEntityId).toBe('system:okie');
  });
});

describe('rail semantic anchor retargeting', () => {
  const viewport = { width: 1280, height: 720 };
  const bounds = [
    { x: 800, y: 120, width: 480, height: 250 },
    { x: 800, y: 120, width: 1444, height: 538 },
    { x: 800, y: 120, width: 2748, height: 1134 },
    { x: 800, y: 120, width: 5408, height: 2126 },
  ];

  it('round-trips every band without accumulating world-space drift', () => {
    const initial: Camera = { x: 1040, y: 245, zoom: presets[0] };
    let camera = initial;
    for (let index = 1; index < bounds.length; index += 1) {
      camera = retargetCameraForSemanticBand(camera, bounds[index - 1], bounds[index]!, presets[index]!, viewport);
    }
    for (let index = bounds.length - 2; index >= 0; index -= 1) {
      camera = retargetCameraForSemanticBand(camera, bounds[index + 1], bounds[index]!, presets[index]!, viewport);
    }
    expect(camera).toEqual(initial);
  });

  it('recenters the incoming semantic anchor when the previous one is offscreen', () => {
    expect(retargetCameraForSemanticBand(
      { x: -10_000, y: -10_000, zoom: presets[3] },
      bounds[3],
      bounds[0]!,
      presets[0],
      viewport,
    )).toEqual({ x: 1040, y: 245, zoom: presets[0] });
  });
});

describe('semantic double-click opening', () => {
  const viewport = { width: 1_280, height: 720 };
  const safeArea = { top: 80, right: 300, bottom: 72, left: 64 };
  const rootEntityId = 'system:okie';

  function expectSafelyFramed(
    scene: ReturnType<typeof createGoldenC4Scene>,
    plan: NonNullable<ReturnType<typeof semanticOpenNextLayer>>,
  ) {
    const bounds = scene.projection!.boundsByEntityIdAndDetail[plan.targetId]![plan.nextDetail]!;
    const band = scene.projection!.zoomPolicy!.bands.find(candidate => candidate.detail === plan.nextDetail)!;
    const fullZoom = band.enterZoom + band.fadeWidth;
    const safeCenter = {
      x: safeArea.left + (viewport.width - safeArea.left - safeArea.right) / 2,
      y: safeArea.top + (viewport.height - safeArea.top - safeArea.bottom) / 2,
    };
    const projectedCenter = {
      x: viewport.width / 2 + (bounds.x + bounds.width / 2 - plan.camera.x) * plan.camera.zoom,
      y: viewport.height / 2 + (bounds.y + bounds.height / 2 - plan.camera.y) * plan.camera.zoom,
    };
    const projectedRect = {
      left: viewport.width / 2 + (bounds.x - plan.camera.x) * plan.camera.zoom,
      top: viewport.height / 2 + (bounds.y - plan.camera.y) * plan.camera.zoom,
      right: viewport.width / 2 + (bounds.x + bounds.width - plan.camera.x) * plan.camera.zoom,
      bottom: viewport.height / 2 + (bounds.y + bounds.height - plan.camera.y) * plan.camera.zoom,
    };
    expect(plan.camera.zoom).toBeGreaterThanOrEqual(fullZoom);
    expect(plan.camera.zoom).toBeLessThanOrEqual(plan.nextDetail === 'code'
      ? scene.projection!.zoomPolicy!.maxZoom
      : band.focusZoom);
    expect(projectedCenter.x).toBeCloseTo(safeCenter.x, 10);
    expect(projectedCenter.y).toBeCloseTo(safeCenter.y, 10);
    expect(projectedRect.left).toBeGreaterThanOrEqual(safeArea.left + 42 - 1e-9);
    expect(projectedRect.right).toBeLessThanOrEqual(viewport.width - safeArea.right - 42 + 1e-9);
    expect(projectedRect.top).toBeGreaterThanOrEqual(safeArea.top + 42 - 1e-9);
    expect(projectedRect.bottom).toBeLessThanOrEqual(viewport.height - safeArea.bottom - 42 + 1e-9);
    expect(plan.rootEntityId).toBe(rootEntityId);
    expect(plan.historyMode).toBe('push');
  }

  function openThrough(detail: 'container' | 'component' | 'code') {
    const scene = createGoldenC4Scene();
    let session = semanticLevelSession(scene, 'context');
    const ids = ['system:okie', 'container:architecture-model', 'component:model-normalized'] as const;
    const stop = ['container', 'component', 'code'].indexOf(detail);
    let plan: NonNullable<ReturnType<typeof semanticOpenNextLayer>> | undefined;
    for (let index = 0; index <= stop; index += 1) {
      plan = semanticOpenNextLayer(scene, session, ids[index]!, viewport, safeArea, rootEntityId)!;
      expect(plan).toBeDefined();
      session = plan.session;
    }
    return { scene, plan: plan!, session };
  }

  it('opens an expandable L1 system into exactly L2', () => {
    const { scene, plan, session } = openThrough('container');
    expect(session.settled.map(entry => entry.targetId)).toEqual(['system:okie']);
    expect(semanticLensSessionDetail(session)).toBe('container');
    expectSafelyFramed(scene, plan);
  });

  it('opens an expandable L2 container into exactly L3', () => {
    const { scene, plan, session } = openThrough('component');
    expect(session.settled.map(entry => entry.targetId))
      .toEqual(['system:okie', 'container:architecture-model']);
    expect(semanticLensSessionDetail(session)).toBe('component');
    expectSafelyFramed(scene, plan);
  });

  it('opens an expandable L3 component into exactly L4', () => {
    const { scene, plan, session } = openThrough('code');
    expect(session.settled.map(entry => entry.targetId))
      .toEqual(['system:okie', 'container:architecture-model', 'component:model-normalized']);
    expect(semanticLensSessionDetail(session)).toBe('code');
    expectSafelyFramed(scene, plan);
  });

  it('leaves a non-expandable L4 source as a no-op', () => {
    const { scene, session } = openThrough('code');
    const source = scene.entities.find(entity => entity.parentId === 'component:model-normalized' && entity.detail === 'code')!;
    const before = structuredClone(session);
    expect(semanticOpenNextLayer(scene, session, source.id, viewport, safeArea, rootEntityId)).toBeUndefined();
    expect(session).toEqual(before);
  });

  it('never turns the clicked target or a persistent ancestor into a navigation root', () => {
    const scene = createGoldenC4Scene();
    const initial = semanticLevelSession(scene, 'context');
    const opened = semanticOpenNextLayer(scene, initial, rootEntityId, viewport, safeArea, rootEntityId)!;
    expect(opened.rootEntityId).toBe(scene.rootEntityId);
    expect(opened.historyMode).toBe('push');
    expect(semanticOpenNextLayer(scene, opened.session, rootEntityId, viewport, safeArea, rootEntityId)).toBeUndefined();
    expect(scene.rootEntityId).toBe(rootEntityId);
    expect(opened.session.settled.map(entry => entry.targetId)).toEqual([rootEntityId]);
  });

  it('transfers a ghost sibling at its depth and expands it without changing root', () => {
    const { scene, session } = openThrough('code');
    const ghost = semanticLensSessionGhostEntities(scene, session)
      .find(candidate => candidate.depth === 1
        && scene.entities.some(entity => entity.parentId === candidate.id && entity.detail === 'component'))!;
    const plan = semanticOpenNextLayer(scene, session, ghost.id, viewport, safeArea, rootEntityId)!;
    expect(plan).toBeDefined();
    expect(plan.session.settled.map(entry => entry.targetId)).toEqual(['system:okie', ghost.id]);
    expect(plan.session.focusTransfer).toMatchObject({ targetId: ghost.id, depth: 1, progress: 0 });
    expect(plan.nextDetail).toBe('component');
    expect(plan.rootEntityId).toBe(rootEntityId);
    expect(plan.historyMode).toBe('push');
  });
});

describe('inspector hierarchy semantic navigation', () => {
  const viewport = { width: 1_280, height: 720 };
  const safeArea = { top: 90, right: 390, bottom: 80, left: 70 };

  it('moves a component parent from an L4 lens back to its native L3 branch and frame', () => {
    const scene = createGoldenC4Scene();
    const l4 = semanticLevelSession(scene, 'code', ['code:model-scoping:select-scoped-view']);
    const l4Camera = semanticEntityFrameCamera(scene, 'code:model-scoping:select-scoped-view', 'code', viewport, safeArea)!;
    const plan = semanticInspectorHierarchyPlan(scene, 'component:model-scoping', viewport, safeArea, l4, l4Camera)!;

    expect(plan.detail).toBe('component');
    expect(semanticLensSessionDetail(plan.session)).toBe('component');
    expect(plan.session.settled.map(entry => entry.targetId))
      .toEqual(['system:okie', 'container:architecture-model']);
    expect(getLevel(plan.camera.zoom)).toBe(2);
    expect(plan.historyMode).toBe('replace');
  });

  it('moves a code child from L3 into its native L4 branch and frame', () => {
    const scene = createGoldenC4Scene();
    const l3 = semanticLevelSession(scene, 'component', ['component:model-scoping']);
    const l3Camera = semanticEntityFrameCamera(scene, 'component:model-scoping', 'component', viewport, safeArea)!;
    const plan = semanticInspectorHierarchyPlan(scene, 'code:model-scoping:select-scoped-view', viewport, safeArea, l3, l3Camera)!;

    expect(plan.detail).toBe('code');
    expect(semanticLensSessionDetail(plan.session)).toBe('code');
    expect(plan.session.settled.map(entry => entry.targetId))
      .toEqual(['system:okie', 'container:architecture-model', 'component:model-scoping']);
    expect(getLevel(plan.camera.zoom)).toBe(3);
  });

  it('moves a component child from L2 into its native L3 branch and frame', () => {
    const scene = createGoldenC4Scene();
    const l2 = semanticLevelSession(scene, 'container', ['container:architecture-model']);
    const l2Camera = semanticEntityFrameCamera(scene, 'container:architecture-model', 'container', viewport, safeArea)!;
    const plan = semanticInspectorHierarchyPlan(scene, 'component:model-scoping', viewport, safeArea, l2, l2Camera)!;

    expect(plan.detail).toBe('component');
    expect(semanticLensSessionDetail(plan.session)).toBe('component');
    expect(plan.session.settled.map(entry => entry.targetId))
      .toEqual(['system:okie', 'container:architecture-model']);
    expect(getLevel(plan.camera.zoom)).toBe(2);
  });

  it('keeps code semantic navigation independent from source-tab availability', () => {
    const scene = createGoldenC4Scene();
    const targetId = 'code:model-scoping:select-scoped-view';
    const target = scene.entities.find(entity => entity.id === targetId)!;
    const withoutExcerpt = {
      ...scene,
      entities: scene.entities.map(entity => entity.id === targetId
        ? { ...entity, sourceExcerpts: undefined }
        : entity),
    };
    const withSourcePlan = semanticInspectorHierarchyPlan(scene, targetId, viewport, safeArea)!;
    const withoutSourcePlan = semanticInspectorHierarchyPlan(withoutExcerpt, targetId, viewport, safeArea)!;

    expect(target.sourceExcerpts?.length).toBeGreaterThan(0);
    expect(inspectorTabForEntity(Boolean(target.sourceExcerpts?.length))).toBe('source');
    expect(inspectorTabForEntity(false)).toBe('details');
    expect(semanticLensSessionDetail(withSourcePlan.session)).toBe('code');
    expect(semanticLensSessionDetail(withoutSourcePlan.session)).toBe('code');
    expect(withoutSourcePlan.session.settled).toEqual(withSourcePlan.session.settled);
  });

  it('returns the root entity to context without retaining a deeper lens', () => {
    const scene = createGoldenC4Scene();
    const l4 = semanticLevelSession(scene, 'code', ['code:model-scoping:select-scoped-view']);
    const plan = semanticInspectorHierarchyPlan(
      scene,
      'system:okie',
      viewport,
      safeArea,
      l4,
      { x: 0, y: 0, zoom: 14 },
    )!;

    expect(plan.detail).toBe('context');
    expect(semanticLensSessionDetail(plan.session)).toBe('context');
    expect(plan.session.settled).toEqual([]);
    expect(getLevel(plan.camera.zoom)).toBe(0);
  });

  it('retargets a same-detail sibling with minimal translation while preserving zoom', () => {
    const scene = createGoldenC4Scene();
    const currentSession = semanticLevelSession(scene, 'component', ['component:model-normalized']);
    const currentCamera = semanticEntityFrameCamera(scene, 'component:model-normalized', 'component', viewport, safeArea)!;
    const plan = semanticInspectorHierarchyPlan(
      scene,
      'component:model-scoping',
      viewport,
      safeArea,
      currentSession,
      currentCamera,
    )!;

    expect(plan.detail).toBe('component');
    expect(plan.camera.zoom).toBe(currentCamera.zoom);
    expect(semanticLensSessionDetail(plan.session)).toBe('component');
    expect(plan.camera).toEqual(currentCamera);
  });

  it('uses the authored reveal/reverse morph for adjacent hierarchy flights', () => {
    const scene = createGoldenC4Scene();
    const component = semanticLevelSession(scene, 'component', ['component:model-scoping']);
    const code = semanticLevelSession(scene, 'code', ['code:model-scoping:select-scoped-view']);
    const inward = semanticInspectorFlightSession(component, code, 'code:model-scoping:select-scoped-view', .4);
    const outward = semanticInspectorFlightSession(code, component, 'component:model-scoping', .4);

    expect(semanticInspectorFlightKind(component, code)).toBe('inward');
    expect(inward.active).toMatchObject({ phase: 'revealing', progress: .4, targetId: 'component:model-scoping' });
    expect(outward.active).toMatchObject({ phase: 'reversing', progress: .6, targetId: 'component:model-scoping' });
    expect(semanticInspectorFlightProgress(.08, 'inward')).toBe(0);
    expect(semanticInspectorFlightProgress(.8, 'outward')).toBe(1);
    expect(semanticLensSessionProjectionOverride(scene, inward)?.morph).toBeDefined();
    expect(semanticLensSessionProjectionOverride(scene, outward)?.morph).toBeDefined();
  });

  it('crossfades arbitrary Back branches and settles without retaining old ownership', () => {
    const scene = createGoldenC4Scene();
    const source = semanticLevelSession(scene, 'code', ['code:model-normalized:state']);
    const target = semanticLevelSession(scene, 'code', ['code:model-scoping:select-scoped-view']);
    const transfer = semanticInspectorFlightSession(source, target, 'code:model-scoping:select-scoped-view', .4);
    const settled = semanticInspectorFlightSession(source, target, 'code:model-scoping:select-scoped-view', 1);

    expect(semanticInspectorFlightKind(source, target)).toBe('transfer');
    expect(transfer.focusTransfer?.sourceEntries).toEqual(source.settled);
    expect(transfer.settled).toEqual(target.settled);
    expect(semanticInspectorFlightProgress(.25, 'transfer')).toBe(0);
    expect(semanticInspectorFlightProgress(.75, 'transfer')).toBe(1);
    expect(settled).toEqual(target);
    expect(settled.focusTransfer).toBeUndefined();
    expect(semanticInspectorFlightSession(target, target, target.settled.at(-1)!.targetId, .2)).toBe(target);
  });

  it('compensates owner reflow without lateral drift and keeps exact camera endpoints', () => {
    const sourceBounds = { x: 0, y: 0, width: 100, height: 80 };
    const targetBounds = { x: 200, y: 100, width: 100, height: 80 };
    const sourceCamera = { x: 50, y: 40, zoom: 2 };
    const desiredTarget = { x: 320, y: 180, zoom: 8 };

    for (const kind of ['inward', 'outward'] as const) {
      const rawTarget = semanticInspectorRawCameraTarget(desiredTarget, sourceBounds, targetBounds, kind);
      const start = compensateSemanticInspectorFlightCamera(sourceCamera, sourceBounds, targetBounds, kind, 0);
      const end = compensateSemanticInspectorFlightCamera(rawTarget, sourceBounds, targetBounds, kind, 1);
      const rawMidpoint = {
        x: (sourceCamera.x + rawTarget.x) / 2,
        y: (sourceCamera.y + rawTarget.y) / 2,
        zoom: Math.sqrt(sourceCamera.zoom * rawTarget.zoom),
      };
      const midpoint = compensateSemanticInspectorFlightCamera(rawMidpoint, sourceBounds, targetBounds, kind, .5);

      expect(start).toEqual(sourceCamera);
      expect(end).toEqual(desiredTarget);
      expect(midpoint.x).toBe((sourceCamera.x + desiredTarget.x) / 2);
      expect(midpoint.y).toBe((sourceCamera.y + desiredTarget.y) / 2);
    }
  });
});
