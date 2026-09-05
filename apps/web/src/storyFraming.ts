import type { AtlasScene, Camera, SemanticDetail } from './renderer/types';
import { ATLAS_CAMERA_BOUNDS } from './renderer/cameraBounds';

export type ViewportSize = { width: number; height: number };
export type SafeArea = { top: number; right: number; bottom: number; left: number };
export type MeasuredRect = { top: number; right: number; bottom: number; left: number };
export type StorySafeAreaEdge = 'top' | 'right' | 'bottom' | 'left';
export type StorySafeAreaOverlay = { rect: MeasuredRect; edge?: StorySafeAreaEdge };
export type StorySafeAreaMeasurements = {
  canvas: MeasuredRect;
  overlays?: readonly StorySafeAreaOverlay[];
  topOverlays?: readonly MeasuredRect[];
  rightOverlays?: readonly MeasuredRect[];
  bottomOverlays?: readonly MeasuredRect[];
  leftOverlays?: readonly MeasuredRect[];
  visualViewport?: { offsetTop: number; offsetLeft: number; width: number; height: number };
  safeInsets?: Partial<SafeArea>;
  overlayMargin?: number;
};

export type FrameEntitiesOptions = {
  screenPadding?: number;
  minZoom?: number;
  maxZoom?: number;
  /**
   * When minZoom forces the frame past layout-fit, `start` pins the bounds'
   * top-left to the padded safe origin so card headers stay on-screen.
   * Default keeps the historical centered crop.
   */
  overflowAlign?: 'center' | 'start';
};

export type FrameSemanticEntitiesOptions = FrameEntitiesOptions & {
  /** Lets an explicit deep owner use the camera range above its authored rail preset. */
  allowFocusRunway?: boolean;
};

const minimumViewport = 1;
const minimumUsableStoryViewport = 80;

export function classifyStoryOverlayEdge(rect: MeasuredRect, canvas: MeasuredRect): StorySafeAreaEdge {
  const horizontal = rect.right - rect.left >= rect.bottom - rect.top;
  const distances: Array<[StorySafeAreaEdge, number]> = horizontal
    ? [
        ['top', Math.abs(rect.top - canvas.top)],
        ['bottom', Math.abs(canvas.bottom - rect.bottom)],
      ]
    : [
        ['right', Math.abs(canvas.right - rect.right)],
        ['left', Math.abs(rect.left - canvas.left)],
      ];
  distances.sort((a, b) => a[1] - b[1]);
  return distances[0][0];
}

function constrainSafeAreaAxis(start: number, end: number, size: number) {
  const normalizedStart = Math.max(0, start);
  const normalizedEnd = Math.max(0, end);
  const budget = Math.max(0, size - Math.min(size, minimumUsableStoryViewport));
  const requested = normalizedStart + normalizedEnd;
  if (requested <= budget || requested === 0) return [normalizedStart, normalizedEnd] as const;
  const scale = budget / requested;
  const constrainedStart = normalizedStart * scale;
  return [constrainedStart, budget - constrainedStart] as const;
}

export function storySafeArea(viewport: ViewportSize): SafeArea {
  const mobile = viewport.width <= 780;
  return mobile
    ? { top: 84, right: 18, bottom: 286, left: 58 }
    : { top: 102, right: 66, bottom: 250, left: 82 };
}

