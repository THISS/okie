import { isDogfoodAtlas } from './hostedAtlas';
import { parseAppRoute, repoSlugFor } from './renderer/route';
import {
  OEMBED_CACHE_AGE_SECONDS,
  OEMBED_JSON_TYPE,
  OEMBED_PROVIDER_NAME,
  effectiveOembedPort,
  isAllowedOembedRequestOrigin,
  isLoopbackHostname,
  oembedRequestOrigin,
  parsePublicAtlasOembedUrl,
  publicAtlasHref,
  publicAtlasOembedHref,
  publicAtlasOgImageHref,
  publicAtlasOgImagePath,
  publicAtlasTitle,
  sanitizeOembedOrigin,
  type OembedHeaderBag,
  type PublicAtlasOembedTarget,
} from './oembed';
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, renderAtlasCardPng } from './atlasCard';

/**
 * Open Graph for public `/r/<owner>/<repo>` share URLs (CLA-39).
 *
 * Crawlers do not run the SPA, so Vite / Vercel inject these tags into the HTML
 * response. The image is a generated Okie atlas card (not the site favicon).
 * Unpublished and private trees 404 with the same generic body — no GitHub
 * lookup, no existence leak, no secrets in meta or PNG bytes.
 */

export const OG_IMAGE_ROUTE_PREFIX = '/og';
/** Local scan process — the only loopback origin used for published-snapshot lookups. */
export const LOCAL_SCAN_ORIGIN = 'http://127.0.0.1:4180';
export const ATLAS_NOT_FOUND_BODY = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="robots" content="noindex" />
    <title>Atlas not found</title>
  </head>
  <body>
    <main>
      <h1>Atlas not found</h1>
    </main>
  </body>
</html>
`;

const SECRET_LEAK = /apiKey|OPENROUTER|GITHUB_TOKEN|GH_TOKEN|gho_|ghp_|sk-|Bearer /i;

export type PublicAtlasLookup = (owner: string, repo: string) => boolean | Promise<boolean>;

export type OpenGraphTags = {
  title: string;
  description: string;
  url: string;
  image: string;
  imageAlt: string;
  imageWidth: number;
  imageHeight: number;
  siteName: string;
  oembedHref: string;
};

export type ShareHtmlInput = {
  method: string;
  pathname: string;
  search?: string;
  requestOrigin: string;
  indexHtml: string;
  allowedOrigins?: readonly string[];
  isPublicAtlas?: PublicAtlasLookup;
};

export type OgImageHttpInput = {
  method: string;
  pathname: string;
  isPublicAtlas?: PublicAtlasLookup;
};

export type PublicAtlasHttpOutput = {
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'Accept',
} as const;

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function publicAtlasDescription(target: PublicAtlasOembedTarget): string {
  return `Public architecture atlas for ${target.owner}/${target.repo}.`;
}

export function defaultIsPublicAtlas(owner: string, repo: string): boolean {
  return isDogfoodAtlas(owner, repo);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const token = raw?.split(',')[0]?.trim();
  return token || undefined;
}

/**
 * Origin used in og:url / og:image. An unallowlisted `X-Forwarded-Host` cannot
 * replace `Host` (forged loopback ports would otherwise leak into meta).
 */
export function trustedShareOrigin(
  headers: OembedHeaderBag,
  allowedOrigins: readonly string[] = [],
): string | undefined {
  const proto = firstHeader(headers['x-forwarded-proto']) === 'https' ? 'https' : 'http';
  const host = firstHeader(headers.host);
  const forwarded = firstHeader(headers['x-forwarded-host']);
  const fromHost = host && !/[@\\/\s]/.test(host) && !host.includes('://')
    ? sanitizeOembedOrigin(`${proto}://${host}`)
    : undefined;
  const fromForwarded = forwarded && !/[@\\/\s]/.test(forwarded) && !forwarded.includes('://')
    ? sanitizeOembedOrigin(`${proto}://${forwarded}`)
    : undefined;
  if (fromForwarded && allowedOrigins.includes(fromForwarded)) return fromForwarded;
  if (fromHost && isAllowedOembedRequestOrigin(fromHost, allowedOrigins)) return fromHost;
  return undefined;
}

