import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  neighborhoodSliceOptionsForFocus,
  sliceArchitectureNeighborhood,
  SMALL_REPO_L3_PREPLACE_CONTAINERS,
  SMALL_REPO_L3_PREPLACE_MAX_COMPONENTS,
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
  scanWindowedCompileDropsPeerGraph,
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
  scanKeepsResidentL3Landmarks,
} from './renderer/scanFixture';

const fixture = readFileSync(new URL('./renderer/scanFixture.ts', import.meta.url), 'utf8');
const neighborhood = readFileSync(new URL('../../../packages/architecture/src/neighborhood.ts', import.meta.url), 'utf8');

describe('CLA-107: small-repo L2 pre-places L3 landmarks (no hollow shells)', () => {
  it('does not raise the 2000 hang-guard or rewrite CLA-66 per-kind mapping', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(SMALL_REPO_L3_PREPLACE_MAX_COMPONENTS).toBe(2000);
    expect(SMALL_REPO_L3_PREPLACE_CONTAINERS).toBe(12);
    expect(fixture).toContain('export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;');
    expect(fixture).toContain("maxBand: 'container'");
    expect(fixture).toContain('snapshotPreplacesL3InL2(snapshot)');
    expect(fixture).toContain('scanKeepsResidentL3Landmarks');
    expect(neighborhood).toContain('maxBand?: C4Band');
    expect(fixture).not.toMatch(/SCAN_BAND_DEPTH_MIN_ENTITIES\s*=\s*[3-9]\d{3}/u);
  });

  it('full small-repo compile puts component and code landmarks inside L2 containers', () => {
    const compiled = compileScanFixture({
      snapshot: structuredClone(demoSnapshot),
      view: structuredClone(demoView),
      story: structuredClone(demoStory),
    });
    expect(snapshotPreplacesL3InL2(compiled.snapshot)).toBe(true);
    expect(compiled.scopeCompileOptions(compiled.navigation.rootEntityId)).toEqual({
      maxBand: 'code',
      maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      pageCodeLandmarks: true,
    });

    const scene = compiled.createScene(compiled.navigation.rootEntityId);
    const componentIds = (scene.projection?.entityIdsByDetail.component ?? [])
      .filter(id => scene.entities.find(entity => entity.id === id)?.detail === 'component');
    expect(componentIds.length).toBeGreaterThan(0);
    const codeIds = (scene.projection?.entityIdsByDetail.code ?? [])
      .filter(id => scene.entities.find(entity => entity.id === id)?.detail === 'code');
    expect(codeIds.length).toBeGreaterThan(0);
    expect(componentIds.every(id => id.startsWith('component:'))).toBe(true);
    expect(codeIds.every(id => id.startsWith('code:'))).toBe(true);

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

    const symbol = scene.entities.find(entity =>
      entity.parentId === child!.id && entity.detail === 'code');
    expect(symbol).toBeDefined();
    expect(scanDeeperBandHasPeerCards(scene, child!.id, 'code')).toBe(true);
    const symbolBounds = scene.projection?.boundsByEntityIdAndDetail[symbol!.id]?.code;
    const fileCodeBounds = scene.projection?.boundsByEntityIdAndDetail[child!.id]?.code
      ?? scene.projection?.boundsByEntityIdAndDetail[child!.id]?.component;
    expect(symbolBounds).toBeDefined();
    expect(fileCodeBounds).toBeDefined();
    expect(symbolBounds!.width).toBeGreaterThan(0);
    expect(symbolBounds!.height).toBeGreaterThan(0);
    expect(symbolBounds!.x).toBeGreaterThanOrEqual(fileCodeBounds!.x);
    expect(symbolBounds!.y).toBeGreaterThanOrEqual(fileCodeBounds!.y);

    expect(scanKeepsResidentL3Landmarks(compiled.snapshot, compiled.navigation.rootEntityId)).toBe(false);
    expect(scanKeepsResidentL3Landmarks(compiled.snapshot, 'container:web-app')).toBe(false);
    const far = compiled.createScene(compiled.navigation.rootEntityId, scene, {
      worldBounds: { x: 1_000_000, y: 1_000_000, width: 10, height: 10 },
    });
    const farIds = (far.projection?.entityIdsByDetail.component ?? [])
      .filter(id => far.entities.find(entity => entity.id === id)?.detail === 'component');
    expect(farIds.sort()).toEqual([...componentIds].sort());
    const farCode = (far.projection?.entityIdsByDetail.code ?? [])
      .filter(id => far.entities.find(entity => entity.id === id)?.detail === 'code');
    expect(farCode.length).toBeGreaterThan(0);
    expect(farCode.length).toBeLessThanOrEqual(codeIds.length);
    expect(scanZoomCompileHandoff(far, compiled.snapshot, compiled.navigation.rootEntityId, compiled.navigation.rootEntityId, 'code')).toBeUndefined();
    expect(scanWindowedCompileDropsPeerGraph(scene, far, compiled.navigation.rootEntityId, 'container')).toBe(false);
  });

  it('hosted-style L1 packet (server opt-in) compiles L2 with in-place landmarks without Open inside', () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const sliceOptions = neighborhoodSliceOptionsForFocus(snapshot, 'system:okie');
    expect(sliceOptions).toEqual({ maxBand: 'code' });
    const l1 = sliceArchitectureNeighborhood(snapshot, view, {
      focusEntityId: 'system:okie',
      ...sliceOptions,
    });
    expect(l1.snapshot.entities.some(entity => entity.kind === 'component')).toBe(true);
    expect(l1.snapshot.entities.some(entity => entity.kind === 'code')).toBe(true);

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
    expect(scanDeeperBandHasPeerCards(l2, 'container:web-app', 'code')).toBe(true);
    const web = l2.entities.find(entity => entity.id === 'container:web-app');
    expect(web).toBeDefined();
    expect(scanDrillDeeperDetail(l2, web!, fixture.snapshot)).toBe('component');
    expect((l2.projection?.entityIdsByDetail.code ?? []).length).toBeGreaterThan(0);
  });

  it('CLA-107: pre-places L3 pills in L2; CLA-117 wheel re-roots like Open inside', () => {
    const compiled = compileScanFixture({
      snapshot: structuredClone(demoSnapshot),
      view: structuredClone(demoView),
      story: structuredClone(demoStory),
    });
    const viewRoot = compiled.navigation.rootEntityId;
    const l2 = compiled.createScene(viewRoot);
    const web = l2.entities.find(entity => entity.id === 'container:web-app')!;
    expect(l2.rootEntityId).toBe(viewRoot);
    expect(scanDeeperBandHasPeerCards(l2, 'container:web-app', 'component')).toBe(true);

    expect(scanZoomCompileHandoff(l2, compiled.snapshot, 'container:web-app', viewRoot, 'context')).toBeUndefined();
    expect(scanZoomCompileHandoff(l2, compiled.snapshot, 'container:web-app', viewRoot, 'container')).toBeUndefined();
    expect(scanZoomCompileHandoff(l2, compiled.snapshot, 'container:web-app', viewRoot, 'component')).toEqual({
      detail: 'component',
      compileFocus: 'container:web-app',
    });
    expect(scanZoomCompileHandoff(l2, compiled.snapshot, viewRoot, viewRoot, 'component')).toBeUndefined();
    expect(scanZoomCompileHandoff(l2, compiled.snapshot, 'container:web-app', viewRoot, 'code')).toEqual({
      detail: 'component',
      compileFocus: 'container:web-app',
    });
    expect(scanZoomCompileHandoff(l2, compiled.snapshot, viewRoot, viewRoot, 'code')).toBeUndefined();

    const l1Morph = l2.projection?.semanticTransitionsByEntityId?.[viewRoot]?.container;
    const l2Morph = l2.projection?.semanticTransitionsByEntityId?.['container:web-app']?.component;
    const file = l2.entities.find(entity =>
      entity.parentId === 'container:web-app' && entity.detail === 'component');
    expect(file).toBeDefined();
    const l3Morph = l2.projection?.semanticTransitionsByEntityId?.[file!.id]?.code;
    expect(l1Morph?.sourceRepresentationId).toBeTruthy();
    expect(l1Morph?.targetRepresentationId).toBeTruthy();
    expect(l1Morph?.sourceRepresentationId).not.toBe(l1Morph?.targetRepresentationId);
    expect(l2Morph?.sourceRepresentationId).toBeTruthy();
    expect(l2Morph?.targetRepresentationId).toBeTruthy();
    expect(l2Morph?.sourceRepresentationId).not.toBe(l2Morph?.targetRepresentationId);
    expect(l3Morph?.sourceRepresentationId).toBeTruthy();
    expect(l3Morph?.targetRepresentationId).toBeTruthy();
    expect(l3Morph?.sourceRepresentationId).not.toBe(l3Morph?.targetRepresentationId);

    const containerBounds = l2.projection?.boundsByEntityIdAndDetail['container:web-app']?.container;
    const componentOwnerBounds = l2.projection?.boundsByEntityIdAndDetail['container:web-app']?.component;
    expect(containerBounds).toBeDefined();
    expect(componentOwnerBounds).toBeDefined();

    expect(scanDrillDeeperDetail(l2, web, compiled.snapshot)).toBe('component');
    const l3Focus = scanCompileFocusForBand(
      compiled.snapshot,
      'container:web-app',
      'component',
      viewRoot,
    );
    expect(l3Focus).toBe('container:web-app');
    const l3 = compiled.createScene(l3Focus);
    expect(l3.rootEntityId).toBe('container:web-app');
    expect(scanDeeperBandHasPeerCards(l3, 'container:web-app', 'component')).toBe(true);
    expect(scanZoomCompileHandoff(l3, compiled.snapshot, 'container:web-app', viewRoot, 'container')).toEqual({
      detail: 'container',
      compileFocus: viewRoot,
    });
    expect(compiled.scopeCompileOptions(l3Focus).maxNodesPerBand).toBe(SCAN_RESIDENT_NODES_PER_BAND);
  });
});
