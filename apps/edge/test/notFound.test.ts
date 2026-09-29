import { describe, expect, it } from 'vitest';
import { NOT_FOUND_CACHE_CONTROL, notFoundPageHtml } from '../../web/src/notFoundPage';
import { edgeFetch, seedAtlas } from './helpers';

/** CLA-318: unknown routes and unknown atlases are a branded page with a real 404; real files are untouched. */
describe('branded 404 at the edge', () => {
  it('404s paths the SPA does not route with the static branded page', async () => {
    for (const path of ['/zzz', '/new/extra', '/r', '/r/acme', '/R/acme/app', '/operator/x', '/about/', '/zzz.html', '/some/client/route?x=1']) {
      const response = await edgeFetch(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get('content-type'), path).toBe('text/html; charset=utf-8');
      expect(response.headers.get('cache-control'), path).toBe(NOT_FOUND_CACHE_CONTROL);
      const html = await response.text();
      expect(html, path).toBe(notFoundPageHtml('page'));
      expect(html, path).not.toContain('<div id="root">');
    }
  });

  it('keeps HEAD bodiless', async () => {
    const head = await edgeFetch('/zzz', { init: { method: 'HEAD' } });
    expect(head.status).toBe(404);
    expect(head.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await head.text()).toBe('');
    const atlasHead = await edgeFetch('/r/foo/bar', { init: { method: 'HEAD' } });
    expect(atlasHead.status).toBe(404);
    expect(await atlasHead.text()).toBe('');
  });

  it('gives an unknown atlas the same page with atlas wording', async () => {
    const response = await edgeFetch('/r/foo/bar');
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe(NOT_FOUND_CACHE_CONTROL);
    const html = await response.text();
    expect(html).toBe(notFoundPageHtml('atlas'));
    expect(html).toContain('href="/new"');
    expect(html).toContain('hello@sourcefor.dev');
  });

  it('still serves the SPA routes, real static files and Worker-owned prefixes', async () => {
    await seedAtlas({ slug: 'acme__known', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    for (const path of ['/', '/new', '/new/', '/operator', '/operator/', '/r/acme/known', '/r/acme/known/main/src', '/?fixture=okie']) {
      const response = await edgeFetch(path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain('<div id="root"></div>');
    }
    const favicon = await edgeFetch('/favicon.svg');
    expect(favicon.status).toBe(200);
    expect(favicon.headers.get('content-type')).toMatch(/^image\/svg\+xml/);
    const robots = await edgeFetch('/robots.txt');
    expect(robots.status).toBe(200);
    expect(await robots.text()).toContain('User-agent');
    // _headers is config, never a served file.
    expect((await edgeFetch('/_headers')).status).toBe(404);
    // Hashed assets keep their own uncacheable plain 404; JSON prefixes keep JSON.
    const asset = await edgeFetch('/assets/missing-abc.js');
    expect(asset.status).toBe(404);
    expect(asset.headers.get('cache-control')).toBe('no-store');
    expect(await asset.text()).toBe('not found\n');
    const api = await edgeFetch('/api/nope');
    expect(api.status).toBe(404);
    expect(api.headers.get('content-type')).toMatch(/json/);
    const scan = await edgeFetch('/scan/nobody__here/snapshot.json');
    expect(scan.status).toBe(404);
    expect(scan.headers.get('content-type')).toMatch(/json/);
  });
});
