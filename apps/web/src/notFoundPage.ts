import { parseAppRoute } from './renderer/route';
import { ATLAS_LICENCE_NOTE, BRAND_NAME, CONTACT_EMAIL, CREDIT_LEAD, CREDIT_LINK_TEXT, CREDIT_REL, CREDIT_URL, GITHUB_REPO_URL, PRIVACY_PATH, PRODUCT_NAME, SITE_HOME_HREF, SITE_HOME_LABEL, SITE_NAME } from './siteMeta';

/**
 * Branded 404 (CLA-318). One self-contained HTML page (inline CSS and SVG, no script, noindex) that
 * the edge Worker, the Vite dev/preview plugin and the unknown-atlas share handler all serve with a
 * real 404 status, so it renders even when the SPA bundle does not. Runtime-agnostic: no DOM, no Node.
 *
 * Which paths are the SPA's own is decided here too ({@link isKnownAppPath}), from the same
 * parseAppRoute main.tsx boots with: everything else that is not a real static file is a 404.
 */

export type NotFoundKind = 'page' | 'atlas';

/**
 * Paths main.tsx renders: `/` (and `/index.html`; the hosted edge answers most of those with the home
 * page, homePage.ts), the `/new` landing (the hosted edge 301s it to `/`), `/operator` (each with or without a trailing slash), and
 * `/r/<owner>/<repo>[/<ref>]`. Worker-owned paths (/assets, /scan, /api, /og, /oembed, /sitemap.xml, /__store) and
 * real files (favicons, robots.txt, og-default.png) are answered before this is consulted.
 */
export function isKnownAppPath(pathname: string): boolean {
  if (pathname === '/' || pathname === '/index.html') return true;
  if (pathname === '/new' || pathname === '/new/') return true;
  if (pathname === '/operator' || pathname === '/operator/') return true;
  try {
    return parseAppRoute(pathname).kind === 'repo';
  } catch {
    // A malformed percent-escape is not a route.
    return false;
  }
}

export const NOT_FOUND_COPY: Record<NotFoundKind, { title: string; heading: string; body: string }> = {
  page: {
    title: `Page not found · ${SITE_NAME}`,
    heading: 'Page not found',
    body: 'There is nothing at this address. It may have moved, or the link may be mistyped.',
  },
  atlas: {
    title: `Atlas not found · ${SITE_NAME}`,
    heading: 'Atlas not found',
    body: 'There is no published atlas at this address yet. Check the owner and repository name, or browse the atlases that are published.',
  },
};

/** The mark as static SVG markup (same geometry as icons.tsx SourceForMark). */
export const SOURCE_FOR_MARK_SVG = '<svg aria-hidden="true" fill="none" height="30" viewBox="0 0 64 64" width="30"><path d="M45 12H25a10 10 0 0 0 0 20h14a10 10 0 0 1 0 20H20" stroke="#f1f7f4" stroke-width="8"/><circle cx="52" cy="12" r="6" stroke="#f1f7f4" stroke-width="4"/><rect fill="#d9ff70" height="16" rx="3" stroke="#070a0b" stroke-width="3" width="16" x="6" y="44"/></svg>';

/** Footer markup for static pages; the React landing renders the same words (siteFooter.tsx). */
export function siteFooterHtml(): string {
  return `<footer class="site-footer" id="about" aria-label="About ${SITE_NAME}">
      <p>${ATLAS_LICENCE_NOTE.replace('’', '&rsquo;')}</p>
      <p><a href="${GITHUB_REPO_URL}" rel="noopener noreferrer">${SITE_NAME} on GitHub</a> · Contact <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> · <a href="${PRIVACY_PATH}">Privacy</a></p>
      ${SITE_CREDIT_HTML}
    </footer>`;
}

/**
 * CLA-269 fine-print credit (static pages; siteFooter.tsx renders the same). #97a5a0 on the #070a0b
 * page ground is 7.76:1 (WCAG AA for small text needs 4.5:1); the link inherits it and is underlined.
 * Pages that use siteFooterHtml include {@link SITE_FOOTER_CSS}.
 */
export const SITE_CREDIT_HTML = `<p class="site-credit">${CREDIT_LEAD}<a href="${CREDIT_URL}" rel="${CREDIT_REL}">${CREDIT_LINK_TEXT}</a></p>`;

