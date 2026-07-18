import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { AtlasScene, Camera, SemanticDetail } from './renderer/types';
import type { ViewportSize } from './storyFraming';
import { subscribeLiveCamera } from './liveCameraBridge';

export type MinimapPoint = { x: number; y: number };
export type MinimapRect = { x: number; y: number; width: number; height: number };
export type MinimapEntityRect = { detail: SemanticDetail; rect: MinimapRect };
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

/** L1 (context) + L2 (container) entity rects for the overview, in world coordinates. */
export function minimapEntityRects(scene: AtlasScene): MinimapEntityRect[] {
  return scene.entities
    .filter(entity => entity.detail === 'context' || entity.detail === 'container')
    .map(entity => ({
      detail: entity.detail as SemanticDetail,
      rect: { x: entity.x, y: entity.y, width: entity.width, height: entity.height },
    }));
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
  return { x: projected.x, y: projected.y, width: Math.max(2, projected.width), height: Math.max(2, projected.height) };
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
  project: MinimapProjector;
  inverse: MinimapInverseProjector;
  viewport: ViewportSize;
  camera: Camera;
  insetWidth: number;
  insetHeight: number;
};

/**
 * Overview inset: world bounds, simplified L1/L2 entity rectangles, and a viewport rectangle
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
export function Minimap({ scene, camera, viewport, insetWidth = 168, onPan }: {
  scene: AtlasScene;
  camera: Camera;
  viewport: ViewportSize;
  insetWidth?: number;
  onPan?: (camera: Camera, phase: MinimapPanPhase) => void;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewportRectRef = useRef<SVGRectElement | null>(null);
  const viewStateRef = useRef<MinimapViewState | null>(null);
  const dragRef = useRef<{ pointerId: number; offset: MinimapPoint } | null>(null);
  const [dragging, setDragging] = useState(false);

  const entityRects = minimapEntityRects(scene);
  const world = unionRect(entityRects.map(entry => entry.rect));
  const ready = !!world && world.width > 0 && world.height > 0;
  const insetHeight = ready ? Math.round(insetWidth * Math.min(1.3, Math.max(0.42, world!.height / world!.width))) : 0;
  const project = ready ? minimapProjector(world!, insetWidth, insetHeight) : null;
  // Keep the latest projection/camera available to the (once-subscribed) live-camera listener and
  // the pointer handlers without re-subscribing/rebinding on every render.
  viewStateRef.current = ready && project
    ? { project, inverse: minimapInverseProjector(world!, insetWidth, insetHeight), viewport, camera, insetWidth, insetHeight }
    : null;

  useEffect(() => subscribeLiveCamera(liveCamera => {
    const state = viewStateRef.current;
    const element = viewportRectRef.current;
    if (!state || !element) return;
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
    dragRef.current = { pointerId: event.pointerId, offset };
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
  const view = projectedViewportRect(camera, viewport, project);
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
        {entityRects.map((entry, index) => {
          const projected = project(entry.rect);
          return <rect className={`minimap-entity detail-${entry.detail}`} height={Math.max(1, projected.height)} key={index} rx={1.5} width={Math.max(1, projected.width)} x={projected.x} y={projected.y}/>;
        })}
        <rect className="minimap-viewport" height={view.height} ref={viewportRectRef} width={view.width} x={view.x} y={view.y}/>
      </svg>
    </div>
  );
}
