import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { SCAN_BAND_DEPTH_MIN_ENTITIES } from './renderer/scanFixture';
import { OEMBED_DEFAULT_HEIGHT, OEMBED_DEFAULT_WIDTH, OEMBED_EMBED_PARAM, OEMBED_SNIPPET_CHROME_NOTE } from './oembed';
import {
  brandHomeLinkProps,
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
    expect(OEMBED_SNIPPET_CHROME_NOTE).toMatch(/inspector Overview architecture brief starts collapsed/);
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
    expect(css).toContain('grid-template-rows: var(--topbar-height) minmax(0, 1fr)');
    expect(css).toContain('.app-shell[data-embed="true"] .saved-story { display: flex; }');
    expect(css).toContain('.app-shell[data-embed="true"] .ask-button { display: none; }');
    expect(css).toContain('.story-catalog-menu');
    expect(css).not.toContain('.app-shell[data-embed="true"] .story-catalog-menu { display: none; }');
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
    const fixture = (readFileSync(new URL('./renderer/scanFixture.ts', import.meta.url), 'utf8') + readFileSync(new URL('./renderer/scanScene.ts', import.meta.url), 'utf8'));
    expect(fixture).toContain('export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;');
  });
});

describe('CLA-269 atlas header brand link', () => {
  const topLevel = (() => { const win: { self?: unknown; top?: unknown } = {}; win.self = win; win.top = win; return win; })();
  const framed = { self: {}, top: {} };
  const plain = { href: '/', 'aria-label': 'Source For Atlas — home' };
  const newTab = { ...plain, target: '_blank', rel: 'noopener noreferrer' };

  it('links home in the same browsing context outside embeds (top-level, no ?embed=1)', () => {
    expect(brandHomeLinkProps(topLevel, '')).toEqual(plain);
    expect(brandHomeLinkProps(topLevel, '?fixture=golden')).toEqual(plain);
  });

  it('opens the site top-level in a new tab without an opener inside an embed', () => {
    // Framed (self !== top) without ?embed=1.
    expect(brandHomeLinkProps(framed, '')).toEqual(newTab);
    // Top-level with ?embed=1.
    expect(brandHomeLinkProps(topLevel, '?embed=1')).toEqual(newTab);
    // A cross-origin top that throws on access counts as framed.
    const throwing = { self: {}, get top(): unknown { throw new Error('cross-origin'); } };
    expect(brandHomeLinkProps(throwing, '')).toEqual(newTab);
  });

  it('defaults to the live window and location.search (the bare call App.tsx makes)', () => {
    vi.stubGlobal('window', { ...topLevel, location: { search: '?embed=1' } });
    try {
      expect(brandHomeLinkProps()).toEqual(newTab);
      const win: { self?: unknown; top?: unknown; location: { search: string } } = { location: { search: '' } };
      win.self = win; win.top = win;
      vi.stubGlobal('window', win);
      expect(brandHomeLinkProps()).toEqual(plain);
      vi.stubGlobal('window', { self: {}, top: {}, location: { search: '' } });
      expect(brandHomeLinkProps()).toEqual(newTab);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('is what the App header renders, as a link styled like the old block', () => {
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
    expect(app).toContain('<a className="brand-block" data-testid="atlas-brand-link" {...brandHomeLinkProps()}>');
    expect(app).not.toContain('<div className="brand-block"');
    // Only the mark + wordmark are clickable, not the whole grid column.
    expect(css).toMatch(/a\.brand-block \{ justify-self: start; color: inherit; text-decoration: none;/);
    expect(css).not.toMatch(/\.brand-block \{[^}]*(?:width: 100%|justify-self: stretch)/);
    // ≤780px: the wordmark hides and the link shrinks to the mark in the topbar's auto column.
    const narrowAt = css.indexOf('@media (max-width: 780px) {\n  .app-shell { --topbar-height: 60px; }');
    expect(narrowAt).toBeGreaterThan(0);
    const narrow = css.slice(narrowAt + 1);
    expect(narrow).toMatch(/^[^@]*\.topbar \{ grid-template-columns: auto 1fr auto;/);
    expect(narrow).toMatch(/^[^@]*\.brand-block > div:last-child \{ display: none; \}/);
    expect(css).toMatch(/a:focus-visible \{\s*outline: 2px solid/);
  });
});
