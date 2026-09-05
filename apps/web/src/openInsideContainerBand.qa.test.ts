import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ASPECT_PRESET_TARGET,
  C4_COMPONENT_CARD_FACE,
  C4_CONTAINER_CARD_FACE,
  C4_CONTEXT_CARD_FACE,
  cameraWorldRect,
  sliceArchitectureNeighborhood,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
  type ArchitectureStory,
  type ArchitectureView,
  type EntityKind,
} from '@okie/architecture';
import demoSnapshot from '../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../fixtures/architecture/demo-story.json';
import { explorerEntitiesForView } from './entityExplorer';
import { ATLAS_CAMERA_BOUNDS } from './renderer/cameraBounds';
import { createC4Scene, scanDrillDeeperDetail } from './renderer/goldenC4Scene';
import { compileScanNeighborhoodFixture, SCAN_BAND_DEPTH_MIN_ENTITIES } from './renderer/scanFixture';
import { scanCompileFocusForBand } from './renderer/lazyBandCompile';
import { containSemanticOwnerCamera, semanticLensSessionDetail } from './semantic/semanticLens';
import {
  COMPONENT_TITLE_READABLE_MIN_ZOOM,
  CONTAINER_TITLE_READABLE_MIN_ZOOM,
  CONTEXT_TITLE_READABLE_MIN_ZOOM,
  componentCardFaceBounds,
  componentTitleCssPx,
  containerCardFaceBounds,
  containerTitleCssPx,
  frameComponentPeerArrivalCamera,
  frameContainerPeerArrivalCamera,
  frameContextArrivalCamera,
  frameProjectionScope,
  semanticLevelSession,
} from './semantic/semanticLensEngine';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

function sliceBetween(source: string, startNeedle: string, endNeedle: string, label: string) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end < 0) throw new Error(`Missing ${label}`);
  return source.slice(start, end);
}

const openInsideLoaded = sliceBetween(app, 'function openInsideLoaded(', 'function navigateRoot(', 'openInsideLoaded');
const drillPath = sliceBetween(openInsideLoaded, 'const drillDetail =', 'const plan = lensPlan;', 'scan drill path');

describe('CLA-80: Open inside an L2 container lands on L3', () => {
  it('lands the scan drill on drillDetail instead of cancelling back to context', () => {
    expect(drillPath).toContain('scanCompileFocusForBand(');
    expect(drillPath).toContain('semanticLevelSession(nextScene, deeperDetail, preferredIds)');
    expect(drillPath).toContain('setSemanticLensSession(nextSession)');
    expect(drillPath).toContain('activeLevelRef.current = semanticDetails.indexOf(deeperDetail)');
    expect(drillPath).toContain('frameProjectionScope(nextScene, compileFocus, deeperDetail');
    expect(drillPath).toContain('detail: nextSession.baseDetail');
    expect(drillPath).toContain('lensPath: semanticLensCanonicalPathIds(nextSession)');
    expect(drillPath).toContain('forceContainerBand');
    expect(drillPath).toContain("target.detail === 'context' || target.kind === 'system'");
    expect(drillPath).toContain('scanNextBand(target.detail ?? \'context\')');
    expect(drillPath).toContain('scanEntityHasChildren(activeSnapshot, target.id)');
    expect(drillPath).not.toContain("cancelSemanticLensAt('scan drill recompile'");
    expect(drillPath).not.toContain('detail: baseDetail');
    expect(openInsideLoaded).toContain('const lensPlan = (!drillDetail && !forceContainerBand)');
    expect(openInsideLoaded).toContain('semanticOpenNextLayer(');
    expect(openInsideLoaded).toContain('const plan = lensPlan');
  });

  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
  });

  it('after Open inside a container, L3 detail/band/explorer are that neighborhood', async () => {
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
    const l1Scene = fixture.createScene(fixture.navigation.rootEntityId);
    const container = l1Scene.entities.find(entity => entity.id === 'container:web-app');
    expect(container).toBeDefined();
    expect(scanDrillDeeperDetail(l1Scene, container!, fixture.snapshot)).toBe('component');
    expect((l1Scene.projection?.entityIdsByDetail.component ?? []).length).toBe(0);

    await fixture.ensureNeighborhood('container:web-app');
    const l3Focus = scanCompileFocusForBand(
      fixture.snapshot,
      'container:web-app',
      'component',
      fixture.navigation.rootEntityId,
    );
    expect(l3Focus).toBe('container:web-app');
    const l3 = fixture.createScene(l3Focus);
    const componentIds = l3.projection?.entityIdsByDetail.component ?? [];
    expect(componentIds.length).toBeGreaterThan(0);
    expect(l3.entities.some(entity => entity.detail === 'component' && entity.parentId === 'container:web-app')).toBe(true);

    const selected = l3.entities.find(entity => entity.id === 'container:web-app');
    expect(selected).toBeDefined();
    const session = semanticLevelSession(l3, 'component', ['container:web-app']);
    expect(semanticLensSessionDetail(session)).toBe('component');
    const rows = explorerEntitiesForView(l3, {
      detail: 'component',
      selected: selected!,
      settledTargetIds: session.settled.map(entry => entry.targetId),
      visibleIds: componentIds,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(entity => componentIds.includes(entity.id))).toBe(true);
    expect(rows.some(entity => entity.parentId === 'container:web-app' || entity.detail === 'component')).toBe(true);
  });

  it('keeps Open-inside a system compiling L2 without a scan drill', async () => {
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
    const l1Scene = fixture.createScene(fixture.navigation.rootEntityId);
    const system = l1Scene.entities.find(entity => entity.id === 'system:okie');
    expect(system).toBeDefined();
    expect(scanDrillDeeperDetail(l1Scene, system!, fixture.snapshot)).toBeUndefined();
    expect((l1Scene.projection?.entityIdsByDetail.container ?? []).length).toBeGreaterThan(0);
  });
});

