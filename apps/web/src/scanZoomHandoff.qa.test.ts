import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  sliceArchitectureNeighborhood,
  type ArchitectureSnapshot,
  type ArchitectureView,
} from '@okie/architecture';
import demoSnapshot from '../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../fixtures/architecture/demo-story.json';
import { explorerEntitiesForView } from './entityExplorer';
import { scanDrillDeeperDetail, scanZoomCompileHandoff } from './renderer/goldenC4Scene';
import { scanCompileFocusForBand } from './renderer/lazyBandCompile';
import { compileScanNeighborhoodFixture, SCAN_BAND_DEPTH_MIN_ENTITIES } from './renderer/scanFixture';
import { semanticLensSessionDetail } from './semantic/semanticLens';
import {
  frameVisibleProjection,
  semanticLevelSession,
} from './semantic/semanticLensEngine';
import { getLevel } from './App';

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
const refreshViewportNeighborhood = sliceBetween(app, 'function refreshViewportNeighborhood(', 'function applyScanZoomHandoff(', 'refreshViewportNeighborhood');

const viewport = { width: 1_280, height: 720 };
const chromeSafeArea = { top: 80, right: 300, bottom: 72, left: 64 };

describe('CLA-104: continuous zoom L2→L3 hands off the focused container graph', () => {
  it('drives wheel/pinch through the Open-inside compile-focus seam, not a hang-guard raise', () => {
    expect(handleSemanticZoom).toContain('maybeScanZoomHandoff(');
    expect(app).toContain('function maybeScanZoomHandoff(');
    expect(app).toContain('const liveCamera = renderedCameraRef.current');
    expect(app).toContain('applyScanZoomHandoff(still, liveCamera, preferredId)');
    expect(settleCamera).toContain('maybeScanZoomHandoff(');
    expect(app).toContain('function applyScanZoomHandoff(');
    expect(app).toContain('scanZoomCompileHandoff(');
    expect(app).toContain('scanCompileFocusForBand(');
    expect(applyScanZoomHandoff).toContain('semanticLevelSession(nextScene, handoff.detail, preferredIds)');
    expect(applyScanZoomHandoff).toContain('retargetCameraForSemanticBand(');
    expect(applyScanZoomHandoff).toContain('liveCamera.zoom');
    expect(applyScanZoomHandoff).not.toContain('frameProjectionScope(');
    expect(applyScanZoomHandoff).toContain("historyControllerRef.current?.replace(navigation)");
    expect(refreshViewportNeighborhood).toContain('semanticLensSessionDetail(semanticLensSessionRef.current)');
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
});
