import { C4_CONTAINER_CARD_FACE, C4_CONTEXT_CARD_FACE } from '@okie/architecture';
import {
  C4_LABEL_MIN_TITLE_PX,
  C4_PRESENTATION_AT_FOCUS,
  C4_ZOOM_BANDS,
  COVERAGE_REVEAL,
} from '@okie/scene-compiler';
import {
  ATLAS_CAMERA_BOUNDS,
  ATLAS_SEMANTIC_ZOOM_BANDS,
  semanticDominantZoomIntervals,
  semanticFocusZooms,
} from '../renderer/cameraBounds';
import {
  compensateSemanticMorphCamera,
  idleSemanticLens,
  idleSemanticLensSession,
  semanticLensBranchEntityIds,
  semanticLensSessionDetail,
  semanticLensSessionGhostEntities,
  settleSemanticLensPanFocus,
  stabilizeSemanticLensSessionForPan,
  transferSemanticLensFocus,
  validateSemanticLensPath,
} from './semanticLens';
import type { SemanticLensPathEntry, SemanticLensSession } from './semanticLens';
import { semanticBounds } from '../renderer/goldenC4Scene';
import { selectedEntityReframePlan } from '../inspector/inspectorSupport';
import {
  frameEntities,
  frameSemanticEntities,
  readableRootCamera,
  storySafeArea,
} from '../storyFraming';
import type { SafeArea, ViewportSize } from '../storyFraming';
import type { SemanticDetail } from '../navigation/navigationState';
import type { AtlasScene, Camera } from '../renderer/types';

export const semanticDetails: SemanticDetail[] = ['context', 'container', 'component', 'code'];

const levelFocusZooms = semanticFocusZooms();
export const levels = [
  { name: 'Context', short: 'L1', zoom: levelFocusZooms[0]! },
  { name: 'Containers', short: 'L2', zoom: levelFocusZooms[1]! },
  { name: 'Components', short: 'L3', zoom: levelFocusZooms[2]! },
  { name: 'Code', short: 'L4', zoom: levelFocusZooms[3]! },
];

const bandDominantIntervals = semanticDominantZoomIntervals();

/** Inspector-open desktop crop used when scan L1 boot has no live map chrome yet. */
export const ATLAS_L1_BOOT_VIEWPORT: ViewportSize = { width: 1_280, height: 720 };
export const ATLAS_L1_BOOT_SAFE_AREA: SafeArea = { top: 80, right: 300, bottom: 72, left: 64 };

type WorldRect = { x: number; y: number; width: number; height: number };

/** CSS px of an L1 authored title at `zoom` (20px at focus 0.75). */
export function contextTitleCssPx(zoom: number): number {
  return C4_PRESENTATION_AT_FOCUS.context.titleFontSize
    * (zoom / C4_ZOOM_BANDS[0]!.focusZoom);
}

/** Zoom at which L1 titles meet `C4_LABEL_MIN_TITLE_PX` (12 CSS px). */
export const CONTEXT_TITLE_READABLE_MIN_ZOOM = C4_LABEL_MIN_TITLE_PX
  * C4_ZOOM_BANDS[0]!.focusZoom
  / C4_PRESENTATION_AT_FOCUS.context.titleFontSize;

/**
 * Readable L1 card face — the title/header leaf, not a CLA-81 reserved interior.
 * Golden 480×250 systems are unchanged; scan shells clip to the top-left leaf.
 */
export function contextCardFaceBounds(bounds: WorldRect): WorldRect {
  if (bounds.width <= C4_CONTEXT_CARD_FACE.width * 1.25
    && bounds.height <= C4_CONTEXT_CARD_FACE.height * 1.25) {
    return bounds;
  }
  return {
    x: bounds.x,
    y: bounds.y,
    width: Math.min(bounds.width, C4_CONTEXT_CARD_FACE.width),
    height: Math.min(bounds.height, C4_CONTEXT_CARD_FACE.height),
  };
}

/** CSS px of an L2 authored title at `zoom` (15.5px at focus 1.99). */
export function containerTitleCssPx(zoom: number): number {
  return C4_PRESENTATION_AT_FOCUS.container.titleFontSize
    * (zoom / C4_ZOOM_BANDS[1]!.focusZoom);
}

/** Zoom at which L2 titles meet `C4_LABEL_MIN_TITLE_PX` (12 CSS px). */
export const CONTAINER_TITLE_READABLE_MIN_ZOOM = C4_LABEL_MIN_TITLE_PX
  * C4_ZOOM_BANDS[1]!.focusZoom
  / C4_PRESENTATION_AT_FOCUS.container.titleFontSize;

/**
 * Readable L2 card face — the title/header leaf, not a CLA-81 reserved interior.
 * Golden 420×180 containers are unchanged; scan shells clip to the top-left leaf.
 */
export function containerCardFaceBounds(bounds: WorldRect): WorldRect {
  if (bounds.width <= C4_CONTAINER_CARD_FACE.width * 1.25
    && bounds.height <= C4_CONTAINER_CARD_FACE.height * 1.25) {
    return bounds;
  }
  return {
    x: bounds.x,
    y: bounds.y,
    width: Math.min(bounds.width, C4_CONTAINER_CARD_FACE.width),
    height: Math.min(bounds.height, C4_CONTAINER_CARD_FACE.height),
  };
}

