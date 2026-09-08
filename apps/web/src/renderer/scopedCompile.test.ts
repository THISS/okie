import { describe, expect, it } from 'vitest';
import {
  buildC4ProjectionBundle,
  selectC4BandProjection,
  type ArchitectureEntity,
  type ArchitectureRelation,
  type ArchitectureSnapshot,
  type C4ProjectionBundle,
  type EntityKind,
} from '@okie/architecture';
import {
  SCAN_BAND_DEPTH_MIN_ENTITIES,
  SCAN_CONTAINER_EDGE_BUDGET,
  SCAN_CONTAINER_GRID_NODES,
  SCAN_NEIGHBORHOOD_TARGET_ASPECT,
  SCAN_RELATION_EDGE_BUDGET,
  SCAN_RELATION_EDGE_MIN,
  SCAN_RESIDENT_NODES_PER_BAND,
  guardScanCompile,
  scanScopeCompileOptions,
  scanScopeStats,
} from './scanFixture';
import {
  resolveOmittedRelations,
  scanDeeperBandHasPeerCards,
  scanDrillDeeperDetail,
  scanZoomCompileHandoff,
  scanZoomEntityUnderPointer,
  scanZoomHandoffPreferredId,
} from './goldenC4Scene';
import type { AtlasScene, SceneEntity } from './types';

function entity(id: string, kind: EntityKind, parentId?: string): ArchitectureEntity {
  return { id, name: id, kind, sourceRefs: [], ...(parentId ? { parentId } : {}) };
}

function relation(id: string, from: string, to: string, evidencePaths: string[] = [], label?: string): ArchitectureRelation {
  return {
    id, from, to, kind: 'uses',
    ...(label ? { label } : {}),
    evidence: evidencePaths.map(path => ({ source: { path, commitSha: 'sha' } })),
  };
}

function snapshot(entities: ArchitectureEntity[], relations: ArchitectureRelation[] = []): ArchitectureSnapshot {
  return { schemaVersion: 1, id: 'snapshot:test', repositoryId: 'repo:test', commitSha: 'sha', generatedAt: '2026-01-01T00:00:00Z', entities, relations };
}

describe('scanScopeCompileOptions — per-kind mapping is the default path at every size (CLA-66)', () => {
  const small = snapshot([
    entity('system:root', 'softwareSystem'),
    entity('container:c', 'container', 'system:root'),
    entity('component:x', 'component', 'container:c'),
    entity('code:0', 'code', 'component:x'),
  ]);
  const big = snapshot([
    entity('system:root', 'softwareSystem'),
    entity('container:c', 'container', 'system:root'),
    entity('component:x', 'component', 'container:c'),
    ...Array.from({ length: SCAN_BAND_DEPTH_MIN_ENTITIES }, (_, index) => entity(`code:${index}`, 'code', 'component:x')),
  ]);

  it('CLA-107: handful of containers compiles L3 into L2 even when L4 exceeds the hang-guard', () => {
    const overlay = {
      maxBand: 'code',
      maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      pageCodeLandmarks: true,
    } as const;
    expect(scanScopeCompileOptions(big, 'system:root')).toEqual(overlay);
    expect(scanScopeCompileOptions(small, 'system:root')).toEqual(overlay);
    for (const snap of [small, big]) {
      expect(scanScopeCompileOptions(snap, 'container:c')).toEqual({
        maxBand: 'component',
        maxEdgesPerBand: SCAN_CONTAINER_EDGE_BUDGET,
        maxGridNodes: SCAN_CONTAINER_GRID_NODES,
        maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
        targetAspect: SCAN_NEIGHBORHOOD_TARGET_ASPECT,
      });
      expect(scanScopeCompileOptions(snap, 'component:x')).toEqual({
        maxBand: 'code',
        maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
        targetAspect: SCAN_NEIGHBORHOOD_TARGET_ASPECT,
      });
      expect(scanScopeCompileOptions(snap, 'code:0')).toEqual({
        maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
        targetAspect: SCAN_NEIGHBORHOOD_TARGET_ASPECT,
      });
    }
  });

  it('does not invent a new entity cap or raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(SCAN_RESIDENT_NODES_PER_BAND).toBe(50);
  });

  it('is deterministic (pure function of snapshot + focus)', () => {
    expect(scanScopeCompileOptions(big, 'system:root')).toEqual(scanScopeCompileOptions(big, 'system:root'));
    expect(scanScopeCompileOptions(small, 'container:c')).toEqual(scanScopeCompileOptions(small, 'container:c'));
  });
});

