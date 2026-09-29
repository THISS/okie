import { describe, expect, it } from 'vitest';
import { handlePublicAtlasRoute, isPublicAtlasRoutePath } from './publicAtlasRoutes';
import { pngSignatureOk } from './atlasCard';

const INDEX = '<!doctype html><html><head><title>Atlas</title></head><body><div id="root"></div></body></html>';
const base = {
  method: 'GET',
  search: '',
  requestOrigin: 'http://localhost:4173',
  allowedOrigins: [] as string[],
  indexHtml: async () => INDEX,
};

describe('public atlas route dispatcher (CLA-266)', () => {
  it('claims only /r, /og, /oembed and the /new landing', () => {
    expect(isPublicAtlasRoutePath('/r/acme/app')).toBe(true);
    expect(isPublicAtlasRoutePath('/og/acme/app')).toBe(true);
    expect(isPublicAtlasRoutePath('/oembed')).toBe(true);
    expect(isPublicAtlasRoutePath('/oembed/')).toBe(true);
    expect(isPublicAtlasRoutePath('/')).toBe(false);
    expect(isPublicAtlasRoutePath('/new')).toBe(true);
    expect(isPublicAtlasRoutePath('/new/extra')).toBe(false);
    expect(isPublicAtlasRoutePath('/scan/index.json')).toBe(false);
    expect(isPublicAtlasRoutePath('/r/%E0%A4%A/x')).toBe(false);
  });

  it('answers share HTML, PNG and oEmbed through one injected lookup', async () => {
    const seen: string[] = [];
    const isPublicAtlas = (owner: string, repo: string) => { seen.push(`${owner}/${repo}`); return owner === 'acme'; };
    const html = await handlePublicAtlasRoute({ ...base, pathname: '/r/acme/app', isPublicAtlas });
    expect(html?.status).toBe(200);
    expect(String(html?.body)).toContain('property="og:image" content="http://localhost:4173/og/acme/app"');
    const png = await handlePublicAtlasRoute({ ...base, pathname: '/og/acme/app', isPublicAtlas });
    expect(png?.headers['content-type']).toBe('image/png');
    expect(pngSignatureOk(png?.body as Uint8Array)).toBe(true);
    const oembed = await handlePublicAtlasRoute({ ...base, pathname: '/oembed', search: `?url=${encodeURIComponent('http://localhost:4173/r/acme/app')}`, isPublicAtlas });
    expect(oembed?.status).toBe(200);
    expect(JSON.parse(String(oembed?.body))).toMatchObject({ type: 'rich', thumbnail_url: 'http://localhost:4173/og/acme/app' });
    expect(seen).toEqual(['acme/app', 'acme/app', 'acme/app']);
    expect((await handlePublicAtlasRoute({ ...base, pathname: '/r/other/app', isPublicAtlas }))?.status).toBe(404);
    const landing = await handlePublicAtlasRoute({ ...base, pathname: '/new', isPublicAtlas });
    expect(landing?.status).toBe(200);
    expect(String(landing?.body)).toContain('<title>Published atlases · Source For Atlas</title>');
    // No shell to inject into: the landing falls through to the static SPA answer.
    expect(await handlePublicAtlasRoute({ ...base, pathname: '/new', isPublicAtlas, indexHtml: async () => '' })).toBeUndefined();
    expect(seen).toEqual(['acme/app', 'acme/app', 'acme/app', 'other/app']);
  });
});
