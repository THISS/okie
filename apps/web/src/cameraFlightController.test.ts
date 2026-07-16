import { describe, expect, it, vi } from 'vitest';
import {
  cameraFlightDuration,
  createCameraFlight,
  createCameraFlightController,
  easeCameraFlight,
  reconcileRenderedCamera,
  sampleCameraFlight,
} from './cameraFlightController';
import type { Camera } from './renderer/types';

function frameHarness(now = 0) {
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  let time = now;
  return {
    api: {
      requestFrame(callback: FrameRequestCallback) {
        id += 1;
        callbacks.set(id, callback);
        return id;
      },
      cancelFrame(handle: number) { callbacks.delete(handle); },
      now: () => time,
    },
    step(next: number) {
      time = next;
      const queued = [...callbacks.values()];
      callbacks.clear();
      queued.forEach(callback => callback(next));
    },
    queued: () => callbacks.size,
  };
}

describe('generic camera flight controller', () => {
  const viewport = { width: 1_280, height: 720 };

  it('uses cubic ease-in-out and logarithmic zoom without changing exact endpoints', () => {
    const flight = createCameraFlight(
      { x: 0, y: 20, zoom: 1 },
      { x: 200, y: 120, zoom: 4 },
      viewport,
      100,
    );
    const halfway = sampleCameraFlight(flight, 100 + flight.durationMs / 2);

    expect(easeCameraFlight(.5)).toBe(.5);
    expect(halfway.camera).toEqual({ x: 100, y: 70, zoom: 2 });
    expect(sampleCameraFlight(flight, 100).camera).toEqual(flight.source);
    expect(sampleCameraFlight(flight, 100 + flight.durationMs).camera).toEqual(flight.target);
  });

  it('adapts nonzero travel to the 450–650ms interaction budget', () => {
    const source = { x: 0, y: 0, zoom: 1 };
    expect(cameraFlightDuration(source, source, viewport)).toBe(0);
    expect(cameraFlightDuration(source, { x: 10, y: 0, zoom: 1 }, viewport)).toBe(451);
    expect(cameraFlightDuration(source, { x: 50_000, y: 0, zoom: 16 }, viewport)).toBe(650);
  });

  it('retargets from the latest rendered camera and commits only the last destination', () => {
    const harness = frameHarness(1_000);
    let camera: Camera = { x: 0, y: 0, zoom: 1 };
    const render = vi.fn((next: Camera) => { camera = next; });
    const firstComplete = vi.fn();
    const secondComplete = vi.fn();
    const controller = createCameraFlightController(() => camera, render, harness.api);
    const first = controller.start({
      target: { x: 1_000, y: 400, zoom: 4 },
      viewport,
      reducedMotion: false,
      onComplete: firstComplete,
    });
    harness.step(1_000 + first.durationMs / 2);
    const retargetSource = { ...camera };
    const second = controller.start({
      target: { x: -300, y: 80, zoom: .5 },
      viewport,
      reducedMotion: false,
      onComplete: secondComplete,
    });

    expect(second.source).toEqual(retargetSource);
    harness.step(1_000 + first.durationMs / 2 + second.durationMs);
    expect(firstComplete).not.toHaveBeenCalled();
    expect(secondComplete).toHaveBeenCalledOnce();
    expect(camera).toEqual(second.target);
  });

  it('retains the live animation source when React camera state is one destination behind', () => {
    const live = { x: 1_040, y: 310, zoom: 13.6 };
    const laggingReactState = { x: 880, y: 260, zoom: 5.15 };

    expect(reconcileRenderedCamera(live, laggingReactState, true)).toBe(live);
    expect(reconcileRenderedCamera(live, laggingReactState, false)).toBe(laggingReactState);
  });

  it('retargets from the live frame even when React still holds the superseded destination', () => {
    const harness = frameHarness(2_000);
    let liveCamera: Camera = { x: 0, y: 0, zoom: 16 };
    let reactCamera: Camera = liveCamera;
    let controller: ReturnType<typeof createCameraFlightController>;
    controller = createCameraFlightController(
      () => liveCamera,
      next => { liveCamera = next; },
      harness.api,
    );
    const first = controller.start({
      target: { x: 80, y: 40, zoom: 5.15 },
      viewport,
      reducedMotion: false,
      onComplete: vi.fn(),
    });
    harness.step(2_000 + 120);
    const liveAtRetarget = { ...liveCamera };

    reactCamera = first.target;
    // Mirror App render reconciliation while the first flight owns the live ref.
    liveCamera = reconcileRenderedCamera(liveCamera, reactCamera, controller.isActive());
    const second = controller.start({
      target: { x: 180, y: 90, zoom: 2.05 },
      viewport,
      reducedMotion: false,
      onComplete: vi.fn(),
    });

    expect(liveAtRetarget.zoom).not.toBe(reactCamera.zoom);
    expect(second.source).toEqual(liveAtRetarget);
  });

  it('preserves the live frame when direct input cancels ahead of lagging React state', () => {
    const harness = frameHarness(3_000);
    let liveCamera: Camera = { x: 0, y: 0, zoom: 16 };
    let reactCamera: Camera = liveCamera;
    let controller: ReturnType<typeof createCameraFlightController>;
    controller = createCameraFlightController(
      () => liveCamera,
      next => { liveCamera = next; },
      harness.api,
    );
    controller.start({
      target: { x: 80, y: 40, zoom: 5.15 },
      viewport,
      reducedMotion: false,
      onComplete: vi.fn(),
    });
    harness.step(3_120);
    const liveAtCancel = { ...liveCamera };

    reactCamera = { x: 80, y: 40, zoom: 5.15 };
    liveCamera = reconcileRenderedCamera(liveCamera, reactCamera, controller.isActive());
    controller.cancel();
    reactCamera = liveAtCancel;
    liveCamera = reconcileRenderedCamera(liveCamera, reactCamera, controller.isActive());

    expect(controller.isActive()).toBe(false);
    expect(liveCamera).toEqual(liveAtCancel);
    expect(liveCamera.zoom).not.toBe(5.15);
  });

  it('cannot overwrite an external selection after its flight is aborted', () => {
    const harness = frameHarness(4_000);
    let camera: Camera = { x: 0, y: 0, zoom: 16 };
    let selection = 'code:starting-point';
    const controller = createCameraFlightController(
      () => camera,
      next => { camera = next; },
      harness.api,
    );
    controller.start({
      target: { x: 80, y: 40, zoom: 5.15 },
      viewport,
      reducedMotion: false,
      onComplete: () => { selection = 'component:superseded-parent'; },
    });
    harness.step(4_120);

    controller.cancel();
    selection = 'container:external-search-result';
    harness.step(5_000);

    expect(selection).toBe('container:external-search-result');
    expect(controller.isActive()).toBe(false);
  });

  it('cancels without committing and snaps synchronously for reduced motion', () => {
    const harness = frameHarness();
    let camera: Camera = { x: 0, y: 0, zoom: 1 };
    const complete = vi.fn();
    const controller = createCameraFlightController(() => camera, next => { camera = next; }, harness.api);
    controller.start({ target: { x: 100, y: 50, zoom: 2 }, viewport, reducedMotion: false, onComplete: complete });
    controller.cancel();
    harness.step(1_000);
    expect(complete).not.toHaveBeenCalled();
    expect(harness.queued()).toBe(0);

    const target = { x: 20, y: 10, zoom: 3 };
    controller.start({ target, viewport, reducedMotion: true, onComplete: complete });
    expect(camera).toEqual(target);
    expect(complete).toHaveBeenCalledWith(target);
    expect(controller.isActive()).toBe(false);
  });

  it('renders a transformed raw endpoint exactly before completion', () => {
    const harness = frameHarness(200);
    let camera: Camera = { x: 0, y: 0, zoom: 1 };
    const controller = createCameraFlightController(() => camera, next => { camera = next; }, harness.api);
    const rawTarget = { x: 120, y: 40, zoom: 4 };
    const desiredTarget = { x: 320, y: 140, zoom: 4 };
    const flight = controller.start({
      target: rawTarget,
      viewport,
      reducedMotion: false,
      transformCamera: sample => ({
        ...sample.camera,
        x: sample.camera.x + sample.easedProgress * 200,
        y: sample.camera.y + sample.easedProgress * 100,
      }),
      onComplete: vi.fn(),
    });

    harness.step(200 + flight.durationMs);
    expect(camera).toEqual(desiredTarget);
  });
});
