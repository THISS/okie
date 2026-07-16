import type { AtlasScene, Camera, SemanticDetail } from './renderer/types';
import type { ViewportSize } from './storyFraming';

export type MinimapRect = { x: number; y: number; width: number; height: number };
export type MinimapEntityRect = { detail: SemanticDetail; rect: MinimapRect };

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
export function minimapProjector(world: MinimapRect, insetWidth: number, insetHeight: number): (rect: MinimapRect) => MinimapRect {
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
 * Non-interactive overview inset: world bounds, simplified L1/L2 entity rectangles, and a live
 * viewport rectangle tracking the camera. Pure indicator — no pointer handlers, aria-hidden, and
 * it simply re-renders when `camera` changes (so it trivially respects reduced motion).
 */
export function Minimap({ scene, camera, viewport, insetWidth = 168 }: {
  scene: AtlasScene;
  camera: Camera;
  viewport: ViewportSize;
  insetWidth?: number;
}) {
  const entityRects = minimapEntityRects(scene);
  const world = unionRect(entityRects.map(entry => entry.rect));
  if (!world || world.width <= 0 || world.height <= 0) return null;

  const insetHeight = Math.round(insetWidth * Math.min(1.3, Math.max(0.42, world.height / world.width)));
  const project = minimapProjector(world, insetWidth, insetHeight);
  const view = project(worldViewportRect(camera, viewport));

  return (
    <div aria-hidden="true" className="minimap" data-testid="minimap">
      <svg height={insetHeight} viewBox={`0 0 ${insetWidth} ${insetHeight}`} width={insetWidth}>
        <rect className="minimap-world" height={insetHeight} width={insetWidth} x={0} y={0}/>
        {entityRects.map((entry, index) => {
          const projected = project(entry.rect);
          return <rect className={`minimap-entity detail-${entry.detail}`} height={Math.max(1, projected.height)} key={index} rx={1.5} width={Math.max(1, projected.width)} x={projected.x} y={projected.y}/>;
        })}
        <rect className="minimap-viewport" height={Math.max(2, view.height)} width={Math.max(2, view.width)} x={view.x} y={view.y}/>
      </svg>
    </div>
  );
}
