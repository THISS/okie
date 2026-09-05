import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ASPECT_PRESET_TARGET,
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
