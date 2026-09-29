import { isDogfoodAtlas } from '../../web/src/hostedAtlas';
import { oembedAllowedOriginsFromEnv, sanitizeOembedOrigin } from '../../web/src/oembed';
import { handlePublicAtlasRoute, isPublicAtlasRoutePath } from '../../web/src/publicAtlasRoutes';
import { parseAppRoute, repoSlugFor } from '../../web/src/renderer/route';
import { PUBLISHED_INDEX_SCHEMA, publishedIndexKey } from '../../server/src/publishedStoreLayout';
import { webMcpHostHeadersForFetchDest } from '../../web/src/webmcpHeaders';
import type { EdgeEnv } from './env';
import { isPublishedAtlas } from './scan';

/**
 * Share pages at the edge (CLA-266): `/r/<owner>/<repo>` Open Graph HTML (injected into the static
 * assets' index.html), `/og/<owner>/<repo>` PNG cards, `/oembed` JSON and `/new` landing meta (CLA-318) — the same runtime-agnostic
 * handlers the Vite dev server uses (apps/web/src/publicAtlasRoutes.ts). "Public" here = the slug has a
 * `latest.json` in R2, plus the THISS/okie dogfood rule.
 */
export { isPublicAtlasRoutePath };

export async function handleShareRoute(request: Request, env: EdgeEnv): Promise<Response | undefined> {
  const url = new URL(request.url);
  const bucket = env.ATLAS_BUCKET;
  const result = await handlePublicAtlasRoute({
    method: request.method,
    pathname: url.pathname,
    search: url.search,
    requestOrigin: sanitizeOembedOrigin(url.origin) ?? '',
    allowedOrigins: oembedAllowedOriginsFromEnv({ OKIE_PUBLIC_ORIGIN: env.OKIE_PUBLIC_ORIGIN }),
    isPublicAtlas: async (owner, repo) => isDogfoodAtlas(owner, repo) || isPublishedAtlas(bucket, repoSlugFor(owner, repo)),
    indexHtml: async () => {
      const shell = await env.ASSETS.fetch(new Request(new URL('/', url), { headers: { accept: 'text/html' } }));
      return shell.ok ? shell.text() : '';
    },
  });
  if (!result) return undefined;
  if (result.status === 404) {
    const redirect = await canonicalShareRedirect(request, url, bucket);
    if (redirect) return redirect;
  }
  const headers = new Headers(result.headers);
  if (headers.get('content-type')?.startsWith('text/html')) {
    for (const [name, value] of Object.entries(webMcpHostHeadersForFetchDest(request.headers.get('sec-fetch-dest') ?? undefined))) {
      headers.set(name, value);
    }
  }
  return new Response(result.body === '' ? null : result.body, { status: result.status, headers });
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
