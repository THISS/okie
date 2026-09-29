import {
  autoGpuAttemptOrder,
  EMBED_FRAME_IDLE_KICK_MS,
  isFramedBrowsingContext,
  isUsableAtlasViewport,
  isWebGpuInterfaceAvailable,
  WEBGPU_ADAPTER_TIMEOUT_MS,
  withDeadline,
} from '../embedCanvas';
// Also App.tsx's import point for the embed-chrome helpers (brandHomeLinkProps, initialInspectorOpen, isEmbedChrome, ...).
import { brandHomeLinkProps, initialInspectorOpen, isEmbedChrome, isEmbedQueryFlag } from '../embedChrome';

export {
  autoGpuAttemptOrder,
  brandHomeLinkProps,
  EMBED_FRAME_IDLE_KICK_MS,
  initialInspectorOpen,
  isEmbedChrome,
  isEmbedQueryFlag,
  isFramedBrowsingContext,
  isUsableAtlasViewport,
  isWebGpuInterfaceAvailable,
  WEBGPU_ADAPTER_TIMEOUT_MS,
  withDeadline,
};

export type RecoveryBackend = 'webgl2' | 'canvas2d';

export function nextBackendAfterLoss(requestedBackend: string, failedBackend: string): RecoveryBackend {
  return requestedBackend === 'auto' && failedBackend.toLowerCase() === 'webgpu' ? 'webgl2' : 'canvas2d';
}

export function listenForWebGlContextLoss(canvas: EventTarget, onLoss: (message: string) => void) {
  const handleLoss = (event: Event) => {
    event.preventDefault();
    onLoss('WebGL context lost.');
  };
  canvas.addEventListener('webglcontextlost', handleLoss);
  return () => canvas.removeEventListener('webglcontextlost', handleLoss);
}
