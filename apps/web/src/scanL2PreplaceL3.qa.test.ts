import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  neighborhoodSliceOptionsForFocus,
  sliceArchitectureNeighborhood,
  SMALL_REPO_L3_PREPLACE_CONTAINERS,
  SMALL_REPO_L3_PREPLACE_MAX_ENTITIES,
  snapshotPreplacesL3InL2,
  type ArchitectureSnapshot,
  type ArchitectureView,
} from '@okie/architecture';
import demoSnapshot from '../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../fixtures/architecture/demo-story.json';
import {
  scanDeeperBandHasPeerCards,
  scanDrillDeeperDetail,
  scanZoomCompileHandoff,
} from './renderer/goldenC4Scene';
import { scanCompileFocusForBand } from './renderer/lazyBandCompile';
import {
  compileScanFixture,
  compileScanNeighborhoodFixture,
  SCAN_BAND_DEPTH_MIN_ENTITIES,
  SCAN_CONTAINER_GRID_NODES,
  SCAN_RELATION_EDGE_BUDGET,
  SCAN_RESIDENT_NODES_PER_BAND,
} from './renderer/scanFixture';

const fixture = readFileSync(new URL('./renderer/scanFixture.ts', import.meta.url), 'utf8');
const neighborhood = readFileSync(new URL('../../../packages/architecture/src/neighborhood.ts', import.meta.url), 'utf8');

