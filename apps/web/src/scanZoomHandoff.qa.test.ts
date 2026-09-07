import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  cameraWorldRect,
  expandRectByTileRing,
  sliceArchitectureNeighborhood,
  type ArchitectureSnapshot,
  type ArchitectureView,
} from '@okie/architecture';
import demoSnapshot from '../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../fixtures/architecture/demo-story.json';
import { explorerEntitiesForView } from './entityExplorer';
import {
  scanDeeperBandHasPeerCards,
  scanDrillDeeperDetail,
  scanPeerContainerIds,
  scanWindowedCompileDropsPeerGraph,
  scanZoomCompileHandoff,
  scanZoomEntityUnderPointer,
  scanZoomHandoffPreferredId,
  semanticBounds,
} from './renderer/goldenC4Scene';
import { scanCompileFocusForBand } from './renderer/lazyBandCompile';
import { compileScanNeighborhoodFixture, SCAN_BAND_DEPTH_MIN_ENTITIES } from './renderer/scanFixture';
import { semanticLensSessionDetail } from './semantic/semanticLens';
import {
  frameVisibleProjection,
  scanZoomHandoffCamera,
  semanticLevelSession,
} from './semantic/semanticLensEngine';
import { getLevel } from './App';
import type { AtlasScene, SceneEntity } from './renderer/types';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

function sliceBetween(source: string, startNeedle: string, endNeedle: string, label: string) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end < 0) throw new Error(`Missing ${label}`);
  return source.slice(start, end);
}

const handleSemanticZoom = sliceBetween(app, 'function handleSemanticZoom(', 'function semanticZoomControl(', 'handleSemanticZoom');
const settleCamera = sliceBetween(app, 'function settleCamera(', 'function flushNavigation(', 'settleCamera');
const applyScanZoomHandoff = sliceBetween(app, 'function applyScanZoomHandoff(', 'function maybeScanZoomHandoff(', 'applyScanZoomHandoff');
const maybeScanZoomHandoff = sliceBetween(app, 'function maybeScanZoomHandoff(', 'function prefetchCommittedBox(', 'maybeScanZoomHandoff');
const refreshViewportNeighborhood = sliceBetween(app, 'function refreshViewportNeighborhood(', 'function applyScanZoomHandoff(', 'refreshViewportNeighborhood');

const viewport = { width: 1_280, height: 720 };
const chromeSafeArea = { top: 80, right: 300, bottom: 72, left: 64 };

