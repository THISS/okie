import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../../web/src/securityHeaders';
import { publishedIndexKey } from '../../server/src/publishedStoreLayout';
import { edgeEnv, edgeFetch } from './helpers';

const TOKEN = '0123456789abcdef0123456789ABCDEF';
const SHA = '3fce3b5a1b2c3d4e5f60718293a4b5c6d7e8f901';

const ROWS = [
  { slug: 'burnt-sushi__ripgrep', owner: 'burntsushi', repo: 'ripgrep', ownerLogin: 'BurntSushi', repoName: 'ripgrep', commitSha: SHA, generatedAt: '2026-08-04T14:00:08.000Z', entityCount: 2831, publishedAt: '2026-09-29T18:02:19.030Z', license: { spdxId: 'Unlicense OR MIT', name: 'Unlicense OR MIT' } },
  { slug: 'source-for__atlas', owner: 'source-for', repo: 'atlas', commitSha: SHA, generatedAt: '2026-09-01T00:00:00.000Z', entityCount: 900, publishedAt: '2026-09-30T08:00:00.000Z', license: { spdxId: 'MIT', name: 'MIT License' } },
  { slug: 'pmndrs__zustand', owner: 'pmndrs', repo: 'zustand', commitSha: SHA, generatedAt: '2026-09-01T00:00:00.000Z', entityCount: 120, publishedAt: '2026-09-01T10:00:00.000Z', license: { spdxId: 'MIT', name: 'MIT License' } },
];

async function seedHomeIndex(repos: unknown[] = ROWS): Promise<void> {
  await edgeEnv.ATLAS_BUCKET.put(publishedIndexKey(), JSON.stringify({ schema: 'okie.published-index/v1', schemaVersion: 1, repos }));
}

