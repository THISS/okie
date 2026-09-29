import { describe, expect, it } from 'vitest';
import webIndexHtml from '../../web/index.html?raw';
import { contentSecurityPolicy, isFramableAtlasPath } from '../../web/src/securityHeaders';
import { injectsInto, WEB_ANALYTICS_IN_EMBEDS, webAnalyticsSnippet, webAnalyticsToken } from '../src/analytics';
import { edgeFetch, seedAtlas } from './helpers';

const TOKEN = '0123456789abcdef0123456789ABCDEF';
const SNIPPET = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${TOKEN}"}'></script>`;
const ON = { env: { WEB_ANALYTICS_TOKEN: TOKEN } };

const HTML_PAGES: Array<[string, number]> = [
  ['/', 200], // the home page (CLA-269)
  ['/index.html', 200],
  ['/?fixture=okie', 200], // the SPA shell
  ['/operator', 200],
  ['/r/acme/shared', 200],
  ['/r/acme/shared/main/src', 200],
  ['/r/THISS/okie', 200],
  ['/zzz', 404], // branded 404
  ['/r/nobody/unpublished', 404], // atlas 404
];

const NOT_HTML: Array<[string, number]> = [
  ['/assets/index-abc123.js', 200],
  ['/assets/missing.js', 404],
  ['/favicon.svg', 200],
  ['/robots.txt', 200],
  ['/sitemap.xml', 200],
  ['/scan/acme__shared/snapshot.json', 200],
  ['/api/auth/me', 200],
  ['/og/acme/shared', 200],
  ['/oembed?url=http%3A%2F%2F127.0.0.1%3A4196%2Fr%2Facme%2Fshared', 200],
];

async function seed() {
  await seedAtlas({ slug: 'acme__shared', versionId: 'v1', files: { 'snapshot.json': '{"ok":true}' } });
}

