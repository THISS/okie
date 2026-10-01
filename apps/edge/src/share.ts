import { isDogfoodAtlas } from '../../web/src/hostedAtlas';
import { oembedAllowedOriginsFromEnv, sanitizeOembedOrigin } from '../../web/src/oembed';
import { parseOgImagePath } from '../../web/src/openGraph';
import { handlePublicAtlasRoute, isPublicAtlasRoutePath } from '../../web/src/publicAtlasRoutes';
import { parseAppRoute, repoSlugFor } from '../../web/src/renderer/route';
import { isPublishedVersionId, PUBLISHED_INDEX_SCHEMA, publishedCardKey, publishedIndexKey } from '../../server/src/publishedStoreLayout';
import { STRUCTURE_CARD_RENDERER_VERSION } from '../../web/src/atlasStructureCardVersion';
import type { PublicAtlasDisplayNames } from '../../web/src/oembed';
import { publishedNamesFor, publishedRowForSlug } from '../../web/src/publishedNames';
import { webMcpHostHeadersForFetchDest } from '../../web/src/webmcpHeaders';
import type { EdgeEnv } from './env';
import { readPublishedIndex } from './publishedIndexCache';
import { isPublishedAtlas } from './scan';

/**
 * Share pages at the edge (CLA-266): `/r/<owner>/<repo>` Open Graph HTML (injected into the static
 * assets' index.html), `/og/<owner>/<repo>` PNG cards, `/oembed` JSON and `/new` landing meta (CLA-318) — the same runtime-agnostic
 * handlers the Vite dev server uses (apps/web/src/publicAtlasRoutes.ts). "Public" here = the slug has a
 * `latest.json` in R2, plus the THISS/okie dogfood rule.
 */
export { isPublicAtlasRoutePath };

export type ShareRouteContext = {
  waitUntil(promise: Promise<unknown>): void;
  /** Cache API store (defaults to `caches.default`); undefined disables edge caching of `/og` cards. */
  cache?: Cache;
};

/**
 * Bump when the card's pixels change for the same names (a layout change), so a deploy never serves
 * a card rendered by the previous layout from the edge cache. apps/edge/test/ogCardVersion.test.ts pins
 * the sha256 of reference cards and fails with a reminder to bump this when apps/web/src/atlasCard.ts
 * renders different bytes. CLA-319 did not bump it: the generated card's pixels are unchanged, and the key
 * now also carries the published version and the structure card renderer (`&v=…&r=…`), so entries cached
 * under the old key shape are simply never looked up again.
 */
export const OG_CARD_CACHE_VERSION = '3';
/** Edge TTL for a rendered `/og` card. The key carries the printed names, so a rename misses at once. */
export const OG_CARD_EDGE_TTL_SECONDS = 86_400;
/**
 * CLA-319: edge TTL for the generated card served in place of a published version's stored card (none yet for the
 * current renderer, or unreadable). Short, so a card put later (`--backfill-cards`) is served within minutes rather
 * than a day under the key that names that version.
 */
export const OG_CARD_FALLBACK_EDGE_TTL_SECONDS = 300;
const BROWSER_CACHE_CONTROL_HEADER = 'x-okie-browser-cache-control';

function defaultCache(): Cache | undefined {
  return typeof caches === 'undefined' ? undefined : (caches as unknown as { default: Cache }).default;
}

export type OgCardCacheEntry = {
  key: string;
  /** Slug the names were read for; the render reuses them instead of reading the index again. */
  slug: string;
  names: PublicAtlasDisplayNames | undefined;
  /** CLA-319: the index row's published version (whose stored card `/og` serves); undefined without a row. */
  versionId: string | undefined;
};

