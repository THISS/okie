import { canonicalAtlasPathForSlug, isoDate } from '../../web/src/publishedNames';
import { CANONICAL_ORIGIN } from '../../web/src/siteMeta';
import { PUBLISHED_INDEX_SCHEMA } from '../../server/src/publishedStoreLayout';
import type { EdgeEnv } from './env';
import { readPublishedIndex } from './publishedIndexCache';

/**
 * `GET /sitemap.xml` (CLA-318): the home page `/` (the published-atlas directory since CLA-269;
 * `<lastmod>` = the newest publishedAt) and every published atlas's canonical
 * `/r/<slug owner>/<slug repo>` (the same target the case/punctuation 301 and the page's
 * `<link rel="canonical">` use), on `OKIE_PUBLIC_ORIGIN` (fallback https://sourcefor.dev), with
 * `<lastmod>` from the row's publishedAt. `/new` is not listed: it 301s to `/`. Built from the
 * published index.json in R2 (through the per-isolate cache, publishedIndexCache.ts); a missing or
 * unreadable index still answers `/`.
 */
export const SITEMAP_PATH = '/sitemap.xml';
export const SITEMAP_CACHE_CONTROL = 'public, max-age=300';

export type SitemapUrl = { loc: string; lastmod?: string };

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The canonical origin for sitemap URLs: `OKIE_PUBLIC_ORIGIN` when it parses as http(s), else production. */
export function sitemapOrigin(env: Pick<EdgeEnv, 'OKIE_PUBLIC_ORIGIN'>): string {
  const raw = env.OKIE_PUBLIC_ORIGIN?.trim();
  if (raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch {
      // fall through to production
    }
  }
  return CANONICAL_ORIGIN;
}

/** Sitemap URLs from a parsed index.json (anything unexpected contributes nothing). */
export function sitemapUrls(index: unknown, origin: string): SitemapUrl[] {
  const repos = (index as { schema?: unknown; repos?: unknown } | null)?.schema === PUBLISHED_INDEX_SCHEMA
    ? (index as { repos?: unknown }).repos
    : undefined;
  const atlases: SitemapUrl[] = [];
  const seen = new Set<string>();
  let newest: string | undefined;
  for (const row of Array.isArray(repos) ? repos : []) {
    const path = canonicalAtlasPathForSlug((row as { slug?: unknown } | null)?.slug);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const lastmod = isoDate((row as { publishedAt?: unknown }).publishedAt);
    if (lastmod && (!newest || lastmod > newest)) newest = lastmod;
    atlases.push({ loc: new URL(path, origin).href, ...(lastmod ? { lastmod } : {}) });
  }
  atlases.sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0));
  return [{ loc: new URL('/', origin).href, ...(newest ? { lastmod: newest } : {}) }, ...atlases];
}

export function renderSitemap(urls: readonly SitemapUrl[]): string {
  const entries = urls.map(url => `  <url>\n    <loc>${escapeXml(url.loc)}</loc>${url.lastmod ? `\n    <lastmod>${escapeXml(url.lastmod)}</lastmod>` : ''}\n  </url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`;
}

export async function handleSitemapRequest(request: Request, env: Pick<EdgeEnv, 'ATLAS_BUCKET' | 'OKIE_PUBLIC_ORIGIN'>): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('method not allowed\n', { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' } });
  }
  const body = renderSitemap(sitemapUrls(await readPublishedIndex(env.ATLAS_BUCKET), sitemapOrigin(env)));
  return new Response(method === 'HEAD' ? null : body, {
    status: 200,
    headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': SITEMAP_CACHE_CONTROL },
  });
}
