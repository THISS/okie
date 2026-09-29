import { isPublicAtlasViewPath } from './hostedAtlas';

/**
 * Security headers for sourcefor.dev (CLA-318). Runtime-agnostic (no DOM, no Node): the edge Worker
 * sets them on every response it returns, and the Vite preview server mirrors them. `pnpm dev` never
 * gets the CSP: Vite's dev client injects inline scripts for HMR.
 *
 * The CSP is written for what the app really loads (audited for CLA-318):
 *   script-src   'self' module chunks only (no inline scripts in the built shell), plus
 *                'wasm-unsafe-eval' for WebAssembly.instantiate(Streaming) of the atlas renderer, and,
 *                only when the edge injects Cloudflare Web Analytics (`webAnalytics`), its beacon script
 *                (static.cloudflareinsights.com).
 *   style-src    'unsafe-inline': Mermaid renders <style> elements and style attributes into its SVG,
 *                the branded 404 page is self-contained (inline <style>), and React style props.
 *   img-src      data: / blob: for Mermaid SVG and canvas exports (screenshot PNG via object URL).
 *   font-src     'self': @fontsource IBM Plex files are bundled under /assets.
 *   connect-src  'self' (/scan, /api), raw.githubusercontent.com (the portable viewer's
 *                "View full source" reads GitHub raw directly; hosted atlases go through /scan
 *                source.json), and with `webAnalytics` cloudflareinsights.com (the beacon reports to
 *                /cdn-cgi/rum there).
 *   frame-ancestors  omitted on atlas pages (`/r/...`, which oEmbed iframes with ?embed=1: any parent,
 *                file:/data:/blob:/sandboxed ones included), 'self' everywhere else.
 * No X-Frame-Options: it would override frame-ancestors' intent for embeds in older browsers.
 */

export const CLOUDFLARE_INSIGHTS_SCRIPT_ORIGIN = 'https://static.cloudflareinsights.com';
export const CLOUDFLARE_INSIGHTS_CONNECT_ORIGIN = 'https://cloudflareinsights.com';
export const GITHUB_RAW_ORIGIN = 'https://raw.githubusercontent.com';

export const BASE_SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
} as const;

export type ContentSecurityPolicyOptions = {
  /** Atlas views: may be embedded by any site. */
  framable: boolean;
  /** The edge injects Cloudflare Web Analytics (a valid WEB_ANALYTICS_TOKEN): allow its script and reports. */
  webAnalytics?: boolean;
};

/** The CSP for an HTML document. */
export function contentSecurityPolicy(options: ContentSecurityPolicyOptions): string {
  const analytics = options.webAnalytics === true;
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${analytics ? ` ${CLOUDFLARE_INSIGHTS_SCRIPT_ORIGIN}` : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${GITHUB_RAW_ORIGIN}${analytics ? ` ${CLOUDFLARE_INSIGHTS_CONNECT_ORIGIN}` : ''}`,
    "worker-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // Framable atlas pages carry no frame-ancestors at all: `*` would still block file:, data:, blob:
    // and sandboxed (opaque-origin) parents, which oEmbed hosts and docs previews use.
    ...(options.framable ? [] : ["frame-ancestors 'self'"]),
  ].join('; ');
}

/** Atlas views (`/r/<owner>/<repo>[/<ref>]`): the pages oEmbed iframes on other sites. */
export function isFramableAtlasPath(pathname: string): boolean {
  try {
    return isPublicAtlasViewPath(pathname);
  } catch {
    // A malformed percent-escape is not an atlas route.
    return false;
  }
}

export function isHtmlContentType(contentType: string | null | undefined): boolean {
  return /^text\/html\b/i.test(contentType ?? '');
}

/** Headers to add to a response for `pathname` with this content type (lower-case names). */
export function securityHeadersFor(pathname: string, contentType: string | null | undefined, options: { webAnalytics?: boolean } = {}): Record<string, string> {
  if (!isHtmlContentType(contentType)) return { ...BASE_SECURITY_HEADERS };
  return {
    ...BASE_SECURITY_HEADERS,
    'content-security-policy': contentSecurityPolicy({ framable: isFramableAtlasPath(pathname), webAnalytics: options.webAnalytics === true }),
  };
}
