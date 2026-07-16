import type { RendererDiagnostics } from './types';

export type BackendPresentation = {
  title: string;
  detail: string;
  tone: 'initializing' | 'recovering' | 'canvas2d' | 'webgpu' | 'webgl2' | 'unsupported';
};

export function presentBackend(diagnostics: Pick<RendererDiagnostics, 'activeBackend' | 'gpuAccelerated'>): BackendPresentation {
  const backend = diagnostics.activeBackend.trim().toLowerCase();

  if (backend === 'initializing') {
    return { title: 'Renderer starting', detail: 'detecting backend', tone: 'initializing' };
  }
  if (backend === 'recovering') {
    return { title: 'Renderer recovering', detail: 'replacing lost surface', tone: 'recovering' };
  }
  if (backend === 'canvas2d' || backend === 'canvas2d-preview') {
    return { title: 'Canvas 2D preview', detail: 'software fallback', tone: 'canvas2d' };
  }
  if (backend === 'webgpu') {
    return { title: 'WebGPU renderer', detail: diagnostics.gpuAccelerated ? 'GPU accelerated' : 'GPU backend', tone: 'webgpu' };
  }
  if (backend === 'webgl2') {
    return { title: 'WebGL 2 renderer', detail: diagnostics.gpuAccelerated ? 'GPU accelerated' : 'GPU fallback', tone: 'webgl2' };
  }
  if (backend === 'unsupported' || backend === 'unavailable' || !backend) {
    return { title: 'Renderer unavailable', detail: 'unsupported browser', tone: 'unsupported' };
  }

  return { title: diagnostics.activeBackend, detail: diagnostics.gpuAccelerated ? 'GPU accelerated' : 'renderer backend', tone: diagnostics.gpuAccelerated ? 'webgpu' : 'unsupported' };
}
