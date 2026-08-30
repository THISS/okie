import { describe, expect, it } from 'vitest';
import type { AtlasScene, SceneEntity, SceneRelation } from '../renderer/types';
import {
  canvasRelationRowsForEntity,
  canvasRelationsForEntity,
  selectedRelationPresentation,
  selectedRelationPresentations,
  selfProjectedRelationCount,
  semanticRelationsForVisibleProjection,
  visibleSemanticRelationsForEntity,
} from './projectionRelations';

const entities: SceneEntity[] = [
  {
    id: 'entity:a', name: 'A', kind: 'component', responsibility: 'A', x: 0, y: 0, width: 10, height: 10,
    sourceRefs: [{ path: 'a.ts', symbol: 'A', revision: 'rev-1' }],
  },
  {
    id: 'entity:b', name: 'B', kind: 'component', responsibility: 'B', x: 20, y: 0, width: 10, height: 10,
    sourceRefs: [{ path: 'b.ts', startLine: 4, endLine: 8, revision: 'rev-1' }],
  },
  { id: 'entity:c', name: 'C', kind: 'component', responsibility: 'C', x: 40, y: 0, width: 10, height: 10 },
];

const relations: SceneRelation[] = [
  { id: 'relation:b-c', from: 'entity:b', to: 'entity:c', kindLabel: 'calls' },
  { id: 'relation:a-b', from: 'entity:a', to: 'entity:b', label: 'reads', kindLabel: 'uses', protocol: ' TypeScript ' },
  { id: 'relation:c-a', from: 'entity:c', to: 'entity:a', label: 'returns' },
  { id: 'relation:self', from: 'entity:a', to: 'entity:a', semanticIds: ['relation:self', 'evidence:self'] },
];

function scene(withProjection = true): AtlasScene {
  return {
    id: 'scene:test', title: 'Test', subtitle: 'Test', entities, relations, regions: [], frozenRevision: 'rev-1',
    ...(withProjection ? {
      projection: {
        semanticToVisualEntityId: {}, visualToSemanticEntityId: {},
        semanticToVisualRelationIds: {},
        visualToSemanticRelationIds: {
          'visual:combined': ['relation:a-b', 'relation:b-c'],
          'visual:duplicate': ['relation:a-b', 'relation:missing'],
          'visual:self': ['relation:self'],
        },
        boundsByEntityIdAndDetail: {},
        entityIdsByDetail: { context: [], container: [], component: [], code: [] },
        relationIdsByDetail: { context: [], container: [], component: [], code: [] },
        projectedRelationsByDetail: { context: [], container: [], component: [], code: [] },
      },
    } : {}),
  };
}

describe('projection relation resolution', () => {
  it('maps visual IDs to canonical relations with deterministic deduplication', () => {
    const resolved = semanticRelationsForVisibleProjection(scene(), [
      'visual:duplicate',
      'visual:combined',
      'visual:combined',
      'visual:unknown',
    ]);

    expect(resolved.map(relation => relation.id)).toEqual(['relation:b-c', 'relation:a-b']);
  });

  it('filters mapped relations by either selected endpoint', () => {
    expect(visibleSemanticRelationsForEntity(scene(), ['visual:combined'], 'entity:a')
      .map(relation => relation.id)).toEqual(['relation:a-b']);
    expect(visibleSemanticRelationsForEntity(scene(), ['visual:combined'], 'entity:b')
      .map(relation => relation.id)).toEqual(['relation:b-c', 'relation:a-b']);
    expect(visibleSemanticRelationsForEntity(scene(), ['visual:combined'], 'entity:missing')).toEqual([]);
  });

  it('falls back to direct IDs for scenes without a projection index', () => {
    expect(semanticRelationsForVisibleProjection(scene(false), ['relation:c-a', 'relation:a-b'])
      .map(relation => relation.id)).toEqual(['relation:a-b', 'relation:c-a']);
  });
});

