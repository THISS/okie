import { describe, expect, it } from 'vitest';
import { NOT_FOUND_CACHE_CONTROL, notFoundPageHtml } from '../../web/src/notFoundPage';
import { edgeFetch, seedAtlas, seedIndex } from './helpers';

/** CLA-318: unknown routes and unknown atlases are a branded page with a real 404; real files are untouched. */
describe('branded 404 at the edge', () => {
  it('serves the explicitly routed agent reference as HTML', async () => {
    const response = await edgeFetch('/docs/agents', { env: {
      ASSETS: { fetch: async () => new Response('<h1>Agent tools</h1>', { headers: { 'content-type': 'text/html; charset=utf-8' } }), connect: () => { throw new Error('No sockets in static docs test'); } },
    } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<h1>Agent tools</h1>');
    expect((await edgeFetch('/docs/missing.html')).status).toBe(404);
  });
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
    expect(html).toContain('href="/"'); // CLA-269: the directory is the home page
    expect(html).toContain('hello@sourcefor.dev');
  });

  /**
   * Every client-side URL shape the public app emits or accepts. From renderer/route.ts (parseAppRoute),
   * navigation/navigationState.ts (canonicalNavigationUrl rewrites only the query, keeping the pathname),
   * oembed.ts (the iframe target is /r/<o>/<r>[/<pin>]?embed=1), scanLanding.tsx (location.assign to
   * /r/<o>/<r>, /operator), main.tsx (?portable=1, ?fixture=) and the
   * CLA-266 case-variant 301. Story/selection/camera deep links are query state on these paths, and a
   * hash never reaches the server. Since CLA-269 `/` and `/index.html` without a query (or with only
   * search/sort/tracking params) are the server-rendered home page, `/new` 301s to `/` (home.test.ts), and
   * the attribution strip's About link is `/#about` (the home's footer; a hash never reaches the server).
   * The documented /embed/r/… path was never shipped (parseAppRoute has no such route), so it is not a
   * legacy link.
   */
  it('serves every public client route, including deep links with query state', async () => {
    await seedAtlas({ slug: 'acme__known', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    const deepNav = '?nav=1&repo=repo%3Aacme-known&snap=s1&view=v1&root=system%3Aacme&sel=container%3Aweb&cx=12.5&cy=-4&z=1.25';
    const routes = [
      '/?fixture=okie', '/?portable=1', '/?embed=1', `/${deepNav}`, `/index.html${deepNav}`,
      '/operator', '/operator/', '/operator?run=abc',
      '/r/acme/known', '/r/acme/known/', '/r/ACME/Known', '/r/acme/known?embed=1',
      `/r/acme/known${deepNav}`, `/r/acme/known${deepNav}&embed=1`,
      '/r/acme/known/main', '/r/acme/known/v1.2.3/src/app.ts', '/r/acme/known/main/src%2Fapp.ts',
    ];
    for (const path of routes) {
      const response = await edgeFetch(path);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toContain('<div id="root"></div>');
    }
    // Case/punctuation variants of a published atlas still reach the CLA-266 canonical 301, not the 404.
    await seedIndex([{ slug: 'burnt-sushi__ripgrep', versionId: 'v1', owner: 'burntsushi', repo: 'ripgrep' }]);
    await seedAtlas({ slug: 'burnt-sushi__ripgrep', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    const moved = await edgeFetch(`/r/burntsushi/ripgrep${deepNav}`);
    expect(moved.status).toBe(301);
    expect(moved.headers.get('location')).toBe(`/r/burnt-sushi/ripgrep${deepNav}`);
  });

  it('still serves the SPA routes, real static files and Worker-owned prefixes', async () => {
    await seedAtlas({ slug: 'acme__known', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    for (const path of ['/operator', '/operator/', '/r/acme/known', '/r/acme/known/main/src', '/?fixture=okie']) {
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