/** CLA-269: `/` is an edge-rendered home page (hero + directory of published atlases). */
describe('home page at the edge', () => {
  it('serves / as the home page listing every published atlas, newest commit date first', async () => {
    await seedHomeIndex();
    const response = await edgeFetch('/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    const html = await response.text();
    expect(html).toContain('data-home="true"');
    expect(html).not.toContain('<div id="root">');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('data-atlas-count="3"');
    // By the commit date each card shows (generatedAt), then publishedAt: source-for and zustand share
    // 1 Sep (source-for published later), ripgrep's commit is 4 Aug.
    const order = ['/r/source-for/atlas', '/r/pmndrs/zustand', '/r/burnt-sushi/ripgrep'].map(href => html.indexOf(`<a class="card" href="${href}">`));
    expect(order.every(at => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('<strong>ripgrep</strong>');
    expect(html).toContain('BurntSushi/');
    expect(html).toContain('<img src="/og/burnt-sushi/ripgrep"');
    expect(html).toContain('2,831 entities');
    expect(html).toContain('<link rel="canonical" href="https://sourcefor.dev/" />');
    expect(html).toContain('<a class="cta" href="/r/source-for/atlas">Explore an atlas</a>');
  });

  it('serves the home for /index.html and for search/sort/tracking params only', async () => {
    await seedHomeIndex();
    for (const path of ['/index.html', '/?utm_source=a', '/?q=x&sort=az', '/?ref=hn&fbclid=1&gclid=2', '/index.html?utm_campaign=x']) {
      const response = await edgeFetch(path);
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html, path).toContain('data-home="true"');
      expect(html, path).not.toContain('<div id="root">');
    }
  });

  it('keeps the SPA shell (golden demo, portable, embeds, deep links) for any other query', async () => {
    await seedHomeIndex();
    for (const path of ['/?fixture=okie', '/?portable=1', '/?embed=1', '/?q=x&fixture=okie', '/?open=x', '/?utm_source=a&sel=container%3Aweb', '/index.html?fixture=okie']) {
      const response = await edgeFetch(path);
      expect(response.status, path).toBe(200);
      const html = await response.text();
      expect(html, path).toContain('<div id="root"></div>');
      expect(html, path).not.toContain('data-home');
    }
  });

  it('answers HEAD / with the headers and no body', async () => {
    await seedHomeIndex();
    const head = await edgeFetch('/', { init: { method: 'HEAD' } });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(head.headers.get('cache-control')).toBe('public, max-age=60');
    expect(head.headers.get('content-security-policy')).toBe(contentSecurityPolicy({ framable: false }));
    expect(await head.text()).toBe('');
  });

  it('leaves other methods on / to Static Assets, as before (405)', async () => {
    await seedHomeIndex();
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await edgeFetch('/', { init: { method, ...(method === 'POST' || method === 'PUT' ? { body: 'x' } : {}) } });
      expect(response.status, method).toBe(405);
      expect(await response.text(), method).not.toContain('data-home');
    }
  });

  it('301s /new and /new/ to / keeping only the home query params', async () => {
    const cases = [
      ['/new', '/'], ['/new/', '/'], ['/new?a=1', '/'], ['/new/?a=1', '/'],
      ['/new?utm_source=x&a=1', '/?utm_source=x'], ['/new?utm_source=x&fixture=okie', '/?utm_source=x'],
      ['/new?q=zu&sort=az&ref=hn&fbclid=1&gclid=2&utm_campaign=c', '/?q=zu&sort=az&ref=hn&fbclid=1&gclid=2&utm_campaign=c'],
    ] as const;
    for (const [path, location] of cases) {
      const response = await edgeFetch(path);
      expect(response.status, path).toBe(301);
      expect(response.headers.get('location'), path).toBe(location);
      expect(response.headers.get('cache-control'), path).toBe('public, max-age=3600');
      expect(await response.text(), path).toBe('');
    }
    const head = await edgeFetch('/new', { init: { method: 'HEAD' } });
    expect(head.status).toBe(301);
    // /new/extra is still not a route.
    expect((await edgeFetch('/new/extra')).status).toBe(404);
  });

  it('sends the WebMCP host headers the static / had (Origin-Agent-Cluster only when not framed)', async () => {
    await seedHomeIndex();
    for (const init of [{}, { method: 'HEAD' }, { headers: { 'sec-fetch-dest': 'document' } }]) {
      const home = await edgeFetch('/', { init });
      expect(home.headers.get('permissions-policy')).toBe('tools=(self)');
      expect(home.headers.get('origin-agent-cluster')).toBe('?1');
    }
    const framed = await edgeFetch('/', { init: { headers: { 'sec-fetch-dest': 'iframe' } } });
    expect(framed.headers.get('permissions-policy')).toBe('tools=(self)');
    expect(framed.headers.get('origin-agent-cluster')).toBeNull();
  });

  it('gets the same CSP as the SPA shell and the security headers', async () => {
    await seedHomeIndex();
    const home = await edgeFetch('/');
    const shell = await edgeFetch('/?fixture=okie');
    expect(home.headers.get('content-security-policy')).toBe(contentSecurityPolicy({ framable: false }));
    expect(home.headers.get('content-security-policy')).toBe(shell.headers.get('content-security-policy'));
    expect(home.headers.get('x-content-type-options')).toBe('nosniff');
    expect(home.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    const staging = await edgeFetch('/', { env: { ROBOTS_NOINDEX: '1' } });
    expect(staging.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('carries the Web Analytics beacon (and its CSP sources) when WEB_ANALYTICS_TOKEN is set', async () => {
    await seedHomeIndex();
    const plain = await edgeFetch('/');
    expect(await plain.text()).not.toMatch(/cloudflareinsights|data-cf-beacon/);
    const response = await edgeFetch('/', { env: { WEB_ANALYTICS_TOKEN: TOKEN } });
    expect(response.headers.get('content-security-policy')).toBe(contentSecurityPolicy({ framable: false, webAnalytics: true }));
    const html = await response.text();
    expect(html.split('data-cf-beacon').length - 1).toBe(1);
    expect(html).toMatch(new RegExp(`data-cf-beacon='\\{"token":"${TOKEN}"\\}'></script>\\s*</body>`));
  });

  it('still answers 200 with the hero and an empty note when the index is missing, unreadable or empty', async () => {
    await edgeEnv.ATLAS_BUCKET.delete(publishedIndexKey());
    const missing = await edgeFetch('/');
    expect(missing.status).toBe(200);
    const html = await missing.text();
    expect(html).toContain('No atlases published yet.');
    // No cards, nothing to explore: the hero keeps the contact link but drops the CTA.
    expect(html).not.toContain('class="cta"');
    expect(html).toContain('Want your repo mapped?');
    await edgeEnv.ATLAS_BUCKET.put(publishedIndexKey(), 'not json');
    expect(await (await edgeFetch('/')).text()).toContain('No atlases published yet.');
    await edgeEnv.ATLAS_BUCKET.put(publishedIndexKey(), JSON.stringify({ schema: 'something-else', repos: ROWS }));
    expect(await (await edgeFetch('/')).text()).toContain('No atlases published yet.');
    await seedHomeIndex([]);
    expect(await (await edgeFetch('/')).text()).toContain('No atlases published yet.');
  });

  it('escapes row text from the index', async () => {
    await seedHomeIndex([{ ...ROWS[0], description: '<script>alert(1)</script>', language: '"><img src=x>' }]);
    const html = await (await edgeFetch('/')).text();
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('points the CTA at the first card when the product atlas is not listed', async () => {
    await seedHomeIndex(ROWS.filter(row => row.slug !== 'source-for__atlas'));
    const html = await (await edgeFetch('/')).text();
    expect(html).toContain('<a class="cta" href="/r/pmndrs/zustand">Explore an atlas</a>');
  });
});

describe('sitemap after the home page (CLA-269)', () => {
  it('has no /new and gives / the newest publishedAt as lastmod', async () => {
    await seedHomeIndex();
    const xml = await (await edgeFetch('/sitemap.xml', { env: { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev' } })).text();
    expect(xml).not.toContain('/new');
    expect(xml).toContain('<loc>https://sourcefor.dev/</loc>\n    <lastmod>2026-09-30T08:00:00.000Z</lastmod>');
  });
});