describe('CLA-107: small-repo L2 pre-places L3 landmarks (no hollow shells)', () => {
  it('does not raise the 2000 hang-guard or rewrite CLA-66 per-kind mapping', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(SMALL_REPO_L3_PREPLACE_MAX_ENTITIES).toBe(2000);
    expect(SMALL_REPO_L3_PREPLACE_CONTAINERS).toBe(12);
    expect(fixture).toContain('export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;');
    expect(fixture).toContain("maxBand: 'container'");
    expect(fixture).toContain('snapshotPreplacesL3InL2(snapshot)');
    expect(neighborhood).toContain('maxBand?: C4Band');
    expect(fixture).not.toMatch(/SCAN_BAND_DEPTH_MIN_ENTITIES\s*=\s*[3-9]\d{3}/u);
  });

  it('full small-repo compile puts component landmarks inside L2 containers, not code', () => {
    const compiled = compileScanFixture({
      snapshot: structuredClone(demoSnapshot),
      view: structuredClone(demoView),
      story: structuredClone(demoStory),
    });
    expect(snapshotPreplacesL3InL2(compiled.snapshot)).toBe(true);
    expect(compiled.scopeCompileOptions(compiled.navigation.rootEntityId)).toEqual({
      maxBand: 'component',
      maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
    });

    const scene = compiled.createScene(compiled.navigation.rootEntityId);
    const componentIds = (scene.projection?.entityIdsByDetail.component ?? [])
      .filter(id => scene.entities.find(entity => entity.id === id)?.detail === 'component');
    expect(componentIds.length).toBeGreaterThan(0);
    expect(scene.projection?.entityIdsByDetail.code ?? []).toEqual([]);
    expect(componentIds.every(id => id.startsWith('component:'))).toBe(true);

    const containers = scene.entities.filter(entity => entity.detail === 'container');
    expect(containers.length).toBeGreaterThan(1);
    expect(containers.some(container => scanDeeperBandHasPeerCards(scene, container.id, 'component'))).toBe(true);

    const web = scene.entities.find(entity => entity.id === 'container:web-app');
    expect(web).toBeDefined();
    expect(scanDeeperBandHasPeerCards(scene, 'container:web-app', 'component')).toBe(true);
    const child = scene.entities.find(entity =>
      entity.parentId === 'container:web-app' && entity.detail === 'component');
    expect(child).toBeDefined();
    const childBounds = scene.projection?.boundsByEntityIdAndDetail[child!.id]?.component;
    const ownerBounds = scene.projection?.boundsByEntityIdAndDetail['container:web-app']?.component
      ?? scene.projection?.boundsByEntityIdAndDetail['container:web-app']?.container;
    expect(childBounds).toBeDefined();
    expect(ownerBounds).toBeDefined();
    expect(childBounds!.width).toBeGreaterThan(0);
    expect(childBounds!.height).toBeGreaterThan(0);
    expect(childBounds!.x).toBeGreaterThanOrEqual(ownerBounds!.x);
    expect(childBounds!.y).toBeGreaterThanOrEqual(ownerBounds!.y);
    expect(childBounds!.x + childBounds!.width).toBeLessThanOrEqual(ownerBounds!.x + ownerBounds!.width + 1);
    expect(childBounds!.y + childBounds!.height).toBeLessThanOrEqual(ownerBounds!.y + ownerBounds!.height + 1);
  });

  it('hosted-style L1 packet (server opt-in) compiles L2 with in-place landmarks without Open inside', () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const sliceOptions = neighborhoodSliceOptionsForFocus(snapshot, 'system:okie');
    expect(sliceOptions).toEqual({ maxBand: 'component' });
    const l1 = sliceArchitectureNeighborhood(snapshot, view, {
      focusEntityId: 'system:okie',
      ...sliceOptions,
    });
    expect(l1.snapshot.entities.some(entity => entity.kind === 'component')).toBe(true);
    expect(l1.snapshot.entities.some(entity => entity.kind === 'code')).toBe(false);

    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        snapshot,
        view,
        {
          focusEntityId: focus || 'system:okie',
          ...neighborhoodSliceOptionsForFocus(snapshot, focus || 'system:okie'),
        },
      ),
      loadExcerpts: async () => undefined,
      loadStory: async () => demoStory,
    };
    const fixture = compileScanNeighborhoodFixture(l1, demoStory, host);
    const l2 = fixture.createScene(fixture.navigation.rootEntityId);
    expect(l2.rootEntityId).toBe('system:okie');
    expect((l2.projection?.entityIdsByDetail.container ?? []).length).toBeGreaterThan(1);
    expect((l2.projection?.entityIdsByDetail.component ?? [])
      .filter(id => l2.entities.find(entity => entity.id === id)?.detail === 'component').length).toBeGreaterThan(0);
    expect(scanDeeperBandHasPeerCards(l2, 'container:web-app', 'component')).toBe(true);
    const web = l2.entities.find(entity => entity.id === 'container:web-app');
    expect(web).toBeDefined();
    expect(scanDrillDeeperDetail(l2, web!, fixture.snapshot)).toBe('component');
    expect((l2.projection?.entityIdsByDetail.code ?? []).length).toBe(0);
  });

  it('CLA-104/105: L2→L3 wheel still hands off into the pointer container', () => {
    const compiled = compileScanFixture({
      snapshot: structuredClone(demoSnapshot),
      view: structuredClone(demoView),
      story: structuredClone(demoStory),
    });
    const l2 = compiled.createScene(compiled.navigation.rootEntityId);
    const web = l2.entities.find(entity => entity.id === 'container:web-app')!;
    expect(scanDrillDeeperDetail(l2, web, compiled.snapshot)).toBe('component');
    expect(scanZoomCompileHandoff(
      l2,
      compiled.snapshot,
      'container:web-app',
      compiled.navigation.rootEntityId,
      'container',
    )).toBeUndefined();
    expect(scanZoomCompileHandoff(
      l2,
      compiled.snapshot,
      'container:web-app',
      compiled.navigation.rootEntityId,
      'component',
    )).toEqual({
      detail: 'component',
      compileFocus: 'container:web-app',
    });
    const l3Focus = scanCompileFocusForBand(
      compiled.snapshot,
      'container:web-app',
      'component',
      compiled.navigation.rootEntityId,
    );
    expect(l3Focus).toBe('container:web-app');
    const l3 = compiled.createScene(l3Focus);
    expect(scanDeeperBandHasPeerCards(l3, 'container:web-app', 'component')).toBe(true);
    expect(compiled.scopeCompileOptions(l3Focus).maxNodesPerBand).toBe(SCAN_RESIDENT_NODES_PER_BAND);
  });
});
