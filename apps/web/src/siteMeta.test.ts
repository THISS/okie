import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pngDimensions } from './atlasCard';
import { buildOpenGraphTags, handleLandingHtmlRequest } from './openGraph';
import { handlePublicAtlasRoute, isPublicAtlasRoutePath } from './publicAtlasRoutes';
import {
  CANONICAL_ORIGIN,
  DEFAULT_OG_IMAGE_PATH,
  HOME_DESCRIPTION,
  HOME_TITLE,
  LANDING_DESCRIPTION,
  LANDING_TITLE,
  SITE_NAME,
  applyPageMeta,
  pageMetaForPath,
} from './siteMeta';

const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const publicFile = (name: string) => new URL(`../public/${name}`, import.meta.url);

/** Just enough of Document for applyPageMeta: head children found by `name` / `rel`. */
function fakeDocument() {
  type El = { tag: string; attrs: Record<string, string>; setAttribute(name: string, value: string): void; getAttribute(name: string): string | null };
  const children: El[] = [];
  const make = (tag: string): El => ({
    tag,
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = value; },
    getAttribute(name) { return this.attrs[name] ?? null; },
  });
  const doc = {
    title: 'old',
    head: { appendChild: (el: El) => { children.push(el); return el; } },
    createElement: make,
    querySelector: (selector: string) => {
      const match = /^(\w+)\[(\w+)="([^"]+)"\]$/.exec(selector);
      return children.find(el => match && el.tag === match[1] && el.attrs[match[2]!] === match[3]) ?? null;
    },
  };
  return { doc: doc as unknown as Parameters<typeof applyPageMeta>[0] & { title: string }, children };
}

