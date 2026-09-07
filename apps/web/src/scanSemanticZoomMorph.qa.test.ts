import { describe, expect, it } from 'vitest';
import {
  neighborhoodSliceOptionsForFocus,
  SMALL_REPO_L3_PREPLACE_CONTAINERS,
  SMALL_REPO_L3_PREPLACE_MAX_COMPONENTS,
  snapshotPreplacesL3InL2,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
} from '@okie/architecture';
import demoSnapshot from '../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../fixtures/architecture/demo-story.json';
import {
  createC4Scene,
  scanDeeperBandHasPeerCards,
  scanDrillDeeperDetail,
  scanZoomCompileHandoff,
  scanZoomEntityUnderPointer,
  scanZoomHandoffPreferredId,
  semanticBounds,
} from './renderer/goldenC4Scene';
import { scanCompileFocusForBand } from './renderer/lazyBandCompile';
import {
  compileScanFixture,
  SCAN_BAND_DEPTH_MIN_ENTITIES,
  SCAN_CONTAINER_GRID_NODES,
  SCAN_RELATION_EDGE_BUDGET,
  SCAN_RESIDENT_NODES_PER_BAND,
  scanKeepsResidentL3Landmarks,
} from './renderer/scanFixture';
import { getLevel } from './App';

const viewport = { width: 1_280, height: 720 };