describe('resolveOmittedRelations — "+N more" enumeration', () => {
  const snap = snapshot(
    [entity('a', 'container'), entity('b', 'container'), entity('c', 'container')],
    [
      relation('rel:a-b', 'a', 'b', ['src/a.ts'], 'calls'),
      relation('rel:a-c', 'a', 'c', ['src/a2.ts', 'src/a.ts']),
    ],
  );

  function bundleWith(omittedEdgeIds: string[]): C4ProjectionBundle {
    return {
      schemaVersion: 1,
      family: { id: 'fam', snapshotId: 'snapshot:test', rootEntityId: 'a', bands: [] },
      projectionById: { proj: { omittedEdgeIds } },
      visualNodeById: {},
      visualEdgeById: {
        've:a-b': { id: 've:a-b', fromVisualId: 'vn:a', toVisualId: 'vn:b', label: 'calls', relations: [] },
        've:a-c': { id: 've:a-c', fromVisualId: 'vn:a', toVisualId: 'vn:c', label: 'uses', relations: [] },
      },
      bandLayoutById: {},
      index: {
        entityIdByVisualNodeId: { 'vn:a': 'a', 'vn:b': 'b', 'vn:c': 'c' },
        visualNodeIdsByEntityId: {},
        relationIdsByVisualEdgeId: { 've:a-b': ['rel:a-b'], 've:a-c': ['rel:a-c'] },
        visualEdgeIdsByRelationId: {},
        boundsByEntityIdAndBand: {},
      },
    } as unknown as C4ProjectionBundle;
  }

  it('resolves omitted edges to relations with names, label, and unioned+sorted evidence', () => {
    const omitted = resolveOmittedRelations(bundleWith(['ve:a-c', 've:a-b']), snap);
    expect(omitted.map(item => item.relationId)).toEqual(['rel:a-b', 'rel:a-c']);
    expect(omitted[0]).toMatchObject({ fromName: 'a', toName: 'b', label: 'calls', evidencePaths: ['src/a.ts'] });
    expect(omitted[1]).toMatchObject({ fromName: 'a', toName: 'c', label: 'uses', evidencePaths: ['src/a.ts', 'src/a2.ts'] });
  });

  it('returns [] when no band carries omittedEdgeIds', () => {
    expect(resolveOmittedRelations(bundleWith([]), snap)).toEqual([]);
  });
});

describe('scanScopeStats — cheap in-scope count (no compile)', () => {
  const snap = snapshot([
    entity('system:root', 'softwareSystem'),
    entity('container:c', 'container', 'system:root'),
    entity('component:x', 'component', 'container:c'),
    entity('code:a', 'code', 'component:x'),
    entity('code:b', 'code', 'component:x'),
  ], [
    relation('r1', 'code:a', 'code:b'),
    relation('r2', 'system:root', 'container:c'),
  ]);

  it('counts descendant-or-self entities and relations touching the scope', () => {
    expect(scanScopeStats(snap, 'system:root')).toEqual({ entityCount: 5, relationCount: 2 });
    expect(scanScopeStats(snap, 'component:x')).toEqual({ entityCount: 3, relationCount: 1 });
    expect(scanScopeStats(snap, 'code:a')).toEqual({ entityCount: 1, relationCount: 1 });
  });

  it('returns zero for an unknown focus (the compile rejects it — never a hang)', () => {
    expect(scanScopeStats(snap, 'nope')).toEqual({ entityCount: 0, relationCount: 0 });
  });
});

