import { parseAppRoute } from './renderer/route';

/**
 * oEmbed 1.0 for public `/r/<owner>/<repo>` atlas views (CLA-30).
 *
 * Docs sites discover the endpoint from a `<link rel="alternate"
 * type="application/json+oembed">` on the share URL, then fetch JSON whose
 * `html` iframe points at that same public view (no login wall). The payload
 * is a pure function of the atlas URL — no scan objects, no secrets.
 *
 * Iframe origins are allowlisted (loopback plus operator/Vercel public hosts).
 * A forged `Host` / `X-Forwarded-Host` cannot become the embed target.
 */

export const OEMBED_PATH = '/oembed';
export const OEMBED_DEFAULT_WIDTH = 800;
export const OEMBED_DEFAULT_HEIGHT = 560;
export const OEMBED_MIN_WIDTH = 200;
export const OEMBED_MIN_HEIGHT = 140;
export const OEMBED_PROVIDER_NAME = 'Okie';
export const OEMBED_CACHE_AGE_SECONDS = 300;
export const OEMBED_JSON_TYPE = 'application/json+oembed';
export const OEMBED_FALLBACK_ORIGIN = 'http://localhost:4173';

const GITHUB_NAME = /^[A-Za-z0-9._-]+$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const PUBLIC_ORIGIN_ENV = ['OKIE_PUBLIC_ORIGIN', 'VERCEL_PROJECT_PRODUCTION_URL', 'VERCEL_URL'] as const;

export type PublicAtlasOembedTarget = {
  owner: string;
  repo: string;
  ref?: string;
  search: string;
  origin: string;
};

export type OembedRichResponse = {
  version: '1.0';
  type: 'rich';
  provider_name: string;
  provider_url: string;
  title: string;
  html: string;
  width: number;
  height: number;
  cache_age: number;
};

export type OembedHttpInput = {
  method: string;
  requestOrigin: string;
  searchParams: URLSearchParams;
  allowedHosts?: readonly string[];
};

export type OembedHttpOutput = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type OembedHeaderBag = {
  host?: string | string[] | undefined;
  'x-forwarded-host'?: string | string[] | undefined;
  'x-forwarded-proto'?: string | string[] | undefined;
};

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'Accept',
} as const;

function firstHeader(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const token = raw?.split(',')[0]?.trim();
  return token || undefined;
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK.has(host) || host === '[::1]';
}

