import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { AtlasScene, Camera, ProjectionOverride, SemanticDetail } from './renderer/types';
import type { ViewportSize } from './storyFraming';
import { subscribeLiveCamera, type LiveCameraFrame } from './liveCameraBridge';
import { C4_ZOOM_BANDS } from '@okie/scene-compiler';
import { minimapEntityRects, minimapWorldRect, type MinimapRect } from './minimapGeometry';
export { minimapEntityRects } from './minimapGeometry';
export type { MinimapRect, MinimapEntityRect } from './minimapGeometry';

export type MinimapPoint = { x: number; y: number };
export type MinimapProjector = (rect: MinimapRect) => MinimapRect;
export type MinimapInverseProjector = (point: MinimapPoint) => MinimapPoint;
/** `start` arms the drag (cancels flights/story), `move` streams the live camera, `settle` commits it. */
export type MinimapPanPhase = 'start' | 'move' | 'settle';

/**
 * World-space rectangle currently visible for `camera` in a `viewport`-sized surface. The map
 * convention (shared with renderer/cameraController + Canvas2DRenderer) centres the camera:
 * screen centre maps to (camera.x, camera.y) and one world unit spans `camera.zoom` px.
 */
export function worldViewportRect(camera: Camera, viewport: ViewportSize): MinimapRect {
  const width = viewport.width / camera.zoom;
  const height = viewport.height / camera.zoom;
  return { x: camera.x - width / 2, y: camera.y - height / 2, width, height };
}

