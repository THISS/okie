import { describe, expect, it } from 'vitest';
import { pngDimensions, pngSignatureOk } from '../../web/src/atlasCard';
import { NOINDEX_ROBOTS_TXT } from '../src/http';
import { canonicalHostRedirect } from '../src/index';
import { edgeFetch, seedAtlas, seedIndex } from './helpers';

const ORIGIN = 'http://127.0.0.1:4196';

describe('share pages at the edge', () => {
  it('injects Open Graph tags into the static index.html for a published slug', async () => {
    await seedAtlas({ slug: 'acme__shared', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    const response = await edgeFetch('/r/acme/shared');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await response.text();
    expect(html).toContain('<title>shared by acme · Source For Atlas</title>');
    expect(html).toContain('<link rel="canonical" href="https://sourcefor.dev/r/acme/shared" />');
    expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/og/acme/shared" />`);
    expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/r/acme/shared" />`);
    expect(html).toContain('application/json+oembed');
    expect(html).toContain('/assets/index-abc123.js'); // the real shell, scripts intact
    expect(html).not.toContain('explore how open-source software is built</title>'); // the home shell's title is replaced
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    // WebMCP host headers on the HTML the Worker renders; framed views drop origin-keying.
    expect(response.headers.get('permissions-policy')).toBe('tools=(self)');
    expect(response.headers.get('origin-agent-cluster')).toBe('?1');
    const framed = await edgeFetch('/r/acme/shared', { init: { headers: { 'sec-fetch-dest': 'iframe' } } });
    expect(framed.headers.get('permissions-policy')).toBe('tools=(self)');
    expect(framed.headers.get('origin-agent-cluster')).toBeNull();
  });

  it('serves /new with landing meta and the default card; staging canonicalizes to production', async () => {
    const response = await edgeFetch('https://staging.sourcefor.dev/new', { env: { OKIE_PUBLIC_ORIGIN: 'https://staging.sourcefor.dev' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('permissions-policy')).toBe('tools=(self)');
    expect(response.headers.get('origin-agent-cluster')).toBe('?1');
    const html = await response.text();
    expect(html).toContain('<title>Published atlases · Source For Atlas</title>');
    expect(html).toContain('<meta property="og:image" content="https://staging.sourcefor.dev/og-default.png" />');
    expect(html).toContain('<link rel="canonical" href="https://sourcefor.dev/new" />');
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain('/assets/index-abc123.js');
    // `/` stays the static shell (its home-page meta is baked into index.html).
    const home = await (await edgeFetch('/')).text();
    expect(home).toContain('<link rel="canonical" href="https://sourcefor.dev/" />');
  });

  it('404s an unpublished slug with the generic body (dogfood THISS/okie is always public)', async () => {
    const response = await edgeFetch('/r/nobody/unpublished');
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('<h1>Atlas not found</h1>');
    expect((await edgeFetch('/r/THISS/okie')).status).toBe(200);
    // A version written but not yet pointed to by latest.json is not public.
    await seedAtlas({ slug: 'acme__pending', versionId: 'v1', files: { 'snapshot.json': '{}' }, latest: false });
    expect((await edgeFetch('/r/acme/pending')).status).toBe(404);
  });

  it('301s a GitHub-cased or lower-cased owner to the canonical published slug path', async () => {
    // The operator lower-cases BurntSushi/ripgrep; the scan slugger turns BurntSushi into burnt-sushi.
    await seedAtlas({ slug: 'burnt-sushi__ripgrep', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    await seedIndex([{ slug: 'burnt-sushi__ripgrep', versionId: 'v1', owner: 'burntsushi', repo: 'ripgrep' }]);
    for (const [path, location] of [
      ['/r/burntsushi/ripgrep', '/r/burnt-sushi/ripgrep'],
      ['/r/BURNTSUSHI/RipGrep?sel=x&z=2', '/r/burnt-sushi/ripgrep?sel=x&z=2'],
      ['/r/burntsushi/ripgrep/src/main.rs', '/r/burnt-sushi/ripgrep/src/main.rs'],
    ] as const) {
      const response = await edgeFetch(path);
      expect(response.status, path).toBe(301);
      expect(response.headers.get('location'), path).toBe(location);
    }
    // Paths that already resolve are served, not redirected.
    expect((await edgeFetch('/r/BurntSushi/ripgrep')).status).toBe(200);
    expect((await edgeFetch('/r/burnt-sushi/ripgrep')).status).toBe(200);
    // Both name the redirect target as their canonical (CLA-318).
    for (const path of ['/r/BurntSushi/ripgrep', '/r/burnt-sushi/ripgrep']) {
      expect(await (await edgeFetch(path)).text(), path).toContain('<link rel="canonical" href="https://sourcefor.dev/r/burnt-sushi/ripgrep" />');
    }
    // No loose match, a different repo, or a non-GET: the usual 404.
    expect((await edgeFetch('/r/burntsushi/ripgrep-extra')).status).toBe(404);
    expect((await edgeFetch('/r/someone/ripgrep')).status).toBe(404);
    expect((await edgeFetch('/r/burntsushi/ripgrep', { init: { method: 'POST', body: '' } })).status).not.toBe(301);
  });

  it('only trusts the configured public origin (plus loopback)', async () => {
    await seedAtlas({ slug: 'acme__origin', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    const forged = await edgeFetch('https://evil.example/r/acme/origin');
    expect(forged.status).toBe(404);
    const prod = await edgeFetch('https://sourcefor.dev/r/acme/origin', { env: { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev' } });
    expect(prod.status).toBe(200);
    expect(await prod.text()).toContain('content="https://sourcefor.dev/og/acme/origin"');
  });

  it('renders the OG PNG in workerd (node:zlib via nodejs_compat)', async () => {
    await seedAtlas({ slug: 'acme__card', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    const response = await edgeFetch('/og/acme/card');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(pngSignatureOk(bytes)).toBe(true);
    expect(pngDimensions(bytes)).toEqual({ width: 1200, height: 630 });
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect((await edgeFetch('/og/nobody/unpublished')).status).toBe(404);
  });

  it('answers oEmbed JSON for a published atlas and 404s others', async () => {
    await seedAtlas({ slug: 'acme__embed', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    const response = await edgeFetch(`/oembed?url=${encodeURIComponent(`${ORIGIN}/r/acme/embed`)}&format=json`);
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ version: '1.0', type: 'rich', thumbnail_url: `${ORIGIN}/og/acme/embed` });
    expect(String(body.html)).toContain(`src="${ORIGIN}/r/acme/embed?embed=1"`);
    const miss = await edgeFetch(`/oembed?url=${encodeURIComponent(`${ORIGIN}/r/nobody/unpublished`)}`);
    expect(miss.status).toBe(404);
  });

  it('leaves everything else to static assets (SPA fallback for /new)', async () => {
    const landing = await edgeFetch('/new');
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain('<div id="root"></div>');
    const wasm = await edgeFetch('/assets/atlas_wasm_bg-abc123.wasm');
    expect(wasm.headers.get('content-type')).toBe('application/wasm');
  });

  it('404s a missing hashed asset (uncacheable) instead of the SPA shell', async () => {
    const present = await edgeFetch('/assets/index-abc123.js');
    expect(present.status).toBe(200);
    expect(present.headers.get('content-type')).toMatch(/javascript/);
    // _headers still apply through the binding now that /assets/* runs the Worker first.
    expect(present.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    for (const path of ['/assets/App-previousBuild.js', '/assets/', '/assets/nested/missing.css']) {
      const missing = await edgeFetch(path);
      expect(missing.status, path).toBe(404);
      expect(missing.headers.get('cache-control'), path).toBe('no-store');
      expect(await missing.text(), path).not.toContain('<div id="root">');
    }
    const head = await edgeFetch('/assets/App-previousBuild.js', { init: { method: 'HEAD' } });
    expect(head.status).toBe(404);
    // A browser revalidating a shell it cached before the fix (index.html's ETag) gets a 404, not a 304.
    const shellEtag = (await edgeFetch('/')).headers.get('etag');
    expect(shellEtag).toBeTruthy();
    const revalidate = await edgeFetch('/assets/App-previousBuild.js', { init: { headers: { 'if-none-match': shellEtag! } } });
    expect(revalidate.status).toBe(404);
    expect(revalidate.headers.get('cache-control')).toBe('no-store');
    // Outside /assets, the SPA's own routes keep the shell; unknown paths are the branded 404 (CLA-318).
    expect((await edgeFetch('/r/THISS/okie')).status).toBe(200);
    expect((await edgeFetch('/some/client/route')).status).toBe(404);
  });

  it('staging (ROBOTS_NOINDEX=1): X-Robots-Tag on every response and a disallow-all robots.txt', async () => {
    const env = { ROBOTS_NOINDEX: '1', OKIE_PUBLIC_ORIGIN: 'https://staging.sourcefor.dev' };
    const robots = await edgeFetch('/robots.txt', { env });
    expect(robots.status).toBe(200);
    expect(robots.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await robots.text()).toBe(NOINDEX_ROBOTS_TXT);
    for (const path of ['/', '/new', '/robots.txt', '/assets/index-abc123.js', '/assets/missing.js', '/scan/index.json', '/scan/nobody__here/snapshot.json', '/api/auth/me', '/oembed?url=x']) {
      const response = await edgeFetch(path, { env });
      expect(response.headers.get('x-robots-tag'), path).toBe('noindex, nofollow');
    }
    // Production (unset) adds nothing and leaves robots.txt to static assets.
    for (const path of ['/', '/assets/index-abc123.js', '/scan/index.json']) {
      expect((await edgeFetch(path)).headers.get('x-robots-tag'), path).toBeNull();
    }
    expect(await (await edgeFetch('/robots.txt')).text()).not.toBe(NOINDEX_ROBOTS_TXT);
  });

  it('301s www.<canonical host> to OKIE_PUBLIC_ORIGIN (same path + query) before anything else', async () => {
    const env = { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev' };
    for (const path of ['/', '/r/acme/shared?sel=x', '/scan/index.json', '/api/auth/me', '/og/acme/shared', '/assets/index-abc123.js']) {
      const response = await edgeFetch(new Request(`https://www.sourcefor.dev${path}`), { env });
      expect(response.status, path).toBe(301);
      expect(response.headers.get('location'), path).toBe(`https://sourcefor.dev${path}`);
    }
    // The apex, other hosts and an unset origin are untouched.
    expect((await edgeFetch(new Request('https://sourcefor.dev/api/auth/me'), { env })).status).toBe(200);
    expect((await edgeFetch(new Request('https://www.example.com/api/auth/me'), { env })).status).toBe(200);
    expect((await edgeFetch(new Request('https://www.sourcefor.dev/api/auth/me'), { env: { OKIE_PUBLIC_ORIGIN: undefined } })).status).toBe(200);
    expect(canonicalHostRedirect(new URL('https://WWW.SourceFor.dev/x'), env)?.headers.get('location')).toBe('https://sourcefor.dev/x');
  });
});
