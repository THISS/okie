import { readdirSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { isKnownAppPath, NOT_FOUND_CACHE_CONTROL, notFoundHttpOutput, notFoundPageHtml, SITE_CREDIT_HTML, SITE_FOOTER_CSS, siteBrandLinkHtml, siteFooterHtml } from './notFoundPage';
import { handlePublicAtlasRoute } from './publicAtlasRoutes';
import { scrollToLocationHash } from './scanLanding';
import { NotFoundScreen, SiteBrand, SiteFooter } from './siteFooter';
import { ATLAS_LICENCE_NOTE, CONTACT_EMAIL, GITHUB_REPO_URL } from './siteMeta';

describe('CLA-318 route classification', () => {
  it('knows exactly the SPA routes main.tsx renders', () => {
    for (const path of ['/', '/index.html', '/new', '/new/', '/operator', '/operator/', '/r/acme/app', '/r/acme/app/', '/r/acme/app/v1.2/src', '/r/THISS/okie']) {
      expect(isKnownAppPath(path), path).toBe(true);
    }
    for (const path of ['/zzz', '/new/extra', '/r', '/r/acme', '/r/acme/', '/R/acme/app', '/r/ac me/app', '/operator/x', '/about', '/r/%E0%A4%A/x', '/favicon.ico']) {
      expect(isKnownAppPath(path), path).toBe(false);
    }
  });
});

describe('CLA-318 branded 404 page', () => {
  it('is a self-contained, noindex, branded page linking the home directory, with the footer', () => {
    const html = notFoundPageHtml();
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<meta name="robots" content="noindex" />');
    expect(html).toContain('<title>Page not found · Source For Atlas</title>');
    expect(html).toContain('<h1>Page not found</h1>');
    expect(html).toContain('<strong>Source For</strong>');
    expect(html).toContain('<svg aria-hidden="true"');
    // CLA-269: the directory is the home page now (the edge 301s /new there).
    expect(html).toContain('<a class="primary" href="/">Browse published atlases</a>');
    expect(html).not.toContain('href="/new"');
    expect(html).toContain(`href="${GITHUB_REPO_URL}"`);
    expect(html).toContain(CONTACT_EMAIL);
    expect(html).toContain('under its own licence');
    // No script, no external stylesheet: renders without the SPA bundle.
    expect(html).not.toMatch(/<script|rel="stylesheet"|\/assets\//);
    expect(notFoundPageHtml('atlas')).toContain('<h1>Atlas not found</h1>');
  });

  it('answers 404 with a short shared cache; HEAD has no body', () => {
    const get = notFoundHttpOutput('GET');
    expect(get.status).toBe(404);
    expect(get.headers).toMatchObject({ 'content-type': 'text/html; charset=utf-8', 'cache-control': NOT_FOUND_CACHE_CONTROL });
    expect(get.body).toBe(notFoundPageHtml());
    expect(notFoundHttpOutput('head').body).toBe('');
    expect(notFoundHttpOutput('HEAD', 'atlas').status).toBe(404);
  });

  it('is what an unknown atlas gets from the share dispatcher (GET body, HEAD none)', async () => {
    const input = { method: 'GET', search: '', requestOrigin: 'http://localhost:4173', allowedOrigins: [], indexHtml: async () => '<html></html>', isPublicAtlas: () => false, pathname: '/r/foo/bar' };
    const get = await handlePublicAtlasRoute(input);
    expect(get?.status).toBe(404);
    expect(get?.body).toBe(notFoundPageHtml('atlas'));
    const head = await handlePublicAtlasRoute({ ...input, method: 'HEAD' });
    expect(head?.status).toBe(404);
    expect(head?.body).toBe('');
  });
});

describe('CLA-318 site footer', () => {
  it('names the GitHub repository, the contact address and the licence note', () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));
    expect(html).toContain('id="about"');
    expect(html).toContain(`href="${GITHUB_REPO_URL}"`);
    expect(html).toContain(`href="mailto:${CONTACT_EMAIL}"`);
    expect(html).toContain(`>${CONTACT_EMAIL}</a>`);
    expect(html).toContain(ATLAS_LICENCE_NOTE);
  });

  it('closes the in-app 404 screen, which links the home directory', () => {
    const html = renderToStaticMarkup(createElement(NotFoundScreen));
    expect(html).toContain('Page not found');
    expect(html).toMatch(/<a href="\/" [^>]*>Browse published atlases<\/a>/);
    expect(html).not.toContain('href="/new"');
    expect(html).toContain('data-testid="site-footer"');
  });
});