describe('guardScanCompile — anti-hang choke point above the size gate', () => {
  // Above-gate repo: system → container → component → many code leaves.
  const aboveGate = snapshot([
    entity('system:root', 'softwareSystem'),
    entity('container:c', 'container', 'system:root'),
    entity('component:x', 'component', 'container:c'),
    ...Array.from({ length: SCAN_BAND_DEPTH_MIN_ENTITIES }, (_, index) => entity(`code:${index}`, 'code', 'component:x')),
  ]);

  it('passes a mapped focus through scoped, never refusing it (restored-from-URL root shapes)', () => {
    // The deep-link restore compiles the URL `root` (e.g. system root while the
    // restored detail is `code`); the guard keeps that focus, scoped to container.
    const system = guardScanCompile(aboveGate, 'system:root', 'system:root');
    expect(system).toEqual({
      focusEntityId: 'system:root',
      options: {
        maxBand: 'code',
        maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
        maxGridNodes: SCAN_CONTAINER_GRID_NODES,
        maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
        pageCodeLandmarks: true,
      },
    });
    expect(system.refusal).toBeUndefined();

    // A container drill carries a router-grid cap → bounded → passed through.
    const container = guardScanCompile(aboveGate, 'container:c', 'system:root');
    expect(container.focusEntityId).toBe('container:c');
    expect(container.options.maxGridNodes).toBe(SCAN_CONTAINER_GRID_NODES);
    expect(container.refusal).toBeUndefined();
  });

  it('compiles a genuinely small unbounded scope (a code leaf) as requested', () => {
    const leaf = guardScanCompile(aboveGate, 'code:0', 'system:root');
    expect(leaf).toEqual({
      focusEntityId: 'code:0',
      options: { maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND, targetAspect: SCAN_NEIGHBORHOOD_TARGET_ASPECT },
    });
    expect(leaf.refusal).toBeUndefined();
  });

  it('REFUSES an unbounded above-gate scope and falls back to the scoped view root', () => {
    // A `code` root with a huge nested subtree derives empty options (unbounded)
    // yet a whole-graph scope — the deep-link hang vector, and the shape a stale
    // pre-scoping package build reintroduces on any path.
    const deepCode = snapshot([
      entity('system:root', 'softwareSystem'),
      entity('code:root', 'code', 'system:root'),
      ...Array.from({ length: SCAN_BAND_DEPTH_MIN_ENTITIES }, (_, index) => entity(`code:${index}`, 'code', 'code:root')),
    ]);
    const decision = guardScanCompile(deepCode, 'code:root', 'system:root');
    expect(decision.focusEntityId).toBe('system:root');
    expect(decision.options).toEqual({ maxBand: 'container' });
    expect(decision.refusal).toEqual({
      requestedFocusId: 'code:root',
      fallbackFocusId: 'system:root',
      entityCount: SCAN_BAND_DEPTH_MIN_ENTITIES + 1,
      relationCount: 0,
    });
  });

  it('forces a guaranteed-bounded band when even the fallback derives no constraint', () => {
    // Degenerate: the view root itself is a `code` node (empty options). The guard
    // clamps the fallback to the shallowest band so it can never hang either.
    const rootless = snapshot([
      entity('code:root', 'code'),
      ...Array.from({ length: SCAN_BAND_DEPTH_MIN_ENTITIES }, (_, index) => entity(`code:${index}`, 'code', 'code:root')),
    ]);
    const decision = guardScanCompile(rootless, 'code:root', 'code:root');
    expect(decision.options).toEqual({ maxBand: 'context' });
    expect(decision.refusal?.requestedFocusId).toBe('code:root');
  });

  it('never refuses below the hang-guard; per-kind maxBand still applies (CLA-66)', () => {
    const small = snapshot([
      entity('system:root', 'softwareSystem'),
      entity('code:root', 'code', 'system:root'),
      ...Array.from({ length: 10 }, (_, index) => entity(`code:${index}`, 'code', 'code:root')),
    ]);
    expect(guardScanCompile(small, 'system:root', 'system:root')).toEqual({
      focusEntityId: 'system:root',
      options: { maxBand: 'container' },
    });
    expect(guardScanCompile(small, 'code:root', 'system:root')).toEqual({
      focusEntityId: 'code:root',
      options: { maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND, targetAspect: SCAN_NEIGHBORHOOD_TARGET_ASPECT },
    });
    expect(guardScanCompile(small, 'code:5', 'system:root').refusal).toBeUndefined();
  });
});

