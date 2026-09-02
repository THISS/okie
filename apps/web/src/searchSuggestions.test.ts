import { describe, expect, it } from 'vitest';
import type { SceneEntity } from './renderer/types';
import { DEFAULT_SEARCH_RESULT_LIMIT, DEFAULT_SEARCH_SUGGESTION_LIMIT, defaultSearchSuggestions, searchArchitectureEntities } from './searchSuggestions';

function entity(id: string, parentId?: string): SceneEntity {
  return {
    id,
    ...(parentId !== undefined ? { parentId } : {}),
    name: id.toUpperCase(),
    kind: 'component',
    responsibility: id,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
  };
}

// Scene order deliberately differs from priority order so tests can prove which
// source each position came from.
const entities: SceneEntity[] = [
  entity('system'),
  entity('web', 'system'),
  entity('api', 'system'),
  entity('worker', 'system'),
  entity('orders', 'api'),
  entity('payments', 'api'),
  entity('db', 'api'),
  entity('other-system'),
  entity('other-child', 'other-system'),
  entity('third-system'),
];

const scene = { entities };

describe('defaultSearchSuggestions', () => {
  it('leads with the selection, then the root, then breadcrumb ancestors', () => {
    const suggestions = defaultSearchSuggestions(scene, {
      selectedId: 'orders',
      rootId: 'api',
      breadcrumbIds: ['system', 'api'],
    });
    expect(suggestions.map(item => item.id)).toEqual([
      'orders',
      'api',
      'system',
      'payments',
      'db',
      'other-system',
      'third-system',
    ]);
  });

  it('deduplicates when selection, root, and breadcrumb overlap', () => {
    const suggestions = defaultSearchSuggestions(scene, {
      selectedId: 'api',
      rootId: 'api',
      breadcrumbIds: ['system', 'api'],
    });
    expect(suggestions.map(item => item.id)).toEqual([
      'api',
      'system',
      'orders',
      'payments',
      'db',
      'other-system',
      'third-system',
    ]);
    expect(new Set(suggestions.map(item => item.id)).size).toBe(suggestions.length);
  });

  it('fills from top-level entities in scene order when nothing is selected or rooted', () => {
    const suggestions = defaultSearchSuggestions(scene, {});
    expect(suggestions.map(item => item.id)).toEqual(['system', 'other-system', 'third-system']);
  });

  it('caps results at the default limit', () => {
    const many = [entity('root'), ...Array.from({ length: 12 }, (_, index) => entity(`child-${index}`, 'root'))];
    const suggestions = defaultSearchSuggestions({ entities: many }, { rootId: 'root' });
    expect(suggestions.length).toBe(DEFAULT_SEARCH_SUGGESTION_LIMIT);
    expect(suggestions[0]?.id).toBe('root');
    expect(suggestions.slice(1).map(item => item.id)).toEqual(
      Array.from({ length: DEFAULT_SEARCH_SUGGESTION_LIMIT - 1 }, (_, index) => `child-${index}`),
    );
  });

  it('honours an explicit limit, including zero', () => {
    expect(defaultSearchSuggestions(scene, { selectedId: 'orders', limit: 2 }).map(item => item.id)).toEqual(['orders', 'system']);
    expect(defaultSearchSuggestions(scene, { selectedId: 'orders', limit: 0 })).toEqual([]);
  });

  it('ignores ids that are not in the scene', () => {
    const suggestions = defaultSearchSuggestions(scene, {
      selectedId: 'ghost',
      rootId: 'also-ghost',
      breadcrumbIds: ['ghost', 'system'],
    });
    expect(suggestions.map(item => item.id)).toEqual(['system', 'other-system', 'third-system']);
  });

  it('is deterministic: identical inputs reproduce identical order', () => {
    const context = { selectedId: 'payments', rootId: 'api', breadcrumbIds: ['system', 'api'] };
    const first = defaultSearchSuggestions(scene, context).map(item => item.id);
    const second = defaultSearchSuggestions(scene, { ...context }).map(item => item.id);
    expect(first).toEqual(second);
  });

  it('never returns an empty list for a non-empty scene, even with no anchors', () => {
    const parentless = { entities: [entity('lone-child', 'missing-parent')] };
    const suggestions = defaultSearchSuggestions(parentless, {});
    expect(suggestions.map(item => item.id)).toEqual(['lone-child']);
  });

  it('returns an empty list for an empty scene', () => {
    expect(defaultSearchSuggestions({ entities: [] }, { selectedId: 'orders' })).toEqual([]);
  });
});

describe('searchArchitectureEntities', () => {
  it('finds a nested entity by name across the whole tree', () => {
    const hits = searchArchitectureEntities(scene, 'orders');
    expect(hits.map(item => item.id)).toEqual(['orders']);
  });

  it('matches source paths so nested files stay searchable', () => {
    const withSource: SceneEntity = { ...entity('code:shell:app', 'web'), source: 'apps/web/src/App.tsx', name: 'App' };
    const hits = searchArchitectureEntities({ entities: [...entities, withSource] }, 'App.tsx');
    expect(hits.map(item => item.id)).toEqual(['code:shell:app']);
  });

  it('caps results at the default limit', () => {
    const many = Array.from({ length: 12 }, (_, index) => entity(`match-${index}`));
    many.forEach(item => { item.name = 'alpha'; });
    expect(searchArchitectureEntities({ entities: many }, 'alpha')).toHaveLength(DEFAULT_SEARCH_RESULT_LIMIT);
  });

  it('returns nothing for a blank query', () => {
    expect(searchArchitectureEntities(scene, '   ')).toEqual([]);
  });
});
