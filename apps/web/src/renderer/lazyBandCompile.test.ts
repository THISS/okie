import { describe, expect, it } from 'vitest';
import type { ArchitectureEntity, ArchitectureSnapshot, EntityKind } from '@okie/architecture';
import {
  cacheableNeighborhoodScene,
  scanAncestorAtBand,
  scanCompileFocusForBand,
  scanEntityHasChildren,
  scanNextBand,
  scanPrefetchFocusIds,
} from './lazyBandCompile';

function entity(id: string, kind: EntityKind, parentId?: string): ArchitectureEntity {
  return { id, name: id, kind, sourceRefs: [], ...(parentId ? { parentId } : {}) };
}

function snapshot(entities: ArchitectureEntity[]): ArchitectureSnapshot {
  return {
    schemaVersion: 1,
    id: 'snapshot:test',
    repositoryId: 'repo:test',
    commitSha: 'sha',
    generatedAt: '2026-01-01T00:00:00Z',
    entities,
    relations: [],
  };
}

const tree = snapshot([
  entity('system:root', 'softwareSystem'),
  entity('container:web', 'container', 'system:root'),
  entity('container:architecture', 'container', 'system:root'),
  entity('container:empty', 'container', 'system:root'),
  entity('component:web-a', 'component', 'container:web'),
  entity('component:arch-a', 'component', 'container:architecture'),
  entity('code:web-fn', 'code', 'component:web-a'),
  entity('code:arch-fn', 'code', 'component:arch-a'),
]);

describe('scanEntityHasChildren', () => {
  it('reads children from the snapshot, not a compiled scene', () => {
    expect(scanEntityHasChildren(tree, 'container:architecture')).toBe(true);
    expect(scanEntityHasChildren(tree, 'container:empty')).toBe(false);
    expect(scanEntityHasChildren(tree, 'code:arch-fn')).toBe(false);
  });
});

describe('scanCompileFocusForBand — neighborhood, not the whole tree', () => {
  it('keeps L1/L2 at the view root', () => {
    expect(scanCompileFocusForBand(tree, 'container:architecture', 'context', 'system:root')).toBe('system:root');
    expect(scanCompileFocusForBand(tree, 'code:arch-fn', 'container', 'system:root')).toBe('system:root');
  });

  it('compiles L3 at the container of the zoom target', () => {
    expect(scanCompileFocusForBand(tree, 'container:architecture', 'component', 'system:root'))
      .toBe('container:architecture');
    expect(scanCompileFocusForBand(tree, 'code:arch-fn', 'component', 'system:root'))
      .toBe('container:architecture');
    expect(scanCompileFocusForBand(tree, 'code:web-fn', 'component', 'system:root'))
      .toBe('container:web');
  });

  it('compiles L4 at the file-component of the zoom target', () => {
    expect(scanCompileFocusForBand(tree, 'component:arch-a', 'code', 'system:root')).toBe('component:arch-a');
    expect(scanCompileFocusForBand(tree, 'code:arch-fn', 'code', 'system:root')).toBe('component:arch-a');
  });

  it('does not fall through to a sibling neighborhood', () => {
    expect(scanCompileFocusForBand(tree, 'container:architecture', 'component', 'system:root'))
      .not.toBe('container:web');
  });
});

describe('scanPrefetchFocusIds', () => {
  it('prefetches visible parents that have children, skipping empty boxes', () => {
    expect(scanPrefetchFocusIds(tree, ['container:architecture', 'container:empty', 'container:web']))
      .toEqual(['container:architecture', 'container:web']);
  });

  it('dedupes and ignores unknown ids', () => {
    expect(scanPrefetchFocusIds(tree, ['container:web', 'container:web', 'missing']))
      .toEqual(['container:web']);
  });
});

describe('scanAncestorAtBand / scanNextBand', () => {
  it('walks to the native band owner', () => {
    expect(scanAncestorAtBand(tree, 'code:arch-fn', 'container')).toBe('container:architecture');
    expect(scanAncestorAtBand(tree, 'system:root', 'container')).toBeUndefined();
  });

  it('strips protocolPatch so a cached neighborhood can be reused after another scene', () => {
    const patched = { id: 's', protocolPatch: { baseRevision: 1, revision: 2 } };
    expect(cacheableNeighborhoodScene(patched)).toEqual({ id: 's' });
    expect(cacheableNeighborhoodScene({ id: 's' })).toEqual({ id: 's' });
  });
});