describe('CLA-109: L2↔L3 and L3↔L4 morph like L1↔L2 (both directions)', () => {
  it('does not raise the 2000 hang-guard or rewrite CLA-66 per-kind mapping', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(SMALL_REPO_L3_PREPLACE_MAX_COMPONENTS).toBe(2000);
    expect(SMALL_REPO_L3_PREPLACE_CONTAINERS).toBe(12);
  });

  it('small-repo system scene keeps L1–L4 on one compile root with representation morphs', () => {
    const compiled = compileScanFixture({
      snapshot: structuredClone(demoSnapshot),
      view: structuredClone(demoView),
      story: structuredClone(demoStory),
    });
    expect(snapshotPreplacesL3InL2(compiled.snapshot)).toBe(true);
    expect(neighborhoodSliceOptionsForFocus(compiled.snapshot, compiled.navigation.rootEntityId))
      .toEqual({ maxBand: 'code' });
    expect(compiled.scopeCompileOptions(compiled.navigation.rootEntityId)).toEqual({
      maxBand: 'code',
      maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      pageCodeLandmarks: true,
    });
    expect(scanKeepsResidentL3Landmarks(compiled.snapshot, compiled.navigation.rootEntityId)).toBe(false);

    const viewRoot = compiled.navigation.rootEntityId;
    const scene = compiled.createScene(viewRoot);
    expect(scene.rootEntityId).toBe(viewRoot);
    expect(scanDeeperBandHasPeerCards(scene, viewRoot, 'component')).toBe(true);
    expect(scanDeeperBandHasPeerCards(scene, viewRoot, 'code')).toBe(true);
    expect(scanDeeperBandHasPeerCards(scene, 'container:web-app', 'component')).toBe(true);
    expect(scanDeeperBandHasPeerCards(scene, 'container:web-app', 'code')).toBe(true);

    expect(getLevel(0.75)).toBe(0);
    expect(getLevel(2.10)).toBe(1);
    expect(getLevel(4)).toBe(2);
    expect(getLevel(10)).toBe(3);

    expect(scanZoomCompileHandoff(scene, compiled.snapshot, 'container:web-app', viewRoot, 'context')).toBeUndefined();
    expect(scanZoomCompileHandoff(scene, compiled.snapshot, 'container:web-app', viewRoot, 'container')).toBeUndefined();
    expect(scanZoomCompileHandoff(scene, compiled.snapshot, 'container:web-app', viewRoot, 'component')).toBeUndefined();
    expect(scanZoomCompileHandoff(scene, compiled.snapshot, 'container:web-app', viewRoot, 'code')).toBeUndefined();
    expect(scanZoomCompileHandoff(scene, compiled.snapshot, viewRoot, viewRoot, 'code')).toBeUndefined();

    const l1Morph = scene.projection?.semanticTransitionsByEntityId?.[viewRoot]?.container;
    const l2Morph = scene.projection?.semanticTransitionsByEntityId?.['container:web-app']?.component;
    const file = scene.entities.find(entity =>
      entity.parentId === 'container:web-app' && entity.detail === 'component');
    expect(file).toBeDefined();
    const l3Morph = scene.projection?.semanticTransitionsByEntityId?.[file!.id]?.code;
    for (const morph of [l1Morph, l2Morph, l3Morph]) {
      expect(morph?.sourceRepresentationId).toBeTruthy();
      expect(morph?.targetRepresentationId).toBeTruthy();
      expect(morph?.sourceRepresentationId).not.toBe(morph?.targetRepresentationId);
    }

    const fileBounds = scene.projection?.boundsByEntityIdAndDetail[file!.id]?.component;
    const symbol = scene.entities.find(entity => entity.parentId === file!.id && entity.detail === 'code');
    expect(symbol).toBeDefined();
    const symbolBounds = scene.projection?.boundsByEntityIdAndDetail[symbol!.id]?.code;
    expect(fileBounds).toBeDefined();
    expect(symbolBounds).toBeDefined();
    expect(symbolBounds!.x).toBeGreaterThanOrEqual(fileBounds!.x);
    expect(symbolBounds!.y).toBeGreaterThanOrEqual(fileBounds!.y);

    const webApp = semanticBounds(scene, 'container:web-app', 'container');
    expect(webApp).toBeDefined();
    const l3Camera = {
      x: webApp!.x + webApp!.width / 2,
      y: webApp!.y + webApp!.height / 2,
      zoom: 4,
    };
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };
    expect(scanZoomEntityUnderPointer(scene, l3Camera, viewport, pointer, 'container'))
      .toBe('container:web-app');
    const preferredL3 = scanZoomHandoffPreferredId(
      scene,
      compiled.snapshot,
      viewRoot,
      'component',
      scene.rootEntityId ?? viewRoot,
      l3Camera,
      viewport,
      pointer,
      'container',
      'system:okie',
    );
    expect(preferredL3).toBe('system:okie');
    const preferredL4 = scanZoomHandoffPreferredId(
      scene,
      compiled.snapshot,
      viewRoot,
      'code',
      scene.rootEntityId ?? viewRoot,
      { ...l3Camera, zoom: 10 },
      viewport,
      pointer,
      'component',
      'system:okie',
    );
    expect(preferredL4).toBe('system:okie');
    expect(scanZoomCompileHandoff(
      scene,
      compiled.snapshot,
      preferredL4,
      viewRoot,
      'code',
    )).toBeUndefined();

    const web = scene.entities.find(entity => entity.id === 'container:web-app')!;
    expect(scanDrillDeeperDetail(scene, web, compiled.snapshot)).toBe('component');
    const openedFocus = scanCompileFocusForBand(
      compiled.snapshot,
      'container:web-app',
      'component',
      viewRoot,
    );
    expect(openedFocus).toBe('container:web-app');
    const opened = compiled.createScene(openedFocus);
    expect(opened.rootEntityId).toBe('container:web-app');
    expect(scanZoomCompileHandoff(opened, compiled.snapshot, 'container:web-app', viewRoot, 'container')).toEqual({
      detail: 'container',
      compileFocus: viewRoot,
    });
  });

  it('pages L4 only on the small-repo system overlay so L3 stays resident', () => {
    const compiled = compileScanFixture({
      snapshot: structuredClone(demoSnapshot),
      view: structuredClone(demoView),
      story: structuredClone(demoStory),
    });
    expect(compiled.scopeCompileOptions(compiled.navigation.rootEntityId).pageCodeLandmarks).toBe(true);
    expect(compiled.scopeCompileOptions(compiled.navigation.rootEntityId).maxNodesPerBand)
      .toBe(SCAN_RESIDENT_NODES_PER_BAND);
    const fileId = compiled.snapshot.entities.find(entity => entity.kind === 'component')?.id;
    expect(fileId).toBeDefined();
    expect(compiled.scopeCompileOptions(fileId!).pageCodeLandmarks).toBeUndefined();

    const entities: ArchitectureEntity[] = [
      { id: 'system:okie', kind: 'softwareSystem', name: 'Okie', sourceRefs: [] },
      { id: 'container:web', kind: 'container', parentId: 'system:okie', name: 'Web', sourceRefs: [] },
    ];
    for (let index = 0; index < 8; index += 1) {
      const nextFileId = `component:f${index}`;
      entities.push({ id: nextFileId, kind: 'component', parentId: 'container:web', name: `f${index}`, sourceRefs: [] });
      for (let code = 0; code < 12; code += 1) {
        entities.push({
          id: `code:f${index}-${code}`,
          kind: 'code',
          parentId: nextFileId,
          name: `k${code}`,
          sourceRefs: [],
        });
      }
    }
    const snapshot: ArchitectureSnapshot = {
      schemaVersion: 1,
      id: 'snapshot:cla109',
      repositoryId: 'repo:cla109',
      commitSha: 'c'.repeat(40),
      generatedAt: '2026-01-01T00:00:00.000Z',
      entities,
      relations: [],
    };
    const scene = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: 'system:okie',
      focusEntityId: 'system:okie',
      familyId: 'f',
      sceneId: 's',
      title: 't',
      subtitle: 's',
      frozenRevision: 'c',
      maxBand: 'code',
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      pageCodeLandmarks: true,
    });
    const files = (scene.projection?.entityIdsByDetail.component ?? [])
      .filter(id => scene.entities.find(entity => entity.id === id)?.detail === 'component');
    const symbols = (scene.projection?.entityIdsByDetail.code ?? [])
      .filter(id => scene.entities.find(entity => entity.id === id)?.detail === 'code');
    expect(files.length).toBe(8);
    expect(symbols.length).toBeGreaterThan(0);
    expect(symbols.length).toBeLessThanOrEqual(SCAN_RESIDENT_NODES_PER_BAND);
    expect(scene.omittedNodes?.some(node => node.detail === 'code')).toBe(true);
    const protocol = scene.protocolSnapshot as { objects: unknown[] };
    expect(protocol.objects.length).toBeLessThan(8 + 2 + SCAN_RESIDENT_NODES_PER_BAND + 8);

    const farFile = scene.entities.find(entity => entity.id === 'component:f7');
    expect(farFile).toBeDefined();
    const farBounds = scene.projection?.boundsByEntityIdAndDetail['component:f7']?.component
      ?? scene.projection?.boundsByEntityIdAndDetail['component:f7']?.code;
    expect(farBounds).toBeDefined();
    const panned = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: 'system:okie',
      focusEntityId: 'system:okie',
      familyId: 'f',
      sceneId: 's',
      title: 't',
      subtitle: 's',
      frozenRevision: 'c',
      maxBand: 'code',
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      pageCodeLandmarks: true,
      previous: scene,
      residentWorldBounds: {
        x: farBounds!.x,
        y: farBounds!.y,
        width: Math.max(1, farBounds!.width),
        height: Math.max(1, farBounds!.height),
      },
    });
    const pannedCode = (panned.projection?.entityIdsByDetail.code ?? [])
      .filter(id => panned.entities.find(entity => entity.id === id)?.detail === 'code');
    expect(pannedCode.some(id => id.startsWith('code:f7-'))).toBe(true);
  });
});
