import { describe, expect, it, vi } from 'vitest';
import { drawSceneForCapture, screenshotFilename } from './sceneScreenshot';
import type { AtlasScene, Camera, RenderState } from './types';

describe('screenshotFilename', () => {
  it('slugifies the view title and stamps a deterministic timestamp', () => {
    const stamp = Date.UTC(2026, 6, 17, 3, 4, 5);
    expect(screenshotFilename('Dynamic Flow · Okie', stamp)).toBe('okie-dynamic-flow-okie-2026-07-17-03-04-05.png');
  });

  it('falls back to a generic slug for an empty title', () => {
    expect(screenshotFilename('', 0)).toBe('okie-view-1970-01-01-00-00-00.png');
  });
});

describe('drawSceneForCapture', () => {
  it('drives an injected renderer through the full capture sequence, then disposes', () => {
    const order: string[] = [];
    const renderer = {
      setScene: vi.fn(() => order.push('setScene')),
      setCamera: vi.fn(() => order.push('setCamera')),
      setRenderState: vi.fn(() => order.push('setRenderState')),
      resize: vi.fn(() => order.push('resize')),
      render: vi.fn(() => order.push('render')),
      dispose: vi.fn(() => order.push('dispose')),
    };
    const scene = { entities: [], relations: [], regions: [] } as unknown as AtlasScene;
    const camera: Camera = { x: 1, y: 2, zoom: 3 };
    const renderState: RenderState = {
      focusedIds: new Set(),
      activeRelationIds: new Set(),
      flowRelationIds: new Set(),
      reduceMotion: true,
      animate: false,
      visibilityMode: 'all',
    };

    drawSceneForCapture(
      {} as HTMLCanvasElement,
      { scene, camera, width: 800.6, height: 600.4, devicePixelRatio: 2, renderState },
      () => renderer,
    );

    expect(order).toEqual(['setScene', 'setCamera', 'setRenderState', 'resize', 'render', 'dispose']);
    expect(renderer.setScene).toHaveBeenCalledWith(scene);
    expect(renderer.setCamera).toHaveBeenCalledWith(camera);
    expect(renderer.setRenderState).toHaveBeenCalledWith(renderState);
    expect(renderer.resize).toHaveBeenCalledWith(801, 600, 2);
    expect(renderer.render).toHaveBeenCalledWith(0);
  });

  it('defaults the device pixel ratio to 1 and clamps dimensions to a minimum of one', () => {
    const renderer = {
      setScene: vi.fn(), setCamera: vi.fn(), setRenderState: vi.fn(), resize: vi.fn(), render: vi.fn(), dispose: vi.fn(),
    };
    const renderState: RenderState = {
      focusedIds: new Set(), activeRelationIds: new Set(), flowRelationIds: new Set(), reduceMotion: true, animate: false, visibilityMode: 'all',
    };
    drawSceneForCapture(
      {} as HTMLCanvasElement,
      { scene: { entities: [], relations: [], regions: [] } as unknown as AtlasScene, camera: { x: 0, y: 0, zoom: 1 }, width: 0, height: 0, renderState },
      () => renderer,
    );
    expect(renderer.resize).toHaveBeenCalledWith(1, 1, 1);
  });
});