/**
 * Cache API entry for a `/og/<owner>/<repo>` card (CLA-269), or undefined when the request is not a
 * plain card GET (HEAD, conditional and range requests bypass the cache). The card's bytes are a pure
 * function of the parsed owner/repo (map seed, case kept) and the printed names, so the key is built
 * from the parsed owner/repo — never the raw path, so `/og/%61cme/x`, `/og//acme/x` and `/og/acme/x.png`
 * share one entry — plus the names the published index gives now (read through the per-isolate index
 * cache) and the card layout version. A backfill or publish that renames the atlas yields a new key
 * within the index cache's minute. CLA-319: the key also carries the row's `versionId` (`&v=`, `-` without
 * one) and {@link STRUCTURE_CARD_RENDERER_VERSION} (`&r=`), because the response may be that version's stored
 * structure card: a re-publish or a `--set-latest` rollback moves the row and so the key (within the minute),
 * and a new renderer never reuses a card cached for the old one.
 */
export async function ogCardCacheEntry(request: Request, url: URL, bucket: R2Bucket): Promise<OgCardCacheEntry | undefined> {
  if (request.method.toUpperCase() !== 'GET') return undefined;
  for (const header of ['if-none-match', 'if-modified-since', 'range']) {
    if (request.headers.has(header)) return undefined;
  }
  let parsed: { owner: string; repo: string } | undefined;
  try { parsed = parseOgImagePath(url.pathname); } catch { return undefined; }
  if (!parsed) return undefined;
  const slug = repoSlugFor(parsed.owner, parsed.repo);
  const row = await publishedIndexRow(bucket, slug);
  const names = displayNamesFromRow(row);
  const versionId = versionIdFromRow(row);
  const printed = names ? `${encodeURIComponent(names.owner)}/${encodeURIComponent(names.repo)}` : '-';
  const path = `/og/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`;
  const version = versionId ? encodeURIComponent(versionId) : '-';
  return {
    key: `${url.origin}${path}?card=${OG_CARD_CACHE_VERSION}&names=${printed}&v=${version}&r=${STRUCTURE_CARD_RENDERER_VERSION}`,
    slug,
    names,
    versionId,
  };
}

/** The Cache API key alone (see {@link ogCardCacheEntry}). */
export async function ogCardCacheKey(request: Request, url: URL, bucket: R2Bucket): Promise<string | undefined> {
  return (await ogCardCacheEntry(request, url, bucket))?.key;
}

/** The cached card with the browser's own cache-control restored (the stored copy carries the edge TTL). */
function fromCache(cached: Response): Response {
  const headers = new Headers(cached.headers);
  const browser = headers.get(BROWSER_CACHE_CONTROL_HEADER);
  headers.delete(BROWSER_CACHE_CONTROL_HEADER);
  if (browser) headers.set('cache-control', browser); else headers.delete('cache-control');
  return new Response(cached.body, { status: cached.status, headers });
}

function forCache(response: Response, ttlSeconds: number): Response {
  const stored = response.clone();
  const headers = new Headers(stored.headers);
  const browser = headers.get('cache-control');
  if (browser) headers.set(BROWSER_CACHE_CONTROL_HEADER, browser);
  headers.set('cache-control', `public, max-age=${ttlSeconds}`);
  return new Response(stored.body, { status: stored.status, headers });
}

/**
 * Share routes. `/og` card GETs go through the Cache API (rendering is a full 1200×630 PNG at deflate
 * level 9 plus an R2 check): only 200s are stored, never a 404, so an atlas published later shows up at once.
 * A generated card served for a published version (its stored card missing) is kept only
 * {@link OG_CARD_FALLBACK_EDGE_TTL_SECONDS}; everything else {@link OG_CARD_EDGE_TTL_SECONDS}.
 * A Cache API failure (match or put) never fails the request: it falls through to a fresh render.
 *
 * No purge on unpublish: an unpublished atlas's card stays cached at the edge for up to
 * {@link OG_CARD_EDGE_TTL_SECONDS} (a day). The card carries the owner/repo name and either a map preview
 * seeded from that name or (CLA-319) the published version's structure card: system, container and peer
 * names from the public snapshot that `/scan` served while it was published. Serving it a little longer
 * exposes nothing that was not already public.
 */
