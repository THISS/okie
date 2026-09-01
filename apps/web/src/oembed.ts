import { parseAppRoute } from './renderer/route';

/**
 * oEmbed 1.0 for public `/r/<owner>/<repo>` atlas views (CLA-30).
 *
 * Docs sites discover the endpoint from a `<link rel="alternate"
 * type="application/json+oembed">` on the share URL, then fetch JSON whose
 * `html` iframe points at that same public view (no login wall). The payload
 * is a pure function of the atlas URL — no scan objects, no secrets.
 */

export const OEMBED_PATH = '/oembed';
export const OEMBED_DEFAULT_WIDTH = 800;
export const OEMBED_DEFAULT_HEIGHT = 560;
export const OEMBED_MIN_WIDTH = 200;
export const OEMBED_MIN_HEIGHT = 140;
export const OEMBED_PROVIDER_NAME = 'Okie';
export const OEMBED_CACHE_AGE_SECONDS = 300;
export const OEMBED_JSON_TYPE = 'application/json+oembed';

const GITHUB_NAME = /^[A-Za-z0-9._-]+$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

export type PublicAtlasOembedTarget = {
  owner: string;
  repo: string;
  ref?: string;
  search: string;
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

/** Public origin of the atlas host (never the loopback scan process). */
export function oembedRequestOrigin(headers: OembedHeaderBag): string {
  const proto = firstHeader(headers['x-forwarded-proto']) === 'https' ? 'https' : 'http';
  const host = firstHeader(headers['x-forwarded-host'])
    ?? firstHeader(headers.host)
    ?? 'localhost:4173';
  return `${proto}://${host}`;
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return LOOPBACK.has(host) || host === '[::1]';
}

function hostsCompatible(page: URL, origin: URL): boolean {
  const a = page.hostname.toLowerCase();
  const b = origin.hostname.toLowerCase();
  if (a === b) return true;
  return isLoopbackHostname(a) && isLoopbackHostname(b);
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

/**
 * Accept only a public `/r/<owner>/<repo>` path on this atlas origin.
 * The iframe `src` is rebuilt from `requestOrigin` so a foreign host in `url`
 * cannot become the embed target.
 */
export function parsePublicAtlasOembedUrl(
  raw: string,
  requestOrigin: string,
): PublicAtlasOembedTarget | undefined {
  if (raw.length > 2048) return undefined;
  let page: URL;
  let origin: URL;
  try {
    page = new URL(raw);
    origin = new URL(requestOrigin);
  } catch {
    return undefined;
  }
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return undefined;
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return undefined;
  if (page.username || page.password) return undefined;
  if (!hostsCompatible(page, origin)) return undefined;
  const route = parseAppRoute(page.pathname);
  if (route.kind !== 'repo') return undefined;
  if (!GITHUB_NAME.test(route.owner) || !GITHUB_NAME.test(route.repo)) return undefined;
  if (route.ref && route.ref.split('/').some(segment => !GITHUB_NAME.test(segment))) return undefined;
  return {
    owner: route.owner,
    repo: route.repo,
    ...(route.ref ? { ref: route.ref } : {}),
    search: page.search,
  };
}

export function publicAtlasPath(target: PublicAtlasOembedTarget): string {
  const pin = target.ref ? `/${target.ref}` : '';
  return `/r/${target.owner}/${target.repo}${pin}`;
}

export function publicAtlasHref(target: PublicAtlasOembedTarget, requestOrigin: string): string {
  return new URL(`${publicAtlasPath(target)}${target.search}`, requestOrigin).href;
}

export function publicAtlasTitle(target: PublicAtlasOembedTarget): string {
  return `${target.owner}/${target.repo} architecture atlas`;
}

export function buildOembedIframeHtml(
  target: PublicAtlasOembedTarget,
  requestOrigin: string,
  size: { width: number; height: number },
): string {
  const src = publicAtlasHref(target, requestOrigin);
  const title = publicAtlasTitle(target);
  return `<iframe src="${escapeAttribute(src)}" width="${size.width}" height="${size.height}" loading="lazy" style="border:0;border-radius:12px" title="${escapeAttribute(title)}" allowfullscreen></iframe>`;
}

export function buildOembedRichResponse(
  target: PublicAtlasOembedTarget,
  requestOrigin: string,
  maxWidth = OEMBED_DEFAULT_WIDTH,
  maxHeight = OEMBED_DEFAULT_HEIGHT,
): OembedRichResponse {
  const size = fitEmbedSize(maxWidth, maxHeight);
  return {
    version: '1.0',
    type: 'rich',
    provider_name: OEMBED_PROVIDER_NAME,
    provider_url: new URL('/', requestOrigin).href.replace(/\/$/, ''),
    title: publicAtlasTitle(target),
    html: buildOembedIframeHtml(target, requestOrigin, size),
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
  const target = parsePublicAtlasOembedUrl(rawUrl, input.requestOrigin);
  if (!target) {
    return jsonBody(404, { error: 'not a public atlas URL' });
  }
  const body = buildOembedRichResponse(
    target,
    input.requestOrigin,
    parseMaxDimension(input.searchParams.get('maxwidth'), OEMBED_DEFAULT_WIDTH),
    parseMaxDimension(input.searchParams.get('maxheight'), OEMBED_DEFAULT_HEIGHT),
  );
  return jsonBody(200, body);
}
