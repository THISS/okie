import type { SceneEntity, SemanticDetail } from './renderer/types';

export type ExplorerScene = {
  entities: readonly SceneEntity[];
  projection?: {
    entityIdsByDetail?: Partial<Record<SemanticDetail, readonly string[]>>;
  };
};

const BANDS: readonly SemanticDetail[] = ['context', 'container', 'component', 'code'];

export type ExplorerScopeInput = {
  /** Current canvas / rail C4 band. */
  detail: SemanticDetail;
  selected: Pick<SceneEntity, 'id' | 'parentId' | 'detail'>;
  entities: readonly Pick<SceneEntity, 'id' | 'parentId' | 'detail'>[];
  /** Nested lens path, shallowest owner first (same order as `semanticLensSession.settled`). */
  settledTargetIds?: readonly string[];
};

export type ExplorerBrowseOptions = {
  detail: SemanticDetail;
  /** C4 owner of this band (system at L2, container at L3, component at L4). */
  parentId?: string;
  /** Current canvas projection; when set, rows must also be in this set. */
  visibleIds?: readonly string[];
};

function ancestorOrSelf(
  entity: Pick<SceneEntity, 'id' | 'parentId'>,
  ownerId: string,
  byId: Map<string, Pick<SceneEntity, 'id' | 'parentId'>>,
): boolean {
  let current: Pick<SceneEntity, 'id' | 'parentId'> | undefined = entity;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.id === ownerId) return true;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

/**
 * Owner of the current C4 band for the entity list. Context has no owner (the
 * whole L1 band is the list). Deeper bands prefer the nested lens target at the
 * previous band, then the selected entity's ancestor at that band. Never falls
 * back to the system root at code/component — that would dump every L4 row.
 */
export function explorerScopeParentId(input: ExplorerScopeInput): string | undefined {
  if (input.detail === 'context') return undefined;
  const ownerDetail = BANDS[BANDS.indexOf(input.detail) - 1];
  if (!ownerDetail) return undefined;
  const byId = new Map(input.entities.map(entity => [entity.id, entity]));

  const settledOwner = [...(input.settledTargetIds ?? [])].reverse()
    .map(id => byId.get(id))
    .find(entity => entity?.detail === ownerDetail);
  if (settledOwner) return settledOwner.id;

  let current: Pick<SceneEntity, 'id' | 'parentId' | 'detail'> | undefined =
    byId.get(input.selected.id) ?? input.selected;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.detail === ownerDetail) return current.id;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return undefined;
}

/**
 * Keyboard-explorer browse set: entities in the current C4 band that sit under
 * the current parent (and in the visible projection when one is supplied).
 * Scene order is preserved. An unscoped deep band returns an empty list rather
 * than every L4 declaration.
 */
export function explorerBrowseEntities(
  scene: ExplorerScene,
  options: ExplorerBrowseOptions,
): SceneEntity[] {
  const bandIds = new Set(
    scene.projection?.entityIdsByDetail?.[options.detail]
    ?? scene.entities
      .filter(entity => (entity.detail ?? 'context') === options.detail)
      .map(entity => entity.id),
  );
  const visible = options.visibleIds ? new Set(options.visibleIds) : undefined;
  const byId = new Map(scene.entities.map(entity => [entity.id, entity]));
  return scene.entities.filter(entity => {
    if (!bandIds.has(entity.id)) return false;
    if (visible && !visible.has(entity.id)) return false;
    if (!options.parentId) return options.detail === 'context';
    return ancestorOrSelf(entity, options.parentId, byId);
  });
}

/** Browse rows for the current canvas band / nested lens / selection. */
export function explorerEntitiesForView(
  scene: ExplorerScene,
  input: Omit<ExplorerScopeInput, 'entities'> & { visibleIds?: readonly string[] },
): SceneEntity[] {
  const parentId = explorerScopeParentId({
    detail: input.detail,
    selected: input.selected,
    entities: scene.entities,
    settledTargetIds: input.settledTargetIds,
  });
  return explorerBrowseEntities(scene, {
    detail: input.detail,
    parentId,
    visibleIds: input.visibleIds,
  });
}
