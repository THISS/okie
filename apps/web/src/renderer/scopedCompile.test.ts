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
  SCAN_RELATION_EDGE_BUDGET,
  SCAN_RELATION_EDGE_MIN,
  guardScanCompile,
  scanScopeCompileOptions,
  scanScopeStats,
} from './scanFixture';
import { resolveOmittedRelations, scanDrillDeeperDetail } from './goldenC4Scene';
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

  it('system→container; container→component + edge budget + grid cap; component→code; code→unbounded — below and above the hang-guard', () => {
    for (const snap of [small, big]) {
      expect(scanScopeCompileOptions(snap, 'system:root')).toEqual({ maxBand: 'container' });
      expect(scanScopeCompileOptions(snap, 'container:c')).toEqual({
        maxBand: 'component',
        maxEdgesPerBand: SCAN_CONTAINER_EDGE_BUDGET,
        maxGridNodes: SCAN_CONTAINER_GRID_NODES,
      });
      expect(scanScopeCompileOptions(snap, 'component:x')).toEqual({ maxBand: 'code' });
      expect(scanScopeCompileOptions(snap, 'code:0')).toEqual({});
    }
  });

  it('does not invent a new entity cap or raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
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
    expect(system).toEqual({ focusEntityId: 'system:root', options: { maxBand: 'container' } });
    expect(system.refusal).toBeUndefined();

    // A container drill carries a router-grid cap → bounded → passed through.
    const container = guardScanCompile(aboveGate, 'container:c', 'system:root');
    expect(container.focusEntityId).toBe('container:c');
    expect(container.options.maxGridNodes).toBe(SCAN_CONTAINER_GRID_NODES);
    expect(container.refusal).toBeUndefined();
  });

  it('compiles a genuinely small unbounded scope (a code leaf) as requested', () => {
    const leaf = guardScanCompile(aboveGate, 'code:0', 'system:root');
    expect(leaf).toEqual({ focusEntityId: 'code:0', options: {} });
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
      options: {},
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
      maxBand: 'container',
      maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
    });
    expect(scanScopeCompileOptions(dense, 'container:c')).toEqual({
      maxBand: 'component',
      maxEdgesPerBand: SCAN_CONTAINER_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
    });
    expect(scanScopeCompileOptions(dense, 'component:x')).toEqual({
      maxBand: 'code',
      maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
    });
    expect(scanScopeCompileOptions(dense, 'code:a')).toEqual({
      maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
    });
  });

  it('stays at per-kind maxBand at or below the relation gate', () => {
    const sparse = snapshot(smallEntities, manyRelations(SCAN_RELATION_EDGE_MIN));
    expect(scanScopeCompileOptions(sparse, 'system:root')).toEqual({ maxBand: 'container' });
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
    });
    expect(scanScopeCompileOptions(big, 'system:root')).toEqual({
      maxBand: 'container',
      maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
    });
    expect(scanScopeCompileOptions(big, 'code:a')).toEqual({
      maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
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

  it('root compile is a handful of L1/L2 nodes, not L4 rows', () => {
    const root = bundle('system:root');
    expect(ids(root, 'container')).toEqual(expect.arrayContaining(['container:web', 'container:architecture']));
    expect(ids(root, 'component')).toEqual([]);
    expect(ids(root, 'code')).toEqual([]);
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
