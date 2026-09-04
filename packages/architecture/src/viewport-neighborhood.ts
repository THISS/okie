import type { EntityKind, NodeLayout, Rect, StoryDetail } from "./model.js";

/**
 * Spatial-index cell size used by the CPU renderer (`crates/atlas-engine`
 * `DEFAULT_CELL_SIZE`). Camera-resident tiles are keyed off this grid.
 */
export const VIEWPORT_TILE_WORLD_SIZE = 512;

/**
 * CLA-67 healthy sibling count for one compiled C4 band. This is a
 * **compiled-scene window** for off-screen L3/L4, not a replacement for the
 * 2000 hang-guard (`SCAN_BAND_DEPTH_MIN_ENTITIES`).
 */
export const VIEWPORT_RESIDENT_NODES_PER_BAND = 50;

export type ViewportTileKey = `${number},${number}`;

export type ResidentVisualNode = {
  kind: EntityKind;
  entity: { logicalId: string };
  parentVisualId?: string;
};

export type SelectResidentVisualNodesInput = {
  band: StoryDetail;
  visualNodeIds: readonly string[];
  packed: Readonly<Record<string, NodeLayout>>;
  visualNodeById: Readonly<Record<string, ResidentVisualNode>>;
  focusEntityId: string;
  maxNodesPerBand?: number;
  residentWorldBounds?: Rect;
  keepEntityIds?: readonly string[];
};

export type ResidentVisualNodeSelection = {
  residentIds: string[];
  omittedIds: string[];
};

function rectsOverlap(left: Rect, right: Rect): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function rectCenter(bounds: Rect): { x: number; y: number } {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function distanceSquared(left: { x: number; y: number }, right: { x: number; y: number }): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return dx * dx + dy * dy;
}

/**
 * Expand a camera world rect by one spatial-index cell on every side (the
 * Google Maps neighbor ring around the viewport).
 */
export function expandRectByTileRing(
  bounds: Rect,
  cellSize = VIEWPORT_TILE_WORLD_SIZE,
): Rect {
  return {
    x: bounds.x - cellSize,
    y: bounds.y - cellSize,
    width: bounds.width + 2 * cellSize,
    height: bounds.height + 2 * cellSize,
  };
}

/** World-space rectangle covered by a camera (zoom = CSS pixels per world unit). */
export function cameraWorldRect(
  camera: { x: number; y: number; zoom: number },
  viewport: { width: number; height: number },
): Rect {
  const zoom = camera.zoom > 0 ? camera.zoom : 1;
  const width = Math.max(1, viewport.width) / zoom;
  const height = Math.max(1, viewport.height) / zoom;
  return {
    x: camera.x - width / 2,
    y: camera.y - height / 2,
    width,
    height,
  };
}

/** Deterministic tile keys covering `bounds` on the 512-world-unit grid. */
export function tileKeysForRect(
  bounds: Rect,
  cellSize = VIEWPORT_TILE_WORLD_SIZE,
): ViewportTileKey[] {
  if (!(cellSize > 0) || !(Number.isFinite(bounds.x) && Number.isFinite(bounds.y))) return [];
  const width = Math.max(0, bounds.width);
  const height = Math.max(0, bounds.height);
  const x0 = Math.floor(bounds.x / cellSize);
  const y0 = Math.floor(bounds.y / cellSize);
  const x1 = Math.floor((bounds.x + width) / cellSize);
  const y1 = Math.floor((bounds.y + height) / cellSize);
  const keys: ViewportTileKey[] = [];
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      keys.push(`${x},${y}`);
    }
  }
  return keys;
}

/**
 * Cache key for a camera-resident compile of one C4 neighborhood. Tile keys
 * change as the user pans; the focus id does not. Not a full-graph compile.
 */