/** Axis-aligned union of `rects`; undefined for an empty list. */
export function unionRect(rects: readonly MinimapRect[]): MinimapRect | undefined {
  if (!rects.length) return undefined;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Uniform world→inset projection that fits `world` inside `insetWidth`×`insetHeight`, centred. */
export function minimapProjector(world: MinimapRect, insetWidth: number, insetHeight: number): MinimapProjector {
  const scale = Math.min(insetWidth / world.width, insetHeight / world.height);
  const offsetX = (insetWidth - world.width * scale) / 2;
  const offsetY = (insetHeight - world.height * scale) / 2;
  return rect => ({
    x: offsetX + (rect.x - world.x) * scale,
    y: offsetY + (rect.y - world.y) * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  });
}

/**
 * Exact inverse of `minimapProjector` for a point: inset (px) → world coordinates. Pure so the
 * drag-to-pan math round-trips against the forward projection under test.
 */
export function minimapInverseProjector(world: MinimapRect, insetWidth: number, insetHeight: number): MinimapInverseProjector {
  const scale = Math.min(insetWidth / world.width, insetHeight / world.height);
  const offsetX = (insetWidth - world.width * scale) / 2;
  const offsetY = (insetHeight - world.height * scale) / 2;
  return point => ({
    x: world.x + (point.x - offsetX) / scale,
    y: world.y + (point.y - offsetY) / scale,
  });
}

/**
 * Inset-space viewport rectangle for `camera`, floored to a visible minimum size. Pure and
 * projector-injectable so the live-update path is unit-testable with mid-gesture cameras.
 */
export function projectedViewportRect(camera: Camera, viewport: ViewportSize, project: MinimapProjector): MinimapRect {
  const projected = project(worldViewportRect(camera, viewport));
  const width = Math.max(2, projected.width);
  const height = Math.max(2, projected.height);
  return {
    x: projected.x + (projected.width - width) / 2,
    y: projected.y + (projected.height - height) / 2,
    width,
    height,
  };
}

/**
 * Maps client (screen) coordinates into inset coordinates for `bounds` (the inset's DOM box),
 * correcting for any CSS scaling between the SVG box and its `insetWidth`×`insetHeight` viewBox.
 * Returns undefined for a degenerate (zero-area) box.
 */
export function minimapInsetPoint(
  client: MinimapPoint,
  bounds: { left: number; top: number; width: number; height: number },
  insetWidth: number,
  insetHeight: number,
): MinimapPoint | undefined {
  if (bounds.width <= 0 || bounds.height <= 0) return undefined;
  return {
    x: (client.x - bounds.left) * (insetWidth / bounds.width),
    y: (client.y - bounds.top) * (insetHeight / bounds.height),
  };
}

/**
 * Grab plan for a pointer-down at `point` (inset coords): whether it landed on the current viewport
 * rectangle and, if so, the inset offset between the pointer and the rect centre so a drag keeps the
 * box anchored under the cursor. A miss recentres — zero offset — which is the click-to-centre case.
 */
export function minimapGrabOffset(
  point: MinimapPoint,
  camera: Camera,
  viewport: ViewportSize,
  project: MinimapProjector,
): { inside: boolean; offset: MinimapPoint } {
  const centre = project({ x: camera.x, y: camera.y, width: 0, height: 0 });
  const view = projectedViewportRect(camera, viewport, project);
  const inside = point.x >= view.x && point.x <= view.x + view.width && point.y >= view.y && point.y <= view.y + view.height;
  return inside ? { inside, offset: { x: point.x - centre.x, y: point.y - centre.y } } : { inside, offset: { x: 0, y: 0 } };
}

/**
 * Camera whose centre places the viewport box at `point − offset` in the inset. Zoom is carried
 * through untouched — a minimap drag pans only. Pure: this is the single source of drag/click math.
 */
export function minimapPanCamera(
  inverse: MinimapInverseProjector,
  point: MinimapPoint,
  offset: MinimapPoint,
  zoom: number,
): Camera {
  const centre = inverse({ x: point.x - offset.x, y: point.y - offset.y });
  return { x: centre.x, y: centre.y, zoom };
}

type MinimapViewState = {
  world: MinimapRect;
  project: MinimapProjector;
  inverse: MinimapInverseProjector;
  viewport: ViewportSize;
  camera: Camera;
  insetWidth: number;
  insetHeight: number;
};

/**
 * Overview inset: smoothly fitted scope bounds, the current semantic projection, and a viewport rectangle
 * tracking the camera. Interactive when `onPan` is supplied — drag the viewport box to pan the main
 * camera (zoom unchanged), or click elsewhere on the inset to centre there. The camera write is
 * owned by the caller: this component only translates pointer geometry into a target camera and a
 * lifecycle phase, so flight/story cancellation, bounds and URL semantics stay on the canvas path.
 *
 * The viewport rectangle tracks the camera IN REAL TIME during continuous gestures: React `camera`
 * state only updates on the throttled/settled publisher, so the rect subscribes to the per-frame
 * `liveCameraBridge` and updates its SVG attributes imperatively — no App/minimap re-render 60×/sec.
 * The React-rendered rect (from the `camera` prop) covers the settled state and the initial paint.
 */
export function Minimap({ scene, camera, viewport, projectionOverride, activeDetail = 'context', reduceMotion = false, insetWidth = 168, onPan }: {
  scene: AtlasScene;
  projectionOverride?: ProjectionOverride;
  activeDetail?: SemanticDetail;
  reduceMotion?: boolean;
  camera: Camera;
  viewport: ViewportSize;
  insetWidth?: number;
  onPan?: (camera: Camera, phase: MinimapPanPhase) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const entityElementsRef = useRef(new Map<string, SVGRectElement>());
  const paintedEntityIdsRef = useRef(new Set<string>());
  const liveCameraRef = useRef(camera);
  const lastCameraPropRef = useRef(camera);
  const liveDetailRef = useRef(activeDetail);
  const paintedFrameRef = useRef<{ frame: LiveCameraFrame; detail: SemanticDetail } | null>(null);
  // React can refresh the SVG from settled props; the next rendered frame reasserts live geometry.
  paintedFrameRef.current = null;
  if (lastCameraPropRef.current !== camera) {
    liveCameraRef.current = camera;
    lastCameraPropRef.current = camera;
  }
  const viewportRectRef = useRef<SVGRectElement | null>(null);
  const viewStateRef = useRef<MinimapViewState | null>(null);
  const dragRef = useRef<{ pointerId: number; offset: MinimapPoint; world: MinimapRect } | null>(null);
  const [dragging, setDragging] = useState(false);

  const entityRects = minimapEntityRects(scene, projectionOverride, activeDetail, reduceMotion);
  const entityRectsById = new Map(entityRects.map(entry => [entry.id, entry]));
  paintedEntityIdsRef.current = new Set(entityRects.map(entry => entry.id!));
  const scopeWorld = useMemo(() => minimapWorldRect(scene, projectionOverride, activeDetail, reduceMotion), [scene, projectionOverride, activeDetail, reduceMotion]);
  const world = dragRef.current?.world ?? scopeWorld;
  const residentIds = useMemo(() => {
    if (!scene.projection) return minimapEntityRects(scene).map(entry => entry.id!);
    const ids = new Set(projectionOverride
      ? scene.projection.entityIdsByDetail[activeDetail]
      : Object.values(scene.projection.entityIdsByDetail).flat());
    for (const object of projectionOverride?.objects ?? []) ids.add(scene.projection.visualToSemanticEntityId[object.objectId] ?? object.objectId);
    return [...ids];
  }, [scene, projectionOverride, activeDetail]);
  const ready = !!world && world.width > 0 && world.height > 0;
  const insetHeight = Math.round(insetWidth * .65);
  const project = ready ? minimapProjector(world!, insetWidth, insetHeight) : null;
  // Keep the latest projection/camera available to the (once-subscribed) live-camera listener and
  // the pointer handlers without re-subscribing/rebinding on every render.
  viewStateRef.current = ready && project
    ? { world: world!, project, inverse: minimapInverseProjector(world!, insetWidth, insetHeight), viewport, camera: liveCameraRef.current, insetWidth, insetHeight }
    : null;

  useEffect(() => subscribeLiveCamera((liveCamera, frame) => {
    const state = viewStateRef.current;
    const element = viewportRectRef.current;
    if (!state || !element) return;
    liveCameraRef.current = liveCamera;
    state.camera = liveCamera;
    if (frame) {
      const order: SemanticDetail[] = ['context', 'container', 'component', 'code'];
      let detailIndex = order.indexOf(liveDetailRef.current);
      const band = (index: number) => frame.scene.projection?.zoomPolicy?.bands?.find(candidate => candidate.detail === order[index])
        ?? C4_ZOOM_BANDS.find(candidate => candidate.detail === order[index])!;
      while (detailIndex < 3 && liveCamera.zoom >= band(detailIndex + 1).enterZoom + band(detailIndex + 1).hysteresis) detailIndex++;
      while (detailIndex > 0 && liveCamera.zoom < band(detailIndex).enterZoom - band(detailIndex).hysteresis) detailIndex--;
      liveDetailRef.current = order[detailIndex]!;
      const previous = paintedFrameRef.current;
      if (!previous || previous.frame.scene !== frame.scene || previous.frame.projectionOverride !== frame.projectionOverride
        || previous.frame.reduceMotion !== frame.reduceMotion || previous.detail !== liveDetailRef.current) {
        const liveWorld = dragRef.current?.world ?? minimapWorldRect(frame.scene, frame.projectionOverride, liveDetailRef.current, frame.reduceMotion);
        if (liveWorld && liveWorld.width > 0 && liveWorld.height > 0) {
          state.world = liveWorld;
          state.project = minimapProjector(liveWorld, state.insetWidth, state.insetHeight);
          state.inverse = minimapInverseProjector(liveWorld, state.insetWidth, state.insetHeight);
        }
        const geometry = minimapEntityRects(frame.scene, frame.projectionOverride, liveDetailRef.current, frame.reduceMotion);
        const visibleIds = new Set(geometry.map(entry => entry.id!));
        for (const id of paintedEntityIdsRef.current) {
          if (!visibleIds.has(id)) entityElementsRef.current.get(id)?.setAttribute('visibility', 'hidden');
        }
        paintedEntityIdsRef.current = visibleIds;
        for (const entry of geometry) {
          const element = entry.id && entityElementsRef.current.get(entry.id);
          if (!element) continue;
          const projected = state.project(entry.rect);
          element.setAttribute('visibility', 'visible');
          element.setAttribute('class', `minimap-entity detail-${entry.detail}`);
          element.setAttribute('opacity', String(entry.opacity ?? 1));
          element.setAttribute('x', String(projected.x));
          element.setAttribute('y', String(projected.y));
          element.setAttribute('width', String(Math.max(1, projected.width)));
          element.setAttribute('height', String(Math.max(1, projected.height)));
        }
        paintedFrameRef.current = { frame, detail: liveDetailRef.current };
      }
    }
    const rect = projectedViewportRect(liveCamera, state.viewport, state.project);
    element.setAttribute('x', String(rect.x));
    element.setAttribute('y', String(rect.y));
    element.setAttribute('width', String(rect.width));
    element.setAttribute('height', String(rect.height));
  }), []);

  function insetPointFromEvent(event: ReactPointerEvent): MinimapPoint | undefined {
    const svg = svgRef.current;
    const state = viewStateRef.current;
    if (!svg || !state) return undefined;
    return minimapInsetPoint({ x: event.clientX, y: event.clientY }, svg.getBoundingClientRect(), state.insetWidth, state.insetHeight);
  }

  function handlePointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    const state = viewStateRef.current;
    if (!onPan || !state || event.button !== 0) return;
    const point = insetPointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    svgRef.current?.setPointerCapture(event.pointerId);
    const { inside, offset } = minimapGrabOffset(point, state.camera, state.viewport, state.project);
    dragRef.current = { pointerId: event.pointerId, offset, world: state.world };
    setDragging(true);
    // Grabbing the box holds position (interrupt only); a miss recentres on the pointer.
    const next = inside ? state.camera : minimapPanCamera(state.inverse, point, offset, state.camera.zoom);
    onPan(next, 'start');
  }

  function handlePointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    const state = viewStateRef.current;
    if (!onPan || !drag || drag.pointerId !== event.pointerId || !state) return;
    const point = insetPointFromEvent(event);
    if (!point) return;
    onPan(minimapPanCamera(state.inverse, point, drag.offset, state.camera.zoom), 'move');
  }

  function endDrag(event: ReactPointerEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    try { svgRef.current?.releasePointerCapture(event.pointerId); } catch { /* capture already released */ }
    const state = viewStateRef.current;
    if (!onPan || !state) return;
    const point = insetPointFromEvent(event);
    const next = point ? minimapPanCamera(state.inverse, point, drag.offset, state.camera.zoom) : state.camera;
    onPan(next, 'settle');
  }

  if (!ready || !project) return null;
  const view = projectedViewportRect(liveCameraRef.current, viewport, project);
  const interactive = !!onPan;

  return (
    <div className={`minimap${dragging ? ' minimap-dragging' : ''}`} data-testid="minimap">
      <svg
        aria-label={interactive ? 'Map overview — drag to pan' : undefined}
        aria-hidden={interactive ? undefined : true}
        data-testid="minimap-inset"
        height={insetHeight}
        onPointerCancel={interactive ? endDrag : undefined}
        onPointerDown={interactive ? handlePointerDown : undefined}
        onPointerMove={interactive ? handlePointerMove : undefined}
        onPointerUp={interactive ? endDrag : undefined}
        ref={svgRef}
        role={interactive ? 'img' : undefined}
        viewBox={`0 0 ${insetWidth} ${insetHeight}`}
        width={insetWidth}
      >
        <rect className="minimap-world" height={insetHeight} width={insetWidth} x={0} y={0}/>
        {residentIds.map(id => {
          const entry = entityRectsById.get(id);
          const projected = entry ? project(entry.rect) : { x: 0, y: 0, width: 0, height: 0 };
          return <rect className={`minimap-entity detail-${entry?.detail ?? 'context'}`} data-entity-id={id} height={Math.max(1, projected.height)} key={id} opacity={entry?.opacity ?? 1} ref={element => { if (element) entityElementsRef.current.set(id, element); else entityElementsRef.current.delete(id); }} rx={1.5} visibility={entry ? 'visible' : 'hidden'} width={Math.max(1, projected.width)} x={projected.x} y={projected.y}/>;
        })}
        <rect className="minimap-viewport" height={view.height} ref={viewportRectRef} width={view.width} x={view.x} y={view.y}/>
      </svg>
    </div>
  );
}