describe('CLA-318 static files', () => {
  it('apps/web/public ships no HTML file', () => {
    const html = (readdirSync(new URL('../public/', import.meta.url), { recursive: true }) as string[])
      .filter(name => /\.html?$/i.test(name));
    // The edge Worker (apps/edge/src/index.ts serveStaticFileOr404) treats any HTML that Static Assets
    // returns for an unrouted path as the SPA fallback and turns it into the branded 404. dist has no
    // HTML besides index.html; a public/*.html would be served as a 404 page. Route it in the Worker
    // (and isKnownAppPath) instead.
    expect(html, 'HTML in apps/web/public would 404 at the edge').toEqual([]);
  });
});

describe('CLA-318 /new#about', () => {
  it('scrolls to the fragment element when it exists, and does nothing otherwise', () => {
    const scrollIntoView = vi.fn();
    const doc = { getElementById: vi.fn((id: string) => (id === 'about' ? { scrollIntoView } as unknown as HTMLElement : null)) };
    expect(scrollToLocationHash(doc, '#about')).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(scrollToLocationHash(doc, '#missing')).toBe(false);
    expect(scrollToLocationHash(doc, '')).toBe(false);
    expect(scrollToLocationHash(doc, '#')).toBe(false);
    expect(scrollToLocationHash(doc, '#%E0%A4%A')).toBe(false);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});

describe('CLA-269 brand home link and footer credit', () => {
  const brandLink = /<a class="brand" href="\/" aria-label="Source For Atlas — home"><svg aria-hidden="true"/;
  const credit = 'Brought to you by the guy who made <a href="https://clabrate.com" rel="noopener"';

  it('static 404: the brand links home (not marked current) and the footer carries the credit', () => {
    const html = notFoundPageHtml();
    expect(html).toMatch(brandLink);
    expect(html).not.toContain('aria-current');
    expect(html).toContain(credit);
    expect(html).toContain('a.brand:focus-visible');
    expect(html).toContain('.site-footer .site-credit{margin:.35rem 0 0;color:#97a5a0;font-size:.72rem');
  });

  it('static brand link: labelled "— home" off the home page; on home, named by its wordmark and marked current', () => {
    expect(siteBrandLinkHtml('brand')).toMatch(/^<a class="brand" href="\/" aria-label="Source For Atlas — home"><svg /);
    const home = siteBrandLinkHtml('brand', true);
    expect(home).toMatch(/^<a class="brand" href="\/" aria-current="page"><svg /);
    expect(home).not.toContain('aria-label');
    // Accessible name from content: the SVG is aria-hidden, so the text is the wordmark.
    expect(home).toContain('<svg aria-hidden="true"');
    expect(home.replace(/<svg[\s\S]*?<\/svg>/, '').replace(/<[^>]+>/g, '')).toBe('Source For Atlas');
  });

  it('static footer: exact credit wording, link and rel', () => {
    expect(SITE_CREDIT_HTML).toBe('<p class="site-credit">Brought to you by the guy who made <a href="https://clabrate.com" rel="noopener">clabrate.com</a></p>');
    expect(siteFooterHtml()).toContain(SITE_CREDIT_HTML);
  });

  it('React footer: same credit, muted fine print, underlined link', () => {
    const html = renderToStaticMarkup(createElement(SiteFooter));
    expect(html).toContain('<p class="site-credit" data-testid="site-credit" style="margin:0.35rem 0 0;color:#97a5a0;font-size:0.72rem;line-height:1.5">Brought to you by the guy who made <a href="https://clabrate.com" rel="noopener" style="color:inherit;text-decoration:underline;text-underline-offset:2px">clabrate.com</a></p>');
  });

  it('React brand (in-app 404, mobile notice) links home with the home label', () => {
    const html = renderToStaticMarkup(createElement(SiteBrand));
    expect(html).toMatch(/^<a aria-label="Source For Atlas — home" data-testid="site-brand" href="\/" style="[^"]*text-decoration:none"><svg aria-hidden="true"/);
    expect(renderToStaticMarkup(createElement(NotFoundScreen))).toContain('aria-label="Source For Atlas — home" data-testid="site-brand" href="/"');
  });

  it('the credit colour meets WCAG AA for small text on the page ground', () => {
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    // Read both colours from what the pages ship: the static 404's page ground and the shared credit CSS,
    // plus the React footer's inline credit colour.
    const ground = notFoundPageHtml().match(/html,body\{[^}]*background:(#[0-9a-f]{6})/)?.[1];
    const staticCredit = SITE_FOOTER_CSS.match(/\.site-credit\{[^}]*color:(#[0-9a-f]{6})/)?.[1];
    const reactCredit = renderToStaticMarkup(createElement(SiteFooter)).match(/class="site-credit"[^>]*color:(#[0-9a-f]{6})/)?.[1];
    expect(ground).toBeDefined();
    expect(staticCredit).toBeDefined();
    expect(reactCredit).toBe(staticCredit);
    const ratio = (luminance(staticCredit!) + 0.05) / (luminance(ground!) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
