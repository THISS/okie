import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';
import {
  HOME_CACHE_CONTROL,
  HOME_DESCRIPTION_MAX,
  HOME_EAGER_THUMBNAILS,
  HOME_EXPLORE_HREF,
  formatEntityCount,
  formatHomeDate,
  homeAtlasCards,
  homeHttpOutput,
  homeExploreHref,
  homePageHtml,
  homeSearchFrom,
  isHomeQueryParam,
  isHomeRequest,
} from './homePage';
import { SOURCE_FOR_MARK_SVG, siteFooterHtml } from './notFoundPage';
import { CONTACT_EMAIL, HOME_DESCRIPTION, HOME_TITLE } from './siteMeta';

const SHA = '3fce3b5a1b2c3d4e5f60718293a4b5c6d7e8f901';

function row(slug: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const [owner, repo] = slug.split('__') as [string, string];
  return {
    slug,
    owner,
    repo,
    repositoryId: `repo:${slug}`,
    versionId: 'publication-1',
    commitSha: SHA,
    generatedAt: '2026-08-04T14:00:08.000Z',
    entityCount: 2831,
    publishedAt: '2026-09-29T18:02:19.030Z',
    license: { spdxId: 'MIT', name: 'MIT License' },
    ...extra,
  };
}

function index(...repos: unknown[]) {
  return { schema: 'okie.published-index/v1', schemaVersion: 1, repos };
}

const RIPGREP = row('burnt-sushi__ripgrep', { owner: 'burntsushi', repo: 'ripgrep', ownerLogin: 'BurntSushi', repoName: 'ripgrep', license: { spdxId: 'Unlicense OR MIT', name: 'Unlicense OR MIT' } });

describe('CLA-269 home: which requests get it', () => {
  const url = (path: string) => new URL(path, 'https://sourcefor.dev');
  it('serves / and /index.html with no query or only allowlisted params', () => {
    for (const path of ['/', '/index.html', '/?', '/?q=x&sort=az', '/?utm_source=a', '/?utm_campaign=b&utm_medium=c', '/?ref=hn', '/?fbclid=1', '/?gclid=2', '/?q=']) {
      expect(isHomeRequest(url(path)), path).toBe(true);
    }
  });
  it('leaves every other query (golden demo, portable, embeds, deep links) and path to the SPA', () => {
    for (const path of ['/?fixture=okie', '/?portable=1', '/?embed=1', '/?open=x', '/?q=x&fixture=okie', '/?nav=1&sel=a', '/?=x', '/?UTM_source=a', '/new', '/operator', '/r/a/b', '/index.htm']) {
      expect(isHomeRequest(url(path)), path).toBe(false);
    }
  });
  it('keeps only the allowlisted params for the /new 301 (the same predicate)', () => {
    expect(homeSearchFrom(url('/new'))).toBe('');
    expect(homeSearchFrom(url('/new?a=1'))).toBe('');
    expect(homeSearchFrom(url('/new?utm_source=x&a=1'))).toBe('?utm_source=x');
    expect(homeSearchFrom(url('/new?fixture=okie&q=zu&sort=az&ref=hn'))).toBe('?q=zu&sort=az&ref=hn');
    expect(homeSearchFrom(url('/new?UTM_source=x&fbclid=1&gclid=2'))).toBe('?fbclid=1&gclid=2');
    for (const path of ['/new', '/new?a=1', '/new?utm_source=x&a=1', '/new?fixture=okie&q=zu']) {
      expect(isHomeRequest(url(`/${homeSearchFrom(url(path))}`)), path).toBe(true);
    }
    expect(['q', 'sort', 'ref', 'fbclid', 'gclid', 'utm_source', 'utm_'].every(isHomeQueryParam)).toBe(true);
    expect(['a', 'fixture', 'UTM_source', ''].some(isHomeQueryParam)).toBe(false);
  });
});

