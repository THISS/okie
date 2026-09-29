import { parseAppRoute, scanSlug } from './renderer/route';

/**
 * Site identity and per-page <title>/description (CLA-318). The brand is "Source For", the product
 * "Atlas" (sourcefor.dev). One source for the browser (document.title after boot), the share/landing
 * HTML the edge Worker and Vite plugin render for crawlers, and the static index.html defaults
 * (asserted in siteMeta.test.ts).
 *
 * Canonical links always name production: staging.sourcefor.dev serves the same pages but must
 * canonicalize to sourcefor.dev. og:url / og:image follow the (allowlisted) request origin instead,
 * like the existing /r share tags, so a staging share still previews from staging.
 */
export const BRAND_NAME = 'Source For';
export const PRODUCT_NAME = 'Atlas';
export const SITE_NAME = `${BRAND_NAME} ${PRODUCT_NAME}`;
export const CANONICAL_ORIGIN = 'https://sourcefor.dev';
/** Static 1200×630 card for `/` and `/new` (apps/web/public; source docs/brand/og/og-default.svg). */
export const DEFAULT_OG_IMAGE_PATH = '/og-default.png';
export const DEFAULT_OG_IMAGE_WIDTH = 1200;
export const DEFAULT_OG_IMAGE_HEIGHT = 630;
export const DEFAULT_OG_IMAGE_ALT = `${SITE_NAME}: explore how open-source software is built`;

export const HOME_TITLE = `${SITE_NAME}: explore how open-source software is built`;
export const HOME_DESCRIPTION =
  'Architecture atlases of open-source software, from system context down to the exact lines of source. Every claim is backed by evidence from the code.';
export const LANDING_TITLE = `Published atlases · ${SITE_NAME}`;
export const LANDING_DESCRIPTION =
  'Browse the published architecture atlases of open-source repositories on Source For Atlas. No sign-in needed.';

export type PageMeta = {
  title: string;
  description: string;
  /** Path on {@link CANONICAL_ORIGIN}; always without a query. */
  canonicalPath: string;
};

/** `<repo> by <owner> · Source For Atlas` — the share page title for `/r/<owner>/<repo>`. */
export function repoPageTitle(owner: string, repo: string): string {
  return `${repo} by ${owner} · ${SITE_NAME}`;
}

export function repoPageDescription(owner: string, repo: string): string {
  return `Explore how ${owner}/${repo} is built: an architecture atlas from system context down to source, on ${SITE_NAME}.`;
}

/**
 * The one canonical share path for an atlas: `/r/<scanSlug(owner)>/<scanSlug(repo)>`, the same target
 * the edge's case/punctuation 301 lands on (apps/edge/src/share.ts canonicalShareRedirect). Case
 * variants and pinned refs all canonicalize to it.
 */
export function repoCanonicalPath(owner: string, repo: string): string {
  return `/r/${scanSlug(owner)}/${scanSlug(repo)}`;
}

export function landingPageMeta(): PageMeta {
  return { title: LANDING_TITLE, description: LANDING_DESCRIPTION, canonicalPath: '/new' };
}

/** Title, description and canonical path for a pathname (a malformed escape reads as the home page). */
export function pageMetaForPath(pathname: string): PageMeta {
  if (pathname === '/operator') return { title: `Operator review · ${SITE_NAME}`, description: HOME_DESCRIPTION, canonicalPath: '/' };
  let route: ReturnType<typeof parseAppRoute>;
  try {
    route = parseAppRoute(pathname);
  } catch {
    route = { kind: 'default' };
  }
  if (route.kind === 'landing') return landingPageMeta();
  if (route.kind === 'repo') {
    return {
      title: repoPageTitle(route.owner, route.repo),
      description: repoPageDescription(route.owner, route.repo),
      canonicalPath: repoCanonicalPath(route.owner, route.repo),
    };
  }
  return { title: HOME_TITLE, description: HOME_DESCRIPTION, canonicalPath: '/' };
}

export function canonicalHref(canonicalPath: string): string {
  return new URL(canonicalPath, CANONICAL_ORIGIN).href;
}

/** The slice of `Document` applyPageMeta touches, structurally typed so the edge Worker (no DOM lib) can import this module. */
type MetaElement = { setAttribute(name: string, value: string): void };
export type MetaDocument = {
  title: string;
  head: { appendChild(element: never): unknown };
  createElement(tag: 'meta' | 'link'): MetaElement;
  querySelector(selector: string): MetaElement | null;
};

function upsert(doc: MetaDocument, selector: string, create: () => MetaElement, attribute: string, value: string): void {
  let element = doc.querySelector(selector);
  if (!element) {
    element = create();
    doc.head.appendChild(element as never);
  }
  element.setAttribute(attribute, value);
}

/**
 * Browser side: sets document.title, the meta description and the canonical link for the route
 * main.tsx is booting. Route changes are full page loads (`/new` → `/r/…` uses location.assign), so
 * boot is the only place this needs to run. Open Graph tags are left alone: crawlers never run the SPA.
 */
export function applyPageMeta(doc: MetaDocument, pathname: string): PageMeta {
  const meta = pageMetaForPath(pathname);
  doc.title = meta.title;
  upsert(doc, 'meta[name="description"]', () => {
    const element = doc.createElement('meta');
    element.setAttribute('name', 'description');
    return element;
  }, 'content', meta.description);
  upsert(doc, 'link[rel="canonical"]', () => {
    const element = doc.createElement('link');
    element.setAttribute('rel', 'canonical');
    return element;
  }, 'href', canonicalHref(meta.canonicalPath));
  return meta;
}
