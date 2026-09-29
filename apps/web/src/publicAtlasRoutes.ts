import { isPublicAtlasViewPath } from './hostedAtlas';
import { handleOembedRequest, OEMBED_PATH, parsePublicAtlasOembedUrl } from './oembed';
import {
  handleLandingHtmlRequest,
  handleOgImageRequest,
  handleShareHtmlRequest,
  isOgImagePath,
  type PublicAtlasHttpOutput,
  type PublicAtlasLookup,
} from './openGraph';

/**
 * Runtime-agnostic dispatcher for the public share surface (CLA-266): `/r/<owner>/<repo>` Open Graph
 * HTML, `/og/<owner>/<repo>` PNG cards, `/oembed` JSON and the `/new` landing's meta (CLA-318). Plain inputs in, `{status, headers, body}`
 * out — the Vite dev/preview plugin (Node) and the Cloudflare edge Worker (workerd) both call this,
 * each supplying its own "is this atlas public" lookup and index.html source.
 */
export type PublicAtlasRouteInput = {
  method: string;
  pathname: string;
  /** Raw query string including `?` (only `/oembed` reads it). */
  search: string;
  /** Trusted request origin (already Host/X-Forwarded-Host checked by the caller), or '' when untrusted. */
  requestOrigin: string;
  allowedOrigins: readonly string[];
  isPublicAtlas: PublicAtlasLookup;
  /** index.html to inject Open Graph tags into; only read for share HTML. */
  indexHtml: () => Promise<string>;
};

export function isOembedPath(pathname: string): boolean {
  return pathname === OEMBED_PATH || pathname === `${OEMBED_PATH}/`;
}

/** `/new`, the published-atlas list: its own title, description and default card for crawlers. */
export function isLandingPath(pathname: string): boolean {
  return pathname === '/new' || pathname === '/new/';
}

/** `/r/<owner>/<repo>[/<ref>]`; a malformed percent-escape is simply not a share path. */
function isSharePath(pathname: string): boolean {
  try {
    return isPublicAtlasViewPath(pathname);
  } catch {
    return false;
  }
}

/** True for the paths {@link handlePublicAtlasRoute} answers. */
export function isPublicAtlasRoutePath(pathname: string): boolean {
  return isOembedPath(pathname) || isOgImagePath(pathname) || isSharePath(pathname) || isLandingPath(pathname);
}

/** Answers a public share route, or `undefined` when the path is not one of them. */
export async function handlePublicAtlasRoute(input: PublicAtlasRouteInput): Promise<PublicAtlasHttpOutput | undefined> {
  const { pathname } = input;
  if (isOembedPath(pathname)) {
    const searchParams = new URLSearchParams(input.search);
    const rawUrl = searchParams.get('url');
    const target = rawUrl && input.requestOrigin
      ? parsePublicAtlasOembedUrl(rawUrl, input.requestOrigin, input.allowedOrigins)
      : undefined;
    const publicOk = target ? Boolean(await input.isPublicAtlas(target.owner, target.repo)) : false;
    return handleOembedRequest({
      method: input.method,
      requestOrigin: input.requestOrigin,
      searchParams,
      allowedOrigins: input.allowedOrigins,
      isPublicAtlas: () => publicOk,
    });
  }
  if (isOgImagePath(pathname)) {
    return handleOgImageRequest({ method: input.method, pathname, isPublicAtlas: input.isPublicAtlas });
  }
  if (isSharePath(pathname)) {
    const method = input.method.toUpperCase();
    // Only GET/HEAD need the shell; OPTIONS and other methods are answered without reading it.
    const indexHtml = method === 'GET' || method === 'HEAD' ? await input.indexHtml() : '';
    return handleShareHtmlRequest({
      method: input.method,
      pathname,
      search: '',
      requestOrigin: input.requestOrigin,
      indexHtml,
      allowedOrigins: input.allowedOrigins,
      isPublicAtlas: input.isPublicAtlas,
    });
  }
  if (isLandingPath(pathname)) {
    const method = input.method.toUpperCase();
    const indexHtml = method === 'GET' || method === 'HEAD' ? await input.indexHtml() : '';
    // No shell to inject into (e.g. a failed asset fetch): fall through to the SPA/static answer.
    if ((method === 'GET' || method === 'HEAD') && !indexHtml) return undefined;
    return handleLandingHtmlRequest({
      method: input.method,
      requestOrigin: input.requestOrigin,
      indexHtml,
      allowedOrigins: input.allowedOrigins,
    });
  }
  return undefined;
}
