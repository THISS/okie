import { describe, expect, it, vi } from 'vitest';
import { createGoldenC4Scene } from './goldenC4Scene';
import type { ProjectionOverride, RenderState } from './types';
import { WasmRendererAdapter } from './WasmRendererAdapter';

function state(overrides: Partial<RenderState> = {}): RenderState {
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

function projection(id: string, progress: number): ProjectionOverride {
  return {
    id,
    progress,
    objects: [{
      objectId: 'visual-node:lineage:container:architecture-model',
      sourceRepresentationId: 'visual-node:lineage:container:architecture-model:container',
      targetRepresentationId: 'visual-node:lineage:container:architecture-model:component',
    }],
    paths: [],
    morph: {
      boundaryObjectId: 'visual-node:lineage:container:architecture-model',
      objectIds: ['visual-node:lineage:container:architecture-model'],
      pathIds: [],
    },
  };
}

describe('WASM projection progress hot path', () => {
  it('installs topology once per lens id and sends only a number for progress frames', () => {
    const native = {
      setProjectionOverride: vi.fn(),
      setProjectionProgress: vi.fn(),
      setVisibility: vi.fn(),
      setReducedMotion: vi.fn(),
      setTimeline: vi.fn(),
      seekTimeline: vi.fn(),
      playTimeline: vi.fn(),
      pauseTimeline: vi.fn(),
    };
    const renderer = Object.create(WasmRendererAdapter.prototype) as WasmRendererAdapter;
    Object.assign(renderer as unknown as Record<string, unknown>, {
      native,
      requestedBackend: 'webgpu',
      scene: createGoldenC4Scene(),
      protocolSceneId: 'scene:golden',
      renderStateKey: '',
      transitionPositionMs: -1,
      projectionOverrideKey: '',
      projectionOverrideProgress: -1,
      timelinePlaying: false,
    });
    const stringify = vi.spyOn(JSON, 'stringify');

    renderer.setRenderState(state({ projectionOverride: projection('lens:architecture-model', 0.1) }));
    expect(native.setProjectionOverride).toHaveBeenCalledTimes(1);
    expect(native.setProjectionProgress).not.toHaveBeenCalled();
    expect(stringify).not.toHaveBeenCalled();

    for (const progress of [0.2, 0.35, 0.5, 0.75, 1]) {
      renderer.setRenderState(state({ projectionOverride: projection('lens:architecture-model', progress) }));
    }
    expect(native.setProjectionOverride).toHaveBeenCalledTimes(1);
    expect(native.setProjectionProgress.mock.calls).toEqual([
      ['lens:architecture-model', 0.2],
      ['lens:architecture-model', 0.35],
      ['lens:architecture-model', 0.5],
      ['lens:architecture-model', 0.75],
      ['lens:architecture-model', 1],
    ]);
    expect(stringify).not.toHaveBeenCalled();

    renderer.setRenderState(state({ projectionOverride: projection('lens:other-target', 0.25) }));
    expect(native.setProjectionOverride).toHaveBeenCalledTimes(2);
    renderer.setRenderState(state());
    expect(native.setProjectionOverride).toHaveBeenLastCalledWith(null);
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
  });

  it('lets a selected flow timeline advance without replaying it on every render-state frame', () => {
    const native = {
      setProjectionOverride: vi.fn(),
      setProjectionProgress: vi.fn(),
      setVisibility: vi.fn(),
      setReducedMotion: vi.fn(),
      setTimeline: vi.fn(),
      seekTimeline: vi.fn(),
      playTimeline: vi.fn(),
      pauseTimeline: vi.fn(),
    };
    const scene = createGoldenC4Scene();
    const semanticRelationId = scene.relations[0]!.id;
    const visualPathIds = scene.projection!.semanticToVisualRelationIds[semanticRelationId]!;
    const renderer = Object.create(WasmRendererAdapter.prototype) as WasmRendererAdapter;
    Object.assign(renderer as unknown as Record<string, unknown>, {
      native,
      requestedBackend: 'webgpu',
      scene,
      protocolSceneId: 'scene:golden',
      renderStateKey: '',
      transitionPositionMs: -1,
      timelinePlaying: false,
      projectionOverrideKey: '',
      projectionOverrideProgress: -1,
    });
    const flowing = state({
      activeRelationIds: new Set([semanticRelationId]),
      flowRelationIds: new Set([semanticRelationId]),
      animate: true,
    });

    renderer.setRenderState(flowing);
    renderer.setRenderState(flowing);
    renderer.setRenderState(flowing);

    expect(native.setTimeline).toHaveBeenCalledTimes(1);
    expect(native.playTimeline).toHaveBeenCalledTimes(1);
    expect(native.seekTimeline).not.toHaveBeenCalled();
    expect(native.pauseTimeline).not.toHaveBeenCalled();
    const timeline = native.setTimeline.mock.calls[0]![0] as {
      keyframes: Array<{ pathStates: Array<{ pathIds: string[]; flowSpeed: number }> }>;
    };
    expect(timeline.keyframes[0]!.pathStates).toContainEqual(expect.objectContaining({
      pathIds: visualPathIds,
      flowSpeed: 1,
    }));

    renderer.setRenderState(state());
    renderer.setRenderState(state());
    expect(native.setTimeline).toHaveBeenCalledTimes(2);
    expect(native.playTimeline).toHaveBeenCalledTimes(1);
    expect(native.pauseTimeline).not.toHaveBeenCalled();
    expect(native.seekTimeline).not.toHaveBeenCalled();
  });
});
