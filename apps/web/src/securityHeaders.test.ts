import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { handlePublicAtlasRoute } from './publicAtlasRoutes';
import { publishedNamesFor } from './publishedNames';
import { publishedListLabel } from './scanLanding';
import { contentSecurityPolicy, isFramableAtlasPath, securityHeadersFor } from './securityHeaders';

describe('security headers (CLA-318)', () => {
  it('adds the CSP to HTML only, framable on atlas routes', () => {
    expect(securityHeadersFor('/', 'text/html; charset=utf-8')).toEqual({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'content-security-policy': contentSecurityPolicy({ framable: false }),
    });
    expect(securityHeadersFor('/r/acme/app', 'text/html')['content-security-policy']).not.toContain('frame-ancestors');
    expect(securityHeadersFor('/r/acme/app', 'text/html')['content-security-policy']).toContain("object-src 'none'");
    expect(securityHeadersFor('/new', 'TEXT/HTML')['content-security-policy']).toContain("frame-ancestors 'self'");
    for (const type of ['application/json', 'image/png', 'application/xml', null]) {
      expect(securityHeadersFor('/r/acme/app', type), String(type)).toEqual({ 'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin' });
    }
    expect(isFramableAtlasPath('/r/acme/app/main/src')).toBe(true);
    expect(isFramableAtlasPath('/r/%E0%A4%A/app')).toBe(false);
    expect(isFramableAtlasPath('/og/acme/app')).toBe(false);
  });

  it('the shell has no inline script (the built dist/index.html when present), so script-src stays strict', () => {
    // The build output is what the edge serves; without a build (plain `pnpm test`) check the source shell.
    const built = new URL('../dist/index.html', import.meta.url);
    const html = readFileSync(existsSync(built) ? built : new URL('../index.html', import.meta.url), 'utf8');
    const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(script).toMatch(/^<script\b[^>]*\bsrc=/);
      expect(script).toMatch(/>\s*<\/script>$/);
    }
    expect(contentSecurityPolicy({ framable: false })).toMatch(/script-src 'self' 'wasm-unsafe-eval';/);
  });

  it('allows Cloudflare Web Analytics only when the edge injects it', () => {
    for (const framable of [false, true]) {
      const off = contentSecurityPolicy({ framable });
      const on = contentSecurityPolicy({ framable, webAnalytics: true });
      expect(off).not.toContain('cloudflareinsights');
      expect(on).toContain("script-src 'self' 'wasm-unsafe-eval' https://static.cloudflareinsights.com;");
      expect(on).toContain("connect-src 'self' https://raw.githubusercontent.com https://cloudflareinsights.com;");
      expect(on.replace(' https://static.cloudflareinsights.com', '').replace(' https://cloudflareinsights.com', '')).toBe(off);
    }
    expect(securityHeadersFor('/', 'text/html')['content-security-policy']).not.toContain('cloudflareinsights');
    expect(securityHeadersFor('/', 'text/html', { webAnalytics: true })['content-security-policy']).toBe(contentSecurityPolicy({ framable: false, webAnalytics: true }));
    expect(securityHeadersFor('/r/acme/app', 'text/html', { webAnalytics: true })['content-security-policy']).toBe(contentSecurityPolicy({ framable: true, webAnalytics: true }));
    expect(securityHeadersFor('/', 'application/json', { webAnalytics: true })).not.toHaveProperty('content-security-policy');
  });

  it('vite preview mirrors the headers; vite dev never gets the CSP (HMR uses inline scripts)', () => {
    const config = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    const plugin = config.slice(config.indexOf('function okieSecurityHeadersPlugin'), config.indexOf('function okieOpenGraphPlugin'));
    expect(plugin).toContain('configurePreviewServer');
    expect(plugin).not.toContain('configureServer');
    expect(config).toContain('okieSecurityHeadersPlugin()');
  });
});

describe('GitHub casing for published atlases (CLA-318)', () => {
  it('prefers ownerLogin/repoName, falling back to the stored names', () => {
    expect(publishedNamesFor({ owner: 'burntsushi', repo: 'ripgrep', ownerLogin: 'BurntSushi', repoName: 'ripgrep' })).toEqual({ owner: 'BurntSushi', repo: 'ripgrep', canonical: true });
    expect(publishedNamesFor({ owner: 'burntsushi', repo: 'ripgrep' })).toEqual({ owner: 'burntsushi', repo: 'ripgrep', canonical: false });
    expect(publishedNamesFor({ owner: 'burntsushi', repo: 'ripgrep', ownerLogin: 'Other', repoName: 'ripgrep' })?.owner).toBe('burntsushi');
    expect(publishedNamesFor({ owner: 'a/b', repo: 'c' })).toBeUndefined();
    expect(publishedNamesFor(null)).toBeUndefined();
  });

  it('labels the /new list with GitHub casing, the stored names, else the slug', () => {
    const base = { slug: 'burnt-sushi__ripgrep', commitSha: 'abc', entityCount: 1 };
    expect(publishedListLabel({ ...base, owner: 'burntsushi', repo: 'ripgrep', ownerLogin: 'BurntSushi', repoName: 'ripgrep' })).toBe('BurntSushi/ripgrep');
    expect(publishedListLabel({ ...base, owner: 'burntsushi', repo: 'ripgrep' })).toBe('burntsushi/ripgrep');
    expect(publishedListLabel(base)).toBe('burnt-sushi/ripgrep'); // a local scan manifest row
  });

  it('share HTML, oEmbed and cards show the looked-up names; URLs keep the route', async () => {
    const input = {
      method: 'GET',
      search: '',
      requestOrigin: 'https://sourcefor.dev',
      allowedOrigins: ['https://sourcefor.dev'],
      isPublicAtlas: async () => true,
      displayNames: async () => ({ owner: 'BurntSushi', repo: 'ripgrep' }),
      indexHtml: async () => '<html><head><title>x</title></head><body></body></html>',
    };
    const page = await handlePublicAtlasRoute({ ...input, pathname: '/r/burnt-sushi/ripgrep' });
    expect(page?.body).toContain('<title>ripgrep by BurntSushi · Source For Atlas</title>');
    expect(page?.body).toContain('<link rel="canonical" href="https://sourcefor.dev/r/burnt-sushi/ripgrep" />');
    const oembed = await handlePublicAtlasRoute({ ...input, pathname: '/oembed', search: `?url=${encodeURIComponent('https://sourcefor.dev/r/burnt-sushi/ripgrep')}` });
    expect(JSON.parse(String(oembed?.body)).title).toBe('BurntSushi/ripgrep architecture atlas');
    // A failing lookup shows the URL's names instead of failing the page.
    const failing = await handlePublicAtlasRoute({ ...input, pathname: '/r/burnt-sushi/ripgrep', displayNames: async () => { throw new Error('r2 down'); } });
    expect(failing?.status).toBe(200);
    expect(failing?.body).toContain('<title>ripgrep by burnt-sushi · Source For Atlas</title>');
    const card = await handlePublicAtlasRoute({ ...input, pathname: '/og/burnt-sushi/ripgrep' });
    expect(card?.status).toBe(200);
  });
});
