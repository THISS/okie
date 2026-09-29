import { CLOUDFLARE_INSIGHTS_SCRIPT_ORIGIN, isHtmlContentType } from '../../web/src/securityHeaders';
import type { EdgeEnv } from './env';

/**
 * Cloudflare Web Analytics (CLA-318): cookieless, no consent banner, no other trackers. Off unless
 * `WEB_ANALYTICS_TOKEN` is set; then the Worker adds Cloudflare's beacon script (the dashboard's
 * manual-install snippet) just before `</body>` of every HTML document it serves: the SPA shell, `/new`,
 * `/r/...` share pages and both 404 pages, and the CSP allows the beacon (securityHeaders.ts
 * `webAnalytics`). Nothing in apps/web ships the beacon, so local dev, `vite preview` and the portable
 * viewer never load it. The beacon reports to `https://cloudflareinsights.com/cdn-cgi/rum`.
 */

/** The token is public (it ships in page HTML), but it is interpolated into markup: only this shape is accepted. */
export const WEB_ANALYTICS_TOKEN_PATTERN = /^[A-Za-z0-9]{16,64}$/;

/**
 * Embeds (`/r/...?embed=1`, the oEmbed iframe on third-party sites) are still our page views, so they
 * count. Flip to false to leave them out.
 */
export const WEB_ANALYTICS_IN_EMBEDS = true;

export const WEB_ANALYTICS_BEACON_SRC = `${CLOUDFLARE_INSIGHTS_SCRIPT_ORIGIN}/beacon.min.js`;

/** The configured token, or undefined when unset, blank or not a plain token (never injected then). */
export function webAnalyticsToken(env: Pick<EdgeEnv, 'WEB_ANALYTICS_TOKEN'>): string | undefined {
  const token = env.WEB_ANALYTICS_TOKEN?.trim();
  return token && WEB_ANALYTICS_TOKEN_PATTERN.test(token) ? token : undefined;
}

export function webAnalyticsSnippet(token: string): string {
  return `<script defer src="${WEB_ANALYTICS_BEACON_SRC}" data-cf-beacon='{"token":"${token}"}'></script>`;
}

/** Whether a page at `url` gets the beacon (every page, except embeds when `inEmbeds` is off). */
export function injectsInto(url: URL, inEmbeds: boolean = WEB_ANALYTICS_IN_EMBEDS): boolean {
  return inEmbeds || url.searchParams.get('embed') !== '1';
}

/**
 * The SPA shell request to Static Assets. With analytics on, the conditional headers are dropped: the
 * browser's validators describe the page *with* the beacon (or, cached before analytics was turned on,
 * without it), and Static Assets would answer 304 for either. The shell is `max-age=0, must-revalidate`
 * and small, so it is simply refetched.
 */
export function analyticsConditionalRequest(request: Request, env: Pick<EdgeEnv, 'WEB_ANALYTICS_TOKEN'>): Request {
  if (!webAnalyticsToken(env) || !injectsInto(new URL(request.url))) return request;
  if (!request.headers.has('if-none-match') && !request.headers.has('if-modified-since')) return request;
  const headers = new Headers(request.headers);
  headers.delete('if-none-match');
  headers.delete('if-modified-since');
  return new Request(request, { headers });
}

/**
 * Adds the beacon to an HTML response when a valid token is configured. Streaming (HTMLRewriter), so the
 * body is never buffered; `content-length`, `etag` and `last-modified` are dropped (they describe the
 * page without the beacon). HEAD and other bodiless answers get the same header treatment and stay
 * bodiless. Non-HTML responses are returned as they are.
 */
export function withWebAnalytics(request: Request, response: Response, env: Pick<EdgeEnv, 'WEB_ANALYTICS_TOKEN'>): Response {
  const token = webAnalyticsToken(env);
  if (!token || !isHtmlContentType(response.headers.get('content-type')) || !injectsInto(new URL(request.url))) return response;
  const snippet = webAnalyticsSnippet(token);
  const out = response.body && request.method !== 'HEAD'
    ? new HTMLRewriter().on('body', { element(body) { body.onEndTag(end => { end.before(snippet, { html: true }); }); } }).transform(response)
    : response;
  const copy = new Response(out.body, out);
  copy.headers.delete('content-length');
  copy.headers.delete('etag');
  copy.headers.delete('last-modified');
  return copy;
}
