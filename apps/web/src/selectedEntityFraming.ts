import type { Camera } from './renderer/types';
import type { SafeArea, ViewportSize } from './storyFraming';

export type EntityBounds = { x: number; y: number; width: number; height: number };
export type ScreenRect = { left: number; top: number; right: number; bottom: number };

export type SelectedEntityReframeOptions = {
  camera: Camera;
  bounds: EntityBounds;
  viewport: ViewportSize;
  safeArea: SafeArea;
  padding?: number;
  /** Reframe on any clipping by default. */
  minimumVisibleRatio?: number;
  /** Centers the entity instead of applying the smallest containing translation. */
  forceCenter?: boolean;
};

export type SelectedEntityReframePlan = {
  camera: Camera;
  previousVisibleRatio: number;
  nextVisibleRatio: number;
  reframed: boolean;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function usableSafeRect(viewport: ViewportSize, safeArea: SafeArea, padding: number): ScreenRect {
  const left = clamp(safeArea.left + padding, 0, viewport.width);
  const right = clamp(viewport.width - safeArea.right - padding, 0, viewport.width);
  const top = clamp(safeArea.top + padding, 0, viewport.height);
  const bottom = clamp(viewport.height - safeArea.bottom - padding, 0, viewport.height);
  if (right >= left && bottom >= top) return { left, right, top, bottom };
  const centerX = clamp((left + right) / 2, 0, viewport.width);
  const centerY = clamp((top + bottom) / 2, 0, viewport.height);
  return { left: centerX, right: centerX, top: centerY, bottom: centerY };
}

export function entityScreenRect(
  bounds: EntityBounds,
  camera: Camera,
  viewport: ViewportSize,
): ScreenRect {
  const left = viewport.width / 2 + (bounds.x - camera.x) * camera.zoom;
  const top = viewport.height / 2 + (bounds.y - camera.y) * camera.zoom;
  return {
    left,
    top,
    right: left + bounds.width * camera.zoom,
    bottom: top + bounds.height * camera.zoom,
  };
}

export function entityVisibleRatio(entity: ScreenRect, safe: ScreenRect): number {
  const width = Math.max(0, entity.right - entity.left);
  const height = Math.max(0, entity.bottom - entity.top);
  if (width === 0 || height === 0) return 0;
  const visibleWidth = Math.max(0, Math.min(entity.right, safe.right) - Math.max(entity.left, safe.left));
  const visibleHeight = Math.max(0, Math.min(entity.bottom, safe.bottom) - Math.max(entity.top, safe.top));
  return clamp(visibleWidth * visibleHeight / (width * height), 0, 1);
}

function containingShift(minimum: number, maximum: number, safeMinimum: number, safeMaximum: number): number {
  if (maximum - minimum > safeMaximum - safeMinimum) {
    return (safeMinimum + safeMaximum - minimum - maximum) / 2;
  }
  if (minimum < safeMinimum) return safeMinimum - minimum;
  if (maximum > safeMaximum) return safeMaximum - maximum;
  return 0;
}

/**
 * Plans a zoom-preserving camera translation after inspector geometry changes.
 * Normal reframes use the smallest translation that fully contains the selected
 * entity, avoiding a disruptive recentering jump. Oversized entities are
 * centered on the usable safe viewport.
 */
export function selectedEntityReframePlan(options: SelectedEntityReframeOptions): SelectedEntityReframePlan {
  const padding = Math.max(0, options.padding ?? 24);
  const minimumVisibleRatio = clamp(options.minimumVisibleRatio ?? 1, 0, 1);
  const safe = usableSafeRect(options.viewport, options.safeArea, padding);
  const entity = entityScreenRect(options.bounds, options.camera, options.viewport);
  const previousVisibleRatio = entityVisibleRatio(entity, safe);
  if (!options.forceCenter && previousVisibleRatio + 1e-9 >= minimumVisibleRatio) {
    return { camera: options.camera, previousVisibleRatio, nextVisibleRatio: previousVisibleRatio, reframed: false };
  }

  const safeCenterX = (safe.left + safe.right) / 2;
  const safeCenterY = (safe.top + safe.bottom) / 2;
  const entityCenterX = (entity.left + entity.right) / 2;
  const entityCenterY = (entity.top + entity.bottom) / 2;
  const shiftX = options.forceCenter
    ? safeCenterX - entityCenterX
    : containingShift(entity.left, entity.right, safe.left, safe.right);
  const shiftY = options.forceCenter
    ? safeCenterY - entityCenterY
    : containingShift(entity.top, entity.bottom, safe.top, safe.bottom);
  if (shiftX === 0 && shiftY === 0) {
    return { camera: options.camera, previousVisibleRatio, nextVisibleRatio: previousVisibleRatio, reframed: false };
  }

  const camera = {
    x: options.camera.x - shiftX / options.camera.zoom,
    y: options.camera.y - shiftY / options.camera.zoom,
    zoom: options.camera.zoom,
  };
  const nextVisibleRatio = entityVisibleRatio(entityScreenRect(options.bounds, camera, options.viewport), safe);
  return { camera, previousVisibleRatio, nextVisibleRatio, reframed: true };
}
