import { describe, expect, it } from 'vitest';
import type { AtlasScene, SceneEntity, SceneRelation } from '../renderer/types';
import {
  selectedRelationPresentation,
  selectedRelationPresentations,
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
