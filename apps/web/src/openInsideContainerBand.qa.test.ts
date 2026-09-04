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
import { scanDrillDeeperDetail } from './renderer/goldenC4Scene';
import { compileScanNeighborhoodFixture, SCAN_BAND_DEPTH_MIN_ENTITIES } from './renderer/scanFixture';
import { scanCompileFocusForBand } from './renderer/lazyBandCompile';
import { semanticLensSessionDetail } from './semantic/semanticLens';
import { semanticLevelSession } from './semantic/semanticLensEngine';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

function sliceBetween(source: string, startNeedle: string, endNeedle: string, label: string) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  if (start < 0 || end < 0) throw new Error(`Missing ${label}`);
  return source.slice(start, end);
}

const openInsideLoaded = sliceBetween(app, 'function openInsideLoaded(', 'function navigateRoot(', 'openInsideLoaded');
const drillPath = sliceBetween(openInsideLoaded, 'const drillDetail =', 'const plan = semanticOpenNextLayer(', 'scan drill path');

describe('CLA-80: Open inside an L2 container lands on L3', () => {
  it('lands the scan drill on drillDetail instead of cancelling back to context', () => {
    expect(drillPath).toContain('scanCompileFocusForBand(');
    expect(drillPath).toContain('semanticLevelSession(nextScene, drillDetail, preferredIds)');
    expect(drillPath).toContain('setSemanticLensSession(nextSession)');
    expect(drillPath).toContain('activeLevelRef.current = semanticDetails.indexOf(drillDetail)');
    expect(drillPath).toContain('frameProjectionScope(nextScene, compileFocus, drillDetail');
    expect(drillPath).toContain('detail: nextSession.baseDetail');
    expect(drillPath).toContain('lensPath: semanticLensCanonicalPathIds(nextSession)');
    expect(drillPath).not.toContain("cancelSemanticLensAt('scan drill recompile'");
    expect(drillPath).not.toContain('detail: baseDetail');
    expect(openInsideLoaded).toContain('const plan = semanticOpenNextLayer(');
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
