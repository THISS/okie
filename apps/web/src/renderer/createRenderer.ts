import { Canvas2DRenderer } from './Canvas2DRenderer';
import { UnsupportedRenderer } from './UnsupportedRenderer';
import { WasmRendererAdapter } from './WasmRendererAdapter';
import { nextBackendAfterLoss } from './gpuLoss';
import type { AtlasRenderer } from './types';

export type RendererSession = { canvas: HTMLCanvasElement; renderer: AtlasRenderer };

function freshCanvas(host: HTMLElement) {
  const canvas = document.createElement('canvas');
  canvas.className = 'atlas-canvas-surface';
  canvas.setAttribute('aria-hidden', 'true');
  host.replaceChildren(canvas);
  return canvas;
}

export function createCanvasFallback(host: HTMLElement, requestedBackend: string, reason?: string): RendererSession {
  const canvas = freshCanvas(host);
  try {
    return { canvas, renderer: new Canvas2DRenderer(canvas, requestedBackend, reason) };
  } catch (error) {
    const message = `${reason ? `${reason} ` : ''}Canvas 2D fallback also failed: ${error instanceof Error ? error.message : String(error)}`;
    return { canvas, renderer: new UnsupportedRenderer(requestedBackend, message) };
  }
}

export async function createRenderer(host: HTMLElement, requestedBackend: string, signal?: AbortSignal): Promise<RendererSession> {
  if (requestedBackend === 'canvas2d') return createCanvasFallback(host, requestedBackend);

  const attemptGpu = async (backend: 'webgpu' | 'webgl2') => {
    // Context choice is permanent for a canvas. Every GPU attempt receives a
    // node that has never been passed to another backend.
    const canvas = freshCanvas(host);
    const renderer = await WasmRendererAdapter.create(canvas, backend, requestedBackend);
    return { canvas, renderer };
  };

  if (requestedBackend === 'auto') {
    let webGpuFailure = '';
    try {
      return await attemptGpu('webgpu');
    } catch (error) {
      if (signal?.aborted) throw error;
      webGpuFailure = error instanceof Error ? error.message : String(error);
    }
    try {
      return await attemptGpu('webgl2');
    } catch (error) {
      if (signal?.aborted) throw error;
      const webGlFailure = error instanceof Error ? error.message : String(error);
      return createCanvasFallback(host, requestedBackend, `GPU initialization failed (WebGPU: ${webGpuFailure}; WebGL2: ${webGlFailure}).`);
    }
  }

  if (requestedBackend !== 'webgpu' && requestedBackend !== 'webgl2') {
    return createCanvasFallback(host, requestedBackend, `Unknown GPU backend “${requestedBackend}”.`);
  }
  try {
    return await attemptGpu(requestedBackend);
  } catch (error) {
    if (signal?.aborted) throw error;
    const failure = error instanceof Error ? error.message : String(error);
    return createCanvasFallback(host, requestedBackend, `GPU initialization failed (${failure}).`);
  }
}

export async function recoverRenderer(
  host: HTMLElement,
  requestedBackend: string,
  failedBackend: string,
  reason: string,
  signal?: AbortSignal,
): Promise<RendererSession> {
  const nextBackend = nextBackendAfterLoss(requestedBackend, failedBackend);
  if (nextBackend === 'canvas2d') {
    return createCanvasFallback(host, requestedBackend, `GPU surface lost (${reason}).`);
  }

  const canvas = freshCanvas(host);
  try {
    const renderer = await WasmRendererAdapter.create(canvas, 'webgl2', requestedBackend);
    return { canvas, renderer };
  } catch (error) {
    if (signal?.aborted) throw error;
    const failure = error instanceof Error ? error.message : String(error);
    return createCanvasFallback(host, requestedBackend, `GPU surface lost (${reason}); WebGL2 recovery failed (${failure}).`);
  }
}
