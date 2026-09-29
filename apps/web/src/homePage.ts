import { SOURCE_FOR_MARK_SVG, siteFooterHtml } from './notFoundPage';
import { buildSitePageOpenGraphTags, renderOpenGraphHead, trustedPageOrigin } from './openGraph';
import { canonicalAtlasPathForSlug, isoDate, publishedNamesFor } from './publishedNames';
import { repoSlugFor } from './renderer/route';
import { BRAND_NAME, CONTACT_EMAIL, HOME_DESCRIPTION, PRODUCT_NAME, homePageMeta } from './siteMeta';

/**
 * The hosted home page (CLA-269): `/` on sourcefor.dev is a server-rendered hero plus a directory of
 * every published atlas, built from the published index.json. One self-contained HTML document (inline
 * CSS and SVG, no script: the CSP forbids inline script and the page needs none), so it renders without
 * the SPA bundle. Runtime-agnostic (no DOM, no Node): the edge Worker bundles it for workerd.
 *
 * Only the edge serves it ({@link isHomeRequest}); the Vite dev/preview servers keep `/` as the golden
 * demo. Everything interpolated from the index is HTML-escaped; names come through publishedNamesFor
 * (GitHub's casing), links through canonicalAtlasPathForSlug (rows without a canonical path, or whose names
 * do not slug back to it, are skipped).
 */

/** The primary CTA: the product's own atlas, when the index lists it (else the first card; no cards, no CTA). */
export const HOME_EXPLORE_HREF = '/r/source-for/atlas';
export const HOME_CACHE_CONTROL = 'public, max-age=60';
/** Caps for the free-text row fields a later increment adds to the index. */
export const HOME_DESCRIPTION_MAX = 280;
export const HOME_LANGUAGE_MAX = 40;
const LICENCE_MAX = 64;

/** Query params that still serve the home (search/sort land in the next increment; the rest are tracking). */
const HOME_QUERY_PARAMS = new Set(['q', 'sort', 'ref', 'fbclid', 'gclid']);

/** Whether a query param name is on the home allowlist (shared by {@link isHomeRequest} and the `/new` 301). */
export function isHomeQueryParam(name: string): boolean {
  return HOME_QUERY_PARAMS.has(name) || /^utm_[A-Za-z0-9_-]*$/.test(name);
}

/**
 * Whether a request URL gets the home page: `/` or `/index.html` whose query holds only allowlisted
 * params (`q`, `sort`, any `utm_*`, `ref`, `fbclid`, `gclid`). Any other param (`fixture`, `portable`,
 * `embed`, `open`, navigation/story state…) keeps today's SPA shell, so the golden demo stays at
 * `/?fixture=okie` and every query-carrying deep link keeps working.
 */
export function isHomeRequest(url: URL): boolean {
  if (url.pathname !== '/' && url.pathname !== '/index.html') return false;
  for (const name of url.searchParams.keys()) {
    if (!isHomeQueryParam(name)) return false;
  }
  return true;
}

/**
 * `url`'s query with only the home-allowlisted params kept, in order (`?utm_source=x`), or `''` when none
 * are left: the `/new` 301 target's query, so an old `/new?<other>` link still lands on the home.
 */