function readableCardFaceBounds(bounds: WorldRect, detail: SemanticDetail): WorldRect {
  if (detail === 'context') return contextCardFaceBounds(bounds);
  if (detail === 'container') return containerCardFaceBounds(bounds);
  return bounds;
}

function projectedBoundsAtDetail(
  scene: AtlasScene,
  entity: AtlasScene['entities'][number],
  detail: SemanticDetail,
): WorldRect | undefined {
  const projected = scene.projection?.boundsByEntityIdAndDetail[entity.id]?.[detail];
  const native = (entity.detail ?? 'context') === detail
    && Number.isFinite(entity.width) && Number.isFinite(entity.height)
    ? { x: entity.x, y: entity.y, width: entity.width, height: entity.height }
    : undefined;
  return projected ?? native;
}

function isReservedContextShell(bounds: WorldRect): boolean {
  return bounds.width > C4_CONTEXT_CARD_FACE.width * 1.25
    || bounds.height > C4_CONTEXT_CARD_FACE.height * 1.25;
}

function isReservedContainerShell(bounds: WorldRect): boolean {
  return bounds.width > C4_CONTAINER_CARD_FACE.width * 1.25
    || bounds.height > C4_CONTAINER_CARD_FACE.height * 1.25;
}

function contextArrivalFace(
  scene: AtlasScene,
  entityIds: readonly string[],
  detail: SemanticDetail,
): WorldRect | undefined {
  const preferred = scene.rootEntityId && entityIds.includes(scene.rootEntityId)
    ? scene.rootEntityId
    : entityIds[0];
  if (!preferred) return undefined;
  const entity = scene.entities.find(candidate => candidate.id === preferred);
  const bounds = entity ? projectedBoundsAtDetail(scene, entity, detail) : undefined;
  return bounds ? contextCardFaceBounds(bounds) : undefined;
}

/**
 * System card face plus exterior peers that share the L1 title row and sit in
 * the adjacent column — not the far flank across a CLA-81 reserved shell, which
 * would re-inflate Fit to the camera floor.
 */
function nearbyContextArrivalIds(
  scene: AtlasScene,
  residentIds: readonly string[],
): string[] {
  const face = contextArrivalFace(scene, residentIds, 'context');
  const focusId = scene.rootEntityId && residentIds.includes(scene.rootEntityId)
    ? scene.rootEntityId
    : residentIds[0];
  if (!face || !focusId) return [...residentIds];
  const padY = C4_CONTEXT_CARD_FACE.height;
  const bandTop = face.y - padY;
  const bandBottom = face.y + face.height + padY;
  const maxGapX = C4_CONTEXT_CARD_FACE.width + 200;
  const cluster: string[] = [];
  for (const id of residentIds) {
    if (id === focusId) {
      cluster.push(id);
      continue;
    }
    const entity = scene.entities.find(candidate => candidate.id === id);
    const bounds = entity ? projectedBoundsAtDetail(scene, entity, 'context') : undefined;
    if (!bounds) continue;
    const card = contextCardFaceBounds(bounds);
    if (card.y + card.height < bandTop || card.y > bandBottom) continue;
    const gap = card.x >= face.x + face.width
      ? card.x - (face.x + face.width)
      : face.x >= card.x + card.width
        ? face.x - (card.x + card.width)
        : 0;
    if (gap <= maxGapX) cluster.push(id);
  }
  return cluster.length > 0 ? cluster : [focusId];
}

function frameContextArrivalCluster(
  scene: AtlasScene,
  residentIds: readonly string[],
  viewport: ViewportSize,
  safeArea: SafeArea,
): Camera | undefined {
  return frameEntityIdsAtDetail(
    scene,
    nearbyContextArrivalIds(scene, residentIds),
    'context',
    viewport,
    safeArea,
    CONTEXT_TITLE_READABLE_MIN_ZOOM,
    levels[0]!.zoom,
    true,
  );
}

/**
 * L2 peer card faces that still fit at a title-readable zoom, starting from
 * the top-left of the packed grid. Fitting every reserved package shell would
 * re-inflate Open inside to the camera floor (CLA-90).
 */