/** Shared static-page CSS for the brand home link's focus ring and the footer credit. */
export const SITE_FOOTER_CSS = '.site-footer a:focus-visible,a.brand:focus-visible{outline:2px solid #79dfd4;outline-offset:2px;border-radius:4px}'
  + '.site-footer .site-credit{margin:.35rem 0 0;color:#97a5a0;font-size:.72rem;line-height:1.5}'
  + '.site-footer .site-credit a{color:inherit;text-decoration:underline;text-underline-offset:2px}';

/**
 * The brand mark + wordmark as a link home (static pages). `current` marks it on the home page itself:
 * there it has no aria-label, so its name is the visible wordmark and `aria-current` says it is home.
 */
export function siteBrandLinkHtml(className: string, current = false): string {
  const naming = current ? ' aria-current="page"' : ` aria-label="${SITE_HOME_LABEL}"`;
  return `<a class="${className}" href="${SITE_HOME_HREF}"${naming}>${SOURCE_FOR_MARK_SVG}<span><strong>${BRAND_NAME}</strong> <span>${PRODUCT_NAME}</span></span></a>`;
}

export function notFoundPageHtml(kind: NotFoundKind = 'page'): string {
  const copy = NOT_FOUND_COPY[kind];
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <meta name="color-scheme" content="dark" />
    <title>${copy.title}</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <style>
      *{box-sizing:border-box}
      html,body{margin:0;min-height:100%;background:#070a0b;color:#eef4f2}
      body{font:16px/1.6 "IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
      main{max-width:640px;margin:0 auto;padding:4.5rem 1.5rem 2rem}
      .brand{display:inline-flex;align-items:center;gap:.6rem;margin-bottom:2.5rem;color:#f1f7f4;text-decoration:none;letter-spacing:-.02em}
      .brand strong{font-weight:600}.brand span span{color:#97a5a0}
      .code{margin:0 0 .25rem;color:#d9ff70;font:600 .8rem/1 "IBM Plex Mono",ui-monospace,monospace;letter-spacing:.08em}
      h1{margin:0 0 .5rem;font-size:1.8rem;line-height:1.25}
      p{margin:0;color:#b7c3c0}
      nav{display:flex;flex-wrap:wrap;gap:.75rem;margin-top:1.75rem}
      nav a{padding:.55rem 1rem;border:1px solid #2a3a37;border-radius:8px;color:#eef4f2;font-weight:600;text-decoration:none}
      nav a.primary{border-color:#d9ff70;background:#d9ff70;color:#0d1a17}
      nav a:hover{border-color:#79dfd4}
      .site-footer{max-width:640px;margin:0 auto;padding:1.5rem 1.5rem 3rem;border-top:1px solid #1d2a28;font-size:.85rem;display:grid;gap:.4rem}
      .site-footer a{color:#79dfd4}
      ${SITE_FOOTER_CSS}
    </style>
  </head>
  <body>
    <main data-not-found="${kind}">
      ${siteBrandLinkHtml('brand')}
      <p class="code">404</p>
      <h1>${copy.heading}</h1>
      <p>${copy.body}</p>
      <nav aria-label="Where to next">
        <a class="primary" href="/">Browse published atlases</a>
      </nav>
    </main>
    ${siteFooterHtml()}
  </body>
</html>
`;
}

/** Short-lived shared caching: a path that 404s today may be published (or routed) soon. */
export const NOT_FOUND_CACHE_CONTROL = 'public, max-age=60';

export type NotFoundHttpOutput = { status: 404; headers: Record<string, string>; body: string };

/** The 404 answer for any method; HEAD gets the headers only. */
export function notFoundHttpOutput(method: string, kind: NotFoundKind = 'page', extraHeaders: Record<string, string> = {}): NotFoundHttpOutput {
  return {
    status: 404,
    headers: {
      ...extraHeaders,
      'cache-control': NOT_FOUND_CACHE_CONTROL,
      'content-type': 'text/html; charset=utf-8',
    },
    body: method.toUpperCase() === 'HEAD' ? '' : notFoundPageHtml(kind),
  };
}