export async function handleShareRoute(request: Request, env: EdgeEnv, context?: ShareRouteContext): Promise<Response | undefined> {
  const url = new URL(request.url);
  const cache = context && ('cache' in context ? context.cache : defaultCache());
  const entry = cache ? await ogCardCacheEntry(request, url, env.ATLAS_BUCKET) : undefined;
  if (cache && entry) {
    let cached: Response | undefined;
    try { cached = await cache.match(entry.key); } catch { cached = undefined; }
    if (cached) return fromCache(cached);
  }
  const rendered = await renderShareRoute(request, url, env, entry);
  const response = rendered?.response;
  if (cache && entry && context && response?.status === 200 && response.headers.get('content-type') === 'image/png') {
    // A version that should have a stored card but served the generated one is cached briefly (CLA-319).
    const ttl = entry.versionId && rendered?.ogCard !== 'stored' ? OG_CARD_FALLBACK_EDGE_TTL_SECONDS : OG_CARD_EDGE_TTL_SECONDS;
    let stored: Promise<unknown>;
    try { stored = Promise.resolve(cache.put(entry.key, forCache(response, ttl))).catch(() => undefined); } catch { stored = Promise.resolve(); }
    context.waitUntil(stored);
  }
  return response;
}

async function renderShareRoute(request: Request, url: URL, env: EdgeEnv, known?: OgCardCacheEntry): Promise<{ response: Response; ogCard?: 'stored' | 'generated' } | undefined> {
  const bucket = env.ATLAS_BUCKET;
  const result = await handlePublicAtlasRoute({
    method: request.method,
    pathname: url.pathname,
    search: url.search,
    requestOrigin: sanitizeOembedOrigin(url.origin) ?? '',
    allowedOrigins: oembedAllowedOriginsFromEnv({ OKIE_PUBLIC_ORIGIN: env.OKIE_PUBLIC_ORIGIN }),
    isPublicAtlas: async (owner, repo) => isDogfoodAtlas(owner, repo) || isPublishedAtlas(bucket, repoSlugFor(owner, repo)),
    displayNames: async (owner, repo) => {
      const slug = repoSlugFor(owner, repo);
      return known?.slug === slug ? known.names : publishedDisplayNames(bucket, slug);
    },
    storedCard: async (owner, repo) => {
      const slug = repoSlugFor(owner, repo);
      const versionId = known?.slug === slug ? known.versionId : versionIdFromRow(await publishedIndexRow(bucket, slug));
      return versionId ? readStoredCard(bucket, slug, versionId) : undefined;
    },
    indexHtml: async () => {
      const shell = await env.ASSETS.fetch(new Request(new URL('/', url), { headers: { accept: 'text/html' } }));
      return shell.ok ? shell.text() : '';
    },
  });
  if (!result) return undefined;
  if (result.status === 404) {
    const redirect = await canonicalShareRedirect(request, url, bucket);
    if (redirect) return { response: redirect };
  }
  const headers = new Headers(result.headers);
  if (headers.get('content-type')?.startsWith('text/html')) {
    for (const [name, value] of Object.entries(webMcpHostHeadersForFetchDest(request.headers.get('sec-fetch-dest') ?? undefined))) {
      headers.set(name, value);
    }
  }
  return {
    response: new Response(result.body === '' ? null : result.body, { status: result.status, headers }),
    ...(result.ogCard ? { ogCard: result.ogCard } : {}),
  };
}

/**
 * CLA-318: owner/repo as the published index row names them — GitHub's casing (`ownerLogin`/`repoName`)
 * when recorded, else the stored names. Reads index.json through the per-isolate cache (at most one R2
 * read a minute), only for a public share route (title, oEmbed, card text); no GitHub call. Undefined
 * (show the URL's names) without a row.
 */
export async function publishedDisplayNames(bucket: R2Bucket, slug: string): Promise<PublicAtlasDisplayNames | undefined> {
  return displayNamesFromRow(await publishedIndexRow(bucket, slug));
}

