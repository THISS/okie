import type { ArchitectureEntity, ArchitectureSnapshot, C4Band, EntityKind } from '@okie/architecture';

const BANDS: readonly C4Band[] = ['context', 'container', 'component', 'code'];

function kindBand(kind: EntityKind): C4Band {
  if (kind === 'container' || kind === 'dataStore' || kind === 'queue') return 'container';
  if (kind === 'component') return 'component';
  if (kind === 'code') return 'code';
  return 'context';
}

function entityById(snapshot: ArchitectureSnapshot): Map<string, ArchitectureEntity> {
  return new Map(snapshot.entities.map(entity => [entity.id, entity]));
}

/** True when the snapshot (not the current scene) has a child under this entity. */
export function scanEntityHasChildren(snapshot: ArchitectureSnapshot, entityId: string): boolean {
  return snapshot.entities.some(entity => entity.parentId === entityId);
}

/**
 * Nearest ancestor-or-self whose native C4 band matches `band`. Undefined when
 * the preferred entity sits above that band (e.g. the system has no container
 * ancestor).
 */
export function scanAncestorAtBand(
  snapshot: ArchitectureSnapshot,
  entityId: string,
  band: C4Band,
): string | undefined {
  const byId = entityById(snapshot);
  let current = byId.get(entityId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (kindBand(current.kind) === band) return current.id;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return undefined;
}

/**
 * Focus id for a per-neighborhood scoped compile of `band`.
 *
 * L1/L2 compile at the view root (current context band + one-down container
 * prefetch). L3 compiles that container. L4 compiles that file-component.
 * Approximate from the zoom/selection/tour target, never the whole tree.
 */
export function scanCompileFocusForBand(
  snapshot: ArchitectureSnapshot,
  preferredEntityId: string,
  band: C4Band,
  viewRootId: string,
): string {
  if (band === 'context' || band === 'container') return viewRootId;
  if (band === 'component') {
    return scanAncestorAtBand(snapshot, preferredEntityId, 'container') ?? viewRootId;
  }
  return scanAncestorAtBand(snapshot, preferredEntityId, 'component')
    ?? scanAncestorAtBand(snapshot, preferredEntityId, 'container')
    ?? viewRootId;
}

/**
 * Visible parents that have children — prefetch their next-band neighborhood
 * so Open inside / zoom is already warm. Does not skip an opened neighborhood
 * just because some of its entities sit outside the viewport (renderer culling).
 */
export function scanPrefetchFocusIds(
  snapshot: ArchitectureSnapshot,
  visibleParentIds: readonly string[],
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of visibleParentIds) {
    if (seen.has(id) || !scanEntityHasChildren(snapshot, id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/** Next C4 band below `band`, or undefined at code. */
export function scanNextBand(band: C4Band): C4Band | undefined {
  return BANDS[BANDS.indexOf(band) + 1];
}

/**
 * Cached neighborhoods must not keep a protocolPatch from the compile that
 * created them. That patch is revision-relative to whatever `previous` was at
 * compile time; replaying it after another neighborhood was shown misses the
 * renderer’s current revision. Full-snapshot load is the safe reuse path.
 */
export function cacheableNeighborhoodScene<T extends object>(scene: T): Omit<T, 'protocolPatch'> {
  if (!('protocolPatch' in scene) || scene.protocolPatch === undefined) return scene as Omit<T, 'protocolPatch'>;
  const { protocolPatch: _protocolPatch, ...rest } = scene as T & { protocolPatch?: unknown };
  return rest as Omit<T, 'protocolPatch'>;
}
