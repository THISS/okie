import { describe, expect, it } from 'vitest';
import type { ArchitectureEntity, ArchitectureRelation, ArchitectureSnapshot, C4ProjectionBundle, EntityKind } from '@okie/architecture';
import {
  SCAN_BAND_DEPTH_MIN_ENTITIES,
  SCAN_CONTAINER_EDGE_BUDGET,
  SCAN_CONTAINER_GRID_NODES,
  scanScopeCompileOptions,
} from './scanFixture';
import { resolveOmittedRelations } from './goldenC4Scene';

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

describe('scanScopeCompileOptions — per-kind mapping above the size gate (large repo)', () => {
  const big = snapshot([
    entity('system:root', 'softwareSystem'),
    entity('container:c', 'container', 'system:root'),
    entity('component:x', 'component', 'container:c'),
    ...Array.from({ length: SCAN_BAND_DEPTH_MIN_ENTITIES }, (_, index) => entity(`code:${index}`, 'code', 'component:x')),
  ]);

  it('system→container; container→component + edge budget + grid cap; component→code; code→unbounded', () => {
    expect(scanScopeCompileOptions(big, 'system:root')).toEqual({ maxBand: 'container' });
    expect(scanScopeCompileOptions(big, 'container:c')).toEqual({
      maxBand: 'component',
      maxEdgesPerBand: SCAN_CONTAINER_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
    });
    expect(scanScopeCompileOptions(big, 'component:x')).toEqual({ maxBand: 'code' });
    expect(scanScopeCompileOptions(big, 'code:0')).toEqual({});
  });

  it('is deterministic (pure function of snapshot + focus)', () => {
    expect(scanScopeCompileOptions(big, 'system:root')).toEqual(scanScopeCompileOptions(big, 'system:root'));
    expect(scanScopeCompileOptions(big, 'container:c')).toEqual(scanScopeCompileOptions(big, 'container:c'));
  });
});

describe('scanScopeCompileOptions — size gate keeps small repos unbounded (Okie stays identical)', () => {
  it('returns {} below the size gate regardless of focus kind', () => {
    const small = snapshot(
      [entity('system:root', 'softwareSystem'), entity('container:c', 'container', 'system:root')],
      [relation('r1', 'system:root', 'container:c')],
    );
    expect(scanScopeCompileOptions(small, 'system:root')).toEqual({});
    expect(scanScopeCompileOptions(small, 'container:c')).toEqual({});
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
