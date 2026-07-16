import { describe, expect, it, vi } from 'vitest';
import { listenForWebGlContextLoss, nextBackendAfterLoss } from './gpuLoss';

describe('GPU loss recovery policy', () => {
  it('moves auto WebGPU to one fresh WebGL2 attempt without looping', () => {
    expect(nextBackendAfterLoss('auto', 'webgpu')).toBe('webgl2');
    expect(nextBackendAfterLoss('auto', 'webgl2')).toBe('canvas2d');
  });

  it('moves forced GPU backends directly to Canvas2D', () => {
    expect(nextBackendAfterLoss('webgpu', 'webgpu')).toBe('canvas2d');
    expect(nextBackendAfterLoss('webgl2', 'webgl2')).toBe('canvas2d');
  });
});

describe('listenForWebGlContextLoss', () => {
  it('prevents browser restoration and cleans up with the active session', () => {
    const canvas = new EventTarget();
    const onLoss = vi.fn();
    const detach = listenForWebGlContextLoss(canvas, onLoss);
    const firstLoss = new Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(firstLoss);
    expect(firstLoss.defaultPrevented).toBe(true);
    expect(onLoss).toHaveBeenCalledOnce();

    detach();
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(onLoss).toHaveBeenCalledOnce();
  });
});
