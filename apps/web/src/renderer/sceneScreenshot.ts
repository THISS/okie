import { Canvas2DRenderer } from './Canvas2DRenderer';
import type { AtlasScene, Camera, RenderState } from './types';

export type SceneScreenshotInput = {
  scene: AtlasScene;
  camera: Camera;
  width: number;
  height: number;
  devicePixelRatio?: number;
  renderState: RenderState;
};

type CaptureRenderer = Pick<Canvas2DRenderer, 'setScene' | 'setCamera' | 'setRenderState' | 'resize' | 'render' | 'dispose'>;
export type CaptureRendererFactory = (canvas: HTMLCanvasElement) => CaptureRenderer;

const defaultRendererFactory: CaptureRendererFactory = canvas => new Canvas2DRenderer(canvas, 'canvas2d', 'screenshot');

/**
 * Deterministic screenshot filename: `okie-<view-slug>-<timestamp>.png`. Pure; the timestamp
 * is injected (never read from the clock here) so it is unit-testable.
 */
export function screenshotFilename(viewTitle: string, timestamp: number): string {
  const slug = viewTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'view';
  const stamp = new Date(timestamp).toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `okie-${slug}-${stamp}.png`;
}

/**
 * Render the current scene/camera into `canvas` through an isolated Canvas2DRenderer. The 2D
 * fallback is a full renderer whose cross-backend parity is held by
 * `renderer/canvasRouteParity.qa.test.ts`, so this avoids unreliable live GPU-canvas readback
 * (WebGPU/WebGL compositing). The renderer factory is injectable for tests. Disposing only clears
 * the renderer's scene reference — the canvas pixels are retained for readback.
 */
export function drawSceneForCapture(
  canvas: HTMLCanvasElement,
  input: SceneScreenshotInput,
  createRenderer: CaptureRendererFactory = defaultRendererFactory,
): void {
  const renderer = createRenderer(canvas);
  try {
    renderer.setScene(input.scene);
    renderer.setCamera(input.camera);
    renderer.setRenderState(input.renderState);
    renderer.resize(Math.max(1, Math.round(input.width)), Math.max(1, Math.round(input.height)), input.devicePixelRatio ?? 1);
    renderer.render(0);
  } finally {
    renderer.dispose();
  }
}

/** Capture the current scene as a PNG blob via an offscreen canvas. Browser-only (needs `toBlob`). */
export async function captureSceneBlob(input: SceneScreenshotInput, createRenderer?: CaptureRendererFactory): Promise<Blob> {
  const canvas = document.createElement('canvas');
  drawSceneForCapture(canvas, input, createRenderer);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('Canvas produced no image data.'))), 'image/png');
  });
}

/** Trigger a browser download of `blob` under `filename`. Browser-only. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
