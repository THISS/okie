import type { Camera } from './renderer/types';

export type CameraFlightViewport = { width: number; height: number };

export type CameraFlight = {
  source: Camera;
  target: Camera;
  startedAtMs: number;
  durationMs: number;
};

export type CameraFlightSample = {
  camera: Camera;
  progress: number;
  easedProgress: number;
  arrived: boolean;
};

export type CameraFlightStart = {
  target: Camera;
  viewport: CameraFlightViewport;
  reducedMotion: boolean;
  transformCamera?: (sample: CameraFlightSample) => Camera;
  onUpdate?: (sample: CameraFlightSample) => void;
  onComplete: (camera: Camera) => void;
};

type FrameApi = {
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
  now(): number;
};

export type CameraFlightController = {
  start(input: CameraFlightStart): CameraFlight;
  cancel(): void;
  dispose(): void;
  isActive(): boolean;
};

/** React state can lag an imperative animation frame; never replace the live source mid-flight. */
export function reconcileRenderedCamera(
  liveCamera: Camera,
  reactCamera: Camera,
  flightActive: boolean,
) {
  return flightActive ? liveCamera : reactCamera;
}

export function easeCameraFlight(progress: number) {
  const value = Math.max(0, Math.min(1, progress));
  return value < .5 ? 4 * value ** 3 : 1 - (-2 * value + 2) ** 3 / 2;
}

export function cameraFlightDuration(source: Camera, target: Camera, viewport: CameraFlightViewport) {
  const centerDistance = Math.hypot(target.x - source.x, target.y - source.y);
  if (centerDistance * Math.min(source.zoom, target.zoom) <= .5
    && Math.abs(Math.log(target.zoom / source.zoom)) <= .001) return 0;
  const diagonal = Math.max(1, Math.hypot(viewport.width, viewport.height));
  const viewportDiagonals = centerDistance * Math.min(source.zoom, target.zoom) / diagonal;
  const zoomStops = Math.abs(Math.log2(target.zoom / source.zoom));
  return Math.round(Math.max(450, Math.min(
    650,
    450 + 120 * Math.min(1, viewportDiagonals) + 40 * Math.min(2, zoomStops),
  )));
}

export function createCameraFlight(
  source: Camera,
  target: Camera,
  viewport: CameraFlightViewport,
  startedAtMs: number,
): CameraFlight {
  return {
    source: { ...source },
    target: { ...target },
    startedAtMs,
    durationMs: cameraFlightDuration(source, target, viewport),
  };
}

export function sampleCameraFlight(flight: CameraFlight, nowMs: number): CameraFlightSample {
  const progress = flight.durationMs === 0
    ? 1
    : Math.max(0, Math.min(1, (nowMs - flight.startedAtMs) / flight.durationMs));
  const easedProgress = easeCameraFlight(progress);
  const sourceLogZoom = Math.log(flight.source.zoom);
  const targetLogZoom = Math.log(flight.target.zoom);
  return {
    camera: progress >= 1 ? { ...flight.target } : {
      x: flight.source.x + (flight.target.x - flight.source.x) * easedProgress,
      y: flight.source.y + (flight.target.y - flight.source.y) * easedProgress,
      zoom: Math.exp(sourceLogZoom + (targetLogZoom - sourceLogZoom) * easedProgress),
    },
    progress,
    easedProgress,
    arrived: progress >= 1,
  };
}

export function createCameraFlightController(
  readCamera: () => Camera,
  renderCamera: (camera: Camera) => void,
  frameApi: FrameApi = {
    requestFrame: callback => requestAnimationFrame(callback),
    cancelFrame: handle => cancelAnimationFrame(handle),
    now: () => performance.now(),
  },
): CameraFlightController {
  let frame: number | undefined;
  let generation = 0;
  let active = false;

  const cancelFrame = () => {
    if (frame !== undefined) frameApi.cancelFrame(frame);
    frame = undefined;
  };

  const cancel = () => {
    generation += 1;
    active = false;
    cancelFrame();
  };

  return {
    start(input) {
      cancel();
      const startedAtMs = frameApi.now();
      const flight = createCameraFlight(readCamera(), input.target, input.viewport, startedAtMs);
      const ownGeneration = generation;
      if (input.reducedMotion || flight.durationMs === 0) {
        const sampled = sampleCameraFlight({ ...flight, durationMs: 0 }, startedAtMs);
        const sample = input.transformCamera
          ? { ...sampled, camera: input.transformCamera(sampled) }
          : sampled;
        renderCamera(sample.camera);
        input.onUpdate?.(sample);
        input.onComplete({ ...input.target });
        return flight;
      }
      active = true;
      input.onUpdate?.(sampleCameraFlight(flight, startedAtMs));
      const tick = (nowMs: number) => {
        if (!active || generation !== ownGeneration) return;
        const sampled = sampleCameraFlight(flight, nowMs);
        const sample = input.transformCamera
          ? { ...sampled, camera: input.transformCamera(sampled) }
          : sampled;
        renderCamera(sample.camera);
        input.onUpdate?.(sample);
        if (sample.arrived) {
          active = false;
          frame = undefined;
          input.onComplete({ ...flight.target });
          return;
        }
        frame = frameApi.requestFrame(tick);
      };
      frame = frameApi.requestFrame(tick);
      return flight;
    },
    cancel,
    dispose: cancel,
    isActive: () => active,
  };
}