describe('CLA-269 home: directory cards', () => {
  it('orders by the date shown (commit date) desc, then publishedAt desc, then name; undated rows last', () => {
    const cards = homeAtlasCards(index(
      row('zeta__b', { generatedAt: '2026-09-01T00:00:00Z', publishedAt: '2026-09-01T00:00:00Z' }),
      row('alpha__a', { generatedAt: '2026-09-01T00:00:00Z', publishedAt: '2026-09-01T00:00:00Z' }),
      row('later__pub', { generatedAt: '2026-09-01T00:00:00Z', publishedAt: '2026-09-20T00:00:00Z' }),
      row('no__commit', { generatedAt: undefined, publishedAt: '2026-09-30T00:00:00Z' }),
      row('undated__x', { generatedAt: undefined, publishedAt: undefined }),
      // Published most recently, but its commit is the oldest: it sorts by the date it shows.
      row('old__commit', { generatedAt: '2026-08-04T00:00:00Z', publishedAt: '2026-09-29T00:00:00Z' }),
      row('newest__one', { generatedAt: '2026-09-28T00:00:00Z', publishedAt: '2026-09-28T00:00:00Z' }),
    ));
    expect(cards.map(card => card.href)).toEqual([
      '/r/newest/one', '/r/later/pub', '/r/alpha/a', '/r/zeta/b', '/r/old/commit', '/r/no/commit', '/r/undated/x',
    ]);
  });

  it('skips rows whose names do not slug back to their slug (accepting the verified GitHub casing)', () => {
    const cards = homeAtlasCards(index(
      // Shows "evil/thing" but would link /r/acme/app.
      row('acme__app', { owner: 'evil', repo: 'thing' }),
      { ...row('acme__lib'), repo: 'other' },
      // Stored `burntsushi` slugs to burntsushi__…, but the verified GitHub casing `BurntSushi` slugs to burnt-sushi__….
      RIPGREP,
      // Without the GitHub casing nothing reproduces the slug.
      row('burnt-sushi__fd', { owner: 'burntsushi', repo: 'fd' }),
      row('pmndrs__zustand'),
    ));
    expect(cards.map(card => card.href)).toEqual(['/r/burnt-sushi/ripgrep', '/r/pmndrs/zustand']);
  });

  it('strips bidi and zero-width characters from row text', () => {
    const [card] = homeAtlasCards(index(row('acme__app', {
      description: 'safe \u202Etxt.exe\u202C and \u200Bhidden\uFEFF\u2066iso\u2069 \u200Ejoin',
      language: '\u202ETypeScript',
      license: { spdxId: 'MIT\u200D' },
    })));
    expect(card!.description).toBe('safe txt.exe and hiddeniso join');
    expect(card!.language).toBe('TypeScript');
    expect(card!.licence).toBe('MIT');
    expect(homeAtlasCards(index(row('acme__app', { description: '\u202E\u200B' })))[0]!.description).toBeUndefined();
    const html = homePageHtml({ index: index(row('acme__app', { description: 'a\u202Eb' })) });
    expect(html).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/);
  });

  it('uses GitHub casing, links the canonical path and thumbnails the /og card; skips unusable rows and duplicates', () => {
    const cards = homeAtlasCards(index(
      RIPGREP,
      row('bad__slug__extra'),
      row('Upper__Case'),
      { ...row('acme__app'), owner: undefined },
      null,
      'nope',
      row('burnt-sushi__ripgrep', { owner: 'burntsushi', repo: 'ripgrep' }),
    ));
    expect(cards).toEqual([{
      href: '/r/burnt-sushi/ripgrep',
      thumbnail: '/og/burnt-sushi/ripgrep',
      owner: 'BurntSushi',
      repo: 'ripgrep',
      licence: 'Unlicense OR MIT',
      shortSha: '3fce3b5',
      commitDate: '2026-08-04T14:00:08.000Z',
      publishedAt: '2026-09-29T18:02:19.030Z',
      entityCount: 2831,
    }]);
    expect(homeAtlasCards(undefined)).toEqual([]);
    expect(homeAtlasCards({ repos: 'x' })).toEqual([]);
  });

  it('caps description and language, and drops malformed commits, counts and licences', () => {
    const [card] = homeAtlasCards(index(row('acme__app', {
      description: `  line one\n\tline two ${'x'.repeat(400)}`,
      language: 'L'.repeat(100),
      commitSha: 'not-a-sha',
      entityCount: -1,
      license: { spdxId: 'NOASSERTION', name: '' },
    })));
    expect(card!.description!.startsWith('line one line two x')).toBe(true);
    expect(Array.from(card!.description!)).toHaveLength(HOME_DESCRIPTION_MAX);
    expect(card!.description!.endsWith('…')).toBe(true);
    expect(card!.language).toHaveLength(40);
    expect(card!.shortSha).toBeUndefined();
    expect(card!.entityCount).toBeUndefined();
    expect(card!.licence).toBeUndefined();
  });

  it('formats counts and dates deterministically', () => {
    expect(formatEntityCount(2831)).toBe('2,831 entities');
    expect(formatEntityCount(1234567)).toBe('1,234,567 entities');
    expect(formatEntityCount(1)).toBe('1 entity');
    expect(formatEntityCount(0)).toBe('0 entities');
    expect(formatHomeDate('2026-08-04T14:00:08.000Z')).toBe('4 Aug 2026');
    expect(formatHomeDate('2026-12-31T23:59:59.000Z')).toBe('31 Dec 2026');
  });
});