describe('selected relation presentation', () => {
  it('provides endpoints, direction, labels, protocol, and evidence join fields', () => {
    const presentation = selectedRelationPresentation(scene(), relations[1]!, 'entity:b');

    expect(presentation).toMatchObject({
      id: 'relation:a-b',
      source: { id: 'entity:a', name: 'A' },
      target: { id: 'entity:b', name: 'B' },
      counterpart: { id: 'entity:a' },
      direction: 'inbound',
      directionLabel: 'IN',
      label: 'reads',
      kindLabel: 'uses',
      protocol: 'TypeScript',
      evidence: {
        relationIds: ['relation:a-b'],
        sourceEntityRefs: [{ path: 'a.ts', symbol: 'A', revision: 'rev-1' }],
        targetEntityRefs: [{ path: 'b.ts', startLine: 4, endLine: 8, revision: 'rev-1' }],
        frozenRevision: 'rev-1',
      },
    });
  });

  it('handles outbound, self, fallback labels, and missing endpoints', () => {
    expect(selectedRelationPresentation(scene(), relations[1]!, 'entity:a')).toMatchObject({
      direction: 'outbound', directionLabel: 'OUT', counterpart: { id: 'entity:b' },
    });
    expect(selectedRelationPresentation(scene(), relations[3]!, 'entity:a')).toMatchObject({
      direction: 'self', directionLabel: 'SELF', label: 'Relationship',
      evidence: { relationIds: ['relation:self', 'evidence:self'] },
    });
    expect(selectedRelationPresentation(scene(), relations[0]!, 'entity:a')).toBeUndefined();
    expect(selectedRelationPresentation(scene(), { id: 'broken', from: 'entity:a', to: 'missing' }, 'entity:a')).toBeUndefined();
  });

  it('combines visible resolution and presentation in canonical relation order', () => {
    expect(selectedRelationPresentations(scene(), ['visual:duplicate', 'visual:combined'], 'entity:b')
      .map(item => `${item.directionLabel}:${item.id}`))
      .toEqual(['OUT:relation:b-c', 'IN:relation:a-b']);
  });
});

const projectedEntities: SceneEntity[] = [
  { id: 'system:app', name: 'App', kind: 'system', detail: 'context', responsibility: '', x: 0, y: 0, width: 10, height: 10 },
  { id: 'external:db', name: 'DB', kind: 'system', detail: 'context', responsibility: '', x: 40, y: 0, width: 10, height: 10 },
  { id: 'container:web', name: 'Web', kind: 'container', detail: 'container', parentId: 'system:app', responsibility: '', x: 0, y: 0, width: 5, height: 5 },
  { id: 'container:api', name: 'API', kind: 'container', detail: 'container', parentId: 'system:app', responsibility: '', x: 6, y: 0, width: 5, height: 5 },
  { id: 'code:w1', name: 'w1.ts', kind: 'component', detail: 'code', parentId: 'container:web', responsibility: '', x: 0, y: 0, width: 1, height: 1 },
  { id: 'code:w2', name: 'w2.ts', kind: 'component', detail: 'code', parentId: 'container:web', responsibility: '', x: 2, y: 0, width: 1, height: 1 },
  { id: 'code:a1', name: 'a1.ts', kind: 'component', detail: 'code', parentId: 'container:api', responsibility: '', x: 6, y: 0, width: 1, height: 1 },
];

const projectedRelations: SceneRelation[] = [
  { id: 'rel:w1-w2', from: 'code:w1', to: 'code:w2', kindLabel: 'calls' },
  { id: 'rel:w1-a1', from: 'code:w1', to: 'code:a1', label: 'posts', kindLabel: 'uses' },
  { id: 'rel:w2-a1', from: 'code:w2', to: 'code:a1', label: 'polls', kindLabel: 'uses' },
  { id: 'rel:a1-db', from: 'code:a1', to: 'external:db', label: 'reads rows', kindLabel: 'reads', protocol: ' SQL ' },
];

/** Mirrors a compiled band projection: descendant relations land on their nearest visible ancestor. */
function projectedScene(): AtlasScene {
  return {
    id: 'scene:projected', title: 'Projected', subtitle: '', regions: [],
    entities: projectedEntities,
    relations: projectedRelations,
    omittedEdges: [{
      edgeId: 'edge:container:api>db:writes',
      detail: 'container',
      fromId: 'container:api',
      toId: 'external:db',
      fromName: 'API',
      toName: 'DB',
      label: '3 writes',
      relationCount: 3,
    }],
    projection: {
      semanticToVisualEntityId: {}, visualToSemanticEntityId: {},
      semanticToVisualRelationIds: {}, visualToSemanticRelationIds: {},
      boundsByEntityIdAndDetail: {},
      entityIdsByDetail: { context: [], container: [], component: [], code: [] },
      relationIdsByDetail: { context: [], container: [], component: [], code: [] },
      projectedRelationsByDetail: {
        context: [
          { id: 'edge:context:app>db', from: 'system:app', to: 'external:db', label: 'reads rows', kindLabel: 'reads', semanticIds: ['rel:a1-db'] },
        ],
        container: [
          { id: 'edge:container:web>api', from: 'container:web', to: 'container:api', label: '2 uses', kindLabel: 'uses', semanticIds: ['rel:w1-a1', 'rel:w2-a1'] },
          { id: 'edge:container:api>db', from: 'container:api', to: 'external:db', label: 'reads rows', kindLabel: 'reads', semanticIds: ['rel:a1-db'] },
        ],
        component: [],
        code: [],
      },
    },
  };
}