function scanEntity(id: string, kind: EntityKind, parentId?: string, name = id): ArchitectureEntity {
  return {
    id,
    name,
    kind,
    sourceRefs: [{ path: `${id.replaceAll(':', '/')}.ts`, commitSha: 'sha' }],
    ...(parentId ? { parentId } : {}),
  };
}

/** Ten scan containers; `container:apps-server` sorts first, like THISS/okie. */
function scanLikeSnapshot(): ArchitectureSnapshot {
  const containers = [
    'container:apps-server',
    'container:apps-web',
    'container:crates-atlas-engine',
    'container:crates-atlas-gpu',
    'container:crates-atlas-protocol',
    'container:crates-atlas-wasm',
    'container:packages-architecture',
    'container:packages-scan',
    'container:packages-scene-compiler',
    'container:packages-theme',
  ];
  const entities: ArchitectureEntity[] = [
    scanEntity('person:developer', 'person', undefined, 'Developer'),
    scanEntity('system:okie', 'softwareSystem', undefined, 'okie'),
    scanEntity('external:npm', 'externalSystem', undefined, 'npm'),
  ];
  for (const containerId of containers) {
    entities.push(scanEntity(containerId, 'container', 'system:okie', containerId.replace('container:', '@okie/')));
    for (let file = 0; file < 3; file += 1) {
      const componentId = `component:${containerId.slice('container:'.length)}-f${file}`;
      entities.push(scanEntity(componentId, 'component', containerId));
      entities.push(scanEntity(`code:${componentId.slice('component:'.length)}:fn`, 'code', componentId));
    }
  }
  return {
    schemaVersion: 1,
    id: 'snapshot:cla-83',
    repositoryId: 'repo:cla-83',
    commitSha: 'sha',
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities,
    relations: [],
  };
}

function scanLikeView(snapshot: ArchitectureSnapshot): ArchitectureView {
  return {
    schemaVersion: 1,
    id: 'view:cla-83',
    snapshotId: snapshot.id,
    name: 'cla-83',
    rootEntityId: 'system:okie',
    entityIds: snapshot.entities.map(entity => entity.id),
    relationIds: [],
    layout: {
      nodes: Object.fromEntries(snapshot.entities.map(entity => [entity.id, { x: 0, y: 0, width: 1, height: 1 }])),
    },
  };
}

function scanLikeStory(snapshot: ArchitectureSnapshot, view: ArchitectureView): ArchitectureStory {
  return {
    schemaVersion: 1,
    id: 'story:cla-83:overview',
    snapshotId: snapshot.id,
    viewId: view.id,
    title: 'Overview',
    steps: [{
      id: 'step:start',
      title: 'Start with okie',
      focusEntityIds: ['system:okie'],
      reveal: 'context',
      narration: 'The scanned software system.',
    }],
  };
}

