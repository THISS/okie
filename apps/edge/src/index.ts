import { isKnownAppPath, notFoundHttpOutput } from '../../web/src/notFoundPage';
import { securityHeadersFor } from '../../web/src/securityHeaders';
import { handleApiRoute } from './api';
import { selectBackend, type Backend } from './backend';
import type { EdgeEnv } from './env';
import { defaultGuards, type Guard } from './guards';
import { NOINDEX_ROBOTS_TXT, notFoundJson, ROBOTS_TAG } from './http';
import { handleScanRoute } from './scan';
import { handleShareRoute, isPublicAtlasRoutePath } from './share';
import { handleSitemapRequest, SITEMAP_PATH } from './sitemap';
import { DEV_STORE_PREFIX, handleStoreRead, storeKeyFromPath } from './store';

export { AtlasBudget } from './budget';
export { AtlasApiContainer } from './container';
// Required by @cloudflare/containers for outbound interception (the atlas-store.internal handler).
export { ContainerProxy } from '@cloudflare/containers';

/**
 * sourcefor.dev edge Worker (CLA-266). Static assets (apps/web/dist) are served by Workers Static
 * Assets behind this handler (`run_worker_first: true`, so every request reaches it first):
 *
 *   www.*                     301 to the canonical origin
 *   /robots.txt               disallow-all when ROBOTS_NOINDEX=1 (staging; also X-Robots-Tag on everything)
 *   /sitemap.xml              `/`, `/new` and every published atlas from index.json (sitemap.ts)
 *   /assets/*                 Static Assets, but a missing hashed asset is 404 no-store, never the SPA shell
 *   /scan/*                   published atlases from R2 (scan.ts), source.json via GitHub raw (source.ts)
 *   /r/*, /og/*, /oembed      share pages (share.ts)
 *   /new                      the published-atlas list, with its own <title>/Open Graph meta (share.ts)
 *   /api/*                    auth/me + Ask status answered here; with ASK_ENABLED=1, Ask + block-plan →
 *                             container behind guards (api.ts), else 404
 *   /__store/*                DEV_STORE_ROUTE=1 only (local mirror for a locally run apps/server)
 *   /, /index.html, /operator the SPA shell (Static Assets)
 *   anything else             a real static file (favicons, robots.txt, og-default.png) from Static
 *                             Assets; otherwise the branded 404 page with a real 404 (CLA-318)
 *
 * Every response leaves through {@link withEdgeHeaders}: nosniff + Referrer-Policy everywhere, a CSP on
 * HTML (frame-ancestors `*` on /r/... for oEmbed, 'self' elsewhere; securityHeaders.ts), and staging's
 * X-Robots-Tag.
 */

export type EdgeDeps = {
  /** undefined = no container / dev backend (the browse-only deploy). */
  backend: Backend | undefined;
  guards: readonly Guard[];
  now: () => Date;
  /** Upstream fetch for source.json; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Cache API override (tests); defaults to `caches.default`. */
  cache?: Cache;
};

export function defaultDeps(env: EdgeEnv): EdgeDeps {
  return { backend: selectBackend(env), guards: defaultGuards(), now: () => new Date() };
}

/**
 * `www.<canonical host>` → 301 to the same path + query on `OKIE_PUBLIC_ORIGIN` (production binds both
 * sourcefor.dev and www.sourcefor.dev). Checked before anything else; the Worker runs first for every
 * path (`run_worker_first: true`), so this covers `/assets/*` too.
 */
export function canonicalHostRedirect(url: URL, env: Pick<EdgeEnv, 'OKIE_PUBLIC_ORIGIN'>): Response | undefined {
  const raw = env.OKIE_PUBLIC_ORIGIN?.trim();
  if (!raw) return undefined;
  let canonical: URL;
  try { canonical = new URL(raw); } catch { return undefined; }
  if (url.hostname.toLowerCase() !== `www.${canonical.hostname.toLowerCase()}`) return undefined;
  return new Response(null, {
    status: 301,
    headers: { location: `${canonical.origin}${url.pathname}${url.search}`, 'cache-control': 'public, max-age=3600' },
  });
}

function noindex(env: Pick<EdgeEnv, 'ROBOTS_NOINDEX'>): boolean {
  return env.ROBOTS_NOINDEX?.trim() === '1';
}

/**
 * `/assets/*` through Static Assets. With `not_found_handling: single-page-application` a missing
 * hashed asset (e.g. a chunk of the previous build, requested by a page loaded before a deploy) would
 * come back as index.html with 200 and the immutable `/assets/*` cache header, and a browser would
 * keep that wrong "script" for a year. Vite never emits HTML under /assets, so an HTML answer there
 * is the SPA fallback: turn it into an uncacheable 404. Cost: every /assets request is now a Worker
 * invocation (Workers Paid; a pass-through to env.ASSETS, negligible CPU).
 */
