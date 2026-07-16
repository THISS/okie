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