function nearbyContainerArrivalIds(
  scene: AtlasScene,
  residentIds: readonly string[],
  viewport: ViewportSize,
  safeArea: SafeArea,
): string[] {
  const faces = residentIds.flatMap(id => {
    const entity = scene.entities.find(candidate => candidate.id === id);
    const bounds = entity ? projectedBoundsAtDetail(scene, entity, 'container') : undefined;
    return bounds ? [{ id, face: containerCardFaceBounds(bounds) }] : [];
  }).sort((left, right) => left.face.y - right.face.y
    || left.face.x - right.face.x
    || left.id.localeCompare(right.id));
  if (!faces.length) return [...residentIds];
  const safeWidth = Math.max(80, viewport.width - safeArea.left - safeArea.right);
  const safeHeight = Math.max(80, viewport.height - safeArea.top - safeArea.bottom);
  const padding = 48;
  const maxWorldWidth = (safeWidth - padding) / CONTAINER_TITLE_READABLE_MIN_ZOOM;
  const maxWorldHeight = (safeHeight - padding) / CONTAINER_TITLE_READABLE_MIN_ZOOM;
  const cluster = [faces[0]!];
  let union = { ...faces[0]!.face };
  for (const candidate of faces.slice(1)) {
    const left = Math.min(union.x, candidate.face.x);
    const top = Math.min(union.y, candidate.face.y);
    const right = Math.max(union.x + union.width, candidate.face.x + candidate.face.width);
    const bottom = Math.max(union.y + union.height, candidate.face.y + candidate.face.height);
    if (right - left <= maxWorldWidth && bottom - top <= maxWorldHeight) {
      cluster.push(candidate);
      union = { x: left, y: top, width: right - left, height: bottom - top };
    }
  }
  return cluster.map(item => item.id);
}

/**
 * Scan Open inside L2: frame resident container peer card faces at band-focus
 * zoom, not coverage-reveal of the reserved owner shell.
 */
export function frameContainerPeerArrivalCamera(
  scene: AtlasScene,
  rootEntityId: string,
  viewport: ViewportSize,
  safeArea: SafeArea,
): Camera | undefined {
  const scopeIds = projectionScopeEntityIds(scene, rootEntityId, 'container');
  const residentIds = residentVisibleProjectionEntityIds(scene, scopeIds, 'container');
  if (!residentIds.length) return undefined;
  const clusterIds = nearbyContainerArrivalIds(scene, residentIds, viewport, safeArea);
  const focusZoom = scene.projection?.zoomPolicy?.bands.find(band => band.detail === 'container')?.focusZoom
    ?? levels[1]!.zoom;
  return frameEntityIdsAtDetail(
    scene,
    clusterIds,
    'container',
    viewport,
    safeArea,
    CONTAINER_TITLE_READABLE_MIN_ZOOM,
    focusZoom,
    true,
  );
}

/** Explicit rail selection chooses one valid nested branch at the requested depth. */
export function semanticLevelSession(
  scene: AtlasScene,
  detail: SemanticDetail,
  preferredIds: readonly string[] = [],
): SemanticLensSession {
  const depth = semanticDetails.indexOf(detail);
  if (depth <= 0) return idleSemanticLensSession('context');
  const byId = new Map(scene.entities.map(entity => [entity.id, entity]));
  const isDescendantOrSelf = (entityId: string, ownerId: string) => {
    let current = byId.get(entityId);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (current.id === ownerId) return true;
      seen.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
  };
  const targetIds: string[] = [];
  let parentTargetId: string | undefined;
  for (let index = 0; index < depth; index += 1) {
    const currentDetail = semanticDetails[index]!;
    const nextDetail = semanticDetails[index + 1]!;
    const candidates = scene.entities.filter(entity => entity.detail === currentDetail
      && (!parentTargetId || isDescendantOrSelf(entity.id, parentTargetId))
      && Boolean(semanticBounds(scene, entity.id, currentDetail))
      && Boolean(semanticBounds(scene, entity.id, nextDetail))
      && scene.entities.some(child => child.id !== entity.id
        && child.detail === nextDetail
        && isDescendantOrSelf(child.id, entity.id)))
      .sort((left, right) => left.id.localeCompare(right.id));
    const target = preferredIds
      .flatMap(preferredId => candidates.filter(candidate => isDescendantOrSelf(preferredId, candidate.id)))
      [0] ?? candidates[0];
    if (!target) return idleSemanticLensSession(detail);
    targetIds.push(target.id);
    parentTargetId = target.id;
  }
  const validated = validateSemanticLensPath(scene, 'context', targetIds);
  return validated.entries.length === depth
    ? { baseDetail: 'context', settled: validated.entries, active: idleSemanticLens() }
    : idleSemanticLensSession(detail);
}

/**
 * Makes an explicitly opened L4 entity part of the primary semantic branch.
 * This is intentionally separate from canvas picking/panning: ordinary map
 * gestures keep their current branch until the existing stationary-pan handoff.
 */
export function semanticSourceSession(
  scene: AtlasScene,
  current: SemanticLensSession,
  entityId: string,
): SemanticLensSession {
  const entity = scene.entities.find(candidate => candidate.id === entityId);
  if (entity?.detail !== 'code') return current;
  const candidate = semanticLevelSession(scene, 'code', [
    entityId,
    ...current.settled.map(entry => entry.targetId).reverse(),
  ]);
  const ownerId = candidate.settled.at(-1)?.targetId;
  return candidate.settled.length === semanticDetails.indexOf('code')
    && ownerId
    && semanticLensBranchEntityIds(scene, ownerId, 'code').includes(entityId)
    ? candidate
    : current;
}