describe('CLA-269 home page HTML', () => {
  it('renders the hero, CTA, contact link, cards and footer, with no script', () => {
    const html = homePageHtml({ index: index(row('acme__app', { publishedAt: '2026-09-01T00:00:00Z', description: 'A small app', language: 'TypeScript' }), RIPGREP) });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/rel="stylesheet"|\/assets\//);
    expect(html).toContain(SOURCE_FOR_MARK_SVG);
    expect(html).toContain(`<p class="lede">${HOME_DESCRIPTION}</p>`);
    // The product's own atlas is not listed here, so the CTA points at the first card.
    expect(html).toContain('<a class="cta" href="/r/burnt-sushi/ripgrep">Explore an atlas</a>');
    expect(HOME_EXPLORE_HREF).toBe('/r/source-for/atlas');
    expect(html).toContain(`Want your repo mapped? <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>`);
    expect(html).toContain(siteFooterHtml());
    expect(html).toContain('id="about"');
    // Same commit date (4 Aug), so the later publish comes first: ripgrep (29 Sep) before acme/app (1 Sep).
    expect(html.indexOf('href="/r/burnt-sushi/ripgrep"')).toBeLessThan(html.indexOf('href="/r/acme/app"'));
    expect(html).toContain('data-atlas-count="2"');
    expect(html).toContain('<li class="atlas" data-name="burntsushi/ripgrep" data-committed="2026-08-04T14:00:08.000Z" data-published="2026-09-29T18:02:19.030Z" data-entities="2831">');
    expect(html).toContain('<span class="name"><span class="owner">BurntSushi/</span><strong>ripgrep</strong></span>');
    expect(html).toContain('<img src="/og/burnt-sushi/ripgrep" alt="" width="1200" height="630" loading="eager" decoding="async" />');
    expect(html).toContain('<span class="fact" data-field="licence">Unlicense OR MIT</span>');
    expect(html).toContain('<span class="fact" data-field="entities">2,831 entities</span>');
    expect(html).toContain('commit <code>3fce3b5</code> · <time datetime="2026-08-04T14:00:08.000Z">4 Aug 2026</time>');
    expect(html).toContain('<span class="description">A small app</span>');
    expect(html).toContain('<span class="fact" data-field="language">TypeScript</span>');
    expect(html).not.toContain('No atlases published yet');
    // Each card is exactly one link.
    const card = html.slice(html.indexOf('<li class="atlas" data-name="acme/app"'), html.indexOf('</li>', html.indexOf('data-name="acme/app"')));
    expect(card.match(/<a /g)).toHaveLength(1);
  });

  it('points the CTA at the product atlas when listed, else the first card in display order, else omits it', () => {
    const atlas = row('source-for__atlas', { generatedAt: '2026-01-01T00:00:00Z' });
    const newer = row('pmndrs__zustand', { generatedAt: '2026-09-29T00:00:00Z' });
    const listed = homePageHtml({ index: index(newer, atlas) });
    expect(listed).toContain(`<a class="cta" href="${HOME_EXPLORE_HREF}">Explore an atlas</a>`);
    expect(listed.match(/class="cta"/g)).toHaveLength(1);

    const unlisted = homeAtlasCards(index(row('acme__app', { generatedAt: '2026-01-01T00:00:00Z' }), newer));
    expect(homeExploreHref(unlisted)).toBe('/r/pmndrs/zustand');
    expect(homePageHtml({ index: index(row('acme__app', { generatedAt: '2026-01-01T00:00:00Z' }), newer) }))
      .toContain('<a class="cta" href="/r/pmndrs/zustand">Explore an atlas</a>');
    // A row for the product atlas that is skipped (names do not slug back) does not count as listed.
    expect(homePageHtml({ index: index({ ...atlas, owner: 'someone' }, newer) }))
      .toContain('<a class="cta" href="/r/pmndrs/zustand">Explore an atlas</a>');

    expect(homeExploreHref([])).toBeUndefined();
    const empty = homePageHtml({ index: index() });
    expect(empty).not.toContain('class="cta"');
    expect(empty).not.toContain('Explore an atlas');
    expect(empty).toContain(`Want your repo mapped? <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>`);
  });

  it('loads the first three thumbnails eagerly and the rest lazily', () => {
    const repos = ['a', 'b', 'c', 'd', 'e'].map((name, at) => row(`acme__${name}`, { generatedAt: `2026-09-0${9 - at}T00:00:00Z` }));
    const html = homePageHtml({ index: index(...repos) });
    const loading = [...html.matchAll(/<img src="(\/og\/[^"]+)"[^>]* loading="(\w+)"/g)].map(([, src, value]) => `${src} ${value}`);
    expect(HOME_EAGER_THUMBNAILS).toBe(3);
    expect(loading).toEqual(['/og/acme/a eager', '/og/acme/b eager', '/og/acme/c eager', '/og/acme/d lazy', '/og/acme/e lazy']);
  });

  it('gives the CTA and the contact link the cards\' 2px teal focus outline', () => {
    const html = homePageHtml({ index: index(row('acme__app')) });
    expect(html).toContain('.card:focus-visible{outline:2px solid #79dfd4;outline-offset:2px}');
    expect(html).toContain('.cta:focus-visible,.ask a:focus-visible{outline:2px solid #79dfd4;outline-offset:2px}');
  });

  it('escapes everything that comes from the index', () => {
    const html = homePageHtml({ index: index(row('acme__app', {
      description: '<script>alert(1)</script> & "quotes"',
      language: '<img src=x onerror=alert(1)>',
      license: { spdxId: '<b>MIT</b>' },
    }), { ...row('evil__repo'), owner: '<script>alert(1)</script>' }) });
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>MIT');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;b&gt;MIT&lt;/b&gt;');
    // The row with an invalid owner name is skipped entirely.
    expect(html).not.toContain('/r/evil/repo');
    expect(html).toContain('data-atlas-count="1"');
  });

  it('shows the hero and an empty note without an index or with no rows', () => {
    for (const value of [undefined, null, {}, index(), index(row('bad__slug__x'))]) {
      const html = homePageHtml({ index: value });
      expect(html).toContain('<p class="empty" data-empty="true">No atlases published yet.</p>');
      expect(html).not.toContain('Explore an atlas');
      expect(html).toContain('Want your repo mapped?');
      expect(html).not.toContain('<ul class="atlases"');
    }
  });

  it('has the home title, description, production canonical, Open Graph/Twitter default card and the index.html favicons', () => {
    const html = homePageHtml({ index: undefined });
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain(`<title>${HOME_TITLE}</title>`);
    expect(html).toContain(`<meta name="description" content="${HOME_DESCRIPTION}" />`);
    expect(html).toContain('<link rel="canonical" href="https://sourcefor.dev/" />');
    expect(html).toContain('<meta property="og:url" content="https://sourcefor.dev/" />');
    expect(html).toContain('<meta property="og:image" content="https://sourcefor.dev/og-default.png" />');
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain('<meta name="twitter:image" content="https://sourcefor.dev/og-default.png" />');
    expect(html).not.toContain('oembed');
    for (const link of indexHtml.match(/<link rel="(?:icon|apple-touch-icon)"[^>]*>/g)!) {
      expect(html, link).toContain(link);
    }
  });

  it('puts an allowlisted request origin (staging) in og:url/og:image but keeps the canonical on production; never an unlisted Host', () => {
    const staging = homePageHtml({ index: undefined, requestOrigin: 'https://staging.sourcefor.dev', allowedOrigins: ['https://staging.sourcefor.dev'] });
    expect(staging).toContain('<meta property="og:url" content="https://staging.sourcefor.dev/" />');
    expect(staging).toContain('<meta property="og:image" content="https://staging.sourcefor.dev/og-default.png" />');
    expect(staging).toContain('<link rel="canonical" href="https://sourcefor.dev/" />');
    const forged = homePageHtml({ index: undefined, requestOrigin: 'https://evil.example', allowedOrigins: ['https://staging.sourcefor.dev'] });
    expect(forged).not.toContain('evil.example');
  });

  it('answers GET with the page and HEAD with headers only', () => {
    const get = homeHttpOutput('GET', { index: undefined });
    expect(get.status).toBe(200);
    expect(get.headers).toEqual({ 'cache-control': HOME_CACHE_CONTROL, 'content-type': 'text/html; charset=utf-8' });
    expect(HOME_CACHE_CONTROL).toBe('public, max-age=60');
    expect(get.body).toContain('<!doctype html>');
    const head = homeHttpOutput('head', { index: undefined });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });
});