export function measuredStorySafeArea(
  viewport: ViewportSize,
  measurements: StorySafeAreaMeasurements,
): SafeArea {
  const margin = measurements.overlayMargin ?? (viewport.width <= 780 ? 24 : 42);
  const { canvas } = measurements;
  const intersectsCanvas = (rect: MeasuredRect) => rect.right > canvas.left
    && rect.left < canvas.right
    && rect.bottom > canvas.top
    && rect.top < canvas.bottom;
  const maximum = (values: number[]) => values.length ? Math.max(...values) : 0;
  const safe = measurements.safeInsets ?? {};
  const classifiedOverlays = (measurements.overlays ?? []).map(overlay => ({
    rect: overlay.rect,
    edge: overlay.edge ?? classifyStoryOverlayEdge(overlay.rect, canvas),
  }));
  const overlaysAt = (edge: StorySafeAreaEdge) => classifiedOverlays
    .filter(overlay => overlay.edge === edge)
    .map(overlay => overlay.rect);
  const visual = measurements.visualViewport;
  const visualTop = visual ? Math.max(0, visual.offsetTop - canvas.top) : 0;
  const visualLeft = visual ? Math.max(0, visual.offsetLeft - canvas.left) : 0;
  const visualRight = visual ? Math.max(0, canvas.right - (visual.offsetLeft + visual.width)) : 0;
  const visualBottom = visual ? Math.max(0, canvas.bottom - (visual.offsetTop + visual.height)) : 0;
  const raw = {
    top: maximum([
      safe.top ?? 0,
      visualTop,
      ...[...(measurements.topOverlays ?? []), ...overlaysAt('top')].filter(intersectsCanvas).map(rect => rect.bottom - canvas.top + margin),
    ]),
    right: maximum([
      safe.right ?? 0,
      visualRight,
      ...[...(measurements.rightOverlays ?? []), ...overlaysAt('right')].filter(intersectsCanvas).map(rect => canvas.right - rect.left + margin),
    ]),
    bottom: maximum([
      safe.bottom ?? 0,
      visualBottom,
      ...[...(measurements.bottomOverlays ?? []), ...overlaysAt('bottom')].filter(intersectsCanvas).map(rect => canvas.bottom - rect.top + margin),
    ]),
    left: maximum([
      safe.left ?? 0,
      visualLeft,
      ...[...(measurements.leftOverlays ?? []), ...overlaysAt('left')].filter(intersectsCanvas).map(rect => rect.right - canvas.left + margin),
    ]),
  };
  const [left, right] = constrainSafeAreaAxis(raw.left, raw.right, Math.max(0, canvas.right - canvas.left));
  const [top, bottom] = constrainSafeAreaAxis(raw.top, raw.bottom, Math.max(0, canvas.bottom - canvas.top));
  return { top, right, bottom, left };
}

export function frameEntities(
  scene: AtlasScene,
  entityIds: readonly string[],
  viewport: ViewportSize,
  safeArea = storySafeArea(viewport),
  options: FrameEntitiesOptions = {},
): Camera | undefined {
  const entities = entityIds
    .map(id => scene.entities.find(entity => entity.id === id))
    .filter((entity): entity is AtlasScene['entities'][number] => entity !== undefined);
  if (!entities.length) return undefined;

  const viewportWidth = Math.max(minimumViewport, viewport.width);
  const viewportHeight = Math.max(minimumViewport, viewport.height);
  const safeWidth = Math.max(80, viewportWidth - safeArea.left - safeArea.right);
  const safeHeight = Math.max(80, viewportHeight - safeArea.top - safeArea.bottom);
  const left = Math.min(...entities.map(entity => entity.x));
  const top = Math.min(...entities.map(entity => entity.y));
  const right = Math.max(...entities.map(entity => entity.x + entity.width));
  const bottom = Math.max(...entities.map(entity => entity.y + entity.height));
  const boundsWidth = Math.max(1, right - left);
  const boundsHeight = Math.max(1, bottom - top);
  const screenPadding = options.screenPadding ?? (viewportWidth <= 780 ? 24 : 42);
  const minZoom = Math.max(ATLAS_CAMERA_BOUNDS.minZoom, options.minZoom ?? ATLAS_CAMERA_BOUNDS.minZoom);
  const maxZoom = Math.min(ATLAS_CAMERA_BOUNDS.maxZoom, options.maxZoom ?? 1.24);
  const widthFit = (safeWidth - screenPadding * 2) / boundsWidth;
  const heightFit = (safeHeight - screenPadding * 2) / boundsHeight;
  const zoom = Math.min(
    maxZoom,
    Math.max(minZoom, widthFit),
    Math.max(minZoom, heightFit),
  );
  const contentLeft = safeArea.left + screenPadding;
  const contentTop = safeArea.top + screenPadding;
  const contentWidth = safeWidth - screenPadding * 2;
  const contentHeight = safeHeight - screenPadding * 2;
  const overflowX = boundsWidth * zoom > contentWidth + 0.5;
  const overflowY = boundsHeight * zoom > contentHeight + 0.5;
  const pinStart = options.overflowAlign === 'start';
  const safeCenterX = safeArea.left + safeWidth / 2;
  const safeCenterY = safeArea.top + safeHeight / 2;
  const worldCenterX = left + boundsWidth / 2;
  const worldCenterY = top + boundsHeight / 2;
  const anchorWorldX = pinStart && overflowX ? left : worldCenterX;
  const anchorWorldY = pinStart && overflowY ? top : worldCenterY;
  const anchorScreenX = pinStart && overflowX ? contentLeft : safeCenterX;
  const anchorScreenY = pinStart && overflowY ? contentTop : safeCenterY;

  return {
    x: anchorWorldX - (anchorScreenX - viewportWidth / 2) / zoom,
    y: anchorWorldY - (anchorScreenY - viewportHeight / 2) / zoom,
    zoom,
  };
}

