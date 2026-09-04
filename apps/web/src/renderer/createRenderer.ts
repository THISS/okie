import { Canvas2DRenderer } from './Canvas2DRenderer';
import { UnsupportedRenderer } from './UnsupportedRenderer';
import { WasmRendererAdapter } from './WasmRendererAdapter';
import * as gpuPolicy from './gpuLoss';
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
    const attempts = gpuPolicy.autoGpuAttemptOrder({
      framed: gpuPolicy.isFramedBrowsingContext(),
      webGpuAvailable: gpuPolicy.isWebGpuInterfaceAvailable(),
    });
    const failures: string[] = [];
    for (const backend of attempts) {
      try {
        const session = attemptGpu(backend);
        return backend === 'webgpu'
          ? await gpuPolicy.withDeadline(
            session,
            gpuPolicy.WEBGPU_ADAPTER_TIMEOUT_MS,
            () => new Error('WebGPU adapter request timed out'),
          )
          : await session;
      } catch (error) {
        if (signal?.aborted) throw error;
        failures.push(`${backend}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const skippedWebGpu = !attempts.includes('webgpu');
    const detail = skippedWebGpu
      ? `WebGPU skipped in framed/unavailable context; ${failures.join('; ') || 'no GPU backend succeeded'}`
      : failures.join('; ') || 'no GPU backend succeeded';
    return createCanvasFallback(host, requestedBackend, `GPU initialization failed (${detail}).`);
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
  const nextBackend = gpuPolicy.nextBackendAfterLoss(requestedBackend, failedBackend);
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
