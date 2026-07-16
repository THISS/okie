import { describe, expect, it, vi } from 'vitest';
import { focusCameraPreservingAnchor, zoomCameraAroundWorldAnchor } from './cameraController';
import { Canvas2DRenderer } from './Canvas2DRenderer';
import { createDemandFrameScheduler } from './demandFrameScheduler';
import { createCommerceFixture } from './fixtures';
import type { Camera, RenderState, SceneEntity } from './types';

const viewport = { width: 1_200, height: 800 };

function screenPoint(point: { x: number; y: number }, camera: Camera) {
  return {
    x: viewport.width / 2 + (point.x - camera.x) * camera.zoom,
    y: viewport.height / 2 + (point.y - camera.y) * camera.zoom,
  };
}

function entityCenter(entity: SceneEntity) {
  return { x: entity.x + entity.width / 2, y: entity.y + entity.height / 2 };
}

function fakeCanvas() {
  const calls = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  const values: Record<PropertyKey, unknown> = {};
  const context = new Proxy(values, {
    get(target, property) {
      if (property in target) return target[property];
      const call = calls.get(property) ?? vi.fn();
      calls.set(property, call);
      return call;
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getContext: vi.fn(() => context),
  } as unknown as HTMLCanvasElement;
  return { canvas, call: (name: PropertyKey) => calls.get(name) ?? vi.fn() };
}

function renderState(overrides: Partial<RenderState> = {}): RenderState {
  return {
    focusedIds: new Set(),
    activeRelationIds: new Set(),
    flowRelationIds: new Set(),
    reduceMotion: false,
    animate: false,
    visibilityMode: 'all',
    ...overrides,
  };
}

function relationScreenMidpoint(from: SceneEntity, to: SceneEntity, camera: Camera) {
  const start = screenPoint({ x: from.x + from.width, y: from.y + from.height / 2 }, camera);
  const end = screenPoint({ x: to.x, y: to.y + to.height / 2 }, camera);
  const bend = Math.max(38, Math.abs(end.x - start.x) * 0.4);
  const phase = 0.5;
  const inverse = 1 - phase;
  return {
    x: inverse ** 3 * start.x
      + 3 * inverse ** 2 * phase * (start.x + bend)
      + 3 * inverse * phase ** 2 * (end.x - bend)
      + phase ** 3 * end.x,
    y: inverse ** 3 * start.y
      + 3 * inverse ** 2 * phase * start.y
      + 3 * inverse * phase ** 2 * end.y
      + phase ** 3 * end.y,
  };
}

describe('semantic zoom and focus continuity', () => {
  it('holds the selected world anchor within half a CSS pixel across every LOD boundary', () => {
    const anchor = { x: 241.25, y: 173.75 };
    let camera: Camera = { x: 95.5, y: 62.25, zoom: 0.42 };
    const originalScreen = screenPoint(anchor, camera);

    for (const zoom of [0.46, 0.50, 0.52, 0.58, 0.64, 0.56, 0.48, 0.44]) {
      camera = zoomCameraAroundWorldAnchor(camera, anchor, zoom, viewport);
      const actual = screenPoint(anchor, camera);
      expect(Math.hypot(actual.x - originalScreen.x, actual.y - originalScreen.y)).toBeLessThanOrEqual(0.5);
    }
  });

  it('preserves the prior on-screen anchor for an explicit drill or search jump', () => {
    const camera: Camera = { x: 100, y: 80, zoom: 0.6 };
    const previous = { x: 160, y: 120, width: 100, height: 80 };
    const target = { x: 600, y: 380, width: 120, height: 90 };
    const before = screenPoint(entityCenter({ ...previous } as SceneEntity), camera);
    const next = focusCameraPreservingAnchor(camera, previous, target, viewport);
    const after = screenPoint(entityCenter({ ...target } as SceneEntity), next);
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThanOrEqual(0.5);
  });
});

describe('draw, pick and accessibility projection parity', () => {
  it('uses one isolation mask for rendering, hit testing and visibleScene', () => {
    const scene = createCommerceFixture(7);
    const gateway = scene.entities.find(entity => entity.id === 'gateway')!;
    const catalog = scene.entities.find(entity => entity.id === 'catalog')!;
    const storefront = scene.entities.find(entity => entity.id === 'storefront')!;
    const camera: Camera = { x: 325, y: 90, zoom: 0.56 };
    const { canvas } = fakeCanvas();
    const renderer = new Canvas2DRenderer(canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(viewport.width, viewport.height, 1);
    renderer.setCamera(camera);
    renderer.setRenderState(renderState({
      focusedIds: new Set(['gateway', 'catalog']),
      visibilityMode: 'isolate',
    }));
    renderer.render(1_000);

    expect(renderer.visibleScene()).toEqual({
      objectIds: ['gateway', 'catalog'],
      relationIds: ['api-catalog'],
    });
    expect(renderer.diagnostics()).toMatchObject({ visibleEntities: 2, visibleRelations: 1 });
    expect(renderer.pick(...Object.values(screenPoint(entityCenter(gateway), camera)) as [number, number]))
      .toEqual({ kind: 'entity', id: 'gateway' });
    expect(renderer.pick(...Object.values(screenPoint(entityCenter(storefront), camera)) as [number, number]))
      .toBeUndefined();
    const relationPoint = relationScreenMidpoint(gateway, catalog, camera);
    expect(renderer.pick(relationPoint.x, relationPoint.y)).toEqual({ kind: 'relation', id: 'api-catalog' });
  });

  it('keeps Dim context discoverable while Isolate removes it', () => {
    const scene = createCommerceFixture(11);
    const hidden = scene.entities.find(entity => entity.id === 'storefront')!;
    const camera: Camera = { x: 325, y: 90, zoom: 0.56 };
    const { canvas } = fakeCanvas();
    const renderer = new Canvas2DRenderer(canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(viewport.width, viewport.height, 1);
    renderer.setCamera(camera);
    renderer.setRenderState(renderState({ focusedIds: new Set(['gateway']), visibilityMode: 'dim' }));
    expect(renderer.visibleScene().objectIds).toHaveLength(scene.entities.length);
    expect(renderer.pick(...Object.values(screenPoint(entityCenter(hidden), camera)) as [number, number]))
      .toEqual({ kind: 'entity', id: hidden.id });

    renderer.setRenderState(renderState({ focusedIds: new Set(['gateway']), visibilityMode: 'isolate' }));
    expect(renderer.visibleScene()).toEqual({ objectIds: ['gateway'], relationIds: [] });
    expect(renderer.pick(...Object.values(screenPoint(entityCenter(hidden), camera)) as [number, number]))
      .toBeUndefined();
  });
});

describe('motion and static-work release gates', () => {
  it('suppresses animated flow particles under reduced motion', () => {
    const scene = createCommerceFixture(13);
    const animated = fakeCanvas();
    const animatedRenderer = new Canvas2DRenderer(animated.canvas, 'canvas2d');
    animatedRenderer.setScene(scene);
    animatedRenderer.resize(viewport.width, viewport.height, 1);
    animatedRenderer.setCamera({ x: 325, y: 90, zoom: 0.56 });
    animatedRenderer.setRenderState(renderState({
      activeRelationIds: new Set(['api-orders']),
      flowRelationIds: new Set(['api-orders']),
      animate: true,
    }));
    animatedRenderer.render(900);
    expect(animated.call('arc')).toHaveBeenCalled();

    const reduced = fakeCanvas();
    const reducedRenderer = new Canvas2DRenderer(reduced.canvas, 'canvas2d');
    reducedRenderer.setScene(scene);
    reducedRenderer.resize(viewport.width, viewport.height, 1);
    reducedRenderer.setCamera({ x: 325, y: 90, zoom: 0.56 });
    reducedRenderer.setRenderState(renderState({
      activeRelationIds: new Set(['api-orders']),
      flowRelationIds: new Set(['api-orders']),
      animate: true,
      reduceMotion: true,
    }));
    reducedRenderer.render(900);
    expect(reduced.call('arc')).not.toHaveBeenCalled();
  });

  it('returns to zero queued frames after animation stops', () => {
    const callbacks = new Map<number, FrameRequestCallback>();
    let id = 0;
    const scheduler = createDemandFrameScheduler(vi.fn(), {
      requestFrame(callback) {
        id += 1;
        callbacks.set(id, callback);
        return id;
      },
      cancelFrame(handle) { callbacks.delete(handle); },
    });
    const step = (time: number) => {
      const queued = [...callbacks.values()];
      callbacks.clear();
      queued.forEach(callback => callback(time));
    };

    scheduler.setContinuous(true);
    step(16);
    expect(callbacks.size).toBe(1);
    scheduler.setContinuous(false);
    step(32);
    expect(callbacks.size).toBe(0);
    expect(scheduler.isScheduled()).toBe(false);
  });

  it('reports no static geometry uploads after camera and filter-only frames', () => {
    const scene = createCommerceFixture(17);
    const { canvas } = fakeCanvas();
    const renderer = new Canvas2DRenderer(canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(viewport.width, viewport.height, 1);

    for (const [index, camera] of [
      { x: 325, y: 90, zoom: 0.46 },
      { x: 280, y: 60, zoom: 0.58 },
      { x: 340, y: 110, zoom: 0.52 },
    ].entries()) {
      renderer.setCamera(camera);
      renderer.setRenderState(renderState({
        focusedIds: new Set(['gateway']),
        visibilityMode: index % 2 ? 'dim' : 'isolate',
      }));
      renderer.render(index * 16);
      expect(renderer.diagnostics()).toMatchObject({
        meshRebuilt: false,
        geometryUploadBytes: 0,
        geometryBufferUploads: 0,
      });
    }
  });
});