describe('CLA-104: continuous zoom L2→L3 hands off the focused container graph', () => {
  it('drives wheel/pinch through the Open-inside compile-focus seam, not a hang-guard raise', () => {
    expect(handleSemanticZoom).toContain('maybeScanZoomHandoff(');
    expect(handleSemanticZoom).toContain('sample.pointer');
    expect(app).toContain('function maybeScanZoomHandoff(');
    expect(maybeScanZoomHandoff).toContain('scanZoomHandoffPreferredId(');
    expect(maybeScanZoomHandoff).toContain('inspectorSelectionRef.current ?? selected.id');
    expect(app).toContain('const liveCamera = renderedCameraRef.current');
    expect(app).toContain('applyScanZoomHandoff(still, liveCamera, preferredId)');
    expect(settleCamera).toContain('maybeScanZoomHandoff(');
    expect(settleCamera).toContain('scanZoomPointerRef.current');
    expect(app).toContain('function applyScanZoomHandoff(');
    expect(app).toContain('scanZoomCompileHandoff(');
    expect(app).toContain('scanCompileFocusForBand(');
    expect(applyScanZoomHandoff).toContain('semanticLevelSession(nextScene, handoff.detail, preferredIds)');
    expect(applyScanZoomHandoff).toContain('scanZoomHandoffCamera(');
    expect(applyScanZoomHandoff).toContain('scanDeeperBandHasPeerCards(');
    expect(applyScanZoomHandoff).toContain('scanZoomAdoptRawRef.current = nextCamera');
    expect(applyScanZoomHandoff).not.toContain('frameProjectionScope(');
    expect(app).toContain('consumeScanZoomAdoptRaw');
    expect(app).toContain('scanZoomAdoptRawRef={scanZoomAdoptRawRef}');
    expect(applyScanZoomHandoff).toContain("historyControllerRef.current?.replace(navigation)");
    expect(refreshViewportNeighborhood).toContain('semanticLensSessionDetail(semanticLensSessionRef.current)');
    expect(refreshViewportNeighborhood).toContain('scanWindowedCompileDropsPeerGraph(');
    expect(refreshViewportNeighborhood).not.toContain('semanticLensSessionRef.current.baseDetail');
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(app).not.toMatch(/SCAN_BAND_DEPTH_MIN_ENTITIES\s*=\s*[3-9]\d{3}/u);
    expect(app).not.toContain('SCAN_BAND_DEPTH_MIN_ENTITIES = 4000');
  });

  it('L1→L2 zoom stays on the system compile; L2→L3 into web-app compiles that file graph', async () => {
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
    const l2Scene = fixture.createScene(fixture.navigation.rootEntityId);
    expect(l2Scene.rootEntityId).toBe('system:okie');
    expect((l2Scene.projection?.entityIdsByDetail.container ?? []).length).toBeGreaterThan(1);
    expect((l2Scene.projection?.entityIdsByDetail.component ?? []).length).toBe(0);

    expect(getLevel(2.10)).toBe(1);
    expect(scanZoomCompileHandoff(
      l2Scene,
      fixture.snapshot,
      'container:web-app',
      fixture.navigation.rootEntityId,
      'container',
    )).toBeUndefined();

    expect(getLevel(4)).toBe(2);
    const container = l2Scene.entities.find(entity => entity.id === 'container:web-app');
    expect(container).toBeDefined();
    expect(scanDrillDeeperDetail(l2Scene, container!, fixture.snapshot)).toBe('component');
    expect(scanZoomCompileHandoff(
      l2Scene,
      fixture.snapshot,
      'container:web-app',
      fixture.navigation.rootEntityId,
      'component',
    )).toEqual({
      detail: 'component',
      compileFocus: 'container:web-app',
    });

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
    expect(componentIds).not.toEqual(l2Scene.projection?.entityIdsByDetail.container);

    const session = semanticLevelSession(l3, 'component', ['container:web-app']);
    expect(semanticLensSessionDetail(session)).toBe('component');
    const selected = l3.entities.find(entity => entity.id === 'container:web-app');
    expect(selected).toBeDefined();
    const rows = explorerEntitiesForView(l3, {
      detail: 'component',
      selected: selected!,
      settledTargetIds: session.settled.map(entry => entry.targetId),
    });
    expect(rows.some(row => row.detail === 'component')).toBe(true);

    const fit = frameVisibleProjection(l3, componentIds, 'component', viewport, chromeSafeArea);
    expect(fit).toBeDefined();
    expect(fit!.zoom).toBeGreaterThan(3);
    expect(scanZoomCompileHandoff(
      l3,
      fixture.snapshot,
      'container:web-app',
      fixture.navigation.rootEntityId,
      'component',
    )).toBeUndefined();
  });

  it('keeps the L3 file graph when the camera is still on the reserved shell interior', async () => {
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
    const l3 = fixture.createScene('container:web-app');
    expect(scanDeeperBandHasPeerCards(l3, 'container:web-app', 'component')).toBe(true);

    const shell = semanticBounds(l3, 'container:web-app', 'component');
    expect(shell).toBeDefined();
    const hollowCamera = { x: 1_000_000, y: 1_000_000, zoom: 4.96 };
    const windowedHollow = fixture.createScene('container:web-app', l3, {
      worldBounds: expandRectByTileRing(cameraWorldRect(hollowCamera, viewport)),
      keepEntityIds: ['container:web-app'],
    });
    expect(scanWindowedCompileDropsPeerGraph(l3, windowedHollow, 'container:web-app', 'component')).toBe(true);
    expect(scanDeeperBandHasPeerCards(windowedHollow, 'container:web-app', 'component')).toBe(false);

    const handoffCamera = scanZoomHandoffCamera(
      hollowCamera,
      l3,
      'container:web-app',
      'component',
      viewport,
      chromeSafeArea,
      undefined,
      shell,
    );
    expect(handoffCamera.zoom).toBe(hollowCamera.zoom);
    expect(Math.hypot(handoffCamera.x - hollowCamera.x, handoffCamera.y - hollowCamera.y)).toBeGreaterThan(100);
    const windowedPeers = fixture.createScene('container:web-app', l3, {
      worldBounds: expandRectByTileRing(cameraWorldRect(handoffCamera, viewport)),
      keepEntityIds: ['container:web-app'],
    });
    expect(scanDeeperBandHasPeerCards(windowedPeers, 'container:web-app', 'component')).toBe(true);
    expect(scanWindowedCompileDropsPeerGraph(l3, windowedPeers, 'container:web-app', 'component')).toBe(false);

    const session = semanticLevelSession(windowedPeers, 'component', ['container:web-app']);
    const selected = windowedPeers.entities.find(entity => entity.id === 'container:web-app')!;
    const rows = explorerEntitiesForView(windowedPeers, {
      detail: 'component',
      selected,
      settledTargetIds: session.settled.map(entry => entry.targetId),
    });
    expect(rows.some(row => row.detail === 'component')).toBe(true);
    const fit = frameVisibleProjection(
      windowedPeers,
      windowedPeers.projection?.entityIdsByDetail.component ?? [],
      'component',
      viewport,
      chromeSafeArea,
    );
    expect(fit).toBeDefined();
    expect(fit!.zoom).toBeGreaterThan(3);
  });

  it('scanWindowedCompileDropsPeerGraph is true only when a windowed compile removes L3/L4 peers', () => {
    const bounds = { x: 0, y: 0, width: 1, height: 1 };
    const withPeers = {
      id: 's',
      title: '',
      subtitle: '',
      rootEntityId: 'container:c',
      entities: [
        { id: 'container:c', name: 'c', kind: 'container', detail: 'container', responsibility: '', x: 0, y: 0, width: 1, height: 1 },
        { id: 'component:x', parentId: 'container:c', name: 'x', kind: 'component', detail: 'component', responsibility: '', x: 0, y: 0, width: 1, height: 1 },
      ],
      relations: [],
      regions: [],
      projection: {
        boundsByEntityIdAndDetail: {
          'container:c': { container: bounds, component: bounds },
          'component:x': { component: bounds },
        },
        entityIdsByDetail: {
          context: [],
          container: ['container:c'],
          component: ['component:x'],
          code: [],
        },
      },
    } as unknown as AtlasScene;
    const hollow = {
      ...withPeers,
      entities: withPeers.entities.slice(0, 1) as SceneEntity[],
      projection: {
        ...withPeers.projection,
        entityIdsByDetail: {
          context: [],
          container: ['container:c'],
          component: ['container:c'],
          code: [],
        },
      },
    } as unknown as AtlasScene;
    expect(scanWindowedCompileDropsPeerGraph(withPeers, hollow, 'container:c', 'component')).toBe(true);
    expect(scanWindowedCompileDropsPeerGraph(withPeers, withPeers, 'container:c', 'component')).toBe(false);
    expect(scanWindowedCompileDropsPeerGraph(withPeers, hollow, 'container:c', 'container')).toBe(false);
  });
});

