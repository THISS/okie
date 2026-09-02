import type { AtlasScene, SceneEntity } from './renderer/types';

export const DEFAULT_SEARCH_SUGGESTION_LIMIT = 7;
export const DEFAULT_SEARCH_RESULT_LIMIT = DEFAULT_SEARCH_SUGGESTION_LIMIT;

export type DefaultSearchSuggestionContext = {
  /** Currently selected entity id, if any. */
  selectedId?: string;
  /** Root entity of the current view. */
  rootId?: string;
  /** Breadcrumb path ids, top-down (ancestors of the current root, ending in the root). */
  breadcrumbIds?: readonly string[];
  /** Maximum suggestions returned. Defaults to {@link DEFAULT_SEARCH_SUGGESTION_LIMIT}. */
  limit?: number;
};

/**
 * Query search across the whole scene (not the current C4 parent). Nested code
 * entities remain reachable while the entity list stays hierarchical.
 */
export function searchArchitectureEntities(
  scene: Pick<AtlasScene, 'entities'>,
  query: string,
  limit = DEFAULT_SEARCH_RESULT_LIMIT,
): SceneEntity[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized || limit <= 0) return [];
  return scene.entities
    .filter(entity => `${entity.name} ${entity.kind} ${entity.responsibility} ${entity.source ?? ''}`.toLowerCase().includes(normalized))
    .slice(0, limit);
}

/**
 * Empty-query search suggestions: deterministic location-aware defaults for the
 * search popover, deduplicated with first occurrence winning:
 *   1. the current selection
 *   2. the root of the current view
 *   3. the breadcrumb path, then children of the current root (the visible layer),
 *      children in scene order
 *   4. top-level entities, in scene order
 * No randomness or clocks — order is reproducible from scene order alone.
 */
export function defaultSearchSuggestions(
  scene: Pick<AtlasScene, 'entities'>,
  context: DefaultSearchSuggestionContext = {},
): SceneEntity[] {
  const limit = Math.max(0, context.limit ?? DEFAULT_SEARCH_SUGGESTION_LIMIT);
  if (limit === 0 || scene.entities.length === 0) return [];

  const byId = new Map(scene.entities.map(entity => [entity.id, entity]));
  const ordered: SceneEntity[] = [];
  const seen = new Set<string>();
  const pushId = (id: string | undefined) => {
    if (id === undefined || seen.has(id) || ordered.length >= limit) return;
    const entity = byId.get(id);
    if (!entity) return;
    seen.add(id);
    ordered.push(entity);
  };

  pushId(context.selectedId);
  pushId(context.rootId);
  for (const id of context.breadcrumbIds ?? []) pushId(id);
  if (context.rootId !== undefined) {
    for (const entity of scene.entities) {
      if (entity.parentId === context.rootId) pushId(entity.id);
    }
  }
  for (const entity of scene.entities) {
    if (entity.parentId === undefined) pushId(entity.id);
  }
  // Degenerate scene (nothing selected/rooted/top-level): fall back to scene order
  // so the popover is never blind.
  if (ordered.length === 0) {
    for (const entity of scene.entities) pushId(entity.id);
  }
  return ordered;
}