/** Semantic pan can change the active owner without implicitly changing inspector selection. */
export function semanticPanFocusPlan(
  scene: AtlasScene,
  session: SemanticLensSession,
  selectedId: string,
  camera: Camera,
  viewport: ViewportSize,
  safeArea: SafeArea,
  stationaryMs: number,
): { session: SemanticLensSession; selectedId: string } {
  const stabilized = stabilizeSemanticLensSessionForPan(session);
  return {
    session: settleSemanticLensPanFocus(scene, stabilized, camera, viewport, safeArea, stationaryMs),
    selectedId,
  };
}

export function projectionScopeEntityIds(scene: AtlasScene, rootEntityId: string, detail: SemanticDetail): string[] {
  const visible = new Set(scene.projection?.entityIdsByDetail[detail] ?? scene.entities.map(entity => entity.id));
  const byId = new Map(scene.entities.map(entity => [entity.id, entity]));
  const isInRoot = (entityId: string) => {
    let current = byId.get(entityId);
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      if (current.id === rootEntityId) return true;
      visited.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
  };
  const scoped = new Set([...visible].filter(isInRoot));
  const nearestAncestorId = byId.get(rootEntityId)?.parentId;
  if (nearestAncestorId && visible.has(nearestAncestorId)) scoped.add(nearestAncestorId);
  for (const relation of scene.projection?.projectedRelationsByDetail[detail] ?? []) {
    if (scoped.has(relation.from) || scoped.has(relation.to)) {
      if (visible.has(relation.from)) scoped.add(relation.from);
      if (visible.has(relation.to)) scoped.add(relation.to);
    }
  }
  if (visible.has(rootEntityId)) scoped.add(rootEntityId);
  return [...scoped].sort();
}

/**
 * Zoom at which `bounds` covers COVERAGE_REVEAL.full of the safe viewport — the landing
 * that shows a focus's coverage-revealed children on arrival (tasks #30/#33). Clamped to
 * the camera envelope. Pure; uses the real safe viewport so the framing is exact on screen.
 */
function coverageRevealLandingZoom(
  bounds: { width: number; height: number },
  viewport: ViewportSize,
  safeArea: SafeArea,
): number {
  const safeWidth = Math.max(80, viewport.width - safeArea.left - safeArea.right);
  const safeHeight = Math.max(80, viewport.height - safeArea.top - safeArea.bottom);
  const fill = Math.min(safeWidth / Math.max(1, bounds.width), safeHeight / Math.max(1, bounds.height));
  return Math.max(ATLAS_CAMERA_BOUNDS.minZoom, Math.min(ATLAS_CAMERA_BOUNDS.maxZoom, COVERAGE_REVEAL.full * fill));
}

function dominantBandZoomRange(detail: SemanticDetail, forceBandOwnership = false) {
  const level = Math.max(0, semanticDetails.indexOf(detail));
  const interval = bandDominantIntervals[level]!;
  const activeBand = ATLAS_SEMANTIC_ZOOM_BANDS[level]!;
  return {
    level,
    minZoom: forceBandOwnership && level > 0
      ? activeBand.enterZoom + activeBand.hysteresis + 0.001
      : interval.min,
    maxZoom: interval.max,
  };
}

function frameEntityIdsAtDetail(
  scene: AtlasScene,
  entityIds: readonly string[],
  detail: SemanticDetail,
  viewport: ViewportSize,
  safeArea: SafeArea,
  minZoom: number,
  maxZoom: number,
  clipToReadableCardFace = false,
): Camera | undefined {
  const wanted = new Set(entityIds);
  const entities = scene.entities.flatMap(entity => {
    const bounds = projectedBoundsAtDetail(scene, entity, detail);
    if (!wanted.has(entity.id) || !bounds) return [];
    const framed = clipToReadableCardFace
      ? readableCardFaceBounds(bounds, detail)
      : bounds;
    return [{ ...entity, ...framed }];
  });
  if (!entities.length) return undefined;
  return frameEntities({ ...scene, entities }, entityIds, viewport, safeArea, {
    screenPadding: 24,
    minZoom,
    maxZoom,
  });
}

/**
 * Painted cards at this C4 band — compiled projection members whose native
 * detail is the band. Fit uses these so ancestor owner-shells (stable packed
 * bounds that still cover omitted CLA-74 neighbors) cannot yank the camera
 * into empty space while the explorer still lists resident L4 cards.
 */
export function residentVisibleProjectionEntityIds(
  scene: AtlasScene,
  entityIds: readonly string[],
  detail: SemanticDetail,
): string[] {
  const painted = new Set(
    scene.projection?.entityIdsByDetail[detail]
    ?? scene.entities.filter(entity => (entity.detail ?? 'context') === detail).map(entity => entity.id),
  );
  const wanted = new Set(entityIds);
  const cards = scene.entities
    .filter(entity => wanted.has(entity.id)
      && painted.has(entity.id)
      && (entity.detail ?? 'context') === detail)
    .map(entity => entity.id);
  // Empty native-band set: do not restore ancestor owner-shells. Their packed
  // code-band bounds still cover omitted CLA-74 neighbors, so Fit would land on
  // empty space (or snap to the L1 default camera) while the explorer lists cards.
  return cards;
}