describe('inspector rows follow the canvas', () => {
  it('keeps the edge a band draws from descendant relations that canonical filtering drops', () => {
    const drawn = ['edge:context:app>db'];

    // The canonical endpoints are code:a1 → external:db, so neither is system:app.
    expect(visibleSemanticRelationsForEntity(projectedScene(), drawn, 'system:app')).toEqual([]);
    expect(canvasRelationRowsForEntity(projectedScene(), drawn, 'system:app')).toEqual([expect.objectContaining({
      id: 'edge:context:app>db',
      relationId: 'rel:a1-db',
      direction: 'outbound',
      directionLabel: 'OUT',
      label: 'reads rows',
      kindLabel: 'reads',
      protocol: 'SQL',
      count: 1,
      semanticIds: ['rel:a1-db'],
    })]);
  });

  it('emits one row per visual edge with the collapsed label and underlying count', () => {
    const rows = canvasRelationRowsForEntity(
      projectedScene(),
      ['edge:container:web>api', 'edge:container:api>db'],
      'container:web',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'edge:container:web>api',
      relationId: 'rel:w1-a1',
      direction: 'outbound',
      label: '2 uses',
      count: 2,
      semanticIds: ['rel:w1-a1', 'rel:w2-a1'],
    });
    expect(rows[0]!.counterpart.name).toBe('API');
    expect(rows[0]!.protocol).toBeUndefined();
  });

  it('ignores edges the band did not draw, duplicates, and unknown counterparts', () => {
    const scene = projectedScene();
    expect(canvasRelationRowsForEntity(scene, [], 'container:web')).toEqual([]);
    expect(canvasRelationRowsForEntity(scene, ['edge:container:web>api', 'edge:container:web>api'], 'container:api'))
      .toHaveLength(1);
    expect(canvasRelationRowsForEntity(
      { ...scene, entities: scene.entities.filter(entity => entity.id !== 'container:api') },
      ['edge:container:web>api'],
      'container:web',
    )).toEqual([]);
  });

  it('falls back to canonical relation identity when the scene has no projection', () => {
    expect(canvasRelationRowsForEntity(scene(false), ['relation:a-b', 'relation:self'], 'entity:a'))
      .toEqual([expect.objectContaining({
        id: 'relation:a-b', relationId: 'relation:a-b', direction: 'outbound', label: 'reads', count: 1,
      })]);
  });
});

describe('honest remainders beside the drawn rows', () => {
  it('counts only the internals the band collapsed onto the selected card', () => {
    const scene = projectedScene();

    // At L1 every relation inside the system self-projects onto the one card.
    expect(selfProjectedRelationCount(scene, 'system:app', 'context')).toBe(3);
    // One band deeper the canvas draws the cross-container traffic, so only the
    // relation inside a single container stays hidden.
    expect(selfProjectedRelationCount(scene, 'container:web', 'container')).toBe(1);
    expect(selfProjectedRelationCount(scene, 'container:api', 'container')).toBe(0);
    expect(selfProjectedRelationCount(scene, 'external:db', 'context')).toBe(0);
  });

  it('attributes unrouted edges to the card they touch', () => {
    const scene = projectedScene();
    const api = canvasRelationsForEntity(scene, ['edge:container:web>api', 'edge:container:api>db'], 'container:api', 'container');
    const web = canvasRelationsForEntity(scene, ['edge:container:web>api', 'edge:container:api>db'], 'container:web', 'container');

    expect(api).toMatchObject({ hiddenInternalCount: 0, omittedEdgeCount: 1, omittedRelationCount: 3 });
    expect(api.rows.map(row => row.id)).toEqual(['edge:container:web>api', 'edge:container:api>db']);
    expect(web).toMatchObject({ hiddenInternalCount: 1, omittedEdgeCount: 0, omittedRelationCount: 0 });
    // A container-band drop is not another band's "+N more".
    expect(canvasRelationsForEntity(scene, ['edge:context:app>db'], 'external:db', 'context').omittedEdgeCount).toBe(0);
  });

  it('does not let leftover omittedRelations inflate omittedRelationCount when they overlap hidden internals', () => {
    const leftover = projectedScene();
    leftover.rootEntityId = 'system:app';
    leftover.omittedEdges = [];
    leftover.omittedRelations = [
      { relationId: 'rel:w1-w2', fromName: 'w1', toName: 'w2', label: 'calls', evidencePaths: [] },
      { relationId: 'rel:w1-a1', fromName: 'w1', toName: 'a1', label: 'uses', evidencePaths: [] },
      { relationId: 'rel:w2-a1', fromName: 'w2', toName: 'a1', label: 'uses', evidencePaths: [] },
      { relationId: 'rel:a1-db', fromName: 'a1', toName: 'DB', label: 'reads', evidencePaths: [] },
    ];

    const root = canvasRelationsForEntity(leftover, ['edge:context:app>db'], 'system:app', 'context');

    expect(root.rows.map(row => row.semanticIds)).toEqual([['rel:a1-db']]);
    expect(root.hiddenInternalCount).toBe(3);
    expect(root.omittedEdgeCount).toBe(0);
    expect(root.omittedRelationCount).toBe(0);
  });
});