/** The published index row for a slug, through the per-isolate index cache; undefined without one. */
async function publishedIndexRow(bucket: R2Bucket, slug: string): Promise<Record<string, unknown> | undefined> {
  const index = await readPublishedIndex(bucket) as { schema?: unknown } | undefined;
  if (index?.schema !== PUBLISHED_INDEX_SCHEMA) return undefined;
  return publishedRowForSlug(index, slug);
}

function displayNamesFromRow(row: Record<string, unknown> | undefined): PublicAtlasDisplayNames | undefined {
  const names = publishedNamesFor(row);
  return names ? { owner: names.owner, repo: names.repo } : undefined;
}

/** CLA-319: the row's published version id, when it is one the store layout accepts. */
function versionIdFromRow(row: Record<string, unknown> | undefined): string | undefined {
  const versionId = row?.versionId;
  return typeof versionId === 'string' && isPublishedVersionId(versionId) ? versionId : undefined;
}

/**
 * CLA-319: the version's stored structure card for the CURRENT renderer only (`card-<STRUCTURE_CARD_RENDERER_VERSION>.png`);
 * a card left by an older renderer is never served. Undefined when missing or unreadable (the generated card serves).
 */
async function readStoredCard(bucket: R2Bucket, slug: string, versionId: string): Promise<Uint8Array | undefined> {
  const object = await bucket.get(publishedCardKey(slug, versionId, STRUCTURE_CARD_RENDERER_VERSION));
  return object ? new Uint8Array(await object.arrayBuffer()) : undefined;
}

/** Owner/repo compared the way people mistype them: case and punctuation ignored (BurntSushi = burntsushi = burnt-sushi). */
function looseName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * `/r/<owner>/<repo>[/…]` that is not a published slug but names a published atlas once case and
 * punctuation are ignored (GitHub's `BurntSushi` slugs to `burnt-sushi`, so `/r/burntsushi/ripgrep`
 * misses): 301 to the canonical `/r/<slug owner>/<slug repo>` with the rest of the path and the query.
 * Only runs on a share-page 404, so published hits never read the index.
 */
export async function canonicalShareRedirect(request: Request, url: URL, bucket: R2Bucket): Promise<Response | undefined> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return undefined;
  let route: ReturnType<typeof parseAppRoute>;
  try { route = parseAppRoute(url.pathname); } catch { return undefined; }
  if (route.kind !== 'repo') return undefined;
  const object = await bucket.get(publishedIndexKey());
  if (!object) return undefined;
  let rows: unknown;
  try {
    const index = await object.json<{ schema?: unknown; repos?: unknown }>();
    rows = index?.schema === PUBLISHED_INDEX_SCHEMA ? index.repos : undefined;
  } catch {
    return undefined;
  }
  if (!Array.isArray(rows)) return undefined;
  const owner = looseName(route.owner);
  const repo = looseName(route.repo);
  const row = rows.find(candidate => {
    const entry = candidate as { owner?: unknown; repo?: unknown } | null;
    return typeof entry?.owner === 'string' && typeof entry.repo === 'string' && looseName(entry.owner) === owner && looseName(entry.repo) === repo;
  }) as { slug?: unknown } | undefined;
  if (typeof row?.slug !== 'string') return undefined;
  const [slugOwner, slugRepo, ...extra] = row.slug.split('__');
  // Only a slug whose own path maps straight back to it (never a loop, never a different atlas).
  if (!slugOwner || !slugRepo || extra.length > 0 || repoSlugFor(slugOwner, slugRepo) !== row.slug || row.slug === route.slug) return undefined;
  const rest = route.ref ? `/${route.ref.split('/').map(encodeURIComponent).join('/')}` : '';
  return new Response(null, {
    status: 301,
    headers: { location: `/r/${slugOwner}/${slugRepo}${rest}${url.search}`, 'cache-control': 'public, max-age=3600' },
  });
}