describe('CLA-105: pointer-centric L2→L3 handoff (no black void)', () => {
  it('wheels into the container under the pointer when inspector selection is the system root', async () => {
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
    const l2Scene = fixture.createScene(fixture.navigation.rootEntityId);
    const webApp = semanticBounds(l2Scene, 'container:web-app', 'container');
    expect(webApp).toBeDefined();
    const camera = {
      x: webApp!.x + webApp!.width / 2,
      y: webApp!.y + webApp!.height / 2,
      zoom: 4,
    };
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };

    expect(scanZoomCompileHandoff(
      l2Scene,
      fixture.snapshot,
      'system:okie',
      fixture.navigation.rootEntityId,
      'component',
    )).toBeUndefined();
    expect(scanZoomEntityUnderPointer(l2Scene, camera, viewport, pointer, 'container'))
      .toBe('container:web-app');

    const preferred = scanZoomHandoffPreferredId(
      l2Scene,
      fixture.snapshot,
      fixture.navigation.rootEntityId,
      'component',
      l2Scene.rootEntityId ?? fixture.navigation.rootEntityId,
      camera,
      viewport,
      pointer,
      'container',
      'system:okie',
    );
    expect(preferred).toBe('container:web-app');
    expect(scanZoomCompileHandoff(
      l2Scene,
      fixture.snapshot,
      preferred,
      fixture.navigation.rootEntityId,
      'component',
    )).toEqual({
      detail: 'component',
      compileFocus: 'container:web-app',
    });

    await fixture.ensureNeighborhood('container:web-app');
    const l3 = fixture.createScene('container:web-app');
    expect(scanDeeperBandHasPeerCards(l3, 'container:web-app', 'component')).toBe(true);
    expect((l3.projection?.entityIdsByDetail.component ?? []).length).toBeGreaterThan(0);
  });

  it('keeps the selected-container CLA-104 path when the pointer misses every card', async () => {
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
    const l2Scene = fixture.createScene(fixture.navigation.rootEntityId);
    const miss = { x: 1_000_000, y: 1_000_000, zoom: 4 };
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };
    expect(scanZoomEntityUnderPointer(l2Scene, miss, viewport, pointer, 'container')).toBeUndefined();
    const preferred = scanZoomHandoffPreferredId(
      l2Scene,
      fixture.snapshot,
      fixture.navigation.rootEntityId,
      'component',
      l2Scene.rootEntityId ?? fixture.navigation.rootEntityId,
      miss,
      viewport,
      pointer,
      'container',
      'container:web-app',
    );
    expect(preferred).toBe('container:web-app');
    expect(scanZoomCompileHandoff(
      l2Scene,
      fixture.snapshot,
      preferred,
      fixture.navigation.rootEntityId,
      'component',
    )).toEqual({
      detail: 'component',
      compileFocus: 'container:web-app',
    });
  });
});