/**
 * Frames the entities currently painted at this C4 band (the visible projection),
 * not the root entity's full descendant scope. Fit uses this; load/open-inside keep
 * `frameProjectionScope` so CLA-11 unsolicited refit behavior stays unchanged.
 *
 * At L1, Fit frames readable card faces / exterior peers — not the CLA-81 reserved
 * interior of the system shell — and will not collapse below a 12 CSS px title.
 */
export function frameVisibleProjection(
  scene: AtlasScene,
  entityIds: readonly string[],
  detail: SemanticDetail,
  viewport: ViewportSize,
  safeArea: SafeArea,
): Camera | undefined {
  const { minZoom, maxZoom } = dominantBandZoomRange(detail);
  const residentIds = residentVisibleProjectionEntityIds(scene, entityIds, detail);
  if (detail !== 'context') {
    return frameEntityIdsAtDetail(scene, residentIds, detail, viewport, safeArea, minZoom, maxZoom);
  }
  const shellCamera = frameEntityIdsAtDetail(
    scene, residentIds, detail, viewport, safeArea, minZoom, maxZoom, false,
  );
  const faceCamera = frameEntityIdsAtDetail(
    scene, residentIds, detail, viewport, safeArea, minZoom, maxZoom, true,
  );
  const camera = faceCamera ?? shellCamera;
  if (!camera) return undefined;
  // Compact L1 graphs (golden) keep the Fit that shows every context peer (CLA-44).
  // A CLA-81 reserved shell whose Fit would drop titles below 12 CSS px frames the
  // adjacent title-row cluster (system card + nearby exterior peers), not the hollow
  // interior or the far flank across the reserved width.
  const reservedShell = residentIds.some(id => {
    const entity = scene.entities.find(candidate => candidate.id === id);
    const bounds = entity ? projectedBoundsAtDetail(scene, entity, 'context') : undefined;
    return bounds !== undefined && isReservedContextShell(bounds);
  });
  if (!reservedShell || camera.zoom + 1e-9 >= CONTEXT_TITLE_READABLE_MIN_ZOOM) return camera;
  return frameContextArrivalCluster(scene, residentIds, viewport, safeArea) ?? camera;
}

/**
 * Scan/hosted L1 boot camera: same readable title-row cluster as Fit, computed
 * from the compiled scene so first paint is not the golden toy camera.
 */
export function frameContextArrivalCamera(
  scene: AtlasScene,
  viewport: ViewportSize = ATLAS_L1_BOOT_VIEWPORT,
  safeArea: SafeArea = ATLAS_L1_BOOT_SAFE_AREA,
): Camera | undefined {
  const ids = scene.projection?.entityIdsByDetail.context
    ?? scene.entities.filter(entity => (entity.detail ?? 'context') === 'context').map(entity => entity.id);
  return frameVisibleProjection(scene, ids, 'context', viewport, safeArea);
}

export function projectedEntitiesFitSafeViewport(
  scene: AtlasScene,
  entityIds: readonly string[],
  detail: SemanticDetail,
  camera: Camera,
  viewport: ViewportSize,
  safeArea: SafeArea,
): boolean {
  const padding = 24;
  return entityIds.every(id => {
    const bounds = scene.projection?.boundsByEntityIdAndDetail[id]?.[detail];
    if (!bounds) return true;
    const left = viewport.width / 2 + (bounds.x - camera.x) * camera.zoom;
    const top = viewport.height / 2 + (bounds.y - camera.y) * camera.zoom;
    const right = left + bounds.width * camera.zoom;
    const bottom = top + bounds.height * camera.zoom;
    return left >= safeArea.left + padding
      && right <= viewport.width - safeArea.right - padding
      && top >= safeArea.top + padding
      && bottom <= viewport.height - safeArea.bottom - padding;
  });
}

