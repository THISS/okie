import { VIEWPORT_RESIDENT_NODES_PER_BAND } from '@okie/architecture';
import type { SemanticDetail } from './renderer/types';

export type IsolateNeighborhoodEntity = {
  id: string;
  parentId?: string;
  detail?: SemanticDetail;
};

export type IsolateNeighborhoodOptions = {
  /**
   * When true, a code-leaf story target lifts to its owning file-component
   * and that file's sibling files (the parent band). User-selected leaves stay
   * a single entity — useful for a leaf, poor for an onboarding tour (CLA-55).
   * Descendants of a fat file are not the neighborhood (CLA-89).
   */
  liftCodeStoryFocus: boolean;
};

/** CLA-67/74 healthy sibling window. Isolate stays in this band, not a 133-entity dump. */
export const ISOLATE_NEIGHBORHOOD_MAX = VIEWPORT_RESIDENT_NODES_PER_BAND;

function owningFileComponentId(
  entity: IsolateNeighborhoodEntity,
  byId: ReadonlyMap<string, IsolateNeighborhoodEntity>,
): string | undefined {
  if (entity.detail !== 'code' || !entity.parentId) return undefined;
  return byId.has(entity.parentId) ? entity.parentId : undefined;
}

function capNeighborhood(
  entities: readonly IsolateNeighborhoodEntity[],
  neighborhood: ReadonlySet<string>,
  seeds: ReadonlySet<string>,
): string[] {
  const ordered = entities.filter(entity => neighborhood.has(entity.id)).map(entity => entity.id);
  if (ordered.length <= ISOLATE_NEIGHBORHOOD_MAX) return ordered;
  const kept = new Set<string>(seeds);
  if (kept.size >= ISOLATE_NEIGHBORHOOD_MAX) {
    return entities.filter(entity => kept.has(entity.id)).map(entity => entity.id);
  }
  for (const id of ordered) {
    if (kept.size >= ISOLATE_NEIGHBORHOOD_MAX) break;
    kept.add(id);
  }
  return entities.filter(entity => kept.has(entity.id)).map(entity => entity.id);
}

/**
 * Isolate membership for the current focus. Story-owned code leaves lift to
 * the owning file-component and its sibling files (or capped sibling code when
 * the file is not in the compiled scene). Every other focus stays the focused
 * ids. Order follows `entities` so the isolate count is deterministic.
 */
export function isolateNeighborhoodIds(
  entities: readonly IsolateNeighborhoodEntity[],
  focusIds: Iterable<string>,
  options: IsolateNeighborhoodOptions,
): string[] {
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  const seeds = new Set<string>();
  const siblingOf = new Set<string>();
  for (const id of focusIds) {
    const entity = byId.get(id);
    if (!entity) continue;
    if (options.liftCodeStoryFocus && entity.detail === 'code') {
      seeds.add(entity.id);
      const ownerId = owningFileComponentId(entity, byId);
      if (ownerId) {
        seeds.add(ownerId);
        siblingOf.add(ownerId);
      } else if (entity.parentId) {
        siblingOf.add(entity.id);
      }
    } else {
      seeds.add(entity.id);
    }
  }
  if (seeds.size === 0) return [];
  if (siblingOf.size === 0) {
    return entities.filter(entity => seeds.has(entity.id)).map(entity => entity.id);
  }

  const parentKeys = new Set<string>();
  for (const id of siblingOf) {
    const entity = byId.get(id);
    if (!entity?.parentId) continue;
    parentKeys.add(`${entity.parentId}\0${entity.detail ?? ''}`);
  }

  const neighborhood = new Set<string>(seeds);
  for (const entity of entities) {
    if (!entity.parentId || neighborhood.has(entity.id)) continue;
    if (parentKeys.has(`${entity.parentId}\0${entity.detail ?? ''}`)) neighborhood.add(entity.id);
  }
  return capNeighborhood(entities, neighborhood, seeds);
}
