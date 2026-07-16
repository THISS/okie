import { describe, expect, it, vi } from 'vitest';
import { compensateSemanticMorphCamera } from '../semantic/semanticLens';
import { createCameraPublisher, focusCameraPreservingAnchor, panCamera, shouldAdoptExternalCameraAsRaw, zoomCameraAroundWorldAnchor, zoomCameraAt } from './cameraController';

describe('camera controls', () => {
  it('keeps the cursor over the same world point while zooming', () => {
    const viewport = { width: 800, height: 600 };
    const current = { x: 50, y: 25, zoom: 0.5 };
    const screen = { x: 650, y: 220 };
    const before = {
      x: current.x + (screen.x - viewport.width / 2) / current.zoom,
      y: current.y + (screen.y - viewport.height / 2) / current.zoom,
    };
    const next = zoomCameraAt(current, screen.x, screen.y, viewport, -120);
    const after = {
      x: next.x + (screen.x - viewport.width / 2) / next.zoom,
      y: next.y + (screen.y - viewport.height / 2) / next.zoom,
    };
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
    expect(panCamera(next, 20, -10)).toEqual({ ...next, x: next.x - 20 / next.zoom, y: next.y + 10 / next.zoom });
  });
});

describe('spatial continuity', () => {
  it('keeps the prior selection screen anchor when focusing a new entity', () => {
    const viewport = { width: 1_000, height: 700 };
    const camera = { x: 100, y: 80, zoom: 0.6 };
    const previous = { x: 160, y: 120, width: 100, height: 80 };
    const target = { x: 600, y: 380, width: 120, height: 90 };
    const anchor = {
      x: viewport.width / 2 + (previous.x + previous.width / 2 - camera.x) * camera.zoom,
      y: viewport.height / 2 + (previous.y + previous.height / 2 - camera.y) * camera.zoom,
    };
    const next = focusCameraPreservingAnchor(camera, previous, target, viewport);
    expect(viewport.width / 2 + (target.x + target.width / 2 - next.x) * next.zoom).toBeCloseTo(anchor.x);
    expect(viewport.height / 2 + (target.y + target.height / 2 - next.y) * next.zoom).toBeCloseTo(anchor.y);
  });

  it('keeps a selected world anchor fixed during semantic zoom', () => {
    const viewport = { width: 1_000, height: 700 };
    const camera = { x: 100, y: 80, zoom: 0.6 };
    const anchor = { x: 230, y: 170 };
    const next = zoomCameraAroundWorldAnchor(camera, anchor, 1.2, viewport);
    expect((anchor.x - next.x) * next.zoom).toBeCloseTo((anchor.x - camera.x) * camera.zoom);
    expect((anchor.y - next.y) * next.zoom).toBeCloseTo((anchor.y - camera.y) * camera.zoom);
  });

  it('consumes a settled morph inverse once across the base override and following assist frame', () => {
    const viewport = { width: 1_321, height: 1_805 };
    const pointer = { x: 962, y: 1_115 };
    const pannedLive = { x: 1_481.025923, y: 375.197170, zoom: 1.55 };
    const source = { x: 0, y: 0, width: 2, height: 2 };
    const target = { x: 482, y: 144, width: 2, height: 2 };

    // The settled structural offset is already part of the rendered/panned camera.
    const rawOutward = zoomCameraAt(pannedLive, pointer.x, pointer.y, viewport, 80);
    const firstRendered = compensateSemanticMorphCamera(rawOutward, source, target, 0, 1);
    expect(firstRendered.x).toBeCloseTo(rawOutward.x - 482);
    expect(firstRendered.y).toBeCloseTo(rawOutward.y - 144);
    expect(firstRendered.zoom).toBe(rawOutward.zoom);

    // Popping the semantic path changes topology to base, but must not make the
    // compensated live camera the raw input while the assist bridge is active.
    const baseProjectionId = 'semantic-path:context:base';
    const rawAfterExternalSync = shouldAdoptExternalCameraAsRaw(baseProjectionId, true)
      ? firstRendered
      : rawOutward;
    const followingAssistFrame = compensateSemanticMorphCamera(rawAfterExternalSync, source, target, 0, 1);
    expect(followingAssistFrame).toEqual(firstRendered);
    expect(followingAssistFrame.x).not.toBeCloseTo(rawOutward.x - 2 * 482);
    expect(followingAssistFrame.y).not.toBeCloseTo(rawOutward.y - 2 * 144);

    // Once assist ownership ends, the final rendered camera becomes canonical.
    expect(shouldAdoptExternalCameraAsRaw(baseProjectionId, false)).toBe(true);
  });
});

describe('camera persistence publisher', () => {
  it('publishes only the exact latest live camera after input settles', () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const publisher = createCameraPublisher(publish, 80);
    publisher.schedule({ x: 1, y: 2, zoom: 0.5 });
    publisher.schedule({ x: 7, y: 8, zoom: 0.9 });
    expect(publish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(79);
    expect(publish).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenLastCalledWith({ x: 7, y: 8, zoom: 0.9 });
    vi.useRealTimers();
  });

  it('flushes the exact latest camera at the end of a pointer gesture', () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const publisher = createCameraPublisher(publish, 80);
    publisher.schedule({ x: -12.25, y: 44.75, zoom: 1.1 });
    publisher.flush();
    expect(publish).toHaveBeenCalledWith({ x: -12.25, y: 44.75, zoom: 1.1 });
    vi.advanceTimersByTime(100);
    expect(publish).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('drops a pending gesture snapshot when an external camera takes over', () => {
    vi.useFakeTimers();
    const publish = vi.fn();
    const publisher = createCameraPublisher(publish, 80);
    publisher.schedule({ x: 2, y: 3, zoom: 0.6 });
    publisher.cancel();
    vi.advanceTimersByTime(100);
    expect(publish).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
