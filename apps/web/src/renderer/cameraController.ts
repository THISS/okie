import type { Camera } from './types';
import { clampAtlasCameraZoom } from './cameraBounds';

type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

type TimerApi = {
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

export type CameraPublisher = {
  schedule(camera: Camera): void;
  flush(): Camera | undefined;
  cancel(): void;
};

export function panCamera(camera: Camera, deltaX: number, deltaY: number): Camera {
  return {
    ...camera,
    x: camera.x - deltaX / camera.zoom,
    y: camera.y - deltaY / camera.zoom,
  };
}

export function zoomCameraAt(
  camera: Camera,
  screenX: number,
  screenY: number,
  viewport: { width: number; height: number },
  deltaY: number,
): Camera {
  const zoom = clampAtlasCameraZoom(camera.zoom * Math.exp(-deltaY * 0.0012));
  const offsetX = screenX - viewport.width / 2;
  const offsetY = screenY - viewport.height / 2;
  const worldX = camera.x + offsetX / camera.zoom;
  const worldY = camera.y + offsetY / camera.zoom;
  return {
    x: worldX - offsetX / zoom,
    y: worldY - offsetY / zoom,
    zoom,
  };
}

/**
 * A semantic zoom burst owns the raw camera until its assist frames finish.
 * Projection topology can return to `:base` before that bridge completes, so
 * it is not sufficient on its own to decide that a rendered camera is raw.
 */
export function shouldAdoptExternalCameraAsRaw(
  projectionOverrideId: string | undefined,
  semanticZoomBurstActive: boolean,
): boolean {
  return Boolean(projectionOverrideId?.endsWith(':base')) && !semanticZoomBurstActive;
}

type WorldPoint = { x: number; y: number };
type WorldBounds = WorldPoint & { width: number; height: number };

function center(bounds: WorldBounds): WorldPoint {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

export function zoomCameraAroundWorldAnchor(
  camera: Camera,
  worldAnchor: WorldPoint,
  zoom: number,
  viewport: { width: number; height: number },
): Camera {
  const screenX = viewport.width / 2 + (worldAnchor.x - camera.x) * camera.zoom;
  const screenY = viewport.height / 2 + (worldAnchor.y - camera.y) * camera.zoom;
  return {
    x: worldAnchor.x - (screenX - viewport.width / 2) / zoom,
    y: worldAnchor.y - (screenY - viewport.height / 2) / zoom,
    zoom,
  };
}

export function focusCameraPreservingAnchor(
  camera: Camera,
  previous: WorldBounds | undefined,
  target: WorldBounds,
  viewport: { width: number; height: number },
  minimumZoom = 0.82,
): Camera {
  const targetCenter = center(target);
  const zoom = Math.max(camera.zoom, minimumZoom);
  if (!previous) return { ...targetCenter, zoom };
  const previousCenter = center(previous);
  const anchorX = viewport.width / 2 + (previousCenter.x - camera.x) * camera.zoom;
  const anchorY = viewport.height / 2 + (previousCenter.y - camera.y) * camera.zoom;
  if (anchorX < 0 || anchorX > viewport.width || anchorY < 0 || anchorY > viewport.height) {
    return { ...targetCenter, zoom };
  }
  return {
    x: targetCenter.x - (anchorX - viewport.width / 2) / zoom,
    y: targetCenter.y - (anchorY - viewport.height / 2) / zoom,
    zoom,
  };
}

export function createCameraPublisher(
  publish: (camera: Camera) => void,
  delayMs = 80,
  timerApi: TimerApi = globalThis,
): CameraPublisher {
  let pending: Camera | undefined;
  let timer: TimerHandle | undefined;

  const cancelTimer = () => {
    if (timer === undefined) return;
    timerApi.clearTimeout(timer);
    timer = undefined;
  };

  const flush = () => {
    cancelTimer();
    if (!pending) return undefined;
    const camera = pending;
    pending = undefined;
    publish(camera);
    return camera;
  };

  return {
    schedule(camera) {
      pending = { ...camera };
      cancelTimer();
      timer = timerApi.setTimeout(flush, delayMs);
    },
    flush,
    cancel() {
      cancelTimer();
      pending = undefined;
    },
  };
}