describe('CLA-106: L2→L3 handoff keeps peer containers (no pan into void)', () => {
  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(app).not.toMatch(/SCAN_BAND_DEPTH_MIN_ENTITIES\s*=\s*[3-9]\d{3}/u);
  });

  it('Open inside / wheel L3 compile keeps sibling containers in distinct world space', async () => {
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
    const l2Scene = fixture.createScene(fixture.navigation.rootEntityId);
    const l2Peers = (l2Scene.projection?.entityIdsByDetail.container ?? [])
      .filter(id => id !== 'system:okie' && id !== 'container:web-app');
    expect(l2Peers.length).toBeGreaterThan(1);

    await fixture.ensureNeighborhood('container:web-app');
    const l3Focus = scanCompileFocusForBand(
      fixture.snapshot,
      'container:web-app',
      'component',
      fixture.navigation.rootEntityId,
    );
    expect(l3Focus).toBe('container:web-app');
    const l3 = fixture.createScene(l3Focus);
    expect(scanDeeperBandHasPeerCards(l3, 'container:web-app', 'component')).toBe(true);

    const peers = scanPeerContainerIds(l3, 'container:web-app');
    expect(peers).toEqual(expect.arrayContaining(['container:architecture-model', 'container:scene-compiler']));
    expect(peers.some(id => l2Peers.includes(id))).toBe(true);

    const focusBounds = semanticBounds(l3, 'container:web-app', 'component')
      ?? semanticBounds(l3, 'container:web-app', 'container');
    expect(focusBounds).toBeDefined();
    const peerBounds = peers.map(id => ({
      id,
      bounds: semanticBounds(l3, id, 'component') ?? semanticBounds(l3, id, 'container'),
    }));
    expect(peerBounds.every(entry => entry.bounds)).toBe(true);
    expect(peerBounds.some(entry => (
      entry.bounds!.x !== focusBounds!.x
      || entry.bounds!.y !== focusBounds!.y
      || entry.bounds!.width !== focusBounds!.width
      || entry.bounds!.height !== focusBounds!.height
    ))).toBe(true);

    const union = peerBounds.reduce((acc, entry) => {
      const box = entry.bounds!;
      const x = Math.min(acc.x, box.x);
      const y = Math.min(acc.y, box.y);
      const right = Math.max(acc.x + acc.width, box.x + box.width);
      const bottom = Math.max(acc.y + acc.height, box.y + box.height);
      return { x, y, width: right - x, height: bottom - y };
    }, { ...focusBounds! });
    expect(union.width * union.height).toBeGreaterThan(focusBounds!.width * focusBounds!.height);

    expect(l3.entities.some(entity =>
      entity.parentId === 'container:architecture-model' && entity.detail === 'component',
    )).toBe(false);

    expect(scanZoomCompileHandoff(
      l2Scene,
      fixture.snapshot,
      'container:web-app',
      fixture.navigation.rootEntityId,
      'component',
    )).toEqual({ detail: 'component', compileFocus: 'container:web-app' });
  });

  it('windowed L3 compile still keeps a peer container outside the focused interior', async () => {
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
    const l3 = fixture.createScene('container:web-app');
    const focusBounds = semanticBounds(l3, 'container:web-app', 'component')!;
    const interiorCamera = {
      x: focusBounds.x + focusBounds.width / 2,
      y: focusBounds.y + focusBounds.height / 2,
      zoom: 4,
    };
    const windowed = fixture.createScene('container:web-app', l3, {
      worldBounds: expandRectByTileRing(cameraWorldRect(interiorCamera, viewport)),
      keepEntityIds: ['container:web-app'],
    });
    expect(scanDeeperBandHasPeerCards(windowed, 'container:web-app', 'component')).toBe(true);
    expect(scanPeerContainerIds(windowed, 'container:web-app').length).toBeGreaterThan(0);
    expect(scanWindowedCompileDropsPeerGraph(l3, windowed, 'container:web-app', 'component')).toBe(false);
  });
});