async function serveHashedAsset(request: Request, env: EdgeEnv): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const type = response.headers.get('content-type') ?? '';
  // Any HTML status counts (a 304 revalidating index.html's ETag included).
  if (/^text\/html\b/i.test(type)) {
    return new Response(request.method === 'HEAD' ? null : 'not found\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return response;
}

export async function handleEdgeRequest(request: Request, env: EdgeEnv, ctx: ExecutionContext, deps: EdgeDeps = defaultDeps(env)): Promise<Response> {
  return withEdgeHeaders(request, await routeEdgeRequest(request, env, ctx, deps), env);
}

/**
 * Security headers on every response (CLA-318) and, on staging, the crawler opt-out. Always a copy:
 * responses fetched from Static Assets, R2 or upstream have immutable headers. A copy keeps the status,
 * statusText, headers (`_headers` rules included) and body stream as-is, so redirects, 204/304 (no
 * body) and HEAD answers pass through unchanged. A 101 WebSocket upgrade is returned untouched (a copy
 * would drop its socket).
 */
function withEdgeHeaders(request: Request, response: Response, env: Pick<EdgeEnv, 'ROBOTS_NOINDEX'>): Response {
  if (response.status === 101 || response.webSocket) return response;
  const out = new Response(response.body, response);
  const { pathname } = new URL(request.url);
  for (const [name, value] of Object.entries(securityHeadersFor(pathname, out.headers.get('content-type')))) {
    // A route that chose its own policy keeps it.
    if (!out.headers.has(name)) out.headers.set(name, value);
  }
  if (noindex(env)) out.headers.set('x-robots-tag', ROBOTS_TAG);
  return out;
}

async function routeEdgeRequest(request: Request, env: EdgeEnv, ctx: ExecutionContext, deps: EdgeDeps): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);

  const redirect = canonicalHostRedirect(url, env);
  if (redirect) return redirect;

  if (pathname === '/robots.txt' && noindex(env)) {
    return new Response(request.method === 'HEAD' ? null : NOINDEX_ROBOTS_TXT, {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' },
    });
  }
  if (pathname === SITEMAP_PATH) return handleSitemapRequest(request, env);
  if (pathname.startsWith('/assets/')) return serveHashedAsset(request, env);
  if (pathname.startsWith('/scan/')) {
    return handleScanRoute(request, {
      bucket: env.ATLAS_BUCKET,
      backend: deps.backend,
      env,
      waitUntil,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...('cache' in deps ? { cache: deps.cache } : {}),
    });
  }
  if (pathname.startsWith('/api/')) {
    return handleApiRoute(request, env, { backend: deps.backend, guards: deps.guards, now: deps.now, waitUntil });
  }
  if (pathname.startsWith(DEV_STORE_PREFIX)) {
    if (env.DEV_STORE_ROUTE !== '1') return notFoundJson();
    const key = storeKeyFromPath(pathname, DEV_STORE_PREFIX);
    return key === undefined ? notFoundJson() : handleStoreRead(request, env.ATLAS_BUCKET, key);
  }
  if (isPublicAtlasRoutePath(pathname)) {
    const shared = await handleShareRoute(request, env);
    if (shared) return shared;
  }
  if (isKnownAppPath(pathname)) return env.ASSETS.fetch(request);
  return serveStaticFileOr404(request, env);
}

/**
 * A path the SPA does not route (CLA-318). Real files in apps/web/dist (favicons, robots.txt,
 * og-default.png…) are served as-is; `_headers` is never served (Static Assets excludes it). Anything
 * else would come back as the SPA shell with 200 (`not_found_handling: single-page-application`):
 * dist has no HTML besides index.html, so an HTML answer here is that fallback, and it becomes the
 * branded 404 page with a real status (short shared cache; HEAD without a body).
 */
async function serveStaticFileOr404(request: Request, env: EdgeEnv): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const type = response.headers.get('content-type') ?? '';
  // Any HTML status counts, like /assets/* (a 304 revalidating index.html's ETag included).
  if (!/^text\/html\b/i.test(type)) return response;
  const page = notFoundHttpOutput(request.method);
  return new Response(page.body === '' ? null : page.body, { status: page.status, headers: page.headers });
}

export default {
  fetch(request, env, ctx) {
    return handleEdgeRequest(request, env, ctx);
  },
} satisfies ExportedHandler<EdgeEnv>;
