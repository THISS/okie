import { describe, expect, it } from 'vitest';
import { canonicalRelationshipGroupsForEntity } from './canonicalRelationshipInventory';

describe('canonicalRelationshipGroupsForEntity', () => {
  it('keeps snapshot relationships stable when the map only draws one semantic edge', () => {
    const groups = canonicalRelationshipGroupsForEntity({
      entities: [
        { id: 'api', name: 'API', kind: 'container' },
        { id: 'worker', name: 'Worker', kind: 'container' },
        { id: 'store', name: 'Store', kind: 'container' },
      ],
      relations: [
        { id: 'api-calls-worker', from: 'api', to: 'worker', kind: 'calls' },
        { id: 'api-uses-store', from: 'api', to: 'store', kind: 'uses' },
      ],
    } as never, {
      relations: [{ id: 'api-calls-worker', from: 'api', to: 'worker' }],
      projection: { semanticToVisualRelationIds: { 'api-calls-worker': ['api-calls-worker'], 'api-uses-store': ['hidden-store-edge'] } },
    } as never, new Set(['api-calls-worker']), 'api');

    expect(groups.map(group => group.label)).toEqual(['Calls', 'Uses']);
    expect(groups[0]?.rows[0]).toMatchObject({ counterpartName: 'Worker', mapStatus: 'shown' });
    expect(groups[1]?.rows[0]).toMatchObject({ counterpartName: 'Store', mapStatus: 'hidden' });
  });
});
