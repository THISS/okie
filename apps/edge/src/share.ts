import { isDogfoodAtlas } from '../../web/src/hostedAtlas';
import { oembedAllowedOriginsFromEnv, sanitizeOembedOrigin } from '../../web/src/oembed';
import { handlePublicAtlasRoute, isPublicAtlasRoutePath } from '../../web/src/publicAtlasRoutes';
import { repoSlugFor } from '../../web/src/renderer/route';
import { webMcpHostHeadersForFetchDest } from '../../web/src/webmcpHeaders';
import type { EdgeEnv } from './env';
import { isPublishedAtlas } from './scan';

/**
 * Share pages at the edge (CLA-266): `/r/<owner>/<repo>` Open Graph HTML (injected into the static
 * assets' index.html), `/og/<owner>/<repo>` PNG cards and `/oembed` JSON — the same runtime-agnostic
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
  const headers = new Headers(result.headers);
  if (headers.get('content-type')?.startsWith('text/html')) {
    for (const [name, value] of Object.entries(webMcpHostHeadersForFetchDest(request.headers.get('sec-fetch-dest') ?? undefined))) {
      headers.set(name, value);
    }
  }
  return new Response(result.body === '' ? null : result.body, { status: result.status, headers });
}