export function frameProjectionScope(
  scene: AtlasScene,
  rootEntityId: string,
  detail: SemanticDetail,
  viewport: ViewportSize,
  safeArea: SafeArea,
  forceBandOwnership = false,
  preferReadableRoot = false,
): Camera | undefined {
  const ids = projectionScopeEntityIds(scene, rootEntityId, detail);
  const { level, minZoom, maxZoom } = dominantBandZoomRange(detail, forceBandOwnership);
  const rootBounds = scene.projection?.boundsByEntityIdAndDetail[rootEntityId]?.[detail];
  // CLA-90: Open inside a scan system must frame L2 container peer card faces
  // at a readable band-focus zoom. Coverage-reveal of the CLA-81 reserved owner
  // commits ATLAS_CAMERA_BOUNDS.minZoom over a hollow shell (same class as CLA-82 L1).
  if (detail === 'container' && scene.targetAspect !== undefined && rootBounds
    && isReservedContainerShell(rootBounds)) {
    const peers = frameContainerPeerArrivalCamera(scene, rootEntityId, viewport, safeArea);
    if (peers) return peers;
  }
  // Coverage-reveal landing (scan mode only): frame the focus at COVERAGE_REVEAL.full
  // coverage so its coverage-revealed children are visible on arrival, instead of clamping
  // up to the band floor (which overframes a large scope and hides its interior). Demo/golden
  // (no targetAspect) keep the band-floor landing → byte-identical, bandPolicy.qa unchanged.
  const coverageLanding = scene.targetAspect !== undefined && rootBounds
    ? coverageRevealLandingZoom(rootBounds, viewport, safeArea)
    : undefined;
  const ownershipFloor = coverageLanding ?? minZoom;
  const fitted = frameEntityIdsAtDetail(scene, ids, detail, viewport, safeArea, ownershipFloor, maxZoom);
  if (!fitted || !preferReadableRoot) return fitted;
  if (!rootBounds) return fitted;
  // L1 scan: frame the readable card face (and adjacent title-row peers) at a
  // title-readable zoom. Coverage-reveal of a reserved interior would land at
  // the camera floor over a hollow shell.
  if (detail === 'context') {
    if (isReservedContextShell(rootBounds)) {
      const contextIds = scene.projection?.entityIdsByDetail.context
        ?? scene.entities.filter(entity => (entity.detail ?? 'context') === 'context').map(entity => entity.id);
      const residentIds = residentVisibleProjectionEntityIds(scene, contextIds, 'context');
      const cluster = frameContextArrivalCluster(
        scene,
        residentIds.length ? residentIds : [rootEntityId],
        viewport,
        safeArea,
      );
      if (cluster) return cluster;
    }
    const face = contextCardFaceBounds(rootBounds);
    const focusZoom = scene.projection?.zoomPolicy?.bands.find(band => band.detail === detail)?.focusZoom
      ?? levels[level]!.zoom;
    return readableRootCamera(fitted, face, focusZoom, viewport, safeArea);
  }
  // The rail's readable-root target is the reveal-coverage zoom in scan mode (frame the focus
  // at its children's reveal coverage), else the band focus preset (unchanged for the demo).
  const focusZoom = coverageLanding
    ?? scene.projection?.zoomPolicy?.bands.find(band => band.detail === detail)?.focusZoom
    ?? levels[level]!.zoom;
  return readableRootCamera(fitted, rootBounds, focusZoom, viewport, safeArea);
}

export function scopeFitsSafeViewport(
  scene: AtlasScene,
  rootEntityId: string,
  detail: SemanticDetail,
  camera: Camera,
  viewport: ViewportSize,
  safeArea: SafeArea,
): boolean {
  return projectedEntitiesFitSafeViewport(
    scene,
    projectionScopeEntityIds(scene, rootEntityId, detail),
    detail,
    camera,
    viewport,
    safeArea,
  );
}

export function retargetCameraForSemanticBand(
  camera: Camera,
  previousBounds: { x: number; y: number; width: number; height: number } | undefined,
  targetBounds: { x: number; y: number; width: number; height: number },
  targetZoom: number,
  viewport: ViewportSize,
): Camera {
  const targetCenter = { x: targetBounds.x + targetBounds.width / 2, y: targetBounds.y + targetBounds.height / 2 };
  if (!previousBounds) return { ...targetCenter, zoom: targetZoom };
  const previousCenter = { x: previousBounds.x + previousBounds.width / 2, y: previousBounds.y + previousBounds.height / 2 };
  const anchorX = viewport.width / 2 + (previousCenter.x - camera.x) * camera.zoom;
  const anchorY = viewport.height / 2 + (previousCenter.y - camera.y) * camera.zoom;
  if (anchorX < 0 || anchorX > viewport.width || anchorY < 0 || anchorY > viewport.height) {
    return { ...targetCenter, zoom: targetZoom };
  }
  return {
    x: targetCenter.x - (anchorX - viewport.width / 2) / targetZoom,
    y: targetCenter.y - (anchorY - viewport.height / 2) / targetZoom,
    zoom: targetZoom,
  };
}

export type SemanticOpenNextLayerPlan = {
  session: SemanticLensSession;
  camera: Camera;
  targetId: string;
  nextDetail: Exclude<SemanticDetail, 'context'>;
  rootEntityId: string;
  historyMode: 'push';
};

/** Frames one semantic entity using the compiled zoom band and the current safe viewport. */
export function semanticEntityFrameCamera(
  scene: AtlasScene,
  targetId: string,
  detail: SemanticDetail,
  viewport: ViewportSize,
  safeArea: SafeArea,
): Camera | undefined {
  const target = scene.entities.find(entity => entity.id === targetId);
  const frameTargetId = detail === 'code' && target?.detail === 'code' && target.parentId
    ? target.parentId
    : targetId;
  return frameSemanticEntities(scene, [frameTargetId], detail, viewport, safeArea, {
    allowFocusRunway: detail === 'code',
  });
}

function storyStepPrimaryId(scene: AtlasScene, entityIds: readonly string[]): string | undefined {
  return scene.rootEntityId && entityIds.includes(scene.rootEntityId)
    ? scene.rootEntityId
    : entityIds[0];
}

function storyStepFocusZoom(scene: AtlasScene, detail: SemanticDetail): number {
  return scene.projection?.zoomPolicy?.bands.find(band => band.detail === detail)?.focusZoom
    ?? levels[Math.max(0, semanticDetails.indexOf(detail))]!.zoom;
}

