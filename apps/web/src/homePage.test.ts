import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';
import {
  HOME_CACHE_CONTROL,
  HOME_DESCRIPTION_MAX,
  HOME_EAGER_THUMBNAILS,
  HOME_EXPLORE_HREF,
  formatEntityCount,
  formatHomeDate,
  HOME_QUERY_MAX,
  homeAtlasCards,
  homeCardMatches,
  homeCountText,
  homeDirectory,
  homeHttpOutput,
  homeSortFrom,
  homeViewFrom,
  normalizeHomeQuery,
  sortHomeCards,
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

  it('shows a row whose names do not slug back under its slug\'s names (never one repo linking another), accepting the verified GitHub casing', () => {
    const { cards, skipped } = homeDirectory(index(
      // Would show "evil/thing" but links /r/acme/app: shown as acme/app.
      row('acme__app', { owner: 'evil', repo: 'thing', generatedAt: '2026-09-05T00:00:00Z' }),
      { ...row('acme__lib', { generatedAt: '2026-09-04T00:00:00Z' }), repo: 'other' },
      // Stored `burntsushi` slugs to burntsushi__…, but the verified GitHub casing `BurntSushi` slugs to burnt-sushi__….
      RIPGREP,
      // Without the GitHub casing nothing reproduces the slug, but the stored names match it once case and
      // punctuation are ignored (burntsushi ≈ burnt-sushi): shown under the stored names, linked to the slug's path.
      row('burnt-sushi__fd', { owner: 'burntsushi', repo: 'fd', generatedAt: '2026-09-03T00:00:00Z' }),
      // Loosely matching but not valid GitHub names: the slug's names.
      { ...row('dot-net__x', { generatedAt: '2026-09-02T12:00:00Z' }), owner: 'dot net' },
      row('pmndrs__zustand', { generatedAt: '2026-09-02T00:00:00Z' }),
      // Unusable stored names (not GitHub names at all) fall back to the slug's too.
      { ...row('evil__repo', { generatedAt: '2026-09-01T00:00:00Z' }), owner: '<script>alert(1)</script>' },
    ));
    expect(skipped).toEqual([]);
    expect(cards.map(card => [card.href, `${card.owner}/${card.repo}`])).toEqual([
      ['/r/acme/app', 'acme/app'],
      ['/r/acme/lib', 'acme/lib'],
      ['/r/burnt-sushi/fd', 'burntsushi/fd'],
      ['/r/dot-net/x', 'dot-net/x'],
      ['/r/pmndrs/zustand', 'pmndrs/zustand'],
      ['/r/evil/repo', 'evil/repo'],
      ['/r/burnt-sushi/ripgrep', 'BurntSushi/ripgrep'],
    ]);
    // Names a card does not show are not searchable either.
    expect(cards.find(card => card.href === '/r/dot-net/x')!.search).toEqual(['dot-net/x']);
    // The loosely matching stored names are the card's own, so they are searchable.
    expect(cards.find(card => card.repo === 'fd')!.search).toEqual(['burntsushi/fd']);
    expect(homePageHtml({ index: index(row('burnt-sushi__fd', { owner: 'burntsushi', repo: 'fd' })) }))
      .toContain('<a class="card" href="/r/burnt-sushi/fd">');
    expect(cards.find(card => card.href === '/r/acme/app')!.search).toEqual(['acme/app']);
    const html = homePageHtml({ index: index(row('acme__app', { owner: 'evil', repo: 'thing' })) });
    expect(html).toContain('<a class="card" href="/r/acme/app">');
    expect(html).toContain('<span class="name"><span class="owner">acme/</span><strong>app</strong></span>');
    expect(html).not.toContain('<strong>thing</strong>');
  });

  it('skips only rows whose slug has no canonical path (and repeats), and reports them', () => {
    const { cards, skipped } = homeDirectory(index(
      row('pmndrs__zustand'),
      row('bad__slug__extra'),
      row('Upper__Case'),
      { ...row('x__y'), slug: 42 },
      null,
      row('pmndrs__zustand'),
    ));
    expect(cards.map(card => card.href)).toEqual(['/r/pmndrs/zustand']);
    expect(skipped).toEqual([
      { slug: 'bad__slug__extra', reason: 'the slug has no canonical /r/ path' },
      { slug: 'Upper__Case', reason: 'the slug has no canonical /r/ path' },
      { slug: '(no slug)', reason: 'the slug has no canonical /r/ path' },
      { slug: '(no slug)', reason: 'not an object' },
      { slug: 'pmndrs__zustand', reason: 'a repeat of a row already shown' },
    ]);
    expect(homeHttpOutput('GET', { index: index(row('bad__slug__extra')) }).skipped).toEqual([{ slug: 'bad__slug__extra', reason: 'the slug has no canonical /r/ path' }]);
    expect(homeHttpOutput('HEAD', { index: index(row('bad__slug__extra')) }).skipped).toHaveLength(1);
  });

  it('strips bidi and invisible characters from row text, but keeps the joiners inside emoji', () => {
    const [card] = homeAtlasCards(index(row('acme__app', {
      description: 'safe \u202Etxt.exe\u202C and \u200Bhidden\uFEFF\u2066iso\u2069 \u200Ejoin',
      language: '\u202ETypeScript',
      license: { spdxId: 'MIT\u200F' },
    })));
    expect(card!.description).toBe('safe txt.exe and hiddeniso join');
    expect(card!.language).toBe('TypeScript');
    expect(card!.licence).toBe('MIT');
    expect(homeAtlasCards(index(row('acme__app', { description: '\u202E\u200B' })))[0]!.description).toBeUndefined();
    const html = homePageHtml({ index: index(row('acme__app', { description: 'a\u202Eb' })) });
    expect(html).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/);
    // U+200D (ZWJ) and U+200C (ZWNJ) are kept: stripping them splits the woman mage into a mage and a ♀ sign.
    const mage = '\u{1F9D9}\u200D\u2640\uFE0F';
    const [emoji] = homeAtlasCards(index(row('trpc__trpc', { description: `${mage} Move fast and break nothing`, language: 'Type\u200CScript' })));
    expect(emoji!.description).toBe(`${mage} Move fast and break nothing`);
    expect(emoji!.language).toBe('Type\u200CScript');
    expect(homePageHtml({ index: index(row('trpc__trpc', { description: `${mage} tRPC` })) })).toContain(`<span class="description">${mage} tRPC</span>`);
    expect(normalizeHomeQuery(` ${mage}\u200B `)).toBe(mage);
    expect(homeCardMatchesFor(emoji!, mage)).toBe(true);
  });

  it('uses GitHub casing, links the canonical path and thumbnails the /og card; skips unusable slugs and duplicates', () => {
    const cards = homeAtlasCards(index(
      RIPGREP,
      row('bad__slug__extra'),
      row('Upper__Case'),
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
      search: ['burntsushi/ripgrep'],
      searchWords: [],
    }]);
    // A row without usable stored names is still listed, under its slug's names.
    expect(homeAtlasCards(index({ ...row('acme__app'), owner: undefined })).map(card => `${card.owner}/${card.repo}`)).toEqual(['acme/app']);
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
  it('renders the hero, CTA, contact link, cards and footer, with only the deferred /home.js script', () => {
    const html = homePageHtml({ index: index(row('acme__app', { publishedAt: '2026-09-01T00:00:00Z', description: 'A small app', language: 'TypeScript' }), RIPGREP) });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html.match(/<script\b[^>]*>/gi)).toEqual(['<script src="/home.js" defer>']);
    expect(html).toContain('<script src="/home.js" defer></script>\n  </head>');
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
    expect(html).toContain('<li class="atlas" data-name="burntsushi/ripgrep" data-committed="2026-08-04T14:00:08.000Z" data-published="2026-09-29T18:02:19.030Z" data-entities="2831" data-search="burntsushi/ripgrep" data-rank-recent="0" data-rank-az="1">');
    expect(html).toContain('data-search="acme/app" data-search-words="a small app&#10;typescript" data-rank-recent="1" data-rank-az="0">');
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
    // A product-atlas row whose names do not slug back is still listed (under its slug's names), so it is the CTA.
    expect(homePageHtml({ index: index({ ...atlas, owner: 'someone' }, newer) }))
      .toContain(`<a class="cta" href="${HOME_EXPLORE_HREF}">Explore an atlas</a>`);
    // One whose slug is unusable is not listed: the CTA falls back to the first card.
    expect(homePageHtml({ index: index({ ...atlas, slug: 'source-for__atlas__x' }, newer) }))
      .toContain('<a class="cta" href="/r/pmndrs/zustand">Explore an atlas</a>');
    // A search never moves the CTA, even when it hides the CTA's card.
    expect(homePageHtml({ index: index(newer, atlas), q: 'zust' })).toContain(`<a class="cta" href="${HOME_EXPLORE_HREF}">Explore an atlas</a>`);

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
    expect(html.replace('<script src="/home.js" defer></script>', '')).not.toMatch(/<script/i);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<b>MIT');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&lt;b&gt;MIT&lt;/b&gt;');
    // The row with an invalid owner name is listed under its slug's names; the bad name appears nowhere.
    expect(html).toContain('<a class="card" href="/r/evil/repo">');
    expect(html).toContain('data-atlas-count="2"');
  });

  it('shows the hero and an empty note without an index or with no rows', () => {
    for (const value of [undefined, null, {}, index(), index(row('bad__slug__x'))]) {
      const html = homePageHtml({ index: value });
      expect(html).toContain('<p class="empty" data-empty="true">No atlases published yet.</p>');
      expect(html).not.toContain('Explore an atlas');
      expect(html).toContain('Want your repo mapped?');
      expect(html).not.toContain('<ul class="atlases"');
      // Nothing to search: no form, no script.
      expect(html).not.toContain('role="search"');
      expect(html).not.toMatch(/<script/i);
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
    expect(get.skipped).toEqual([]);
    expect(get.headers).toEqual({ 'cache-control': HOME_CACHE_CONTROL, 'content-type': 'text/html; charset=utf-8' });
    expect(HOME_CACHE_CONTROL).toBe('public, max-age=60');
    expect(get.body).toContain('<!doctype html>');
    const head = homeHttpOutput('head', { index: undefined });
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });
});

