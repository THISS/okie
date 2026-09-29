import { isDogfoodAtlas } from './hostedAtlas';
import { parseAppRoute, repoSlugFor } from './renderer/route';
import {
  OEMBED_CACHE_AGE_SECONDS,
  OEMBED_JSON_TYPE,
  OEMBED_PROVIDER_NAME,
  effectiveOembedPort,
  isAllowedOembedRequestOrigin,
  isLoopbackHostname,
  parsePublicAtlasOembedUrl,
  publicAtlasHref,
  publicAtlasOembedHref,
  publicAtlasOgImageHref,
  publicAtlasTitle,
  sanitizeOembedOrigin,
  type OembedHeaderBag,
  type PublicAtlasDisplayNames,
  type PublicAtlasOembedTarget,
} from './oembed';
import { OG_IMAGE_HEIGHT, OG_IMAGE_WIDTH, renderAtlasCardPng } from './atlasCard';
import {
  DEFAULT_OG_IMAGE_ALT,
  DEFAULT_OG_IMAGE_HEIGHT,
  DEFAULT_OG_IMAGE_PATH,
  DEFAULT_OG_IMAGE_WIDTH,
  CANONICAL_ORIGIN,
  SITE_NAME,
  canonicalHref,
  landingPageMeta,
  repoCanonicalPath,
  repoPageDescription,
  repoPageTitle,
} from './siteMeta';
import { notFoundHttpOutput, notFoundPageHtml } from './notFoundPage';

/**
 * Open Graph for public `/r/<owner>/<repo>` share URLs (CLA-39).
 *
 * Crawlers do not run the SPA, so the Vite dev/preview plugin and the Cloudflare
 * edge Worker (apps/edge) inject these tags into the HTML response. The image is a generated atlas card (not the site favicon).
 * Unpublished and private trees 404 with the same generic body — no GitHub
 * lookup, no existence leak, no secrets in meta or PNG bytes.
 */

export const OG_IMAGE_ROUTE_PREFIX = '/og';
/** Default loopback port of the local scan process (apps/server). */
export const DEFAULT_LOCAL_SCAN_PORT = '4180';
/** Default local scan origin; hosts configure theirs with {@link localScanOriginFromEnv}. */
export const DEFAULT_LOCAL_SCAN_ORIGIN = `http://127.0.0.1:${DEFAULT_LOCAL_SCAN_PORT}`;
/** CLA-318: the branded, self-contained 404 page (notFoundPage.ts), atlas wording. */
export const ATLAS_NOT_FOUND_BODY = notFoundPageHtml('atlas');

const SECRET_LEAK = /apiKey|OPENROUTER|GITHUB_TOKEN|GH_TOKEN|gho_|ghp_|sk-|Bearer /i;

export type PublicAtlasLookup = (owner: string, repo: string) => boolean | Promise<boolean>;
/**
 * CLA-318: owner/repo as shown for a public atlas (GitHub's casing from the published index row), or
 * undefined to show the URL's names. Only consulted after the atlas is known to be public.
 */
export type PublicAtlasDisplayLookup = (owner: string, repo: string) => Promise<PublicAtlasDisplayNames | undefined>;

export type OpenGraphTags = {
  title: string;
  description: string;
  url: string;
  image: string;
  imageAlt: string;
  imageWidth: number;
  imageHeight: number;
  siteName: string;
  /** `<link rel="canonical">`: always the production origin (staging canonicalizes to sourcefor.dev). */
  canonical: string;
  /** oEmbed discovery link; share pages only. */
  oembedHref?: string;
};

export type ShareHtmlInput = {
  method: string;
  pathname: string;
  search?: string;
  requestOrigin: string;
  indexHtml: string;
  allowedOrigins?: readonly string[];
  isPublicAtlas?: PublicAtlasLookup;
  displayNames?: PublicAtlasDisplayLookup;
};

export type OgImageHttpInput = {
  method: string;
  pathname: string;
  isPublicAtlas?: PublicAtlasLookup;
  displayNames?: PublicAtlasDisplayLookup;
};