/**
 * Frames a guided-story step as a readable box at the band's focus zoom.
 * Scan L1 reserved shells must not fit the hollow interior down to z=0.32
 * (CLA-84); nearby card faces land at context focus, matching golden.
 */
export function frameStoryStepCamera(
  scene: AtlasScene,
  entityIds: readonly string[],
  detail: SemanticDetail,
  viewport: ViewportSize,
  safeArea: SafeArea = storySafeArea(viewport),
): Camera | undefined {
  const focusZoom = storyStepFocusZoom(scene, detail);
  const primaryId = storyStepPrimaryId(scene, entityIds);
  if (detail === 'context') {
    const clustered = frameEntityIdsAtDetail(
      scene,
      nearbyContextArrivalIds(scene, entityIds),
      'context',
      viewport,
      safeArea,
      CONTEXT_TITLE_READABLE_MIN_ZOOM,
      focusZoom,
      true,
    );
    const entity = primaryId ? scene.entities.find(candidate => candidate.id === primaryId) : undefined;
    const bounds = entity ? projectedBoundsAtDetail(scene, entity, 'context') : undefined;
    const face = bounds ? contextCardFaceBounds(bounds) : undefined;
    if (clustered && face) return readableRootCamera(clustered, face, focusZoom, viewport, safeArea);
    if (clustered) return clustered;
  }
  const fitted = frameSemanticEntities(scene, entityIds, detail, viewport, safeArea);
  if (!fitted) return undefined;
  const entity = primaryId ? scene.entities.find(candidate => candidate.id === primaryId) : undefined;
  const bounds = entity ? projectedBoundsAtDetail(scene, entity, detail) : undefined;
  if (!bounds) return fitted;
  return readableRootCamera(fitted, bounds, focusZoom, viewport, safeArea);
}

export type SemanticInspectorHierarchyPlan = {
  session: SemanticLensSession;
  camera: Camera;
  targetId: string;
  detail: SemanticDetail;
  historyMode: 'replace';
};

/** Retains the outgoing semantic branch while an inspector camera flight reveals its destination. */
export type SemanticInspectorFlightKind = 'inward' | 'outward' | 'transfer' | 'none';

function semanticPathPrefix(
  prefix: readonly SemanticLensPathEntry[],
  path: readonly SemanticLensPathEntry[],
) {
  return prefix.every((entry, index) => entry.targetId === path[index]?.targetId);
}

export function semanticInspectorFlightKind(
  source: SemanticLensSession,
  target: SemanticLensSession,
): SemanticInspectorFlightKind {
  if (source.baseDetail !== target.baseDetail) return 'transfer';
  if (target.settled.length === source.settled.length + 1
    && semanticPathPrefix(source.settled, target.settled)) return 'inward';
  if (source.settled.length === target.settled.length + 1
    && semanticPathPrefix(target.settled, source.settled)) return 'outward';
  if (source.settled.length === target.settled.length
    && semanticPathPrefix(source.settled, target.settled)) return 'none';
  return 'transfer';
}

export function semanticInspectorFlightProgress(
  easedCameraProgress: number,
  kind: SemanticInspectorFlightKind,
) {
  if (kind === 'none') return 1;
  const start = kind === 'transfer' ? .25 : .08;
  const end = kind === 'transfer' ? .75 : .8;
  return Math.max(0, Math.min(1, (easedCameraProgress - start) / (end - start)));
}

export type InspectorMorphBounds = { x: number; y: number; width: number; height: number };

function inspectorMorphDelta(source: InspectorMorphBounds, target: InspectorMorphBounds) {
  return {
    x: target.x + target.width / 2 - source.x - source.width / 2,
    y: target.y + target.height / 2 - source.y - source.height / 2,
  };
}

export function semanticInspectorRawCameraTarget(
  desiredTarget: Camera,
  sourceBounds: InspectorMorphBounds,
  targetBounds: InspectorMorphBounds,
  kind: Extract<SemanticInspectorFlightKind, 'inward' | 'outward'>,
) {
  const delta = inspectorMorphDelta(sourceBounds, targetBounds);
  return {
    ...desiredTarget,
    x: desiredTarget.x + (kind === 'outward' ? delta.x : -delta.x),
    y: desiredTarget.y + (kind === 'outward' ? delta.y : -delta.y),
  };
}

export function compensateSemanticInspectorFlightCamera(
  raw: Camera,
  sourceBounds: InspectorMorphBounds,
  targetBounds: InspectorMorphBounds,
  kind: Extract<SemanticInspectorFlightKind, 'inward' | 'outward'>,
  semanticProgress: number,
) {
  return compensateSemanticMorphCamera(
    raw,
    sourceBounds,
    targetBounds,
    kind === 'outward' ? 1 - semanticProgress : semanticProgress,
    kind === 'outward' ? 1 : 0,
  );
}

