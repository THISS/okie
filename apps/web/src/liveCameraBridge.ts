import type { Camera } from './renderer/types';

/**
 * Per-frame camera bridge.
 *
 * The canvas renders every frame from CanvasViewport's internal `liveCameraRef`, but React
 * `camera` state only updates on the throttled/settled publisher (per the renderer contract in
 * docs/architecture/renderer.md — Rust emits only low-frequency settled events). Anything outside
 * the render loop that must track the camera in real time (the minimap viewport rectangle) would
 * otherwise lag until the gesture settles.
 *
 * This is a deliberately tiny synchronous pub/sub so the render loop can hand the just-rendered
 * camera to imperative subscribers WITHOUT waking React 60×/sec. There is exactly one
 * CanvasViewport, so a module-scoped bridge is sufficient; subscribers update the DOM directly.
 */
type LiveCameraListener = (camera: Camera) => void;

const listeners = new Set<LiveCameraListener>();

/** Broadcast the per-frame rendered camera to every imperative subscriber. Called from the render loop. */
export function publishLiveCamera(camera: Camera): void {
  for (const listener of listeners) listener(camera);
}

/** Subscribe to per-frame camera updates; returns an unsubscribe function. */
export function subscribeLiveCamera(listener: LiveCameraListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