export function homeSearchFrom(url: URL): string {
  const kept = new URLSearchParams();
  for (const [name, value] of url.searchParams) {
    if (isHomeQueryParam(name)) kept.append(name, value);
  }
  const search = kept.toString();
  return search ? `?${search}` : '';
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Bidi controls and zero-width characters: they can reorder or hide the text around them (U+202E flips a name). */
const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * Single-line, trimmed, length-capped text (an ellipsis marks a cut), with bidi and zero-width characters
 * removed; undefined when not a non-empty string.
 */
function cappedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(INVISIBLE, '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  if (!text) return undefined;
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `4 Aug 2026` in UTC (deterministic: no locale, no time zone). */
export function formatHomeDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** `2,831 entities` / `1 entity` (deterministic grouping, no locale). */
export function formatEntityCount(count: number): string {
  const grouped = String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped} ${count === 1 ? 'entity' : 'entities'}`;
}

const COMMIT = /^[a-f0-9]{7,40}$/;

export type HomeAtlasCard = {
  href: string;
  /** `/og/<slug owner>/<slug repo>`: the 1200×630 share card. */
  thumbnail: string;
  owner: string;
  repo: string;
  licence?: string;
  shortSha?: string;
  /** The snapshot generatedAt: the pinned commit's committer date (packages/scan github.ts). */
  commitDate?: string;
  publishedAt?: string;
  entityCount?: number;
  description?: string;
  language?: string;
};

function licenceFor(license: unknown): string | undefined {
  if (!license || typeof license !== 'object') return undefined;
  const spdxId = cappedText((license as { spdxId?: unknown }).spdxId, LICENCE_MAX);
  if (spdxId && spdxId !== 'NOASSERTION') return spdxId;
  return cappedText((license as { name?: unknown }).name, LICENCE_MAX);
}

/** Newest first by an ISO field; undated last; 0 on a tie. */
function newestFirst(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? 1 : -1;
}

function compareCards(a: HomeAtlasCard, b: HomeAtlasCard): number {
  // By the date each card shows (the commit date) newest first, then most recently published; undated
  // last; ties by name. ISO strings from isoDate compare in time order.
  const byDate = newestFirst(a.commitDate, b.commitDate) || newestFirst(a.publishedAt, b.publishedAt);
  if (byDate) return byDate;
  const an = `${a.owner}/${a.repo}`.toLowerCase();
  const bn = `${b.owner}/${b.repo}`.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.href < b.href ? -1 : a.href > b.href ? 1 : 0;
}

/**
 * Whether the names a card shows slug back to the row's slug (so a card can never show one repo and link
 * another): the stored owner/repo, or GitHub's casing when publishedNamesFor verified it against them.
 * The casing counts because the slug is derived from it: stored `burntsushi` has slug `burnt-sushi__ripgrep`
 * (from `BurntSushi`), which the stored names alone would never reproduce.
 */
function namesMatchSlug(row: Record<string, unknown>, names: { owner: string; repo: string }, slug: unknown): boolean {
  return repoSlugFor(String(row.owner), String(row.repo)) === slug || repoSlugFor(names.owner, names.repo) === slug;
}

/** Directory cards from a parsed index (`{ repos: [...] }`); anything unexpected contributes nothing. */
export function homeAtlasCards(index: unknown): HomeAtlasCard[] {
  const repos = (index as { repos?: unknown } | null | undefined)?.repos;
  if (!Array.isArray(repos)) return [];
  const cards: HomeAtlasCard[] = [];
  const seen = new Set<string>();
  for (const row of repos) {
    if (!row || typeof row !== 'object') continue;
    const value = row as Record<string, unknown>;
    const href = canonicalAtlasPathForSlug(value.slug);
    const names = publishedNamesFor(value);
    if (!href || !names || seen.has(href) || !namesMatchSlug(value, names, value.slug)) continue;
    seen.add(href);
    const commitSha = typeof value.commitSha === 'string' && COMMIT.test(value.commitSha) ? value.commitSha : undefined;
    const entityCount = typeof value.entityCount === 'number' && Number.isSafeInteger(value.entityCount) && value.entityCount >= 0 ? value.entityCount : undefined;
    const licence = licenceFor(value.license);
    const commitDate = isoDate(value.generatedAt);
    const publishedAt = isoDate(value.publishedAt);
    const description = cappedText(value.description, HOME_DESCRIPTION_MAX);
    const language = cappedText(value.language, HOME_LANGUAGE_MAX);
    cards.push({
      href,
      thumbnail: `/og/${href.slice('/r/'.length)}`,
      owner: names.owner,
      repo: names.repo,
      ...(licence ? { licence } : {}),
      ...(commitSha ? { shortSha: commitSha.slice(0, 7) } : {}),
      ...(commitDate ? { commitDate } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(entityCount !== undefined ? { entityCount } : {}),
      ...(description ? { description } : {}),
      ...(language ? { language } : {}),
    });
  }
  return cards.sort(compareCards);
}

/** Thumbnails above the fold on a wide screen (one row of three) load eagerly; the rest wait for the viewport. */
export const HOME_EAGER_THUMBNAILS = 3;

/** The hero CTA target: the product's own atlas when listed, else the first card; undefined without cards. */
export function homeExploreHref(cards: readonly HomeAtlasCard[]): string | undefined {
  return cards.some(card => card.href === HOME_EXPLORE_HREF) ? HOME_EXPLORE_HREF : cards[0]?.href;
}

function cardHtml(card: HomeAtlasCard, position: number): string {
  const e = escapeHtml;
  const name = `${card.owner}/${card.repo}`;
  const facts: string[] = [];
  if (card.language) facts.push(`<span class="fact" data-field="language">${e(card.language)}</span>`);
  if (card.licence) facts.push(`<span class="fact" data-field="licence">${e(card.licence)}</span>`);
  if (card.entityCount !== undefined) facts.push(`<span class="fact" data-field="entities">${e(formatEntityCount(card.entityCount))}</span>`);
  const commit = card.shortSha
    ? `<span class="commit">commit <code>${e(card.shortSha)}</code>${card.commitDate ? ` · <time datetime="${e(card.commitDate)}">${e(formatHomeDate(card.commitDate))}</time>` : ''}</span>`
    : '';
  const body = [
    `<span class="name"><span class="owner">${e(card.owner)}/</span><strong>${e(card.repo)}</strong></span>`,
    card.description ? `<span class="description">${e(card.description)}</span>` : '',
    facts.length ? `<span class="facts">${facts.join('')}</span>` : '',
    commit,
  ].filter(Boolean);
  const attributes = [
    `data-name="${e(name.toLowerCase())}"`,
    card.commitDate ? `data-committed="${e(card.commitDate)}"` : '',
    card.publishedAt ? `data-published="${e(card.publishedAt)}"` : '',
    card.entityCount !== undefined ? `data-entities="${card.entityCount}"` : '',
    card.language ? `data-language="${e(card.language.toLowerCase())}"` : '',
  ].filter(Boolean).join(' ');
  return `<li class="atlas" ${attributes}>
          <a class="card" href="${e(card.href)}">
            <img src="${e(card.thumbnail)}" alt="" width="1200" height="630" loading="${position < HOME_EAGER_THUMBNAILS ? 'eager' : 'lazy'}" decoding="async" />
            <span class="body">
              ${body.join('\n              ')}
            </span>
          </a>
        </li>`;
}

export type HomePageInput = {
  /** The parsed published index.json (`{ repos: [...] }`), or undefined when missing/unreadable. */
  index: unknown;
  /** The request's origin; og:url / og:image use it only when allowlisted, else production. */
  requestOrigin?: string;
  allowedOrigins?: readonly string[];
};

const FAVICONS = `<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32" />
    <link rel="icon" href="/favicon-16.png" type="image/png" sizes="16x16" />
    <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" />`;

const STYLE = `
      *{box-sizing:border-box}
      html,body{margin:0;min-height:100%;background:#070a0b;color:#eef4f2}
      body{font:16px/1.6 "IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
      a{color:inherit}
      .hero{max-width:1120px;margin:0 auto;padding:4rem 1rem 2.5rem}
      .hero h1{display:flex;align-items:center;gap:.7rem;margin:0 0 .75rem;font-size:2rem;line-height:1.2;font-weight:600;letter-spacing:-.02em;color:#f1f7f4}
      .hero h1 svg{flex:none;width:40px;height:40px}
      .hero h1 span span{color:#97a5a0;font-weight:500}
      .lede{max-width:42rem;margin:0;color:#b7c3c0;font-size:1.1rem}
      .actions{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem 1.25rem;margin-top:1.75rem}
      .cta{padding:.6rem 1.1rem;border:1px solid #d9ff70;border-radius:8px;background:#d9ff70;color:#0d1a17;font-weight:600;text-decoration:none}
      .cta:hover{border-color:#79dfd4;background:#79dfd4}
      .cta:focus-visible,.ask a:focus-visible{outline:2px solid #79dfd4;outline-offset:2px}
      .ask{margin:0;color:#97a5a0;font-size:.9rem}
      .ask a{color:#79dfd4}
      .directory{max-width:1120px;margin:0 auto;padding:0 1rem 3rem}
      .directory h2{margin:0 0 1rem;font-size:1.15rem;font-weight:600}
      .directory h2 span{color:#97a5a0;font-weight:400}
      .empty{margin:0;color:#b7c3c0}
      .atlases{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:1rem;margin:0;padding:0;list-style:none}
      .atlas{min-width:0}
      .card{display:flex;flex-direction:column;height:100%;border:1px solid #1d2a28;border-radius:10px;background:#0d1413;text-decoration:none;overflow:hidden}
      .card:hover,.card:focus-visible{border-color:#79dfd4}
      .card:focus-visible{outline:2px solid #79dfd4;outline-offset:2px}
      .card img{display:block;width:100%;height:auto;aspect-ratio:1200/630;background:#101918;border-bottom:1px solid #1d2a28}
      .body{display:grid;gap:.45rem;padding:.85rem 1rem 1rem}
      .name{font-size:1.05rem;line-height:1.3;color:#f1f7f4}
      .name .owner{color:#97a5a0}
      .name strong{font-weight:600}
      .description{color:#b7c3c0;font-size:.9rem}
      .facts{display:flex;flex-wrap:wrap;gap:.35rem}
      .fact{padding:.1rem .5rem;border:1px solid #2a3a37;border-radius:999px;color:#cfd9d6;font-size:.78rem}
      .commit{color:#97a5a0;font-size:.8rem}
      .commit code{color:#d9ff70;font:600 .8rem/1 "IBM Plex Mono",ui-monospace,monospace}
      .site-footer{max-width:1120px;margin:0 auto;padding:1.5rem 1rem 3rem;border-top:1px solid #1d2a28;color:#b7c3c0;font-size:.85rem;display:grid;gap:.4rem}
      .site-footer p{margin:0}
      .site-footer a{color:#79dfd4}
      @media (min-width:720px){.hero{padding:5rem 1.5rem 3rem}.hero h1{font-size:2.6rem}.directory,.site-footer{padding-left:1.5rem;padding-right:1.5rem}}
    `;

export function homePageHtml(input: HomePageInput): string {
  const tags = buildSitePageOpenGraphTags(homePageMeta(), trustedPageOrigin(input.requestOrigin ?? '', input.allowedOrigins));
  const cards = homeAtlasCards(input.index);
  const exploreHref = homeExploreHref(cards);
  const cta = exploreHref ? `<a class="cta" href="${escapeHtml(exploreHref)}">Explore an atlas</a>\n          ` : '';
  const directory = cards.length
    ? `<h2 id="atlases-heading">Published atlases <span>(${cards.length})</span></h2>
      <ul class="atlases" aria-labelledby="atlases-heading" data-atlas-count="${cards.length}">
        ${cards.map((card, position) => cardHtml(card, position)).join('\n        ')}
      </ul>`
    : `<h2 id="atlases-heading">Published atlases</h2>
      <p class="empty" data-empty="true">No atlases published yet.</p>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#070a0b" />
    <meta name="color-scheme" content="dark" />
    ${renderOpenGraphHead(tags)}
    ${FAVICONS}
    <style>${STYLE}</style>
  </head>
  <body>
    <main data-home="true">
      <section class="hero" aria-labelledby="home-heading">
        <h1 id="home-heading">${SOURCE_FOR_MARK_SVG}<span>${escapeHtml(BRAND_NAME)} <span>${escapeHtml(PRODUCT_NAME)}</span></span></h1>
        <p class="lede">${escapeHtml(HOME_DESCRIPTION)}</p>
        <div class="actions">
          ${cta}<p class="ask">Want your repo mapped? <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a></p>
        </div>
      </section>
      <section class="directory" aria-labelledby="atlases-heading">
      ${directory}
      </section>
    </main>
    ${siteFooterHtml()}
  </body>
</html>
`;
}

export type HomeHttpOutput = { status: 200; headers: Record<string, string>; body: string };

/** The home answer for GET/HEAD; HEAD gets the headers only. */
export function homeHttpOutput(method: string, input: HomePageInput): HomeHttpOutput {
  return {
    status: 200,
    headers: { 'cache-control': HOME_CACHE_CONTROL, 'content-type': 'text/html; charset=utf-8' },
    body: method.toUpperCase() === 'HEAD' ? '' : homePageHtml(input),
  };
}