describe('CLA-83: Open inside the scan system lands on L2 container peers', () => {
  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
  });

  it('Open inside the system compiles the container band at the system root, not the first package', async () => {
    const snapshot = scanLikeSnapshot();
    const view = scanLikeView(snapshot);
    const story = scanLikeStory(snapshot, view);
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        snapshot,
        view,
        { focusEntityId: focus || 'system:okie' },
      ),
      loadExcerpts: async () => undefined,
      loadStory: async () => story,
    };
    const l1 = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: 'system:okie' });
    expect(l1.snapshot.entities.filter(entity => entity.kind === 'container')).toHaveLength(10);
    expect(l1.unpublishedChildren?.some(child => child.kind === 'component')).toBe(true);

    const fixture = compileScanNeighborhoodFixture(l1, story, host, { targetAspect: ASPECT_PRESET_TARGET.landscape });
    const l1Scene = fixture.createScene(fixture.navigation.rootEntityId);
    const system = l1Scene.entities.find(entity => entity.id === 'system:okie');
    expect(system).toBeDefined();
    expect(system!.detail).toBe('context');

    const residentContainerIds = (l1Scene.projection?.entityIdsByDetail.container ?? [])
      .filter(id => l1Scene.entities.find(entity => entity.id === id)?.detail === 'container');
    expect(residentContainerIds.length).toBeGreaterThanOrEqual(10);
    expect(scanDrillDeeperDetail(l1Scene, system!, fixture.snapshot)).toBeUndefined();

    const culled = {
      ...l1Scene,
      entities: l1Scene.entities.filter(entity => entity.detail !== 'container'),
      projection: {
        ...l1Scene.projection!,
        entityIdsByDetail: {
          ...l1Scene.projection!.entityIdsByDetail,
          container: (l1Scene.projection!.entityIdsByDetail.container ?? []).filter(id => id === 'system:okie'),
        },
      },
    };
    expect(scanDrillDeeperDetail(culled, system!, fixture.snapshot)).toBe('container');

    const l2Focus = scanCompileFocusForBand(
      fixture.snapshot,
      'system:okie',
      'container',
      fixture.navigation.rootEntityId,
    );
    expect(l2Focus).toBe('system:okie');
    expect(l2Focus).not.toBe('container:apps-server');

    const l2 = fixture.createScene(l2Focus);
    const containerIds = (l2.projection?.entityIdsByDetail.container ?? [])
      .filter(id => l2.entities.find(entity => entity.id === id)?.detail === 'container');
    expect(containerIds.length).toBeGreaterThanOrEqual(10);
    expect(containerIds).toEqual(expect.arrayContaining([
      'container:apps-server',
      'container:apps-web',
      'container:packages-architecture',
    ]));
    expect((l2.projection?.entityIdsByDetail.component ?? []).length).toBe(0);

    const session = semanticLevelSession(l2, 'container', ['system:okie']);
    expect(semanticLensSessionDetail(session)).toBe('container');
    const rows = explorerEntitiesForView(l2, {
      detail: 'container',
      selected: system!,
      settledTargetIds: session.settled.map(entry => entry.targetId),
      visibleIds: l2.projection?.entityIdsByDetail.container,
    });
    expect(rows.filter(entity => entity.detail === 'container').length).toBeGreaterThanOrEqual(10);
    expect(rows.every(entity => entity.detail !== 'component')).toBe(true);
  });

  it('second Open inside @okie/web lands on that container’s L3 file-components', async () => {
    const snapshot = scanLikeSnapshot();
    const view = scanLikeView(snapshot);
    const story = scanLikeStory(snapshot, view);
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        snapshot,
        view,
        { focusEntityId: focus || 'system:okie' },
      ),
      loadExcerpts: async () => undefined,
      loadStory: async () => story,
    };
    const l1 = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: 'system:okie' });
    const fixture = compileScanNeighborhoodFixture(l1, story, host, { targetAspect: ASPECT_PRESET_TARGET.landscape });
    await fixture.ensureNeighborhood('container:apps-web');
    const l3Focus = scanCompileFocusForBand(
      fixture.snapshot,
      'container:apps-web',
      'component',
      fixture.navigation.rootEntityId,
    );
    expect(l3Focus).toBe('container:apps-web');
    expect(l3Focus).not.toBe('container:apps-server');
    const l3 = fixture.createScene(l3Focus);
    const componentIds = l3.projection?.entityIdsByDetail.component ?? [];
    expect(componentIds.length).toBeGreaterThan(0);
    expect(l3.entities.some(entity => entity.detail === 'component' && entity.parentId === 'container:apps-web')).toBe(true);
    expect(l3.entities.filter(entity => entity.detail === 'component' && entity.parentId === 'container:apps-server')).toHaveLength(0);

    const selected = l3.entities.find(entity => entity.id === 'container:apps-web');
    expect(selected).toBeDefined();
    const session = semanticLevelSession(l3, 'component', ['container:apps-web']);
    expect(semanticLensSessionDetail(session)).toBe('component');
    const rows = explorerEntitiesForView(l3, {
      detail: 'component',
      selected: selected!,
      settledTargetIds: session.settled.map(entry => entry.targetId),
      visibleIds: componentIds,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(entity => componentIds.includes(entity.id))).toBe(true);
  });
});

