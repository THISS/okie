import { COVERAGE_REVEAL } from '@okie/scene-compiler';
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
): Camera | undefined {
  const wanted = new Set(entityIds);
  const entities = scene.entities.flatMap(entity => {
    const bounds = scene.projection?.boundsByEntityIdAndDetail[entity.id]?.[detail];
    return wanted.has(entity.id) && bounds ? [{ ...entity, ...bounds }] : [];
  });
  if (!entities.length) return undefined;
  return frameEntities({ ...scene, entities }, entityIds, viewport, safeArea, {
    screenPadding: 24,
    minZoom,
    maxZoom,
  });
}

/**
 * Frames the entities currently painted at this C4 band (the visible projection),
 * not the root entity's full descendant scope. Fit uses this; load/open-inside keep
 * `frameProjectionScope` so CLA-11 unsolicited refit behavior stays unchanged.
 */
export function frameVisibleProjection(
  scene: AtlasScene,
  entityIds: readonly string[],
  detail: SemanticDetail,
  viewport: ViewportSize,
  safeArea: SafeArea,
): Camera | undefined {
  const { minZoom, maxZoom } = dominantBandZoomRange(detail);
  return frameEntityIdsAtDetail(scene, entityIds, detail, viewport, safeArea, minZoom, maxZoom);
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
