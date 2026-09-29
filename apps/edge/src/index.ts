import { handleApiRoute } from './api';
import { selectBackend, type Backend } from './backend';
import type { EdgeEnv } from './env';
import { defaultGuards, type Guard } from './guards';
import { notFoundJson } from './http';
import { handleScanRoute } from './scan';
import { handleShareRoute, isPublicAtlasRoutePath } from './share';
import { DEV_STORE_PREFIX, handleStoreRead, storeKeyFromPath } from './store';

export { AtlasBudget } from './budget';
export { AtlasApiContainer } from './container';
// Required by @cloudflare/containers for outbound interception (the atlas-store.internal handler).
export { ContainerProxy } from '@cloudflare/containers';

/**
 * sourcefor.dev edge Worker (CLA-266). Static assets (apps/web/dist) are served by Workers Static
 * Assets; only `run_worker_first` routes reach this handler:
 *
 *   /scan/*                   published atlases from R2 (scan.ts), source.json via GitHub raw (source.ts)
 *   /r/*, /og/*, /oembed      share pages (share.ts)
 *   /api/*                    auth/me + Ask status answered here; with ASK_ENABLED=1, Ask + block-plan →
 *                             container behind guards (api.ts), else 404
 *   /__store/*                DEV_STORE_ROUTE=1 only (local mirror for a locally run apps/server)
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
 * sourcefor.dev and www.sourcefor.dev). Checked before anything else. `run_worker_first` patterns are
 * path-only, so every path except the content-hashed `/assets/*` runs the Worker first; those asset
 * URLs are only ever requested by an already-redirected page.
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

export async function handleEdgeRequest(request: Request, env: EdgeEnv, ctx: ExecutionContext, deps: EdgeDeps = defaultDeps(env)): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);

  const redirect = canonicalHostRedirect(url, env);
  if (redirect) return redirect;

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
  return env.ASSETS.fetch(request);
}

export default {
  fetch(request, env, ctx) {
    return handleEdgeRequest(request, env, ctx);
  },
} satisfies ExportedHandler<EdgeEnv>;