const viewport = { width: 1_280, height: 720 };
const chromeSafeArea = { top: 80, right: 300, bottom: 72, left: 64 };

function reservedShellL2Scene() {
  const packageNames = [
    'server', 'web', 'engine', 'gpu', 'protocol', 'wasm',
    'architecture', 'scan', 'compiler', 'theme',
  ];
  const containers = packageNames.map(name => ({
    id: `container:${name}`,
    kind: 'container' as const,
    name: `@okie/${name}`,
    parentId: 'system:okie',
    sourceRefs: [],
  }));
  const unpublished: Array<{ id: string; kind: 'component'; parentId: string }> = [];
  const childCounts: Record<string, number> = { 'system:okie': containers.length };
  for (const container of containers) {
    childCounts[container.id] = 24;
    for (let index = 0; index < 24; index += 1) {
      const componentId = `component:${container.id.slice('container:'.length)}-${String(index).padStart(2, '0')}`;
      unpublished.push({ id: componentId, kind: 'component', parentId: container.id });
      childCounts[componentId] = 12;
    }
  }
  const snapshot: ArchitectureSnapshot = {
    schemaVersion: 1,
    id: 'snapshot:cla-90',
    repositoryId: 'repo:cla-90',
    commitSha: 'sha',
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities: [
      { id: 'person:developer', kind: 'person', name: 'Developer', sourceRefs: [] },
      { id: 'system:okie', kind: 'softwareSystem', name: 'okie', sourceRefs: [] },
      { id: 'external:npm', kind: 'externalSystem', name: 'npm', sourceRefs: [] },
      ...containers,
    ],
    relations: [],
  };
  return createC4Scene({
    baseSnapshot: snapshot,
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
    familyId: 'f',
    sceneId: 'scan:cla-90:c4',
    title: 'okie',
    subtitle: '',
    frozenRevision: 'sha',
    maxBand: 'container',
    targetAspect: ASPECT_PRESET_TARGET.landscape,
    childCounts,
    unpublishedChildren: unpublished,
  });
}

function containerFaceInSafeViewport(
  bounds: { x: number; y: number; width: number; height: number },
  camera: { x: number; y: number; zoom: number },
) {
  const face = containerCardFaceBounds(bounds);
  const padding = 24;
  const left = viewport.width / 2 + (face.x - camera.x) * camera.zoom;
  const top = viewport.height / 2 + (face.y - camera.y) * camera.zoom;
  const right = left + face.width * camera.zoom;
  const bottom = top + face.height * camera.zoom;
  return left >= chromeSafeArea.left + padding
    && right <= viewport.width - chromeSafeArea.right - padding
    && top >= chromeSafeArea.top + padding
    && bottom <= viewport.height - chromeSafeArea.bottom - padding;
}

