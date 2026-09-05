import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCAN_BAND_DEPTH_MIN_ENTITIES } from './renderer/scanFixture';
import { OEMBED_DEFAULT_HEIGHT, OEMBED_DEFAULT_WIDTH, OEMBED_EMBED_PARAM, OEMBED_SNIPPET_CHROME_NOTE } from './oembed';
import {
  INSPECTOR_OVERLAY_MAX_WIDTH,
  initialInspectorOpen,
  isEmbedChrome,
  isEmbedQueryFlag,
  shouldAutoOpenInspector,
} from './embedChrome';

describe('CLA-85 embed chrome vs Overview overlay', () => {
  it('does not auto-open the inspector at the default oEmbed 800×560 size', () => {
    expect(OEMBED_DEFAULT_WIDTH).toBe(800);
    expect(OEMBED_DEFAULT_HEIGHT).toBe(560);
    expect(OEMBED_DEFAULT_WIDTH).toBeLessThanOrEqual(INSPECTOR_OVERLAY_MAX_WIDTH);
    expect(shouldAutoOpenInspector({ width: OEMBED_DEFAULT_WIDTH })).toBe(false);
    expect(shouldAutoOpenInspector({ width: INSPECTOR_OVERLAY_MAX_WIDTH })).toBe(false);
    expect(shouldAutoOpenInspector({ width: 781 })).toBe(false);
  });

  it('auto-opens beside the map only when the overlay breakpoint is cleared', () => {
    expect(shouldAutoOpenInspector({ width: INSPECTOR_OVERLAY_MAX_WIDTH + 1 })).toBe(true);
    expect(shouldAutoOpenInspector({ width: 1280 })).toBe(true);
  });

  it('keeps framed and ?embed=1 chrome map-first even on a wide viewport', () => {
    expect(isEmbedQueryFlag('?embed=1')).toBe(true);
    expect(isEmbedQueryFlag('embed=1')).toBe(true);
    expect(isEmbedQueryFlag('?nav=1&embed=1')).toBe(true);
    expect(isEmbedQueryFlag('?embed=true')).toBe(false);
    expect(isEmbedQueryFlag('')).toBe(false);
    expect(isEmbedChrome({ framed: true })).toBe(true);
    expect(isEmbedChrome({ embedQuery: true })).toBe(true);
    expect(isEmbedChrome({ framed: false, embedQuery: false })).toBe(false);
    expect(shouldAutoOpenInspector({ width: 1400, framed: true })).toBe(false);
    expect(shouldAutoOpenInspector({ width: 1400, embedQuery: true })).toBe(false);
    expect(initialInspectorOpen({ innerWidth: OEMBED_DEFAULT_WIDTH, self: {}, top: {} }, '')).toBe(false);
    expect(initialInspectorOpen({ innerWidth: 1400, self: 'same', top: 'same' }, '?embed=1')).toBe(false);
    expect(initialInspectorOpen({ innerWidth: 1400, self: 'same', top: 'same' }, '')).toBe(true);
  });

  it('documents reduced chrome in the oEmbed snippet without keys or host paths', () => {
    expect(OEMBED_SNIPPET_CHROME_NOTE).toMatch(/inspector Overview one-pager starts collapsed/);
    expect(OEMBED_SNIPPET_CHROME_NOTE).toMatch(/800×560/);
    expect(OEMBED_SNIPPET_CHROME_NOTE).toMatch(/Overview tour stays on the map/);
    expect(OEMBED_SNIPPET_CHROME_NOTE).toMatch(/Ask Atlas is hidden/);
    expect(OEMBED_SNIPPET_CHROME_NOTE).not.toMatch(/apiKey|OPENROUTER|GITHUB_TOKEN|GH_TOKEN|scanRoot|--/);
    expect(OEMBED_EMBED_PARAM).toBe('embed');
  });

  it('wires overlay width, embed flag, and data-embed in the shell and CSS', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    const oembed = readFileSync(new URL('./oembed.ts', import.meta.url), 'utf8');
    expect(css).toContain('@media (max-width: 900px)');
    expect(css).toContain('.app-shell[data-embed="true"]');
    expect(css).toContain('.app-shell[data-embed="true"] .saved-story { display: flex; }');
    expect(css).toContain('.app-shell[data-embed="true"] .ask-button { display: none; }');
    expect(app).toContain('initialInspectorOpen()');
    expect(app).toContain("data-embed={isEmbedChrome({ framed: isFramedBrowsingContext(), embedQuery: isEmbedQueryFlag(window.location.search) }) ? 'true' : 'false'}");
    expect(app).toContain("preserveParams: preservedNavigationParams");
    expect(app).toContain("'embed'");
    expect(oembed).toContain('publicAtlasEmbedHref');
    expect(oembed).toContain('OEMBED_SNIPPET_CHROME_NOTE');
    expect(app).not.toMatch(/scanRoot|OPENROUTER_API_KEY|apiKey/);
  });

  it('does not raise the 2000 hang-guard or rewrite CLA-66', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    const fixture = readFileSync(new URL('./renderer/scanFixture.ts', import.meta.url), 'utf8');
    expect(fixture).toContain('export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;');
  });
});