/**
 * Frames authored bounds from one semantic representation instead of the
 * entities' default band. Story steps use the focus ceiling; explicit L4 owner
 * navigation can opt into the remaining camera runway.
 */
export function frameSemanticEntities(
  scene: AtlasScene,
  entityIds: readonly string[],
  detail: SemanticDetail,
  viewport: ViewportSize,
  safeArea = storySafeArea(viewport),
  options: FrameSemanticEntitiesOptions = {},
): Camera | undefined {
  const projection = scene.projection;
  const band = projection?.zoomPolicy?.bands.find(candidate => candidate.detail === detail);
  if (!projection || !band) return undefined;
  const ids = new Set(entityIds);
  const entities = scene.entities.flatMap(entity => {
    if (!ids.has(entity.id)) return [];
    const bounds = projection.boundsByEntityIdAndDetail[entity.id]?.[detail];
    return bounds ? [{ ...entity, ...bounds }] : [];
  });
  if (!entities.length) return undefined;
  const viewMinZoom = projection.zoomPolicy?.minZoom ?? ATLAS_CAMERA_BOUNDS.minZoom;
  const viewMaxZoom = projection.zoomPolicy?.maxZoom ?? ATLAS_CAMERA_BOUNDS.maxZoom;
  const fullBandZoom = Math.min(viewMaxZoom, band.enterZoom + band.fadeWidth);
  const focusZoom = Math.min(viewMaxZoom, Math.max(fullBandZoom, band.focusZoom));
  return frameEntities(
    { ...scene, entities },
    entityIds,
    viewport,
    safeArea,
    {
      ...options,
      minZoom: Math.max(viewMinZoom, options.minZoom ?? fullBandZoom),
      maxZoom: Math.min(
        viewMaxZoom,
        options.maxZoom ?? (options.allowFocusRunway ? viewMaxZoom : focusZoom),
      ),
    },
  );
}

/** Keeps an overview readable when fitting every related context object would zoom too far out. */
export function readableRootCamera(
  fitted: Camera,
  rootBounds: { x: number; y: number; width: number; height: number },
  focusZoom: number,
  viewport: ViewportSize,
  safeArea: SafeArea,
): Camera {
  const zoom = Math.min(ATLAS_CAMERA_BOUNDS.maxZoom, Math.max(ATLAS_CAMERA_BOUNDS.minZoom, focusZoom));
  if (fitted.zoom >= zoom) return fitted;
  const safeWidth = Math.max(80, viewport.width - safeArea.left - safeArea.right);
  const safeHeight = Math.max(80, viewport.height - safeArea.top - safeArea.bottom);
  const safeCenterX = safeArea.left + safeWidth / 2;
  const safeCenterY = safeArea.top + safeHeight / 2;
  return {
    x: rootBounds.x + rootBounds.width / 2 - (safeCenterX - viewport.width / 2) / zoom,
    y: rootBounds.y + rootBounds.height / 2 - (safeCenterY - viewport.height / 2) / zoom,
    zoom,
  };
}

export function worldToScreen(x: number, y: number, camera: Camera, viewport: ViewportSize) {
  return {
    x: viewport.width / 2 + (x - camera.x) * camera.zoom,
    y: viewport.height / 2 + (y - camera.y) * camera.zoom,
  };
}