describe('site meta (CLA-318)', () => {
  it('titles each route for Source For Atlas', () => {
    expect(SITE_NAME).toBe('Source For Atlas');
    expect(pageMetaForPath('/')).toEqual({ title: HOME_TITLE, description: HOME_DESCRIPTION, canonicalPath: '/' });
    expect(HOME_TITLE).toBe('Source For Atlas: explore how open-source software is built');
    // CLA-269: the directory moved to the home page; /new canonicalizes there.
    expect(pageMetaForPath('/new')).toEqual({ title: LANDING_TITLE, description: LANDING_DESCRIPTION, canonicalPath: '/' });
    expect(pageMetaForPath('/new/').title).toBe('Published atlases · Source For Atlas');
    expect(pageMetaForPath('/r/BurntSushi/ripgrep')).toEqual({
      title: 'ripgrep by BurntSushi · Source For Atlas',
      description: 'Explore how BurntSushi/ripgrep is built: an architecture atlas from system context down to source, on Source For Atlas.',
      canonicalPath: '/r/burnt-sushi/ripgrep',
    });
    // One canonical per atlas: the slug form the edge 301s to, without a pinned ref.
    const variants = ['/r/THISS/okie', '/r/thiss/OKIE', '/r/THISS/okie/v1.2/src'].map(path => pageMetaForPath(path));
    expect(new Set(variants.map(meta => meta.canonicalPath))).toEqual(new Set(['/r/thiss/okie']));
    expect(variants.map(meta => meta.title)).toEqual(['okie by THISS · Source For Atlas', 'OKIE by thiss · Source For Atlas', 'okie by THISS · Source For Atlas']);
    const tags = ['THISS/okie', 'thiss/OKIE'].map(name => {
      const [owner, repo] = name.split('/') as [string, string];
      return buildOpenGraphTags({ owner, repo, search: '', origin: 'https://sourcefor.dev' });
    });
    tags.push(buildOpenGraphTags({ owner: 'THISS', repo: 'okie', ref: 'v1.2', search: '', origin: 'https://sourcefor.dev' }));
    expect(new Set(tags.map(tag => tag.canonical))).toEqual(new Set(['https://sourcefor.dev/r/thiss/okie']));
    expect(pageMetaForPath('/operator').title).toBe('Operator review · Source For Atlas');
    // Unknown paths and malformed escapes read as the home page, never throw.
    expect(pageMetaForPath('/r/%E0%A4%A/x').title).toBe(HOME_TITLE);
    expect(pageMetaForPath('/whatever').title).toBe(HOME_TITLE);
    for (const path of ['/', '/new', '/r/acme/app', '/operator']) {
      expect(JSON.stringify(pageMetaForPath(path))).not.toMatch(/okie/i);
    }
  });

  it('sets document.title, the description and a production canonical in the browser', () => {
    const { doc, children } = fakeDocument();
    applyPageMeta(doc, '/r/acme/app');
    expect(doc.title).toBe('app by acme · Source For Atlas');
    expect(children.find(el => el.attrs.name === 'description')?.attrs.content).toMatch(/acme\/app/);
    expect(children.find(el => el.attrs.rel === 'canonical')?.attrs.href).toBe('https://sourcefor.dev/r/acme/app');
    // Idempotent: a second call updates in place.
    applyPageMeta(doc, '/new');
    expect(doc.title).toBe(LANDING_TITLE);
    expect(children).toHaveLength(2);
    expect(children.find(el => el.attrs.rel === 'canonical')?.attrs.href).toBe('https://sourcefor.dev/');
  });

  it('ships home-page meta, Open Graph and icons in the static index.html', () => {
    expect(indexHtml).not.toMatch(/okie/i);
    expect(indexHtml).toContain(`<title>${HOME_TITLE}</title>`);
    expect(indexHtml).toContain(`<meta name="description" content="${HOME_DESCRIPTION}" />`);
    expect(indexHtml).toContain(`<link rel="canonical" href="${CANONICAL_ORIGIN}/" />`);
    expect(indexHtml).toContain(`<meta property="og:image" content="${CANONICAL_ORIGIN}${DEFAULT_OG_IMAGE_PATH}" />`);
    expect(indexHtml).toContain(`<meta name="twitter:image" content="${CANONICAL_ORIGIN}${DEFAULT_OG_IMAGE_PATH}" />`);
    expect(indexHtml).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(indexHtml).toContain(`<meta property="og:url" content="${CANONICAL_ORIGIN}/" />`);
    for (const href of ['/favicon.svg', '/favicon-32.png', '/favicon-16.png', '/favicon.ico', '/apple-touch-icon.png']) {
      expect(indexHtml, href).toContain(`href="${href}"`);
      expect(existsSync(publicFile(href.slice(1))), href).toBe(true);
    }
  });

  it('ships real raster icons and a 1200×630 default card', () => {
    const png = (name: string) => new Uint8Array(readFileSync(publicFile(name)));
    expect(pngDimensions(png('og-default.png'))).toEqual({ width: 1200, height: 630 });
    expect(pngDimensions(png('favicon-32.png'))).toEqual({ width: 32, height: 32 });
    expect(pngDimensions(png('favicon-16.png'))).toEqual({ width: 16, height: 16 });
    const touch = png('apple-touch-icon.png');
    expect(pngDimensions(touch)).toEqual({ width: 180, height: 180 });
    expect(touch[25], 'apple-touch-icon is opaque RGB (PNG colour type 2)').toBe(2);
    const ico = readFileSync(publicFile('favicon.ico'));
    expect([...ico.subarray(0, 4)], 'favicon.ico is an ICO, not an SVG').toEqual([0, 0, 1, 0]);
    expect(ico.readUInt16LE(4)).toBeGreaterThanOrEqual(2);
  });

  it('serves /new to crawlers with landing meta and the default card on the trusted origin', async () => {
    expect(isPublicAtlasRoutePath('/new')).toBe(true);
    const result = await handlePublicAtlasRoute({
      method: 'GET',
      pathname: '/new',
      search: '',
      requestOrigin: 'https://staging.sourcefor.dev',
      allowedOrigins: ['https://staging.sourcefor.dev'],
      isPublicAtlas: () => false,
      indexHtml: async () => indexHtml,
    });
    expect(result?.status).toBe(200);
    const html = String(result?.body);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain(`<title>${LANDING_TITLE}</title>`);
    expect(html).toContain(`<meta name="description" content="${LANDING_DESCRIPTION}" />`);
    expect(html).toContain('<meta property="og:image" content="https://staging.sourcefor.dev/og-default.png" />');
    expect(html).toContain('<meta property="og:url" content="https://staging.sourcefor.dev/" />');
    // Staging canonicalizes to production; the home page's canonical is replaced, not duplicated.
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html).toContain('<link rel="canonical" href="https://sourcefor.dev/" />');
    expect(html).not.toContain(`<title>${HOME_TITLE}`);
    expect(html).not.toContain(HOME_DESCRIPTION);
    expect(html).not.toContain('oembed');
    expect(html).toContain('<script type="module" src="/src/main.tsx"></script>');
  });

  it('never puts an unallowlisted Host into /new meta', () => {
    const forged = handleLandingHtmlRequest({ method: 'GET', requestOrigin: 'https://evil.example', indexHtml, allowedOrigins: [] });
    expect(forged.status).toBe(200);
    expect(String(forged.body)).not.toContain('evil.example');
    expect(String(forged.body)).toContain('<meta property="og:image" content="https://sourcefor.dev/og-default.png" />');
    const head = handleLandingHtmlRequest({ method: 'HEAD', requestOrigin: 'https://sourcefor.dev', indexHtml, allowedOrigins: ['https://sourcefor.dev'] });
    expect(head.body).toBe('');
    expect(handleLandingHtmlRequest({ method: 'POST', requestOrigin: 'https://sourcefor.dev', indexHtml }).status).toBe(405);
  });
});

describe('portable viewer shell (CLA-318)', () => {
  it('drops the hosted canonical, og:* and twitter:* tags and adds the portable marker', async () => {
    const scriptUrl = new URL('../../../scripts/portable-html.mjs', import.meta.url).href;
    const { portableIndexHtml } = await import(/* @vite-ignore */ scriptUrl) as { portableIndexHtml(html: string): string };
    const html = portableIndexHtml(indexHtml);
    expect(html).not.toMatch(/rel="canonical"|property="og:|name="twitter:|sourcefor\.dev/);
    expect(html).toContain('<meta name="okie-portable" content="true">');
    // Web Analytics is injected by the sourcefor.dev edge only: the shell (and so the portable viewer) never carries it.
    expect(indexHtml).not.toMatch(/cloudflareinsights|data-cf-beacon/);
    expect(html).not.toMatch(/cloudflareinsights|data-cf-beacon/);
    expect(html).toContain(`<title>${HOME_TITLE}</title>`);
    expect(html).toContain('<link rel="icon" href="/favicon.svg"');
    expect(html).toContain('<script type="module" src="/src/main.tsx"></script>');
    const script = readFileSync(new URL('../../../scripts/build-portable-viewer.mjs', import.meta.url), 'utf8');
    expect(script).toContain('portableIndexHtml(');
  });
});
