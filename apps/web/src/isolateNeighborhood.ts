import type { SemanticDetail } from './renderer/types';

export type IsolateNeighborhoodEntity = {
  id: string;
  parentId?: string;
  detail?: SemanticDetail;
};

export type IsolateNeighborhoodOptions = {
  /**
   * When true, a code-leaf story target lifts to its owning file-component
   * (parent band) and that component's descendants. User-selected leaves stay
   * a single entity — useful for a leaf, poor for an onboarding tour (CLA-55).
   */
  liftCodeStoryFocus: boolean;
};

function owningFileComponentId(
  entity: IsolateNeighborhoodEntity,
  byId: ReadonlyMap<string, IsolateNeighborhoodEntity>,
): string {
  if (entity.detail !== 'code' || !entity.parentId) return entity.id;
  return byId.has(entity.parentId) ? entity.parentId : entity.id;
}

/**
 * Isolate membership for the current focus. Story-owned code leaves expand to
 * the file-component neighborhood; every other focus stays the focused ids.
 * Order follows `entities` so the isolate count is deterministic.
 */
export function isolateNeighborhoodIds(
  entities: readonly IsolateNeighborhoodEntity[],
  focusIds: Iterable<string>,
  options: IsolateNeighborhoodOptions,
): string[] {
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  const seeds = new Set<string>();
  const expandFrom = new Set<string>();
  for (const id of focusIds) {
    const entity = byId.get(id);
    if (!entity) continue;
    if (options.liftCodeStoryFocus && entity.detail === 'code') {
      const rootId = owningFileComponentId(entity, byId);
      seeds.add(rootId);
      expandFrom.add(rootId);
    } else {
      seeds.add(entity.id);
    }
  }
  if (seeds.size === 0) return [];
  if (expandFrom.size === 0) {
    return entities.filter(entity => seeds.has(entity.id)).map(entity => entity.id);
  }

  const childrenByParent = new Map<string, string[]>();
  for (const entity of entities) {
    if (!entity.parentId) continue;
    const siblings = childrenByParent.get(entity.parentId);
    if (siblings) siblings.push(entity.id);
    else childrenByParent.set(entity.parentId, [entity.id]);
  }

  const neighborhood = new Set<string>(seeds);
  const stack = [...expandFrom];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const children = childrenByParent.get(id);
    if (!children) continue;
    for (const childId of children) {
      if (neighborhood.has(childId)) continue;
      neighborhood.add(childId);
      stack.push(childId);
    }
  }
  return entities.filter(entity => neighborhood.has(entity.id)).map(entity => entity.id);
}
