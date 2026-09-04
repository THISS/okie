import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  autoGpuAttemptOrder,
  EMBED_FRAME_IDLE_KICK_MS,
  isFramedBrowsingContext,
  isFramedFetchDest,
  isUsableAtlasViewport,
  isWebGpuInterfaceAvailable,
  USABLE_ATLAS_VIEWPORT_MIN,
  WEBGPU_ADAPTER_TIMEOUT_MS,
  withDeadline,
} from './embedCanvas';
import { OEMBED_DEFAULT_HEIGHT, OEMBED_DEFAULT_WIDTH } from './oembed';
import { webMcpHostHeadersForFetchDest, WEBMCP_HOST_HEADERS } from './webmcp';

describe('CLA-72 embed canvas boot', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats cross-origin iframe comparison as framed, even when top throws', () => {
    expect(isFramedBrowsingContext({ self: {}, top: {} })).toBe(true);
    expect(isFramedBrowsingContext({ self: 'same', top: 'same' })).toBe(false);
    expect(isFramedBrowsingContext({
      get self() { return this; },
      get top() { throw new Error('Blocked a frame with origin'); },
    })).toBe(true);
  });

  it('does not consume the initialize fit on a degenerate iframe viewport', () => {
    expect(isUsableAtlasViewport({ width: 1, height: 1 })).toBe(false);
    expect(isUsableAtlasViewport({ width: USABLE_ATLAS_VIEWPORT_MIN - 1, height: 400 })).toBe(false);
    expect(isUsableAtlasViewport({ width: OEMBED_DEFAULT_WIDTH, height: OEMBED_DEFAULT_HEIGHT })).toBe(true);
  });

  it('skips WebGPU in framed auto mode and when navigator.gpu is missing', () => {
    expect(isWebGpuInterfaceAvailable({})).toBe(false);
    expect(isWebGpuInterfaceAvailable({ gpu: {} })).toBe(true);
    expect(autoGpuAttemptOrder({ framed: true, webGpuAvailable: true })).toEqual(['webgl2']);
    expect(autoGpuAttemptOrder({ framed: false, webGpuAvailable: false })).toEqual(['webgl2']);
    expect(autoGpuAttemptOrder({ framed: false, webGpuAvailable: true })).toEqual(['webgpu', 'webgl2']);
  });

  it('times out a hung WebGPU adapter instead of waiting forever', async () => {
    vi.useFakeTimers();
    const hung = withDeadline(
      new Promise<string>(() => {}),
      WEBGPU_ADAPTER_TIMEOUT_MS,
      () => new Error('WebGPU adapter request timed out'),
    );
    const caught = hung.then(
      () => { throw new Error('expected timeout'); },
      error => error as Error,
    );
    await vi.advanceTimersByTimeAsync(WEBGPU_ADAPTER_TIMEOUT_MS);
    await expect(caught).resolves.toMatchObject({ message: 'WebGPU adapter request timed out' });
  });

  it('omits Origin-Agent-Cluster for iframe fetch dest without widening tools', () => {
    expect(isFramedFetchDest('iframe')).toBe(true);
    expect(isFramedFetchDest('document')).toBe(false);
    const framed = webMcpHostHeadersForFetchDest('iframe');
    expect(framed['Permissions-Policy']).toBe('tools=(self)');
    expect(framed).not.toHaveProperty('Origin-Agent-Cluster');
    expect(webMcpHostHeadersForFetchDest('document')).toEqual(WEBMCP_HOST_HEADERS);
    expect(JSON.stringify(framed)).not.toMatch(/apiKey|OPENROUTER|GITHUB_TOKEN|scanRoot/);
  });

  it('keeps the oEmbed iframe allowlist GPU-capable, 800×560, and key-free', () => {
    const oembed = readFileSync(new URL('./oembed.ts', import.meta.url), 'utf8');
    expect(oembed).toContain("allow=\"${OEMBED_IFRAME_ALLOW}\"");
    expect(oembed).toContain("export const OEMBED_IFRAME_ALLOW = 'fullscreen; gpu'");
    expect(oembed).toContain('allowfullscreen');
    expect(oembed).not.toMatch(/apiKey|OPENROUTER|GITHUB_TOKEN|GH_TOKEN|scanRoot/);
    expect(EMBED_FRAME_IDLE_KICK_MS).toBeGreaterThan(0);
  });
});
