import { describe, expect, it } from 'vitest';
import { entityScreenRect, entityVisibleRatio, selectedEntityReframePlan } from './selectedEntityFraming';

const viewport = { width: 1_000, height: 700 };
const safeArea = { top: 60, right: 400, bottom: 80, left: 40 };

describe('selected entity safe-area reframing', () => {
  it('keeps an already-contained camera unchanged', () => {
    const camera = { x: 500, y: 350, zoom: 1 };
    const plan = selectedEntityReframePlan({
      camera,
      bounds: { x: 100, y: 200, width: 200, height: 100 },
      viewport,
      safeArea,
      padding: 40,
    });

    expect(plan).toEqual({ camera, previousVisibleRatio: 1, nextVisibleRatio: 1, reframed: false });
    expect(plan.camera).toBe(camera);
  });

  it('uses the smallest translation that brings a clipped selection fully onscreen', () => {
    const plan = selectedEntityReframePlan({
      camera: { x: 500, y: 350, zoom: 1 },
      bounds: { x: 450, y: 200, width: 200, height: 100 },
      viewport,
      safeArea,
      padding: 40,
    });

    expect(plan.previousVisibleRatio).toBeCloseTo(.55);
    expect(plan.reframed).toBe(true);
    expect(plan.camera).toEqual({ x: 590, y: 350, zoom: 1 });
    expect(plan.nextVisibleRatio).toBe(1);
    expect(entityScreenRect(
      { x: 450, y: 200, width: 200, height: 100 },
      plan.camera,
      viewport,
    )).toEqual({ left: 360, top: 200, right: 560, bottom: 300 });
  });

  it('centers an oversized selection within the usable safe viewport', () => {
    const plan = selectedEntityReframePlan({
      camera: { x: 500, y: 350, zoom: 1 },
      bounds: { x: 100, y: 100, width: 700, height: 500 },
      viewport,
      safeArea,
      padding: 40,
    });
    const rect = entityScreenRect({ x: 100, y: 100, width: 700, height: 500 }, plan.camera, viewport);

    expect(plan.reframed).toBe(true);
    expect((rect.left + rect.right) / 2).toBeCloseTo(320);
    expect((rect.top + rect.bottom) / 2).toBeCloseTo(340);
    expect(plan.camera.zoom).toBe(1);
    expect(plan.nextVisibleRatio).toBeGreaterThan(plan.previousVisibleRatio);
  });

  it('can force a contained selection to the safe-area center', () => {
    const plan = selectedEntityReframePlan({
      camera: { x: 500, y: 350, zoom: 2 },
      bounds: { x: 350, y: 300, width: 50, height: 40 },
      viewport,
      safeArea,
      padding: 40,
      forceCenter: true,
    });
    const rect = entityScreenRect({ x: 350, y: 300, width: 50, height: 40 }, plan.camera, viewport);

    expect(plan.reframed).toBe(true);
    expect(plan.camera.zoom).toBe(2);
    expect((rect.left + rect.right) / 2).toBeCloseTo(320);
    expect((rect.top + rect.bottom) / 2).toBeCloseTo(340);
  });

  it('measures area visibility rather than one-dimensional overlap', () => {
    expect(entityVisibleRatio(
      { left: 0, top: 0, right: 200, bottom: 200 },
      { left: 100, top: 100, right: 300, bottom: 300 },
    )).toBe(.25);
  });
});