/** The display names for a public target (never throws: a failed lookup shows the URL's names). */
export async function resolveDisplayNames(target: { owner: string; repo: string }, lookup: PublicAtlasDisplayLookup | undefined): Promise<PublicAtlasDisplayNames> {
  if (!lookup) return { owner: target.owner, repo: target.repo };
  try {
    return (await lookup(target.owner, target.repo)) ?? { owner: target.owner, repo: target.repo };
  } catch {
    return { owner: target.owner, repo: target.repo };
  }
}

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
  return repoPageDescription(target.owner, target.repo);
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

/**
 * Configured local scan origin (not a secret). `OKIE_SCAN_ORIGIN` wins when it is a loopback http or an
 * https origin; else loopback on `OKIE_SCAN_SERVER_PORT` (the same knob the Vite proxy uses), default 4180.
 * Callers pass `process.env`; this module never reads it itself.
 */
export function localScanOriginFromEnv(env: Record<string, string | undefined>): string {
  const explicit = env.OKIE_SCAN_ORIGIN?.trim();
  const origin = explicit ? sanitizeOembedOrigin(explicit) : undefined;
  if (origin && isTrustedScanOrigin(origin, origin)) return origin;
  const port = /^\d{2,5}$/.test(env.OKIE_SCAN_SERVER_PORT ?? '') ? env.OKIE_SCAN_SERVER_PORT! : DEFAULT_LOCAL_SCAN_PORT;
  return `http://127.0.0.1:${port}`;
}

/** Snapshot lookup origin: the configured scan origin on loopback, else an allowlisted https origin. */
export function trustedScanLookupOrigin(
  requestOrigin: string,
  allowedOrigins: readonly string[] = [],
  scanOrigin: string = DEFAULT_LOCAL_SCAN_ORIGIN,
): string | undefined {
  const origin = sanitizeOembedOrigin(requestOrigin);
  if (!origin) return undefined;
  const url = new URL(origin);
  if (isLoopbackHostname(url.hostname)) return scanOrigin;
  if (allowedOrigins.includes(origin) && url.protocol === 'https:') return origin;
  return undefined;
}

/**
 * A scan origin may be probed when it is https, or plain http on loopback at the configured scan
 * port (`trustedLoopbackOrigin`, default {@link DEFAULT_LOCAL_SCAN_ORIGIN}) — never another local port.
 */
export function isTrustedScanOrigin(raw: string, trustedLoopbackOrigin: string = DEFAULT_LOCAL_SCAN_ORIGIN): boolean {
  const origin = sanitizeOembedOrigin(raw);
  if (!origin) return false;
  const url = new URL(origin);
  if (url.username || url.password) return false;
  if (isLoopbackHostname(url.hostname)) {
    const trusted = sanitizeOembedOrigin(trustedLoopbackOrigin);
    if (!trusted) return false;
    const trustedUrl = new URL(trusted);
    return url.protocol === 'http:' && isLoopbackHostname(trustedUrl.hostname)
      && effectiveOembedPort(url) === effectiveOembedPort(trustedUrl);
  }
  return url.protocol === 'https:';
}