describe('scanDrillDeeperDetail — "Open inside" recompiles a scoped-out deeper scope', () => {
  const bounds = { x: 0, y: 0, width: 1, height: 1 };
  const sceneEntities: SceneEntity[] = [
    { id: 'system:root', name: 'root', kind: 'system', detail: 'context', responsibility: '', x: 0, y: 0, width: 1, height: 1 },
    { id: 'container:c', parentId: 'system:root', name: 'c', kind: 'container', detail: 'container', responsibility: '', x: 0, y: 0, width: 1, height: 1 },
    { id: 'component:x', parentId: 'container:c', name: 'x', kind: 'component', detail: 'component', responsibility: '', x: 0, y: 0, width: 1, height: 1 },
  ];
  const sceneWith = (boundsByEntityIdAndDetail: Record<string, Record<string, typeof bounds>>): AtlasScene =>
    ({ id: 's', title: '', subtitle: '', entities: sceneEntities, relations: [], regions: [], projection: { boundsByEntityIdAndDetail } } as unknown as AtlasScene);
  const container = sceneEntities[1]!;

  it('returns the next band when the target has children but its deeper band was scoped out', () => {
    // Scoped top scene (maxBand: container): the container has no `component` bounds.
    const scoped = sceneWith({ 'system:root': { context: bounds, container: bounds }, 'container:c': { container: bounds } });
    expect(scanDrillDeeperDetail(scoped, container)).toBe('component');
  });

  it('returns undefined when the deeper band is already laid out', () => {
    const full = sceneWith({ 'container:c': { container: bounds, component: bounds } });
    expect(scanDrillDeeperDetail(full, container)).toBeUndefined();
  });

  it('CLA-107: pre-placed L3 in the system scene still Open-inside drills the container', () => {
    const preplaced = {
      ...sceneWith({
        'container:c': { container: bounds, component: bounds },
        'component:x': { component: bounds },
      }),
      rootEntityId: 'system:root',
    } as AtlasScene;
    expect(scanDrillDeeperDetail(preplaced, container)).toBe('component');
    const atContainer = { ...preplaced, rootEntityId: 'container:c' };
    expect(scanDrillDeeperDetail(atContainer, container)).toBeUndefined();
  });

  it('CLA-83: reserved owner bounds without descendant peer cards still drill', () => {
    const system = sceneEntities[0]!;
    const snap = snapshot([
      entity('system:root', 'softwareSystem'),
      entity('container:apps-server', 'container', 'system:root'),
      entity('container:apps-web', 'container', 'system:root'),
      entity('component:ask', 'component', 'container:apps-server'),
    ]);
    const reserved = {
      ...sceneWith({ 'system:root': { context: bounds, container: bounds } }),
      entities: [system, sceneEntities[1]!],
      projection: {
        boundsByEntityIdAndDetail: { 'system:root': { context: bounds, container: bounds } },
        entityIdsByDetail: { context: ['system:root'], container: ['system:root'] },
      },
    } as unknown as AtlasScene;
    expect(scanDrillDeeperDetail(reserved, system, snap)).toBe('container');
    const withPeers = {
      ...reserved,
      projection: {
        boundsByEntityIdAndDetail: {
          'system:root': { context: bounds, container: bounds },
          'container:c': { container: bounds },
        },
        entityIdsByDetail: { context: ['system:root'], container: ['system:root', 'container:c'] },
      },
    } as unknown as AtlasScene;
    expect(scanDrillDeeperDetail(withPeers, system, snap)).toBeUndefined();
  });

  it('returns undefined for a leaf (no deeper band) and for a childless target', () => {
    const scene = sceneWith({ 'component:x': { component: bounds } });
    const codeLeaf: SceneEntity = { id: 'code:a', parentId: 'component:x', name: 'a', kind: 'component', detail: 'code', responsibility: '', x: 0, y: 0, width: 1, height: 1 };
    expect(scanDrillDeeperDetail(scene, codeLeaf)).toBeUndefined();
    // component:x has no children in the scene → nothing deeper to compile.
    expect(scanDrillDeeperDetail(scene, sceneEntities[2]!)).toBeUndefined();
  });

  it('uses snapshot children when the compiled neighborhood omitted descendants (CLA-66)', () => {
    const scoped = sceneWith({ 'container:c': { container: bounds } });
    const containerOnly: SceneEntity = sceneEntities[1]!;
    const emptyScene = { ...scoped, entities: [containerOnly] } as AtlasScene;
    expect(scanDrillDeeperDetail(emptyScene, containerOnly)).toBeUndefined();
    const snap = snapshot([
      entity('system:root', 'softwareSystem'),
      entity('container:c', 'container', 'system:root'),
      entity('component:x', 'component', 'container:c'),
    ]);
    expect(scanDrillDeeperDetail(emptyScene, containerOnly, snap)).toBe('component');
  });
});