describe('CLA-269 home: search and sort (no JavaScript)', () => {
  const ROWS = index(
    row('pmndrs__zustand', { generatedAt: '2026-09-20T00:00:00Z', description: '🐻 Bear necessities for state management in React', language: 'TypeScript' }),
    RIPGREP,
    row('source-for__atlas', { generatedAt: '2026-09-25T00:00:00Z', description: 'Maps a repository <from> C4 context down to code', language: 'TypeScript' }),
    row('excalidraw__excalidraw', { generatedAt: '2026-09-10T00:00:00Z', description: 'Virtual whiteboard for sketching hand-drawn like diagrams', language: 'TypeScript' }),
    row('ziglang__zig', { generatedAt: '2026-09-01T00:00:00Z', language: 'Zig' }),
  );
  /** hrefs of the cards in page order, `hidden` ones marked. */
  const shown = (html: string) => [...html.matchAll(/<li class="atlas"[^>]*?( hidden)?>\s*<a class="card" href="([^"]+)"/g)].map(([, hidden, href]) => `${href}${hidden ? ' (hidden)' : ''}`);

  it('renders a labelled GET search form with the sort select above the grid', () => {
    const html = homePageHtml({ index: ROWS });
    expect(html).toContain('<form class="search" action="/" method="get" role="search" aria-label="Search published atlases" data-home-search>');
    expect(html).toContain('<label class="sr-only" for="home-q">Search atlases</label>');
    expect(html).toMatch(/<input id="home-q" class="search-input" type="search" name="q" value="" maxlength="100" /);
    expect(html).toContain('<label class="sr-only" for="home-sort">Sort</label>');
    expect(html).toContain('<option value="recent" selected>Most recent</option>');
    expect(html).toContain('<option value="az">A–Z</option>');
    expect(html).toContain('<button type="submit">Search</button>');
    expect(html.indexOf('role="search"')).toBeLessThan(html.indexOf('<ul class="atlases"'));
    expect(html).toContain('<p class="count" aria-live="polite" data-home-count>5 atlases</p>');
    expect(html).toContain('<p class="no-match" data-home-no-match hidden>');
    expect(shown(html)).toEqual(['/r/source-for/atlas', '/r/pmndrs/zustand', '/r/excalidraw/excalidraw', '/r/ziglang/zig', '/r/burnt-sushi/ripgrep']);
  });

  it('filters on owner/repo (GitHub casing and stored), description and language, case-insensitively; hides the rest', () => {
    const html = homePageHtml({ index: ROWS, q: 'ZUST' });
    expect(shown(html)).toEqual(['/r/source-for/atlas (hidden)', '/r/pmndrs/zustand', '/r/excalidraw/excalidraw (hidden)', '/r/ziglang/zig (hidden)', '/r/burnt-sushi/ripgrep (hidden)']);
    expect(html).toContain('<p class="count" aria-live="polite" data-home-count>1 of 5 atlases</p>');
    expect(html).toContain('value="ZUST"');
    const hits = (q: string) => homeAtlasCards(ROWS).filter(card => homeCardMatchesFor(card, q)).map(card => card.href);
    expect(hits('BurntSushi')).toEqual(['/r/burnt-sushi/ripgrep']);
    expect(hits('burntsushi/rip')).toEqual(['/r/burnt-sushi/ripgrep']);
    expect(hits('whiteboard')).toEqual(['/r/excalidraw/excalidraw']);
    expect(hits('zig')).toEqual(['/r/ziglang/zig']);
    expect(hits('typescript')).toEqual(['/r/source-for/atlas', '/r/pmndrs/zustand', '/r/excalidraw/excalidraw']);
    // Description and language match at word starts only: "TypeScript" contains "rip" and "script", but not at a
    // word start (camelCase is not a boundary), so `rip` finds ripgrep by name alone.
    expect(hits('rip')).toEqual(['/r/burnt-sushi/ripgrep']);
    expect(hits('script')).toEqual([]);
    expect(hits('type')).toEqual(['/r/source-for/atlas', '/r/pmndrs/zustand', '/r/excalidraw/excalidraw']);
    expect(hits('hand-drawn')).toEqual(['/r/excalidraw/excalidraw']);
    expect(hits('drawn')).toEqual(['/r/excalidraw/excalidraw']);
    expect(hits('rawn')).toEqual([]);
    expect(hits('state man')).toEqual(['/r/pmndrs/zustand']);
    expect(hits('bear')).toEqual(['/r/pmndrs/zustand']);
    // Names still match anywhere.
    expect(hits('calid')).toEqual(['/r/excalidraw/excalidraw']);
    const rip = homePageHtml({ index: ROWS, q: 'rip' });
    expect(shown(rip)).toEqual(['/r/source-for/atlas (hidden)', '/r/pmndrs/zustand (hidden)', '/r/excalidraw/excalidraw (hidden)', '/r/ziglang/zig (hidden)', '/r/burnt-sushi/ripgrep']);
    expect(rip).toContain('<p class="count" aria-live="polite" data-home-count>1 of 5 atlases</p>');
    expect(hits('🐻')).toEqual(['/r/pmndrs/zustand']);
    expect(hits('<from>')).toEqual(['/r/source-for/atlas']);
    // Fields are matched one at a time: text spanning two fields is not a hit.
    expect(hits('zig zig')).toEqual([]);
    // The first three SHOWN thumbnails load eagerly.
    expect(html).toMatch(/href="\/r\/pmndrs\/zustand">\s*<img [^>]*loading="eager"/);
    expect(html).toMatch(/href="\/r\/source-for\/atlas">\s*<img [^>]*loading="lazy"/);
  });

  it('sorts A–Z by owner/repo ignoring case, and falls back to recent for an unknown sort', () => {
    const az = homePageHtml({ index: ROWS, sort: 'az' });
    expect(shown(az)).toEqual(['/r/burnt-sushi/ripgrep', '/r/excalidraw/excalidraw', '/r/pmndrs/zustand', '/r/source-for/atlas', '/r/ziglang/zig']);
    expect(az).toContain('<option value="az" selected>A–Z</option>');
    expect(az).toContain('<option value="recent">Most recent</option>');
    // Ranks let home.js re-sort without the server: recent order and A–Z order.
    expect(az).toMatch(/data-rank-recent="4" data-rank-az="0">\s*<a class="card" href="\/r\/burnt-sushi\/ripgrep"/);
    expect(sortHomeCards(homeAtlasCards(ROWS), 'az').map(card => `${card.owner}/${card.repo}`)).toEqual(['BurntSushi/ripgrep', 'excalidraw/excalidraw', 'pmndrs/zustand', 'source-for/atlas', 'ziglang/zig']);
    for (const sort of ['popular', 'AZ', '', undefined]) {
      const html = homePageHtml({ index: ROWS, ...(sort === undefined ? {} : { sort }) });
      expect(shown(html)[0], String(sort)).toBe('/r/source-for/atlas');
      expect(html, String(sort)).toContain('<option value="recent" selected>');
      expect(homeSortFrom(sort)).toBe('recent');
    }
    expect(homeSortFrom('az')).toBe('az');
    const both = homePageHtml({ index: ROWS, q: 'typescript', sort: 'az' });
    expect(shown(both)).toEqual(['/r/burnt-sushi/ripgrep (hidden)', '/r/excalidraw/excalidraw', '/r/pmndrs/zustand', '/r/source-for/atlas', '/r/ziglang/zig (hidden)']);
    expect(both).toContain('3 of 5 atlases');
  });

  it('escapes the search in the input value and in the no-match message, which links back to /', () => {
    const q = '"><script>alert(1)</script>&\'';
    const html = homePageHtml({ index: ROWS, q });
    expect(html.replace('<script src="/home.js" defer></script>', '')).not.toMatch(/<script/i);
    const escaped = '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&#39;';
    expect(html).toContain(`name="q" value="${escaped}"`);
    expect(html).toContain(`<p class="no-match" data-home-no-match>No atlases match “<span data-home-query>${escaped}</span>”. <a href="/">Clear the search</a></p>`);
    expect(html).toContain('<p class="count" aria-live="polite" data-home-count>0 of 5 atlases</p>');
    expect(shown(html).every(entry => entry.endsWith('(hidden)'))).toBe(true);
  });

  it('trims the search, drops control/bidi characters and caps it at 100 code points', () => {
    expect(HOME_QUERY_MAX).toBe(100);
    expect(normalizeHomeQuery('  zu\tst \n')).toBe('zu st');
    expect(normalizeHomeQuery('‮zu​st')).toBe('zust');
    expect(normalizeHomeQuery(undefined)).toBe('');
    expect(Array.from(normalizeHomeQuery('🐻'.repeat(150)))).toHaveLength(100);
    const html = homePageHtml({ index: ROWS, q: `  ${'x'.repeat(150)}  ` });
    expect(html).toContain(`value="${'x'.repeat(100)}"`);
    expect(homeViewFrom(new URL('https://sourcefor.dev/?q=%20zust%20&sort=az&q=other'))).toEqual({ q: 'zust', sort: 'az' });
    expect(homeViewFrom(new URL('https://sourcefor.dev/?sort=nope'))).toEqual({ q: '', sort: 'recent' });
    // A whitespace-only search is no search.
    expect(homePageHtml({ index: ROWS, q: '   ' })).toContain('data-home-count>5 atlases</p>');
  });

  it('counts in words', () => {
    expect(homeCountText(3, 7, true)).toBe('3 of 7 atlases');
    expect(homeCountText(7, 7, false)).toBe('7 atlases');
    expect(homeCountText(1, 1, false)).toBe('1 atlas');
    expect(homeCountText(0, 1, true)).toBe('0 of 1 atlas');
  });

  it('renders realistic GitHub descriptions: long ones capped, emoji kept, markup escaped', () => {
    const long = `A cross-platform, GPU-accelerated terminal emulator and multiplexer written by @wez and implemented in Rust. ${'Lots more detail. '.repeat(20)}`;
    const html = homePageHtml({ index: index(
      row('wez__wezterm', { description: long, language: 'Rust' }),
      row('pmndrs__zustand', { description: '🐻 Bear necessities for state management in React' }),
      row('acme__app', { description: 'Renders <div> & "quotes" in 1 < 2 cases' }),
    ) });
    expect(html).toContain('<span class="description">🐻 Bear necessities for state management in React</span>');
    expect(html).toContain('<span class="description">Renders &lt;div&gt; &amp; &quot;quotes&quot; in 1 &lt; 2 cases</span>');
    const description = /<span class="description">(A cross-platform[^<]*)<\/span>/.exec(html)![1]!;
    expect(Array.from(description)).toHaveLength(280);
    expect(description.endsWith('…')).toBe(true);
  });
});

function homeCardMatchesFor(card: { search: string[]; searchWords: string[] }, q: string): boolean {
  return homeCardMatches(card, normalizeHomeQuery(q));
}
