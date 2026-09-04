/**
 * CLA-72: public atlas views are framed by docs-site oEmbed (a different origin
 * by design). WebGPU is Permissions-Policy `gpu=(self)` by default, so a
 * cross-origin iframe must skip or time out the WebGPU adapter instead of
 * hanging on a blank canvas. Origin-keyed agent clustering is omitted for
 * framed documents so WebGL2/Canvas2D can still present.
 */

export const USABLE_ATLAS_VIEWPORT_MIN = 32;
export const WEBGPU_ADAPTER_TIMEOUT_MS = 1_500;
export const EMBED_FRAME_IDLE_KICK_MS = 32;

export type GpuAttemptBackend = 'webgpu' | 'webgl2';

export type FrameDestHeader = string | string[] | undefined;

const FRAMED_FETCH_DEST = new Set(['iframe', 'embed', 'object', 'frame']);

export function firstHeaderToken(value: FrameDestHeader): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const token = raw?.split(',')[0]?.trim();
  return token || undefined;
}

/** True when this document is inside an iframe/embed (including cross-origin). */
export function isFramedBrowsingContext(win: { self: unknown; top: unknown } = window): boolean {
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}

export function isUsableAtlasViewport(size: { width: number; height: number }): boolean {
  return size.width >= USABLE_ATLAS_VIEWPORT_MIN && size.height >= USABLE_ATLAS_VIEWPORT_MIN;
}

export function isWebGpuInterfaceAvailable(nav: { gpu?: unknown } = navigator): boolean {
  return nav.gpu != null;
}

export function isFramedFetchDest(dest: FrameDestHeader): boolean {
  const token = firstHeaderToken(dest)?.toLowerCase();
  return Boolean(token && FRAMED_FETCH_DEST.has(token));
}

/**
 * Auto backend order for a public atlas. Framed views (oEmbed) skip WebGPU so
 * a permissions-policy denial cannot hang before WebGL2/Canvas2D fallback.
 */
export function autoGpuAttemptOrder(input: {
  framed: boolean;
  webGpuAvailable: boolean;
}): GpuAttemptBackend[] {
  if (input.framed || !input.webGpuAvailable) return ['webgl2'];
  return ['webgpu', 'webgl2'];
}

export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}