/** `https://host` origin with no userinfo, or undefined if the raw value is unsafe. */
export function sanitizeOembedOrigin(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (url.username || url.password) return undefined;
    if (!url.hostname) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Extra public hostnames (not secrets) from operator/Vercel origin env.
 * Callers pass `process.env` from Node (Vite plugin / serverless); this module
 * does not read process.env itself so the browser bundle stays env-free.
 */
export function oembedAllowedHostsFromEnv(
  env: Record<string, string | undefined>,
): string[] {
  const hosts = new Set<string>();
  for (const key of PUBLIC_ORIGIN_ENV) {
    const raw = env[key]?.trim();
    if (!raw) continue;
    const origin = sanitizeOembedOrigin(raw.includes('://') ? raw : `https://${raw}`);
    if (!origin) continue;
    hosts.add(new URL(origin).hostname.toLowerCase());
  }
  return [...hosts];
}

export function isAllowedOembedHostname(
  hostname: string,
  allowedHosts: readonly string[] = [],
): boolean {
  const host = hostname.toLowerCase();
  if (isLoopbackHostname(host)) return true;
  return allowedHosts.some(allowed => allowed.toLowerCase() === host);
}

/**
 * Public origin of the atlas host. Rejects credentialed / path-shaped Host
 * headers rather than echoing them into iframe src.
 */
export function oembedRequestOrigin(headers: OembedHeaderBag): string {
  const proto = firstHeader(headers['x-forwarded-proto']) === 'https' ? 'https' : 'http';
  const host = firstHeader(headers['x-forwarded-host'])
    ?? firstHeader(headers.host)
    ?? 'localhost:4173';
  if (/[@\\/\s]/.test(host) || host.includes('://')) return OEMBED_FALLBACK_ORIGIN;
  return sanitizeOembedOrigin(`${proto}://${host}`) ?? OEMBED_FALLBACK_ORIGIN;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function parseMaxDimension(raw: string | null, fallback: number): number {
  if (raw === null || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function fitEmbedSize(maxWidth: number, maxHeight: number): { width: number; height: number } {
  const aspect = OEMBED_DEFAULT_WIDTH / OEMBED_DEFAULT_HEIGHT;
  let width = Math.min(maxWidth, OEMBED_DEFAULT_WIDTH);
  let height = Math.round(width / aspect);
  if (height > maxHeight) {
    height = Math.min(maxHeight, OEMBED_DEFAULT_HEIGHT);
    width = Math.round(height * aspect);
  }
  return {
    width: Math.max(OEMBED_MIN_WIDTH, width),
    height: Math.max(OEMBED_MIN_HEIGHT, height),
  };
}

function jsonBody(
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): OembedHttpOutput {
  return {
    status,
    headers: {
      ...CORS_HEADERS,
      'cache-control': `public, max-age=${OEMBED_CACHE_AGE_SECONDS}`,
      'content-type': 'application/json; charset=utf-8',
      ...extra,
    },
    body: `${JSON.stringify(body, null, 2)}\n`,
  };
}

function parseAtlasRoute(pathname: string): ReturnType<typeof parseAppRoute> | undefined {
  try {
    return parseAppRoute(pathname);
  } catch {
    return undefined;
  }
}

/**
 * Accept only a public `/r/<owner>/<repo>` path on an allowlisted atlas origin.
 * Iframe `src` uses `URL.origin` of that page (never userinfo, never a forged Host).
 */
export function parsePublicAtlasOembedUrl(
  raw: string,
  requestOrigin: string,
  allowedHosts: readonly string[] = [],
): PublicAtlasOembedTarget | undefined {
  if (raw.length > 2048) return undefined;
  const pageOrigin = sanitizeOembedOrigin(raw);
  const reqOrigin = sanitizeOembedOrigin(requestOrigin);
  if (!pageOrigin || !reqOrigin) return undefined;
  let page: URL;
  let request: URL;
  try {
    page = new URL(raw);
    request = new URL(reqOrigin);
  } catch {
    return undefined;
  }
  if (page.username || page.password) return undefined;
  if (!isAllowedOembedHostname(page.hostname, allowedHosts)) return undefined;
  if (!isAllowedOembedHostname(request.hostname, allowedHosts)) return undefined;
  const route = parseAtlasRoute(page.pathname);
  if (!route || route.kind !== 'repo') return undefined;
  if (!GITHUB_NAME.test(route.owner) || !GITHUB_NAME.test(route.repo)) return undefined;
  if (route.ref && route.ref.split('/').some(segment => !GITHUB_NAME.test(segment))) return undefined;
  return {
    owner: route.owner,
    repo: route.repo,
    ...(route.ref ? { ref: route.ref } : {}),
    search: page.search,
    origin: page.origin,
  };
}

export function publicAtlasPath(target: PublicAtlasOembedTarget): string {
  const pin = target.ref ? `/${target.ref}` : '';
  return `/r/${target.owner}/${target.repo}${pin}`;
}

export function publicAtlasHref(target: PublicAtlasOembedTarget): string {
  return new URL(`${publicAtlasPath(target)}${target.search}`, target.origin).href;
}

export function publicAtlasTitle(target: PublicAtlasOembedTarget): string {
  return `${target.owner}/${target.repo} architecture atlas`;
}

export function buildOembedIframeHtml(
  target: PublicAtlasOembedTarget,
  size: { width: number; height: number },
): string {
  const src = publicAtlasHref(target);
  const title = publicAtlasTitle(target);
  return `<iframe src="${escapeAttribute(src)}" width="${size.width}" height="${size.height}" loading="lazy" style="border:0;border-radius:12px" title="${escapeAttribute(title)}" allowfullscreen></iframe>`;
}

export function buildOembedRichResponse(
  target: PublicAtlasOembedTarget,
  maxWidth = OEMBED_DEFAULT_WIDTH,
  maxHeight = OEMBED_DEFAULT_HEIGHT,
): OembedRichResponse {
  const size = fitEmbedSize(maxWidth, maxHeight);
  return {
    version: '1.0',
    type: 'rich',
    provider_name: OEMBED_PROVIDER_NAME,
    provider_url: target.origin,
    title: publicAtlasTitle(target),
    html: buildOembedIframeHtml(target, size),
    width: size.width,
    height: size.height,
    cache_age: OEMBED_CACHE_AGE_SECONDS,
  };
}

/** Discovery href docs sites fetch after seeing the share page. */
export function publicAtlasOembedHref(pageHref: string): string {
  const page = new URL(pageHref);
  const endpoint = new URL(OEMBED_PATH, page.origin);
  endpoint.searchParams.set('url', `${page.origin}${page.pathname}${page.search}`);
  endpoint.searchParams.set('format', 'json');
  return endpoint.href;
}

export type OembedLinkParent = {
  querySelector(selectors: string): { setAttribute(name: string, value: string): void } | null;
  appendChild(node: { setAttribute(name: string, value: string): void }): unknown;
};

export type OembedLinkFactory = () => {
  setAttribute(name: string, value: string): void;
};

/**
 * Install `<link rel="alternate" type="application/json+oembed">` for a public
 * atlas view. No-ops when `document` is missing (non-browser tests).
 */
export function installPublicAtlasOembedDiscovery(
  pageHref: string,
  head?: OembedLinkParent,
  createLink?: OembedLinkFactory,
): void {
  const target = head
    ?? (typeof document === 'undefined' ? undefined : document.head as unknown as OembedLinkParent);
  const factory = createLink
    ?? (typeof document === 'undefined' ? undefined : () => document.createElement('link'));
  if (!target || !factory) return;
  const href = publicAtlasOembedHref(pageHref);
  const selector = `link[rel="alternate"][type="${OEMBED_JSON_TYPE}"]`;
  let link = target.querySelector(selector);
  if (!link) {
    link = factory();
    link.setAttribute('rel', 'alternate');
    link.setAttribute('type', OEMBED_JSON_TYPE);
    target.appendChild(link);
  }
  link.setAttribute('href', href);
  link.setAttribute('title', `${OEMBED_PROVIDER_NAME} oEmbed`);
}

export function handleOembedRequest(input: OembedHttpInput): OembedHttpOutput {
  const cors = {
    ...CORS_HEADERS,
    'cache-control': `public, max-age=${OEMBED_CACHE_AGE_SECONDS}`,
  };
  const method = input.method.toUpperCase();
  if (method === 'OPTIONS') {
    return { status: 204, headers: cors, body: '' };
  }
  if (method !== 'GET') {
    return jsonBody(405, { error: 'method not allowed' });
  }
  const format = (input.searchParams.get('format') ?? 'json').toLowerCase();
  if (format === 'xml') {
    return jsonBody(501, { error: 'xml format is not supported' });
  }
  if (format !== 'json') {
    return jsonBody(400, { error: 'format must be json' });
  }
  const rawUrl = input.searchParams.get('url');
  if (!rawUrl) {
    return jsonBody(400, { error: 'url query parameter is required' });
  }
  const target = parsePublicAtlasOembedUrl(rawUrl, input.requestOrigin, input.allowedHosts);
  if (!target) {
    return jsonBody(404, { error: 'not a public atlas URL' });
  }
  const body = buildOembedRichResponse(
    target,
    parseMaxDimension(input.searchParams.get('maxwidth'), OEMBED_DEFAULT_WIDTH),
    parseMaxDimension(input.searchParams.get('maxheight'), OEMBED_DEFAULT_HEIGHT),
  );
  return jsonBody(200, body);
}
