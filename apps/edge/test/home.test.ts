import { afterEach, describe, expect, it, vi } from 'vitest';
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
    // The only script is the self-hosted, deferred search enhancement.
    expect(html.match(/<script\b[^>]*>/gi)).toEqual(['<script src="/home.js" defer>']);
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
    expect(html.replace('<script src="/home.js" defer></script>', '')).not.toMatch(/<script/i);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('points the CTA at the first card when the product atlas is not listed', async () => {
    await seedHomeIndex(ROWS.filter(row => row.slug !== 'source-for__atlas'));
    const html = await (await edgeFetch('/')).text();
    expect(html).toContain('<a class="cta" href="/r/pmndrs/zustand">Explore an atlas</a>');
  });
});

/** CLA-269 increment 2: search and sort. */
describe('home page search and sort at the edge', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  /** Card hrefs in page order; `hidden` ones marked. */
  const cards = (html: string) => [...html.matchAll(/<li class="atlas"[^>]*?( hidden)?>\s*<a class="card" href="([^"]+)"/g)].map(([, hidden, href]) => `${href}${hidden ? ' (hidden)' : ''}`);

  it('/?q=zust shows only zustand, keeps every card in the page, echoes the search and counts', async () => {
    await seedHomeIndex();
    const response = await edgeFetch('/?q=zust');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    const html = await response.text();
    expect(cards(html)).toEqual(['/r/source-for/atlas (hidden)', '/r/pmndrs/zustand', '/r/burnt-sushi/ripgrep (hidden)']);
    expect(html).toContain('name="q" value="zust"');
    expect(html).toContain('<p class="count" aria-live="polite" data-home-count>1 of 3 atlases</p>');
    expect(html).toContain('<p class="no-match" data-home-no-match hidden>');
  });

  it('matches GitHub casing, description and language; sorts A–Z; falls back to recent for an unknown sort', async () => {
    await seedHomeIndex([{ ...ROWS[0], language: 'Rust' }, { ...ROWS[1], description: 'Maps a repo from C4 context to code' }, ROWS[2]]);
    expect(cards(await (await edgeFetch('/?q=BurntSushi')).text())).toEqual(['/r/source-for/atlas (hidden)', '/r/pmndrs/zustand (hidden)', '/r/burnt-sushi/ripgrep']);
    expect(cards(await (await edgeFetch('/?q=rust')).text())).toEqual(['/r/source-for/atlas (hidden)', '/r/pmndrs/zustand (hidden)', '/r/burnt-sushi/ripgrep']);
    expect(cards(await (await edgeFetch('/?q=C4+CONTEXT')).text())).toEqual(['/r/source-for/atlas', '/r/pmndrs/zustand (hidden)', '/r/burnt-sushi/ripgrep (hidden)']);
    const az = await (await edgeFetch('/?sort=az')).text();
    expect(cards(az)).toEqual(['/r/burnt-sushi/ripgrep', '/r/pmndrs/zustand', '/r/source-for/atlas']);
    expect(az).toContain('<option value="az" selected>');
    const unknown = await (await edgeFetch('/?sort=popular&utm_source=x')).text();
    expect(cards(unknown)).toEqual(['/r/source-for/atlas', '/r/pmndrs/zustand', '/r/burnt-sushi/ripgrep']);
    expect(unknown).toContain('<option value="recent" selected>');
  });

  it('says so when nothing matches, with the search escaped and a link back to /', async () => {
    await seedHomeIndex();
    const html = await (await edgeFetch(`/?q=${encodeURIComponent('<b>"x"</b>')}`)).text();
    expect(html).toContain('<p class="no-match" data-home-no-match>No atlases match “<span data-home-query>&lt;b&gt;&quot;x&quot;&lt;/b&gt;</span>”. <a href="/">Clear the search</a></p>');
    expect(html).toContain('0 of 3 atlases');
    expect(html).not.toContain('<b>"x"');
  });

  it('serves /home.js from Static Assets as JavaScript with a short cache and the security headers', async () => {
    const response = await edgeFetch('/home.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^(text|application)\/javascript\b/);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const body = await response.text();
    expect(body).toContain('data-home-search');
    // A same-origin script: the home's CSP (`script-src 'self'`) allows it.
    expect(contentSecurityPolicy({ framable: false })).toMatch(/script-src 'self'/);
    expect((await edgeFetch('/home.js', { init: { method: 'HEAD' } })).status).toBe(200);
  });

  it('lists a row whose names do not slug back under its slug, and warns about a row whose slug is unusable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await seedHomeIndex([
      ...ROWS,
      // Names that do not slug back: still listed, under the slug's names.
      { ...ROWS[2], slug: 'acme__app', owner: 'evil', repo: 'thing' },
      // No canonical path: skipped, and logged.
      { ...ROWS[2], slug: 'Bad__Slug' },
    ]);
    const html = await (await edgeFetch('/')).text();
    expect(html).toContain('<a class="card" href="/r/acme/app">');
    expect(html).toContain('<span class="owner">acme/</span><strong>app</strong>');
    expect(html).not.toContain('evil');
    expect(html).not.toContain('<strong>thing</strong>');
    expect(html).toContain('data-atlas-count="4"');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('home: index row "Bad__Slug" not listed (the slug has no canonical /r/ path)');
    // Once per cached index per isolate: more requests served from the same cached index log nothing more.
    for (const path of ['/', '/?q=zust', '/?sort=az']) {
      expect((await edgeFetch(path, { keepIndexCache: true })).status).toBe(200);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    // A fresh read of the index (the cache expired) reports again.
    await edgeFetch('/');
    expect(warn).toHaveBeenCalledTimes(2);
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

describe('home page sign-in slot (CLA-316)', () => {
  it('changes nothing without the sign-in secrets: no slot and, on an empty directory, no script', async () => {
    await seedHomeIndex([]);
    const html = await (await edgeFetch('https://sourcefor.dev/', { env: { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev' } })).text();
    expect(html).not.toContain('data-auth-slot');
    expect(html).not.toMatch(/<script/i);
  });

  it('ships the header slot hidden and user-free (the page stays shared-cacheable), and home.js drives it from /api/auth/me', async () => {
    await seedHomeIndex([]);
    const env = { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', SESSION_SIGNING_KEY: 'k'.repeat(32) };
    const response = await edgeFetch('https://sourcefor.dev/', { env });
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    const html = await response.text();
    expect(html).toContain('<nav class="site-auth" aria-label="Account" data-auth-slot hidden></nav>');
    // Even an empty directory loads /home.js now: it fills the slot.
    expect(html.match(/<script\b[^>]*>/gi)).toEqual(['<script src="/home.js" defer>']);
    expect(await (await edgeFetch('https://sourcefor.dev/api/auth/me', { env })).json()).toMatchObject({ oauthConfigured: true, loginPath: '/api/auth/github' });
    const script = await (await edgeFetch('/home.js')).text();
    expect(script).toContain("'/api/auth/me'");
    expect(script).toContain('[data-auth-slot]');
  });
});