/** CLA-318: Cloudflare Web Analytics, injected at the edge behind WEB_ANALYTICS_TOKEN. */
describe('Cloudflare Web Analytics beacon', () => {
  it('is the exact manual-install snippet', () => {
    expect(webAnalyticsSnippet(TOKEN)).toBe(SNIPPET);
  });

  it('accepts only a plain 16-64 character alphanumeric token', () => {
    expect(webAnalyticsToken({ WEB_ANALYTICS_TOKEN: TOKEN })).toBe(TOKEN);
    expect(webAnalyticsToken({ WEB_ANALYTICS_TOKEN: `  ${TOKEN}\n` })).toBe(TOKEN);
    expect(webAnalyticsToken({ WEB_ANALYTICS_TOKEN: 'a'.repeat(16) })).toBe('a'.repeat(16));
    expect(webAnalyticsToken({ WEB_ANALYTICS_TOKEN: 'a'.repeat(64) })).toBe('a'.repeat(64));
    for (const bad of [undefined, '', '   ', 'a'.repeat(15), 'a'.repeat(65), `${TOKEN}-x`, `${TOKEN}"}'></script><script>alert(1)`, `${TOKEN} x`, 'ÄÖÜäöüßÄÖÜäöüßÄÖÜ']) {
      expect(webAnalyticsToken({ WEB_ANALYTICS_TOKEN: bad }), String(bad)).toBeUndefined();
    }
  });

  it('is absent everywhere, CSP included, when the token is unset (staging, local dev, the checked-in config)', async () => {
    await seed();
    for (const [path, status] of [...HTML_PAGES, ['/r/acme/shared?embed=1', 200] as [string, number], ...NOT_HTML]) {
      const response = await edgeFetch(path);
      expect(response.status, path).toBe(status);
      expect(response.headers.get('content-security-policy') ?? '', path).not.toContain('cloudflareinsights');
      expect(new TextDecoder().decode(await response.arrayBuffer()), path).not.toMatch(/cloudflareinsights|data-cf-beacon/);
    }
  });

  it('is added once, just before </body>, to every HTML document when set, and the CSP allows it', async () => {
    await seed();
    for (const [path, status] of HTML_PAGES) {
      const response = await edgeFetch(path, ON);
      expect(response.status, path).toBe(status);
      expect(response.headers.get('content-type'), path).toMatch(/^text\/html/);
      expect(response.headers.get('content-length'), path).toBeNull();
      expect(response.headers.get('etag'), path).toBeNull();
      expect(response.headers.get('last-modified'), path).toBeNull();
      expect(response.headers.get('content-security-policy'), path).toBe(contentSecurityPolicy({ framable: isFramableAtlasPath(path), webAnalytics: true }));
      const html = await response.text();
      expect(html.split('cloudflareinsights').length - 1, path).toBe(1);
      expect(html, path).toMatch(new RegExp(`${SNIPPET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</body>`));
    }
    // The rest of the page is untouched (share pages keep their own meta, the shell its root).
    expect(await (await edgeFetch('/r/acme/shared', ON)).text()).toContain('<title>shared by acme · Source For Atlas</title>');
    expect(await (await edgeFetch('/?fixture=okie', ON)).text()).toContain('<div id="root"></div>');
    expect(await (await edgeFetch('/', ON)).text()).toContain('data-home="true"');
  });

  it('counts oEmbed iframes (?embed=1) unless WEB_ANALYTICS_IN_EMBEDS is off', async () => {
    const embed = new URL('http://127.0.0.1:4196/r/acme/shared?embed=1');
    const page = new URL('http://127.0.0.1:4196/r/acme/shared');
    expect(injectsInto(embed, true)).toBe(true);
    expect(injectsInto(embed, false)).toBe(false);
    expect(injectsInto(page, false)).toBe(true);
    expect(injectsInto(new URL('http://127.0.0.1:4196/r/acme/shared?embed=0'), false)).toBe(true);
    // The shipped setting, end to end.
    await seed();
    const response = await edgeFetch('/r/acme/shared?embed=1', ON);
    expect((await response.text()).includes(SNIPPET)).toBe(WEB_ANALYTICS_IN_EMBEDS);
    expect(response.headers.get('content-security-policy')!.includes('cloudflareinsights')).toBe(WEB_ANALYTICS_IN_EMBEDS);
  });

  it('never touches JSON, PNG, scripts, the sitemap or other static files', async () => {
    await seed();
    for (const [path, status] of NOT_HTML) {
      const plain = await edgeFetch(path);
      const withToken = await edgeFetch(path, ON);
      expect(withToken.status, path).toBe(status);
      expect(withToken.headers.get('content-type'), path).toBe(plain.headers.get('content-type'));
      expect(withToken.headers.get('etag'), path).toBe(plain.headers.get('etag'));
      expect(new Uint8Array(await withToken.arrayBuffer()), path).toEqual(new Uint8Array(await plain.arrayBuffer()));
    }
  });

  it('ignores an invalid token (no beacon, no CSP sources)', async () => {
    await seed();
    for (const token of ['', 'short', `${TOKEN}"><script>alert(1)</script>`]) {
      for (const [path] of HTML_PAGES) {
        const response = await edgeFetch(path, { env: { WEB_ANALYTICS_TOKEN: token } });
        expect(response.headers.get('content-security-policy'), `${path} ${token}`).not.toContain('cloudflareinsights');
        expect(await response.text(), `${path} ${token}`).not.toMatch(/cloudflareinsights|data-cf-beacon|alert/);
      }
    }
  });

  it('keeps HEAD bodiless and drops the validators of the page without the beacon', async () => {
    await seed();
    // Static Assets' HEAD for the shell carries an ETag (and a length) of the un-injected file…
    const plainHead = await edgeFetch('/?fixture=okie', { init: { method: 'HEAD' } });
    expect(plainHead.headers.get('etag')).toBeTruthy();
    // …which an injected HEAD must not repeat.
    for (const [path, status] of HTML_PAGES) {
      const head = await edgeFetch(path, { ...ON, init: { method: 'HEAD' } });
      expect(head.status, path).toBe(status);
      expect(head.headers.get('content-type'), path).toMatch(/^text\/html/);
      expect(head.headers.get('etag'), path).toBeNull();
      expect(head.headers.get('content-length'), path).toBeNull();
      expect(head.headers.get('content-security-policy'), path).toContain('cloudflareinsights');
      expect(await head.text(), path).toBe('');
    }
  });

  it('never answers the shell with a 304 while analytics is on', async () => {
    // The SPA shell (`/` with a non-home query; bare `/` is the edge-rendered home since CLA-269).
    const plain = await edgeFetch('/?fixture=okie');
    const assetEtag = plain.headers.get('etag')!;
    expect(assetEtag).toBeTruthy();
    // Without analytics the asset ETag revalidates as before.
    expect((await edgeFetch('/?fixture=okie', { init: { headers: { 'if-none-match': assetEtag } } })).status).toBe(304);
    // A copy cached before analytics was turned on is refetched in full, with the beacon.
    for (const path of ['/?fixture=okie', '/index.html?portable=1', '/operator']) {
      const refreshed = await edgeFetch(path, { env: ON.env, init: { headers: { 'if-none-match': assetEtag, 'if-modified-since': 'Wed, 30 Sep 2026 00:00:00 GMT' } } });
      expect(refreshed.status, path).toBe(200);
      expect(refreshed.headers.get('etag'), path).toBeNull();
      expect(await refreshed.text(), path).toContain(SNIPPET);
    }
  });

  it('is never part of the web build itself (so the portable viewer never carries it)', () => {
    expect(webIndexHtml).toContain('<div id="root"></div>');
    expect(webIndexHtml).not.toMatch(/cloudflareinsights|data-cf-beacon/);
  });
});
