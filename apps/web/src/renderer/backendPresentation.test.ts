import { describe, expect, it } from 'vitest';
import { presentBackend } from './backendPresentation';

describe('presentBackend', () => {
  it.each([
    ['canvas2d-preview', false, 'Canvas 2D preview', 'canvas2d'],
    ['recovering', false, 'Renderer recovering', 'recovering'],
    ['webgpu', true, 'WebGPU renderer', 'webgpu'],
    ['webgl2', true, 'WebGL 2 renderer', 'webgl2'],
    ['unsupported', false, 'Renderer unavailable', 'unsupported'],
  ] as const)('presents %s truthfully', (activeBackend, gpuAccelerated, title, tone) => {
    expect(presentBackend({ activeBackend, gpuAccelerated })).toMatchObject({ title, tone });
  });
});