export async function resolvePublicAtlasShare(
  owner: string,
  repo: string,
  scanOrigin: string,
  fetchImpl: typeof fetch = fetch,
  trustedLoopbackOrigin: string = DEFAULT_LOCAL_SCAN_ORIGIN,
): Promise<boolean> {
  if (isDogfoodAtlas(owner, repo)) return true;
  if (!isTrustedScanOrigin(scanOrigin, trustedLoopbackOrigin)) return false;
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

export function buildOpenGraphTags(target: PublicAtlasOembedTarget, displayNames: PublicAtlasDisplayNames = target): OpenGraphTags {
  const canonical = { ...target, search: '' };
  const title = repoPageTitle(displayNames.owner, displayNames.repo);
  const description = repoPageDescription(displayNames.owner, displayNames.repo);
  const pageHref = publicAtlasHref(canonical);
  const image = publicAtlasOgImageHref(canonical);
  return {
    title,
    description,
    url: pageHref,
    image,
    imageAlt: publicAtlasTitle(displayNames),
    imageWidth: OG_IMAGE_WIDTH,
    imageHeight: OG_IMAGE_HEIGHT,
    siteName: OEMBED_PROVIDER_NAME,
    canonical: canonicalHref(repoCanonicalPath(canonical.owner, canonical.repo)),
    oembedHref: publicAtlasOembedHref(pageHref),
  };
}

/**
 * `/new` (the published-atlas list) for crawlers: branded title/description, the static default card
 * (`/og-default.png`) and og:url on the trusted request origin — production when the origin is not
 * allowlisted, so a forged Host never lands in meta.
 */
export function buildLandingOpenGraphTags(origin: string | undefined): OpenGraphTags {
  const base = origin ?? CANONICAL_ORIGIN;
  const meta = landingPageMeta();
  return {
    title: meta.title,
    description: meta.description,
    url: new URL(meta.canonicalPath, base).href,
    image: new URL(DEFAULT_OG_IMAGE_PATH, base).href,
    imageAlt: DEFAULT_OG_IMAGE_ALT,
    imageWidth: DEFAULT_OG_IMAGE_WIDTH,
    imageHeight: DEFAULT_OG_IMAGE_HEIGHT,
    siteName: SITE_NAME,
    canonical: canonicalHref(meta.canonicalPath),
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
    `<link rel="canonical" href="${t(tags.canonical)}" />`,
    ...(tags.oembedHref
      ? [`<link rel="alternate" type="${OEMBED_JSON_TYPE}" href="${t(tags.oembedHref)}" title="${t(OEMBED_PROVIDER_NAME)} oEmbed" />`]
      : []),
  ].join('\n    ');
}

export function injectPublicAtlasOpenGraph(html: string, tags: OpenGraphTags): string {
  const stripped = html
    .replace(/<title>[\s\S]*?<\/title>/i, '')
    .replace(/<meta\s+name=["']description["'][^>]*>/gi, '')
    .replace(/<meta\s+(?:property|name)=["'](?:og|twitter):[^"']*["'][^>]*>/gi, '')
    .replace(/<link\s+rel=["']canonical["'][^>]*>/gi, '');
  const block = `    ${renderOpenGraphHead(tags)}`;
  if (stripped.includes('</head>')) return stripped.replace('</head>', `${block}\n  </head>`);
  return `${block}\n${stripped}`;
}

/** Bytes → latin1 text without Node's Buffer (runs in Node and workerd alike). */
function latin1(bytes: Uint8Array): string {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return text;
}

export function openGraphLeaksSecrets(text: string): boolean {
  return SECRET_LEAK.test(text);
}

function notFound(method: string): PublicAtlasHttpOutput {
  return notFoundHttpOutput(method, 'atlas', CORS);
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
  if (!origin || !isAllowedOembedRequestOrigin(origin, input.allowedOrigins ?? [])) return notFound(method);
  const target = parseSharePath(input.pathname, origin, input.search ?? '', input.allowedOrigins);
  if (!target || !(await isAllowedAtlas(target, input.isPublicAtlas))) return notFound(method);
  const tags = buildOpenGraphTags(target, await resolveDisplayNames(target, input.displayNames));
  const html = injectPublicAtlasOpenGraph(input.indexHtml, tags);
  if (openGraphLeaksSecrets(html) || openGraphLeaksSecrets(tags.image)) return notFound(method);
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

export type LandingHtmlInput = {
  method: string;
  requestOrigin: string;
  indexHtml: string;
  allowedOrigins?: readonly string[];
};

/** `/new` HTML with landing meta injected. Always 200: the list is public and names nothing private. */
export function handleLandingHtmlRequest(input: LandingHtmlInput): PublicAtlasHttpOutput {
  const method = input.method.toUpperCase();
  if (method === 'OPTIONS') return { status: 204, headers: { ...CORS }, body: '' };
  if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed();
  const origin = sanitizeOembedOrigin(input.requestOrigin);
  const trusted = origin && isAllowedOembedRequestOrigin(origin, input.allowedOrigins ?? []) ? origin : undefined;
  const html = injectPublicAtlasOpenGraph(input.indexHtml, buildLandingOpenGraphTags(trusted));
  return {
    status: 200,
    headers: {
      'cache-control': 'public, max-age=0, must-revalidate',
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
  const label = await resolveDisplayNames(parsed, input.displayNames);
  const png = renderAtlasCardPng({ ...parsed, label });
  const asText = latin1(png);
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

