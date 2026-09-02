import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OEMBED_THUMBNAIL_HEIGHT, OEMBED_THUMBNAIL_WIDTH, publicAtlasOgImageHref } from './oembed';
import {
  ATLAS_NOT_FOUND_BODY,
  buildOpenGraphTags,
  handleOgImageRequest,
  handleShareHtmlRequest,
  injectPublicAtlasOpenGraph,
  LOCAL_SCAN_ORIGIN,
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
    expect(html).toContain('<meta property="og:title" content="THISS/okie architecture atlas" />');
    expect(html).toContain('<meta property="og:description" content="Public architecture atlas for THISS/okie." />');
    expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/og/THISS/okie" />`);
    expect(html).not.toMatch(/property="og:image" content="[^"]*favicon\.ico"/);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain('<meta name="twitter:title" content="THISS/okie architecture atlas" />');
    expect(html).toContain('<meta name="twitter:description" content="Public architecture atlas for THISS/okie." />');
    expect(html).toContain(`<meta name="twitter:image" content="${ORIGIN}/og/THISS/okie" />`);
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
    expect(tags.title).toBe('THISS/okie architecture atlas');
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
    })).toBe('Public architecture atlas for THISS/okie.');
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
    expect(trustedScanLookupOrigin('http://127.0.0.1:65534')).toBe(LOCAL_SCAN_ORIGIN);
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
  });

  it('wires Vite and Vercel to intercept share HTML and OG images', () => {
    const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    expect(viteConfig).toContain('okieOpenGraphPlugin');
    expect(viteConfig).toContain('handleShareHtmlRequest');
    expect(viteConfig).toContain('handleOgImageRequest');
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
      rewrites: Array<{ source: string; destination: string }>;
    };
    expect(vercel.rewrites).toEqual(expect.arrayContaining([
      { source: '/og/:owner/:repo', destination: '/api/og?owner=:owner&repo=:repo' },
      { source: '/r/:owner/:repo', destination: '/api/share?owner=:owner&repo=:repo' },
    ]));
    const shareFn = readFileSync(new URL('../api/share.ts', import.meta.url), 'utf8');
    const ogFn = readFileSync(new URL('../api/og.ts', import.meta.url), 'utf8');
    expect(shareFn).toContain('trustedShareOrigin');
    expect(shareFn).toContain('trustedScanLookupOrigin');
    expect(ogFn).toContain('trustedScanLookupOrigin');
    expect(shareFn).not.toMatch(/OPENROUTER_API_KEY|GITHUB_TOKEN|GH_TOKEN/);
    expect(ogFn).not.toMatch(/OPENROUTER_API_KEY|GITHUB_TOKEN|GH_TOKEN/);
  });
});