/** Snapshot lookup origin: known scan bind on loopback, else an allowlisted https origin. */
export function trustedScanLookupOrigin(
  requestOrigin: string,
  allowedOrigins: readonly string[] = [],
): string | undefined {
  const origin = sanitizeOembedOrigin(requestOrigin);
  if (!origin) return undefined;
  const url = new URL(origin);
  if (isLoopbackHostname(url.hostname)) return LOCAL_SCAN_ORIGIN;
  if (allowedOrigins.includes(origin) && url.protocol === 'https:') return origin;
  return undefined;
}

export function isTrustedScanOrigin(raw: string): boolean {
  const origin = sanitizeOembedOrigin(raw);
  if (!origin) return false;
  const url = new URL(origin);
  if (url.username || url.password) return false;
  if (isLoopbackHostname(url.hostname)) {
    return url.protocol === 'http:' && effectiveOembedPort(url) === '4180';
  }
  return url.protocol === 'https:';
}

export async function resolvePublicAtlasShare(
  owner: string,
  repo: string,
  scanOrigin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (isDogfoodAtlas(owner, repo)) return true;
  if (!isTrustedScanOrigin(scanOrigin)) return false;
  const snapshot = new URL(`/scan/${encodeURIComponent(repoSlugFor(owner, repo))}/snapshot.json`, scanOrigin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetchImpl(snapshot, { signal: controller.signal });
    const ok = response.ok;
    await response.body?.cancel();
    return ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function isOgImagePath(pathname: string): boolean {
  return pathname === OG_IMAGE_ROUTE_PREFIX || pathname.startsWith(`${OG_IMAGE_ROUTE_PREFIX}/`);
}

export function parseOgImagePath(pathname: string): { owner: string; repo: string } | undefined {
  const segments = pathname.split('/').filter(Boolean);
  if (segments[0] !== 'og' || segments.length !== 3) return undefined;
  const owner = segments[1];
  let repo = segments[2];
  if (!owner || !repo) return undefined;
  if (repo.toLowerCase().endsWith('.png')) repo = repo.slice(0, -4);
  if (!repo) return undefined;
  const route = parseAppRoute(`/r/${owner}/${repo}`);
  if (route.kind !== 'repo') return undefined;
  return { owner: route.owner, repo: route.repo };
}

export function parseSharePath(
  pathname: string,
  requestOrigin: string,
  search = '',
  allowedOrigins: readonly string[] = [],
): PublicAtlasOembedTarget | undefined {
  const href = `${requestOrigin}${pathname}${search}`;
  return parsePublicAtlasOembedUrl(href, requestOrigin, allowedOrigins);
}

export function buildOpenGraphTags(target: PublicAtlasOembedTarget): OpenGraphTags {
  const canonical = { ...target, search: '' };
  const title = publicAtlasTitle(canonical);
  const description = publicAtlasDescription(canonical);
  const pageHref = publicAtlasHref(canonical);
  const image = publicAtlasOgImageHref(canonical);
  return {
    title,
    description,
    url: pageHref,
    image,
    imageAlt: title,
    imageWidth: OG_IMAGE_WIDTH,
    imageHeight: OG_IMAGE_HEIGHT,
    siteName: OEMBED_PROVIDER_NAME,
    oembedHref: publicAtlasOembedHref(pageHref),
  };
}

export function renderOpenGraphHead(tags: OpenGraphTags): string {
  const t = escapeAttribute;
  return [
    `<title>${t(tags.title)}</title>`,
    `<meta name="description" content="${t(tags.description)}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${t(tags.siteName)}" />`,
    `<meta property="og:title" content="${t(tags.title)}" />`,
    `<meta property="og:description" content="${t(tags.description)}" />`,
    `<meta property="og:url" content="${t(tags.url)}" />`,
    `<meta property="og:image" content="${t(tags.image)}" />`,
    `<meta property="og:image:alt" content="${t(tags.imageAlt)}" />`,
    `<meta property="og:image:width" content="${tags.imageWidth}" />`,
    `<meta property="og:image:height" content="${tags.imageHeight}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${t(tags.title)}" />`,
    `<meta name="twitter:description" content="${t(tags.description)}" />`,
    `<meta name="twitter:image" content="${t(tags.image)}" />`,
    `<link rel="alternate" type="${OEMBED_JSON_TYPE}" href="${t(tags.oembedHref)}" title="${t(OEMBED_PROVIDER_NAME)} oEmbed" />`,
  ].join('\n    ');
}

export function injectPublicAtlasOpenGraph(html: string, tags: OpenGraphTags): string {
  const stripped = html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+name=["']description["'][^>]*>/gi, '')
    .replace(/<meta\s+(?:property|name)=["'](?:og|twitter):[^"']*["'][^>]*>/gi, '');
  const block = `    ${renderOpenGraphHead(tags)}`;
  if (stripped.includes('</head>')) return stripped.replace('</head>', `${block}\n  </head>`);
  return `${block}\n${stripped}`;
}

export function openGraphLeaksSecrets(text: string): boolean {
  return SECRET_LEAK.test(text);
}

function notFound(): PublicAtlasHttpOutput {
  return {
    status: 404,
    headers: {
      ...CORS,
      'cache-control': 'public, max-age=60',
      'content-type': 'text/html; charset=utf-8',
    },
    body: ATLAS_NOT_FOUND_BODY,
  };
}

function methodNotAllowed(): PublicAtlasHttpOutput {
  return {
    status: 405,
    headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' },
    body: 'method not allowed',
  };
}

async function isAllowedAtlas(
  target: { owner: string; repo: string },
  lookup: PublicAtlasLookup | undefined,
): Promise<boolean> {
  const check = lookup ?? defaultIsPublicAtlas;
  return Boolean(await check(target.owner, target.repo));
}

export async function handleShareHtmlRequest(input: ShareHtmlInput): Promise<PublicAtlasHttpOutput> {
  const method = input.method.toUpperCase();
  if (method === 'OPTIONS') {
    return { status: 204, headers: { ...CORS }, body: '' };
  }
  if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed();
  const origin = sanitizeOembedOrigin(input.requestOrigin);
  if (!origin || !isAllowedOembedRequestOrigin(origin, input.allowedOrigins ?? [])) return notFound();
  const target = parseSharePath(input.pathname, origin, input.search ?? '', input.allowedOrigins);
  if (!target || !(await isAllowedAtlas(target, input.isPublicAtlas))) return notFound();
  const tags = buildOpenGraphTags(target);
  const html = injectPublicAtlasOpenGraph(input.indexHtml, tags);
  if (openGraphLeaksSecrets(html) || openGraphLeaksSecrets(tags.image)) return notFound();
  return {
    status: 200,
    headers: {
      ...CORS,
      'cache-control': `public, max-age=${OEMBED_CACHE_AGE_SECONDS}`,
      'content-type': 'text/html; charset=utf-8',
    },
    body: method === 'HEAD' ? '' : html,
  };
}

export async function handleOgImageRequest(input: OgImageHttpInput): Promise<PublicAtlasHttpOutput> {
  const method = input.method.toUpperCase();
  if (method === 'OPTIONS') {
    return { status: 204, headers: { ...CORS }, body: '' };
  }
  if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed();
  const parsed = parseOgImagePath(input.pathname);
  if (!parsed || !(await isAllowedAtlas(parsed, input.isPublicAtlas))) {
    return {
      status: 404,
      headers: {
        ...CORS,
        'cache-control': 'public, max-age=60',
        'content-type': 'text/plain; charset=utf-8',
      },
      body: 'not found',
    };
  }
  const png = renderAtlasCardPng(parsed);
  const asText = Buffer.from(png).toString('latin1');
  if (openGraphLeaksSecrets(asText)) {
    return {
      status: 404,
      headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8' },
      body: 'not found',
    };
  }
  return {
    status: 200,
    headers: {
      ...CORS,
      'cache-control': `public, max-age=${OEMBED_CACHE_AGE_SECONDS}`,
      'content-type': 'image/png',
      'content-length': String(png.byteLength),
    },
    body: method === 'HEAD' ? '' : png,
  };
}

export function shareRequestOrigin(headers: OembedHeaderBag): string | undefined {
  return oembedRequestOrigin(headers);
}

export { publicAtlasOgImageHref, publicAtlasOgImagePath, OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH };
