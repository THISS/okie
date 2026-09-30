import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OEMBED_THUMBNAIL_HEIGHT, OEMBED_THUMBNAIL_WIDTH, publicAtlasOgImageHref } from './oembed';
import {
  ATLAS_NOT_FOUND_BODY,
  buildOpenGraphTags,
  handleOgImageRequest,
  handleShareHtmlRequest,
  injectPublicAtlasOpenGraph,
  DEFAULT_LOCAL_SCAN_ORIGIN,
  isTrustedScanOrigin,
  localScanOriginFromEnv,
  openGraphLeaksSecrets,
  parseOgImagePath,
  publicAtlasDescription,
  resolvePublicAtlasShare,
  trustedScanLookupOrigin,
  trustedShareOrigin,
} from './openGraph';
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, pngDimensions, pngSignatureOk } from './atlasCard';

const ORIGIN = 'http://localhost:4173';
const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="description" content="Atlas — a spatial explanation system for software." />
    <link rel="icon" href="/favicon.ico" type="image/svg+xml" />
    <title>Atlas · Okie architecture</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

describe('Open Graph for public atlas URLs (CLA-39)', () => {
  it('injects og and twitter tags for GET /r/THISS/okie (no login wall)', async () => {
    const result = await handleShareHtmlRequest({
      method: 'GET',
      pathname: '/r/THISS/okie',
      requestOrigin: ORIGIN,
      indexHtml: INDEX,
    });
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('text/html; charset=utf-8');
    const html = result.body as string;
    expect(html).toContain('<meta property="og:title" content="okie by THISS · Source For Atlas" />');
    expect(html).toContain('<meta property="og:description" content="Explore how THISS/okie is built: an architecture atlas from system context down to source, on Source For Atlas." />');
    expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/og/THISS/okie" />`);
    expect(html).not.toMatch(/property="og:image" content="[^"]*favicon\.ico"/);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain('<meta name="twitter:title" content="okie by THISS · Source For Atlas" />');
    expect(html).toContain('<meta name="twitter:description" content="Explore how THISS/okie is built: an architecture atlas from system context down to source, on Source For Atlas." />');
    expect(html).toContain(`<meta name="twitter:image" content="${ORIGIN}/og/THISS/okie" />`);
    // CLA-329: the embed page advertised as an Iframely player (honoured once Iframely has reviewed the domain).
    expect(html).toContain(`<link rel="iframely player" type="text/html" href="${ORIGIN}/r/THISS/okie?embed=1" media="aspect-ratio: 16/9" />`);
    expect(html).not.toMatch(/login|signin|oauth|authorize/i);
    expect(openGraphLeaksSecrets(html)).toBe(false);
    expect(html).toContain('id="root"');
  });

  it('reuses the same title and image as oEmbed', () => {
    const tags = buildOpenGraphTags({
      owner: 'THISS',
      repo: 'okie',
      search: '',
      origin: ORIGIN,
    });
    expect(tags.title).toBe('okie by THISS · Source For Atlas');
    expect(tags.imageAlt).toBe('THISS/okie architecture atlas');
    expect(tags.siteName).toBe('Source For Atlas');
    expect(tags.canonical).toBe('https://sourcefor.dev/r/thiss/okie');
    expect(tags.image).toBe(publicAtlasOgImageHref({
      owner: 'THISS',
      repo: 'okie',
      search: '',
      origin: ORIGIN,
    }));
    expect(tags.imageWidth).toBe(OEMBED_THUMBNAIL_WIDTH);
    expect(tags.imageHeight).toBe(OEMBED_THUMBNAIL_HEIGHT);
    expect(tags.imageWidth).toBe(OG_IMAGE_WIDTH);
    expect(tags.imageHeight).toBe(OG_IMAGE_HEIGHT);
    expect(publicAtlasDescription({
      owner: 'THISS',
      repo: 'okie',
      search: '',
      origin: ORIGIN,
    })).toBe('Explore how THISS/okie is built: an architecture atlas from system context down to source, on Source For Atlas.');
  });

  it('returns a PNG atlas card for /og/THISS/okie, not a logo file', async () => {
    const result = await handleOgImageRequest({
      method: 'GET',
      pathname: '/og/THISS/okie',
    });
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('image/png');
    const png = result.body as Uint8Array;
    expect(pngSignatureOk(png)).toBe(true);
    expect(pngDimensions(png)).toEqual({ width: 1200, height: 630 });
    expect(parseOgImagePath('/og/THISS/okie.png')).toEqual({ owner: 'THISS', repo: 'okie' });
  });

  it('404s unpublished and private trees with the same generic body (no leak)', async () => {
    const share = await handleShareHtmlRequest({
      method: 'GET',
      pathname: '/r/secret-org/private-tree',
      requestOrigin: ORIGIN,
      indexHtml: INDEX,
      isPublicAtlas: () => false,
    });
    expect(share.status).toBe(404);
    const html = share.body as string;
    expect(html).toBe(ATLAS_NOT_FOUND_BODY);
    expect(html).not.toContain('secret-org');
    expect(html).not.toContain('private-tree');
    expect(html).not.toMatch(/og:title|og:image|twitter:image/);
    expect(html).not.toMatch(/login|signin|oauth/i);
    expect(html).not.toMatch(/apiKey|OPENROUTER|GITHUB_TOKEN|exists|private repository/i);

    const image = await handleOgImageRequest({
      method: 'GET',
      pathname: '/og/secret-org/private-tree',
      isPublicAtlas: () => false,
    });
    expect(image.status).toBe(404);
    expect(String(image.body)).toBe('not found');
    expect(String(image.body)).not.toContain('secret-org');
  });

  it('does not fetch GitHub and treats a missing published snapshot as closed', async () => {
    let called = 0;
    const fetchImpl: typeof fetch = async (input) => {
      called += 1;
      const url = String(input);
      expect(url).toContain('/scan/acme__app/snapshot.json');
      expect(url).not.toContain('api.github.com');
      return new Response('not found', { status: 404 });
    };
    expect(await resolvePublicAtlasShare('THISS', 'okie', 'http://127.0.0.1:4180', fetchImpl)).toBe(true);
    expect(called).toBe(0);
    expect(await resolvePublicAtlasShare('acme', 'app', 'http://127.0.0.1:4180', fetchImpl)).toBe(false);
    expect(called).toBe(1);
    expect(await resolvePublicAtlasShare('acme', 'app', 'http://127.0.0.1:4180', async () => new Response('{}', { status: 200 }))).toBe(true);
  });

  it('does not fetch a caller-supplied loopback port and omits query secrets from meta', async () => {
    let called = 0;
    const fetchImpl: typeof fetch = async () => {
      called += 1;
      return new Response('{}', { status: 200 });
    };
    expect(await resolvePublicAtlasShare('acme', 'app', 'http://127.0.0.1:65534', fetchImpl)).toBe(false);
    expect(called).toBe(0);
    expect(trustedScanLookupOrigin('http://127.0.0.1:65534')).toBe(DEFAULT_LOCAL_SCAN_ORIGIN);
    expect(trustedShareOrigin({
      host: 'localhost:4173',
      'x-forwarded-host': '127.0.0.1:65534',
    })).toBe('http://localhost:4173');
    expect(trustedShareOrigin({
      'x-forwarded-host': '127.0.0.1:65534',
    })).toBeUndefined();

    const result = await handleShareHtmlRequest({
      method: 'GET',
      pathname: '/r/THISS/okie',
      search: '?api_key=okie-test-llm-key-cla39-fake&nav=1',
      requestOrigin: ORIGIN,
      indexHtml: INDEX,
    });
    const html = result.body as string;
    expect(result.status).toBe(200);
    expect(html).toContain(`property="og:url" content="${ORIGIN}/r/THISS/okie"`);
    expect(html).not.toContain('api_key');
    expect(html).not.toContain('okie-test-llm-key-cla39-fake');
    expect(html).not.toContain('nav=1');
  });

  it('strips the generic shell title when injecting tags', () => {
    const tags = buildOpenGraphTags({
      owner: 'THISS',
      repo: 'okie',
      search: '',
      origin: ORIGIN,
    });
    const html = injectPublicAtlasOpenGraph(INDEX, tags);
    expect(html).not.toContain('Atlas · Okie architecture');
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain('<title>okie by THISS · Source For Atlas</title>');
    // The shell's own canonical (the home page's) is replaced, never duplicated.
    const withCanonical = injectPublicAtlasOpenGraph(INDEX.replace('</head>', '<link rel="canonical" href="https://sourcefor.dev/" />\n</head>'), tags);
    expect(withCanonical.match(/rel="canonical"/g)).toHaveLength(1);
    expect(withCanonical).toContain('<link rel="canonical" href="https://sourcefor.dev/r/thiss/okie" />');
  });

  it('wires Vite and the edge Worker to the same runtime-agnostic share dispatcher', () => {
    const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    expect(viteConfig).toContain('okieOpenGraphPlugin');
    expect(viteConfig).toContain('handlePublicAtlasRoute');
    expect(viteConfig).toContain('localScanOriginFromEnv');
    expect(viteConfig).not.toMatch(/127\.0\.0\.1:4180/);
    const dispatcher = readFileSync(new URL('./publicAtlasRoutes.ts', import.meta.url), 'utf8');
    expect(dispatcher).toContain('handleShareHtmlRequest');
    expect(dispatcher).toContain('handleOgImageRequest');
    expect(dispatcher).toContain('handleOembedRequest');
    const edge = readFileSync(new URL('../../edge/src/share.ts', import.meta.url), 'utf8');
    expect(edge).toContain('handlePublicAtlasRoute');
    expect(`${viteConfig}\n${dispatcher}\n${edge}`).not.toMatch(/OPENROUTER_API_KEY|GITHUB_TOKEN|GH_TOKEN/);
  });

  it('configures the local scan origin instead of hard-coding port 4180', async () => {
    expect(localScanOriginFromEnv({})).toBe('http://127.0.0.1:4180');
    expect(localScanOriginFromEnv({ OKIE_SCAN_SERVER_PORT: '4195' })).toBe('http://127.0.0.1:4195');
    expect(localScanOriginFromEnv({ OKIE_SCAN_SERVER_PORT: 'nope' })).toBe('http://127.0.0.1:4180');
    expect(localScanOriginFromEnv({ OKIE_SCAN_ORIGIN: 'http://localhost:4197/' })).toBe('http://localhost:4197');
    expect(localScanOriginFromEnv({ OKIE_SCAN_ORIGIN: 'https://scan.example.test' })).toBe('https://scan.example.test');
    expect(localScanOriginFromEnv({ OKIE_SCAN_ORIGIN: 'http://scan.example.test', OKIE_SCAN_SERVER_PORT: '4195' })).toBe('http://127.0.0.1:4195');
    expect(isTrustedScanOrigin('http://127.0.0.1:4180')).toBe(true);
    expect(isTrustedScanOrigin('http://127.0.0.1:4195')).toBe(false);
    expect(isTrustedScanOrigin('http://127.0.0.1:4195', 'http://127.0.0.1:4195')).toBe(true);
    expect(isTrustedScanOrigin('http://127.0.0.1:4180', 'http://127.0.0.1:4195')).toBe(false);
    expect(trustedScanLookupOrigin('http://localhost:4173', [], 'http://127.0.0.1:4195')).toBe('http://127.0.0.1:4195');
    let fetched = '';
    const fetchImpl: typeof fetch = async input => { fetched = String(input); return new Response('{}', { status: 200 }); };
    expect(await resolvePublicAtlasShare('acme', 'app', 'http://127.0.0.1:4195', fetchImpl)).toBe(false);
    expect(await resolvePublicAtlasShare('acme', 'app', 'http://127.0.0.1:4195', fetchImpl, 'http://127.0.0.1:4195')).toBe(true);
    expect(fetched).toBe('http://127.0.0.1:4195/scan/acme__app/snapshot.json');
  });
});