describe('CLA-90: Open inside scan L2 frames peer cards at readable zoom', () => {
  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
  });

  it('Open inside a reserved system does not contain the owner shell (CLA-90)', () => {
    expect(openInsideLoaded).toContain("deeperDetail === 'container' || deeperDetail === 'component'");
    expect(openInsideLoaded).toContain('frameProjectionScope(nextScene, compileFocus, deeperDetail, viewport, mapSafeArea)');
    expect(openInsideLoaded).toContain('containSemanticOwnerCamera(framedCamera, targetBounds, viewport, mapSafeArea)');
  });

  it('frames L2 container peer cards above minZoom, not z=0.32 over a hollow shell', () => {
    const scene = reservedShellL2Scene();
    const system = scene.projection!.boundsByEntityIdAndDetail['system:okie']!.container!;
    expect(system.height).toBeGreaterThan(C4_CONTAINER_CARD_FACE.height * 4);
    expect(system.width).toBeGreaterThan(C4_CONTAINER_CARD_FACE.width * 1.5);

    const camera = frameProjectionScope(scene, 'system:okie', 'container', viewport, chromeSafeArea);
    expect(camera).toBeDefined();
    expect(camera).toEqual(frameContainerPeerArrivalCamera(scene, 'system:okie', viewport, chromeSafeArea));
    expect(camera!.zoom).toBeGreaterThan(ATLAS_CAMERA_BOUNDS.minZoom);
    expect(camera!.zoom).toBeGreaterThanOrEqual(CONTAINER_TITLE_READABLE_MIN_ZOOM - 1e-9);
    expect(camera!.zoom).toBeCloseTo(1.99, 5);
    expect(containerTitleCssPx(camera!.zoom)).toBeGreaterThanOrEqual(12);

    const peers = scene.entities.filter(entity => entity.detail === 'container');
    expect(peers.length).toBeGreaterThanOrEqual(10);
    expect(peers.some(entity => containerFaceInSafeViewport(
      scene.projection!.boundsByEntityIdAndDetail[entity.id]!.container!,
      camera!,
    ))).toBe(true);

    const world = cameraWorldRect(camera!, viewport);
    const hollow = { x: system.x, y: system.y, width: system.width, height: system.height };
    expect(world.width * world.height).toBeLessThan(hollow.width * hollow.height * 0.5);

    const contained = containSemanticOwnerCamera(camera!, system, viewport, chromeSafeArea);
    expect(contained.zoom).toBe(camera!.zoom);
    expect(contained.zoom).not.toBe(ATLAS_CAMERA_BOUNDS.minZoom);
  });

  it('CLA-83: Open inside the system keeps root=system and L2 peers visible', async () => {
    const snapshot = scanLikeSnapshot();
    const view = scanLikeView(snapshot);
    const story = scanLikeStory(snapshot, view);
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        snapshot,
        view,
        { focusEntityId: focus || 'system:okie' },
      ),
      loadExcerpts: async () => undefined,
      loadStory: async () => story,
    };
    const l1 = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: 'system:okie' });
    const fixture = compileScanNeighborhoodFixture(l1, story, host, { targetAspect: ASPECT_PRESET_TARGET.landscape });
    const l2Focus = scanCompileFocusForBand(
      fixture.snapshot,
      'system:okie',
      'container',
      fixture.navigation.rootEntityId,
    );
    expect(l2Focus).toBe('system:okie');
    const l2 = fixture.createScene(l2Focus);
    const containerIds = (l2.projection?.entityIdsByDetail.container ?? [])
      .filter(id => l2.entities.find(entity => entity.id === id)?.detail === 'container');
    expect(containerIds.length).toBeGreaterThanOrEqual(10);

    const camera = frameProjectionScope(l2, l2Focus, 'container', viewport, chromeSafeArea);
    expect(camera).toBeDefined();
    expect(camera!.zoom).toBeGreaterThan(ATLAS_CAMERA_BOUNDS.minZoom);
    expect(camera!.zoom).toBeGreaterThanOrEqual(CONTAINER_TITLE_READABLE_MIN_ZOOM - 1e-9);

    const session = semanticLevelSession(l2, 'container', ['system:okie']);
    const rows = explorerEntitiesForView(l2, {
      detail: 'container',
      selected: l2.entities.find(entity => entity.id === 'system:okie')!,
      settledTargetIds: session.settled.map(entry => entry.targetId),
      visibleIds: l2.projection?.entityIdsByDetail.container,
    });
    expect(rows.filter(entity => entity.detail === 'container').length).toBeGreaterThanOrEqual(10);
  });

  it('CLA-82 L1 first paint still frames readable card faces', () => {
    const scene = reservedShellL2Scene();
    const camera = frameContextArrivalCamera(scene, viewport, chromeSafeArea);
    expect(camera).toBeDefined();
    expect(camera!.zoom).toBeGreaterThan(CONTEXT_TITLE_READABLE_MIN_ZOOM - 1e-9);
    const system = scene.projection!.boundsByEntityIdAndDetail['system:okie']!.context!;
    expect(system.height).toBeGreaterThan(C4_CONTEXT_CARD_FACE.height * 2);
    expect(cameraWorldRect(camera!, viewport).height).toBeLessThan(system.height);
  });
});

/** 41 scan file-components under `@okie/web`, matching the CLA-92 repro. */
function reservedShellL3Scene() {
  const files = Array.from({ length: 41 }, (_, index) => ({
    id: `component:web-${String(index).padStart(2, '0')}`,
    kind: 'component' as const,
    name: index === 0 ? 'App.tsx' : `file-${index}.ts`,
    parentId: 'container:web',
    sourceRefs: [],
  }));
  const unpublished: Array<{ id: string; kind: 'code'; parentId: string }> = [];
  const childCounts: Record<string, number> = {
    'system:okie': 1,
    'container:web': files.length,
  };
  for (const file of files) {
    childCounts[file.id] = 12;
    for (let index = 0; index < 12; index += 1) {
      unpublished.push({
        id: `code:${file.id.slice('component:'.length)}-${String(index).padStart(2, '0')}`,
        kind: 'code',
        parentId: file.id,
      });
    }
  }
  const snapshot: ArchitectureSnapshot = {
    schemaVersion: 1,
    id: 'snapshot:cla-92',
    repositoryId: 'repo:cla-92',
    commitSha: 'sha',
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities: [
      { id: 'person:developer', kind: 'person', name: 'Developer', sourceRefs: [] },
      { id: 'system:okie', kind: 'softwareSystem', name: 'okie', sourceRefs: [] },
      { id: 'external:npm', kind: 'externalSystem', name: 'npm', sourceRefs: [] },
      {
        id: 'container:web',
        kind: 'container',
        name: '@okie/web',
        parentId: 'system:okie',
        sourceRefs: [],
      },
      ...files,
    ],
    relations: [],
  };
  return createC4Scene({
    baseSnapshot: snapshot,
    rootEntityId: 'system:okie',
    focusEntityId: 'container:web',
    familyId: 'f',
    sceneId: 'scan:cla-92:c4',
    title: '@okie/web',
    subtitle: '',
    frozenRevision: 'sha',
    targetAspect: ASPECT_PRESET_TARGET.landscape,
    childCounts,
    unpublishedChildren: unpublished,
  });
}

function componentFaceInSafeViewport(
  bounds: { x: number; y: number; width: number; height: number },
  camera: { x: number; y: number; zoom: number },
) {
  const face = componentCardFaceBounds(bounds);
  const padding = 24;
  const left = viewport.width / 2 + (face.x - camera.x) * camera.zoom;
  const top = viewport.height / 2 + (face.y - camera.y) * camera.zoom;
  const right = left + face.width * camera.zoom;
  const bottom = top + face.height * camera.zoom;
  return left >= chromeSafeArea.left + padding
    && right <= viewport.width - chromeSafeArea.right - padding
    && top >= chromeSafeArea.top + padding
    && bottom <= viewport.height - chromeSafeArea.bottom - padding;
}