export function viewportNeighborhoodCacheKey(
  focusEntityId: string,
  camera?: { x: number; y: number; zoom: number },
  viewport?: { width: number; height: number },
): string {
  if (!camera || !viewport) return `${focusEntityId}@unwindowed`;
  const windowed = expandRectByTileRing(cameraWorldRect(camera, viewport));
  return `${focusEntityId}@${tileKeysForRect(windowed).join(";")}`;
}

function ancestorVisualIds(
  startId: string,
  visualNodeById: Readonly<Record<string, ResidentVisualNode>>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = startId;
  while (current && !seen.has(current)) {
    ids.push(current);
    seen.add(current);
    current = visualNodeById[current]?.parentVisualId;
  }
  return ids;
}

/**
 * Compiled and resident set for one C4 band (CLA-74): focused entity +
 * siblings + one band down, then the camera tile window (viewport + one
 * 512-unit ring). L1/L2 stay unpaged (a handful). Off-screen L3/L4 beyond
 * the window are omitted for inspector `+N more`.
 *
 * Packing of the full neighborhood must happen first so parent bounds stay
 * stable; this helper only chooses which packed nodes remain in the compiled
 * scene. Default (no cap, no camera rect) returns every id — byte-identical.
 */
export function selectResidentVisualNodeIds(
  input: SelectResidentVisualNodesInput,
): ResidentVisualNodeSelection {
  const ordered = [...input.visualNodeIds];
  const all = () => ({ residentIds: ordered, omittedIds: [] as string[] });
  if (input.band === "context" || input.band === "container") return all();
  if (input.maxNodesPerBand === undefined && input.residentWorldBounds === undefined) return all();

  const byId = input.visualNodeById;
  const keepEntities = new Set([input.focusEntityId, ...(input.keepEntityIds ?? [])]);
  const always = new Set<string>();
  for (const id of ordered) {
    const node = byId[id];
    if (!node) continue;
    if (keepEntities.has(node.entity.logicalId)
      || node.kind === "person"
      || node.kind === "externalSystem") {
      for (const ancestor of ancestorVisualIds(id, byId)) always.add(ancestor);
    }
  }

  const origin = input.residentWorldBounds
    ? rectCenter(input.residentWorldBounds)
    : (() => {
      const focusId = ordered.find(id => byId[id]?.entity.logicalId === input.focusEntityId);
      const bounds = (focusId ? input.packed[focusId] : undefined) ?? input.packed[ordered[0] ?? ""];
      return bounds ? rectCenter(bounds) : { x: 0, y: 0 };
    })();

  const eligible = new Set<string>(always);
  for (const id of ordered) {
    if (always.has(id)) continue;
    const bounds = input.packed[id];
    if (!bounds) continue;
    if (input.residentWorldBounds && !rectsOverlap(bounds, input.residentWorldBounds)) continue;
    eligible.add(id);
  }

  if (input.maxNodesPerBand === undefined || eligible.size <= input.maxNodesPerBand) {
    const residentIds = ordered.filter(id => eligible.has(id));
    return {
      residentIds,
      omittedIds: ordered.filter(id => !eligible.has(id)),
    };
  }

  const ranked = [...eligible]
    .filter(id => !always.has(id))
    .sort((left, right) => {
      const leftBounds = input.packed[left];
      const rightBounds = input.packed[right];
      const leftDistance = leftBounds ? distanceSquared(rectCenter(leftBounds), origin) : Number.POSITIVE_INFINITY;
      const rightDistance = rightBounds ? distanceSquared(rectCenter(rightBounds), origin) : Number.POSITIVE_INFINITY;
      return leftDistance - rightDistance || left.localeCompare(right);
    });
  const kept = new Set(always);
  const remaining = Math.max(0, input.maxNodesPerBand - kept.size);
  for (const id of ranked.slice(0, remaining)) kept.add(id);
  const residentIds = ordered.filter(id => kept.has(id));
  return {
    residentIds,
    omittedIds: ordered.filter(id => !kept.has(id)),
  };
}