describe('CLA-104: scanZoomCompileHandoff — continuous zoom swaps the focused neighborhood', () => {
  const bounds = { x: 0, y: 0, width: 1, height: 1 };
  const sceneEntities: SceneEntity[] = [
    { id: 'system:root', name: 'root', kind: 'system', detail: 'context', responsibility: '', x: 0, y: 0, width: 1, height: 1 },
    { id: 'container:c', parentId: 'system:root', name: 'c', kind: 'container', detail: 'container', responsibility: '', x: 0, y: 0, width: 1, height: 1 },
    { id: 'container:empty', parentId: 'system:root', name: 'empty', kind: 'container', detail: 'container', responsibility: '', x: 0, y: 0, width: 1, height: 1 },
    { id: 'component:x', parentId: 'container:c', name: 'x', kind: 'component', detail: 'component', responsibility: '', x: 0, y: 0, width: 1, height: 1 },
  ];
  const snap = snapshot([
    entity('system:root', 'softwareSystem'),
    entity('container:c', 'container', 'system:root'),
    entity('container:empty', 'container', 'system:root'),
    entity('component:x', 'component', 'container:c'),
  ]);
  const l2Scene: AtlasScene = {
    id: 's',
    title: '',
    subtitle: '',
    rootEntityId: 'system:root',
    entities: sceneEntities,
    relations: [],
    regions: [],
    projection: {
      boundsByEntityIdAndDetail: {
        'system:root': { context: bounds, container: bounds },
        'container:c': { container: bounds },
        'container:empty': { container: bounds },
      },
      entityIdsByDetail: {
        context: ['system:root'],
        container: ['system:root', 'container:c', 'container:empty'],
        component: [],
        code: [],
      },
    },
  } as unknown as AtlasScene;

  it('does not swap on L1→L2 — the system compile already includes container peers', () => {
    expect(scanZoomCompileHandoff(l2Scene, snap, 'container:c', 'system:root', 'context')).toBeUndefined();
    expect(scanZoomCompileHandoff(l2Scene, snap, 'container:c', 'system:root', 'container')).toBeUndefined();
  });

  it('swaps L2→L3 into the focused code-bearing container, not the view root', () => {
    expect(scanZoomCompileHandoff(l2Scene, snap, 'container:c', 'system:root', 'component')).toEqual({
      detail: 'component',
      compileFocus: 'container:c',
    });
  });

  it('does not swap into an empty container', () => {
    expect(scanZoomCompileHandoff(l2Scene, snap, 'container:empty', 'system:root', 'component')).toBeUndefined();
  });

  it('does not recompile the view root at L3 — system maxBand cannot grow component peers', () => {
    expect(scanZoomCompileHandoff(l2Scene, snap, 'system:root', 'system:root', 'component')).toBeUndefined();
  });

  it('does not swap again once the L3 peer graph is resident', () => {
    const l3Scene: AtlasScene = {
      ...l2Scene,
      rootEntityId: 'container:c',
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
    expect(scanZoomCompileHandoff(l3Scene, snap, 'container:c', 'system:root', 'component')).toBeUndefined();
  });

  it('swaps back to the view root when zooming out of an L3 neighborhood', () => {
    const l3Scene: AtlasScene = {
      ...l2Scene,
      rootEntityId: 'container:c',
    } as unknown as AtlasScene;
    expect(scanZoomCompileHandoff(l3Scene, snap, 'container:c', 'system:root', 'container')).toEqual({
      detail: 'container',
      compileFocus: 'system:root',
    });
  });

  it('CLA-117: pre-placed L3 pills in the L2 shell still hand off into the container', () => {
    const preplaced: AtlasScene = {
      ...l2Scene,
      projection: {
        boundsByEntityIdAndDetail: {
          'system:root': { context: bounds, container: bounds },
          'container:c': { container: bounds, component: bounds },
          'container:empty': { container: bounds },
          'component:x': { component: bounds },
        },
        entityIdsByDetail: {
          context: ['system:root'],
          container: ['system:root', 'container:c', 'container:empty'],
          component: ['component:x'],
          code: [],
        },
      },
    } as unknown as AtlasScene;
    expect(scanDeeperBandHasPeerCards(preplaced, 'system:root', 'component')).toBe(true);
    expect(scanZoomCompileHandoff(preplaced, snap, 'container:c', 'system:root', 'component')).toEqual({
      detail: 'component',
      compileFocus: 'container:c',
    });
    expect(scanZoomCompileHandoff(preplaced, snap, 'container:c', 'system:root', 'container')).toBeUndefined();
    expect(scanZoomCompileHandoff(preplaced, snap, 'system:root', 'system:root', 'component')).toBeUndefined();
    const opened: AtlasScene = { ...preplaced, rootEntityId: 'container:c' } as unknown as AtlasScene;
    expect(scanZoomCompileHandoff(opened, snap, 'container:c', 'system:root', 'component')).toBeUndefined();
    expect(scanZoomCompileHandoff(opened, snap, 'container:c', 'system:root', 'container')).toEqual({
      detail: 'container',
      compileFocus: 'system:root',
    });
  });

  it('CLA-117: L2→L4 overshoot from a pill-filled L2 shell opens the container, not a file', () => {
    const codeSnap = snapshot([
      entity('system:root', 'softwareSystem'),
      entity('container:c', 'container', 'system:root'),
      entity('container:empty', 'container', 'system:root'),
      entity('component:x', 'component', 'container:c'),
      entity('code:fn', 'code', 'component:x'),
    ]);
    const preplaced: AtlasScene = {
      ...l2Scene,
      entities: [
        ...sceneEntities,
        { id: 'code:fn', parentId: 'component:x', name: 'fn', kind: 'code', detail: 'code', responsibility: '', x: 0, y: 0, width: 1, height: 1 },
      ],
      projection: {
        boundsByEntityIdAndDetail: {
          'system:root': { context: bounds, container: bounds },
          'container:c': { container: bounds, component: bounds },
          'container:empty': { container: bounds },
          'component:x': { component: bounds, code: bounds },
          'code:fn': { code: bounds },
        },
        entityIdsByDetail: {
          context: ['system:root'],
          container: ['system:root', 'container:c', 'container:empty'],
          component: ['component:x'],
          code: ['code:fn'],
        },
      },
    } as unknown as AtlasScene;
    expect(scanZoomCompileHandoff(preplaced, codeSnap, 'container:c', 'system:root', 'component')).toEqual({
      detail: 'component',
      compileFocus: 'container:c',
    });
    expect(scanZoomCompileHandoff(preplaced, codeSnap, 'component:x', 'system:root', 'code')).toEqual({
      detail: 'component',
      compileFocus: 'container:c',
    });
    expect(scanZoomCompileHandoff(preplaced, codeSnap, 'container:c', 'system:root', 'code')).toEqual({
      detail: 'component',
      compileFocus: 'container:c',
    });
    expect(scanZoomCompileHandoff(preplaced, codeSnap, 'system:root', 'system:root', 'code')).toBeUndefined();
    expect(scanZoomCompileHandoff(preplaced, codeSnap, 'container:c', 'system:root', 'container')).toBeUndefined();
    const opened: AtlasScene = { ...preplaced, rootEntityId: 'container:c' } as unknown as AtlasScene;
    expect(scanZoomCompileHandoff(opened, codeSnap, 'component:x', 'system:root', 'code')).toEqual({
      detail: 'code',
      compileFocus: 'component:x',
    });
    expect(scanZoomCompileHandoff(opened, codeSnap, 'container:c', 'system:root', 'code')).toEqual({
      detail: 'code',
      compileFocus: 'component:x',
    });
  });

  it('CLA-117: camera-paged sibling pills do not block handoff into the pointer container', () => {
    const siblingSnap = snapshot([
      entity('system:root', 'softwareSystem'),
      entity('container:c', 'container', 'system:root'),
      entity('container:empty', 'container', 'system:root'),
      entity('container:d', 'container', 'system:root'),
      entity('component:x', 'component', 'container:c'),
      entity('component:y', 'component', 'container:d'),
    ]);
    const siblingScene: AtlasScene = {
      ...l2Scene,
      entities: [
        ...sceneEntities,
        { id: 'container:d', parentId: 'system:root', name: 'd', kind: 'container', detail: 'container', responsibility: '', x: 0, y: 0, width: 1, height: 1 },
        { id: 'component:y', parentId: 'container:d', name: 'y', kind: 'component', detail: 'component', responsibility: '', x: 0, y: 0, width: 1, height: 1 },
      ],
      projection: {
        boundsByEntityIdAndDetail: {
          'system:root': { context: bounds, container: bounds },
          'container:c': { container: bounds, component: bounds },
          'container:d': { container: bounds, component: bounds },
          'container:empty': { container: bounds },
          'component:y': { component: bounds },
        },
        entityIdsByDetail: {
          context: ['system:root'],
          container: ['system:root', 'container:c', 'container:empty', 'container:d'],
          component: ['component:y'],
          code: [],
        },
      },
    } as unknown as AtlasScene;
    expect(scanDeeperBandHasPeerCards(siblingScene, 'container:c', 'component')).toBe(false);
    expect(scanDeeperBandHasPeerCards(siblingScene, 'system:root', 'component')).toBe(true);
    expect(scanZoomCompileHandoff(siblingScene, siblingSnap, 'container:c', 'system:root', 'component')).toEqual({
      detail: 'component',
      compileFocus: 'container:c',
    });
  });
});

describe('CLA-105: scan zoom prefers the container under the pointer', () => {
  const viewport = { width: 400, height: 200 };
  const camera = { x: 200, y: 100, zoom: 1 };
  const sceneEntities: SceneEntity[] = [
    { id: 'system:root', name: 'root', kind: 'system', detail: 'context', responsibility: '', x: 0, y: 0, width: 400, height: 200 },
    { id: 'container:c', parentId: 'system:root', name: 'c', kind: 'container', detail: 'container', responsibility: '', x: 10, y: 10, width: 100, height: 80 },
    { id: 'container:empty', parentId: 'system:root', name: 'empty', kind: 'container', detail: 'container', responsibility: '', x: 200, y: 10, width: 100, height: 80 },
    { id: 'component:x', parentId: 'container:c', name: 'x', kind: 'component', detail: 'component', responsibility: '', x: 20, y: 20, width: 20, height: 20 },
  ];
  const snap = snapshot([
    entity('system:root', 'softwareSystem'),
    entity('container:c', 'container', 'system:root'),
    entity('container:empty', 'container', 'system:root'),
    entity('component:x', 'component', 'container:c'),
  ]);
  const l2Scene: AtlasScene = {
    id: 's',
    title: '',
    subtitle: '',
    rootEntityId: 'system:root',
    entities: sceneEntities,
    relations: [],
    regions: [],
    projection: {
      boundsByEntityIdAndDetail: {
        'system:root': { context: { x: 0, y: 0, width: 400, height: 200 }, container: { x: 0, y: 0, width: 400, height: 200 } },
        'container:c': { container: { x: 10, y: 10, width: 100, height: 80 } },
        'container:empty': { container: { x: 200, y: 10, width: 100, height: 80 } },
      },
      entityIdsByDetail: {
        context: ['system:root'],
        container: ['system:root', 'container:c', 'container:empty'],
        component: [],
        code: [],
      },
    },
  } as unknown as AtlasScene;

  function pointerAt(worldX: number, worldY: number) {
    return {
      x: viewport.width / 2 + (worldX - camera.x) * camera.zoom,
      y: viewport.height / 2 + (worldY - camera.y) * camera.zoom,
    };
  }

  it('hits the nested container, not the system shell', () => {
    expect(scanZoomEntityUnderPointer(l2Scene, camera, viewport, pointerAt(60, 50), 'container'))
      .toBe('container:c');
    expect(scanZoomEntityUnderPointer(l2Scene, camera, viewport, pointerAt(250, 50), 'container'))
      .toBe('container:empty');
  });

  it('hands off L2→L3 with no inspector selection when the pointer is over a code-bearing container', () => {
    expect(scanZoomCompileHandoff(l2Scene, snap, 'system:root', 'system:root', 'component')).toBeUndefined();
    const preferred = scanZoomHandoffPreferredId(
      l2Scene, snap, 'system:root', 'component', 'system:root',
      camera, viewport, pointerAt(60, 50), 'container', 'system:root',
    );
    expect(preferred).toBe('container:c');
    expect(scanZoomCompileHandoff(l2Scene, snap, preferred, 'system:root', 'component')).toEqual({
      detail: 'component',
      compileFocus: 'container:c',
    });
  });

  it('uses the pointer container even when a different container is selected', () => {
    const preferred = scanZoomHandoffPreferredId(
      l2Scene, snap, 'system:root', 'component', 'system:root',
      camera, viewport, pointerAt(60, 50), 'container', 'container:empty',
    );
    expect(preferred).toBe('container:c');
  });

  it('falls back to inspector selection when the pointer misses or is over an empty container', () => {
    expect(scanZoomHandoffPreferredId(
      l2Scene, snap, 'system:root', 'component', 'system:root',
      camera, viewport, pointerAt(150, 50), 'container', 'container:c',
    )).toBe('container:c');
    expect(scanZoomHandoffPreferredId(
      l2Scene, snap, 'system:root', 'component', 'system:root',
      camera, viewport, pointerAt(250, 50), 'container', 'container:c',
    )).toBe('container:c');
    expect(scanZoomHandoffPreferredId(
      l2Scene, snap, 'system:root', 'component', 'system:root',
      camera, viewport, undefined, 'container', 'container:c',
    )).toBe('container:c');
  });

  it('does not invent an L3 handoff when pointer and selection are both the view root', () => {
    const preferred = scanZoomHandoffPreferredId(
      l2Scene, snap, 'system:root', 'component', 'system:root',
      camera, viewport, pointerAt(150, 50), 'container', 'system:root',
    );
    expect(preferred).toBe('system:root');
    expect(scanZoomCompileHandoff(l2Scene, snap, preferred, 'system:root', 'component')).toBeUndefined();
  });

  it('CLA-117: pointer over a pill-filled L2 container prefers that container for L3 handoff', () => {
    const preplaced: AtlasScene = {
      ...l2Scene,
      projection: {
        boundsByEntityIdAndDetail: {
          'system:root': {
            context: { x: 0, y: 0, width: 400, height: 200 },
            container: { x: 0, y: 0, width: 400, height: 200 },
          },
          'container:c': {
            container: { x: 10, y: 10, width: 100, height: 80 },
            component: { x: 10, y: 10, width: 100, height: 80 },
          },
          'container:empty': { container: { x: 200, y: 10, width: 100, height: 80 } },
          'component:x': { component: { x: 20, y: 20, width: 20, height: 20 } },
        },
        entityIdsByDetail: {
          context: ['system:root'],
          container: ['system:root', 'container:c', 'container:empty'],
          component: ['component:x'],
          code: [],
        },
      },
    } as unknown as AtlasScene;
    const preferred = scanZoomHandoffPreferredId(
      preplaced, snap, 'system:root', 'component', 'system:root',
      camera, viewport, pointerAt(60, 50), 'container', 'system:root',
    );
    expect(preferred).toBe('container:c');
    expect(scanZoomCompileHandoff(preplaced, snap, preferred, 'system:root', 'component')).toEqual({
      detail: 'component',
      compileFocus: 'container:c',
    });
  });
});

describe('scanScopeCompileOptions — relation-pressure gate (symbol `uses` graphs)', () => {
  const manyRelations = (count: number) =>
    Array.from({ length: count }, (_, index) => relation(`r${index}`, 'code:a', 'code:b'));
  const smallEntities = [
    entity('system:root', 'softwareSystem'),
    entity('container:c', 'container', 'system:root'),
    entity('component:x', 'component', 'container:c'),
    entity('code:a', 'code', 'component:x'),
    entity('code:b', 'code', 'component:x'),
  ];

  it('budgets routed edges + router grid above the relation gate, composed with per-kind maxBand', () => {
    const dense = snapshot(smallEntities, manyRelations(SCAN_RELATION_EDGE_MIN + 1));
    expect(scanScopeCompileOptions(dense, 'system:root')).toEqual({
      maxBand: 'code',
      maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      pageCodeLandmarks: true,
    });
    expect(scanScopeCompileOptions(dense, 'container:c')).toEqual({
      maxBand: 'component',
      maxEdgesPerBand: SCAN_CONTAINER_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      targetAspect: SCAN_NEIGHBORHOOD_TARGET_ASPECT,
    });
    expect(scanScopeCompileOptions(dense, 'component:x')).toEqual({
      maxBand: 'code',
      maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      targetAspect: SCAN_NEIGHBORHOOD_TARGET_ASPECT,
    });
    expect(scanScopeCompileOptions(dense, 'code:a')).toEqual({
      maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      targetAspect: SCAN_NEIGHBORHOOD_TARGET_ASPECT,
    });
  });

  it('CLA-107: small-repo system overlay still applies at or below the relation gate', () => {
    const sparse = snapshot(smallEntities, manyRelations(SCAN_RELATION_EDGE_MIN));
    expect(scanScopeCompileOptions(sparse, 'system:root')).toEqual({
      maxBand: 'code',
      maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      pageCodeLandmarks: true,
    });
  });

  it('CLA-107: more than 12 containers stay CLA-66 lazy (maxBand container, no L3 overlay)', () => {
    const large = snapshot([
      entity('system:root', 'softwareSystem'),
      ...Array.from({ length: 13 }, (_, index) => entity(`container:c${index}`, 'container', 'system:root')),
      entity('component:x', 'component', 'container:c0'),
    ]);
    expect(scanScopeCompileOptions(large, 'system:root')).toEqual({ maxBand: 'container' });
    expect(scanScopeCompileOptions(large, 'container:c0')).toEqual({
      maxBand: 'component',
      maxEdgesPerBand: SCAN_CONTAINER_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      targetAspect: SCAN_NEIGHBORHOOD_TARGET_ASPECT,
    });
  });

  it('composes with the entity gate: per-kind options win where set, budgets fill the gaps', () => {
    const big = snapshot(
      [
        ...smallEntities,
        ...Array.from({ length: SCAN_BAND_DEPTH_MIN_ENTITIES }, (_, index) => entity(`code:${index}`, 'code', 'component:x')),
      ],
      manyRelations(SCAN_RELATION_EDGE_MIN + 1),
    );
    // Container keeps its OWN tighter budget; system/component/code gain the relation budgets.
    expect(scanScopeCompileOptions(big, 'container:c')).toEqual({
      maxBand: 'component',
      maxEdgesPerBand: SCAN_CONTAINER_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      targetAspect: SCAN_NEIGHBORHOOD_TARGET_ASPECT,
    });
    expect(scanScopeCompileOptions(big, 'system:root')).toEqual({
      maxBand: 'code',
      maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      pageCodeLandmarks: true,
    });
    expect(scanScopeCompileOptions(big, 'code:a')).toEqual({
      maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      targetAspect: SCAN_NEIGHBORHOOD_TARGET_ASPECT,
    });
  });

  it('guardScanCompile accepts relation-gated options as bounded (no refusal on deep links)', () => {
    const big = snapshot(
      [
        ...smallEntities,
        ...Array.from({ length: SCAN_BAND_DEPTH_MIN_ENTITIES }, (_, index) => entity(`code:${index}`, 'code', 'component:x')),
      ],
      manyRelations(SCAN_RELATION_EDGE_MIN + 1),
    );
    const decision = guardScanCompile(big, 'code:a', 'system:root');
    expect(decision.refusal).toBeUndefined();
    expect(decision.focusEntityId).toBe('code:a');
    expect(decision.options.maxGridNodes).toBe(SCAN_CONTAINER_GRID_NODES);
  });
});

describe('CLA-66: per-neighborhood compile — quiet containers drill without a whole-tree scene', () => {
  const snap = snapshot([
    entity('system:root', 'softwareSystem'),
    entity('container:web', 'container', 'system:root'),
    entity('container:architecture', 'container', 'system:root'),
    entity('component:web-a', 'component', 'container:web'),
    entity('component:arch-a', 'component', 'container:architecture'),
    entity('code:web-fn', 'code', 'component:web-a'),
    entity('code:arch-fn', 'code', 'component:arch-a'),
  ]);

  function bundle(focus: string) {
    return buildC4ProjectionBundle(snap, {
      rootEntityId: 'system:root',
      focusEntityId: focus,
      familyId: `fam:${focus}`,
      ...scanScopeCompileOptions(snap, focus),
    });
  }

  function ids(compiled: ReturnType<typeof bundle>, band: 'context' | 'container' | 'component' | 'code') {
    return selectC4BandProjection(compiled, band).nodes.map(node => node.entity.logicalId);
  }

  it('root compile is a handful of L1–L4 nodes on the small-repo overlay (CLA-109)', () => {
    const root = bundle('system:root');
    expect(ids(root, 'container')).toEqual(expect.arrayContaining(['container:web', 'container:architecture']));
    expect(ids(root, 'component')).toEqual(expect.arrayContaining(['component:web-a', 'component:arch-a']));
    expect(ids(root, 'code')).toEqual(expect.arrayContaining(['code:web-fn', 'code:arch-fn']));
  });

  it('Open inside a quiet package compiles that container’s L3, not a sibling neighborhood', () => {
    const arch = bundle('container:architecture');
    expect(ids(arch, 'component')).toContain('component:arch-a');
    expect(ids(arch, 'component')).not.toContain('component:web-a');
    expect(ids(arch, 'code')).toEqual([]);
  });

  it('Open inside a file compiles that file’s L4', () => {
    const file = bundle('component:arch-a');
    expect(ids(file, 'code')).toContain('code:arch-fn');
    expect(ids(file, 'code')).not.toContain('code:web-fn');
  });
});