describe('CLA-92: Open inside scan L3 frames file-component peer cards at readable zoom', () => {
  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
  });

  it('Open inside a reserved container does not contain the owner shell (CLA-92)', () => {
    expect(openInsideLoaded).toContain("deeperDetail === 'container' || deeperDetail === 'component'");
    expect(openInsideLoaded).toContain('frameProjectionScope(nextScene, compileFocus, deeperDetail, viewport, mapSafeArea)');
    expect(openInsideLoaded).not.toContain(
      "const nextCamera = deeperDetail === 'container' ? framedCamera : containSemanticOwnerCamera(framedCamera, targetBounds, viewport, mapSafeArea);",
    );
  });

  it('frames L3 file-component peer cards above minZoom, not z=0.32 over a hollow shell', () => {
    const scene = reservedShellL3Scene();
    const owner = scene.projection!.boundsByEntityIdAndDetail['container:web']!.component!;
    expect(owner.height).toBeGreaterThan(C4_COMPONENT_CARD_FACE.height * 1.25);
    expect(owner.width).toBeGreaterThan(C4_COMPONENT_CARD_FACE.width * 1.25);

    const camera = frameProjectionScope(scene, 'container:web', 'component', viewport, chromeSafeArea);
    expect(camera).toBeDefined();
    expect(camera).toEqual(frameComponentPeerArrivalCamera(scene, 'container:web', viewport, chromeSafeArea));
    expect(camera!.zoom).toBeGreaterThan(ATLAS_CAMERA_BOUNDS.minZoom);
    expect(camera!.zoom).toBeGreaterThanOrEqual(COMPONENT_TITLE_READABLE_MIN_ZOOM - 1e-9);
    expect(componentTitleCssPx(camera!.zoom)).toBeGreaterThanOrEqual(12);

    const peers = scene.entities.filter(entity => entity.detail === 'component');
    expect(peers.length).toBe(41);
    expect(peers.some(entity => componentFaceInSafeViewport(
      scene.projection!.boundsByEntityIdAndDetail[entity.id]!.component!,
      camera!,
    ))).toBe(true);

    const world = cameraWorldRect(camera!, viewport);
    const hollow = { x: owner.x, y: owner.y, width: owner.width, height: owner.height };
    expect(world.width * world.height).toBeLessThan(hollow.width * hollow.height * 0.5);

    const contained = containSemanticOwnerCamera(camera!, owner, viewport, chromeSafeArea);
    expect(contained.zoom).toBe(camera!.zoom);
    expect(contained.zoom).not.toBe(ATLAS_CAMERA_BOUNDS.minZoom);
  });

  it('CLA-80: Open inside the container keeps root=container and L3 peers visible', async () => {
    const snapshot = scanLikeSnapshot();
    const view = scanLikeView(snapshot);
    const story = scanLikeStory(snapshot, view);
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        snapshot,
        view,
        { focusEntityId: focus || 'system:okie' },
      ),
      loadExcerpts: async () => undefined,
      loadStory: async () => story,
    };
    const l1 = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: 'system:okie' });
    const fixture = compileScanNeighborhoodFixture(l1, story, host, { targetAspect: ASPECT_PRESET_TARGET.landscape });
    await fixture.ensureNeighborhood('container:apps-web');
    const l3Focus = scanCompileFocusForBand(
      fixture.snapshot,
      'container:apps-web',
      'component',
      fixture.navigation.rootEntityId,
    );
    expect(l3Focus).toBe('container:apps-web');
    const l3 = fixture.createScene(l3Focus);
    const componentIds = (l3.projection?.entityIdsByDetail.component ?? [])
      .filter(id => l3.entities.find(entity => entity.id === id)?.detail === 'component');
    expect(componentIds.length).toBeGreaterThan(0);
    expect(l3.entities.some(entity => entity.detail === 'component' && entity.parentId === 'container:apps-web')).toBe(true);

    const camera = frameProjectionScope(l3, l3Focus, 'component', viewport, chromeSafeArea);
    expect(camera).toBeDefined();
    expect(camera!.zoom).toBeGreaterThan(ATLAS_CAMERA_BOUNDS.minZoom);
    expect(camera!.zoom).toBeGreaterThanOrEqual(COMPONENT_TITLE_READABLE_MIN_ZOOM - 1e-9);

    const session = semanticLevelSession(l3, 'component', ['container:apps-web']);
    expect(semanticLensSessionDetail(session)).toBe('component');
    const rows = explorerEntitiesForView(l3, {
      detail: 'component',
      selected: l3.entities.find(entity => entity.id === 'container:apps-web')!,
      settledTargetIds: session.settled.map(entry => entry.targetId),
      visibleIds: componentIds,
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(entity => componentIds.includes(entity.id))).toBe(true);
  });

  it('CLA-90 L2 Open inside still frames readable container peer cards', () => {
    const scene = reservedShellL2Scene();
    const camera = frameProjectionScope(scene, 'system:okie', 'container', viewport, chromeSafeArea);
    expect(camera).toBeDefined();
    expect(camera!.zoom).toBeGreaterThan(ATLAS_CAMERA_BOUNDS.minZoom);
    expect(camera!.zoom).toBeGreaterThanOrEqual(CONTAINER_TITLE_READABLE_MIN_ZOOM - 1e-9);
    expect(containerTitleCssPx(camera!.zoom)).toBeGreaterThanOrEqual(12);
  });
});