export function semanticInspectorFlightSession(
  source: SemanticLensSession,
  target: SemanticLensSession,
  targetId: string,
  progress: number,
): SemanticLensSession {
  const amount = Math.max(0, Math.min(1, progress));
  const kind = semanticInspectorFlightKind(source, target);
  if (amount >= 1 || kind === 'none' || source.baseDetail !== target.baseDetail) return target;
  if (kind === 'inward') {
    const entry = target.settled.at(-1)!;
    return {
      baseDetail: target.baseDetail,
      settled: source.settled,
      active: {
        phase: 'revealing',
        targetId: entry.targetId,
        currentDetail: entry.currentDetail,
        nextDetail: entry.nextDetail,
        progress: amount,
        assistBlend: 0,
      },
    };
  }
  if (kind === 'outward') {
    const entry = source.settled.at(-1)!;
    return {
      baseDetail: target.baseDetail,
      settled: target.settled,
      active: {
        phase: 'reversing',
        targetId: entry.targetId,
        currentDetail: entry.currentDetail,
        nextDetail: entry.nextDetail,
        progress: 1 - amount,
        assistBlend: 0,
      },
    };
  }
  return {
    ...target,
    focusTransfer: {
      sourceEntries: source.focusTransfer && source.focusTransfer.progress < .5
        ? source.focusTransfer.sourceEntries
        : source.settled,
      targetId,
      depth: Math.max(0, target.settled.length - 1),
      progress: amount,
    },
  };
}

/** Resolves inspector parent/child traversal to the destination's own canonical C4 level. */
export function semanticInspectorHierarchyPlan(
  scene: AtlasScene,
  targetId: string,
  viewport: ViewportSize,
  safeArea: SafeArea,
  currentSession?: SemanticLensSession,
  currentCamera?: Camera,
): SemanticInspectorHierarchyPlan | undefined {
  const target = scene.entities.find(entity => entity.id === targetId);
  const detail = target?.detail;
  if (!target || !detail || !semanticDetails.includes(detail)) return undefined;
  const session = semanticLevelSession(scene, detail, [target.id]);
  if (semanticLensSessionDetail(session) !== detail) return undefined;
  const targetBounds = semanticBounds(scene, target.id, detail);
  const camera = currentSession && currentCamera && targetBounds && semanticLensSessionDetail(currentSession) === detail
    ? selectedEntityReframePlan({
        camera: currentCamera,
        bounds: targetBounds,
        viewport,
        safeArea,
      }).camera
    : semanticEntityFrameCamera(scene, target.id, detail, viewport, safeArea);
  if (!camera) return undefined;
  return { session, camera, targetId: target.id, detail, historyMode: 'replace' };
}

/**
 * Plans one explicit semantic drill without changing projection family/root.
 * The clicked owner must belong to the currently presented layer, so a
 * persistent ancestor shell cannot accidentally navigate back up the tree.
 */
export function semanticOpenNextLayer(
  scene: AtlasScene,
  session: SemanticLensSession,
  targetId: string,
  viewport: ViewportSize,
  safeArea: SafeArea,
  rootEntityId: string,
): SemanticOpenNextLayerPlan | undefined {
  if (session.active.phase !== 'idle' || session.focusTransfer) return undefined;
  const target = scene.entities.find(entity => entity.id === targetId);
  if (!target || session.settled.some(entry => entry.targetId === targetId)) return undefined;
  const ghost = semanticLensSessionGhostEntities(scene, session).find(candidate => candidate.id === targetId);
  const currentDetail = ghost?.detail ?? semanticLensSessionDetail(session);
  const currentIndex = semanticDetails.indexOf(currentDetail);
  const nextDetail = (ghost
    ? session.settled[ghost.depth]?.nextDetail
    : semanticDetails[currentIndex + 1]) as Exclude<SemanticDetail, 'context'> | undefined;
  if (!nextDetail || target.detail !== currentDetail) return undefined;
  const sourceBounds = semanticBounds(scene, targetId, currentDetail);
  const targetBounds = semanticBounds(scene, targetId, nextDetail);
  if (!sourceBounds || !targetBounds) return undefined;

  const targetIds = ghost
    ? [...session.settled.slice(0, ghost.depth).map(entry => entry.targetId), targetId]
    : [...session.settled.map(entry => entry.targetId), targetId];
  const validated = validateSemanticLensPath(scene, session.baseDetail, targetIds);
  const expectedLength = ghost ? ghost.depth + 1 : session.settled.length + 1;
  if (validated.truncated || validated.entries.length !== expectedLength) return undefined;
  const entry = validated.entries.at(-1);
  if (!entry || entry.targetId !== targetId || entry.currentDetail !== currentDetail || entry.nextDetail !== nextDetail) return undefined;

  const camera = semanticEntityFrameCamera(scene, targetId, nextDetail, viewport, safeArea);
  if (!camera) return undefined;

  return {
    session: ghost
      ? transferSemanticLensFocus(scene, session, { id: ghost.id, depth: ghost.depth })
      : { ...session, settled: validated.entries, active: idleSemanticLens() },
    camera,
    targetId,
    nextDetail,
    rootEntityId,
    historyMode: 'push',
  };
}
