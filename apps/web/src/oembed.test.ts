import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  OEMBED_DEFAULT_HEIGHT,
  OEMBED_DEFAULT_WIDTH,
  OEMBED_JSON_TYPE,
  OEMBED_PATH,
  buildOembedRichResponse,
  handleOembedRequest,
  installPublicAtlasOembedDiscovery,
  oembedRequestOrigin,
  parsePublicAtlasOembedUrl,
  publicAtlasOembedHref,
} from './oembed';

const ORIGIN = 'http://localhost:4173';
const DOGFOOD = `${ORIGIN}/r/THISS/okie`;

function request(query: string, method = 'GET', origin = ORIGIN) {
  return handleOembedRequest({
    method,
    requestOrigin: origin,
    searchParams: new URLSearchParams(query.startsWith('?') ? query.slice(1) : query),
  });
}

describe('oEmbed for public atlas URLs (CLA-30)', () => {
  it('parses /r/THISS/okie on this origin and rejects everything else', () => {
    expect(parsePublicAtlasOembedUrl(DOGFOOD, ORIGIN)).toEqual({
      owner: 'THISS',
      repo: 'okie',
      search: '',
    });
    expect(parsePublicAtlasOembedUrl(`${ORIGIN}/r/THISS/okie/v1?nav=1`, ORIGIN)).toEqual({
      owner: 'THISS',
      repo: 'okie',
      ref: 'v1',
      search: '?nav=1',
    });
    expect(parsePublicAtlasOembedUrl(`${ORIGIN}/new`, ORIGIN)).toBeUndefined();
    expect(parsePublicAtlasOembedUrl(`${ORIGIN}/`, ORIGIN)).toBeUndefined();
    expect(parsePublicAtlasOembedUrl('javascript:alert(1)', ORIGIN)).toBeUndefined();
    expect(parsePublicAtlasOembedUrl('https://evil.example/r/THISS/okie', ORIGIN)).toBeUndefined();
    expect(parsePublicAtlasOembedUrl('http://user:pass@localhost:4173/r/THISS/okie', ORIGIN)).toBeUndefined();
    expect(parsePublicAtlasOembedUrl(`${ORIGIN}/r/THISS/okie/<script>`, ORIGIN)).toBeUndefined();
  });

  it('treats localhost and 127.0.0.1 as the same loopback atlas host', () => {
    expect(parsePublicAtlasOembedUrl('http://127.0.0.1:4173/r/THISS/okie', ORIGIN)?.owner).toBe('THISS');
  });

  it('returns a rich iframe payload for the dogfood public view (no login wall)', () => {
    const result = request(`url=${encodeURIComponent(DOGFOOD)}&format=json`);
    expect(result.status).toBe(200);
    expect(result.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(result.headers['access-control-allow-origin']).toBe('*');
    const body = JSON.parse(result.body) as ReturnType<typeof buildOembedRichResponse>;
    expect(body.version).toBe('1.0');
    expect(body.type).toBe('rich');
    expect(body.provider_name).toBe('Okie');
    expect(body.title).toBe('THISS/okie architecture atlas');
    expect(body.width).toBe(OEMBED_DEFAULT_WIDTH);
    expect(body.height).toBe(OEMBED_DEFAULT_HEIGHT);
    expect(body.html).toContain(`src="${DOGFOOD}"`);
    expect(body.html).toMatch(/^<iframe /);
    expect(body.html).not.toMatch(/login|signin|oauth|authorize/i);
    expect(JSON.stringify(body)).not.toMatch(/apiKey|OPENROUTER|GITHUB_TOKEN|GH_TOKEN|gho_|ghp_/);
  });

  it('rebuilds the iframe src from the request origin, not a foreign host', () => {
    const result = request(`url=${encodeURIComponent('https://evil.example/r/THISS/okie')}`);
    expect(result.status).toBe(404);
    expect(result.body).not.toContain('evil.example');
  });

  it('rejects missing, xml, and non-atlas URLs', () => {
    expect(request('').status).toBe(400);
    expect(request(`url=${encodeURIComponent(DOGFOOD)}&format=xml`).status).toBe(501);
    expect(request(`url=${encodeURIComponent(`${ORIGIN}/new`)}`).status).toBe(404);
    expect(request(`url=${encodeURIComponent(DOGFOOD)}`, 'POST').status).toBe(405);
    expect(request('', 'OPTIONS').status).toBe(204);
  });

  it('honors maxwidth without growing past the default', () => {
    const result = request(`url=${encodeURIComponent(DOGFOOD)}&maxwidth=400`);
    const body = JSON.parse(result.body) as { width: number; height: number; html: string };
    expect(body.width).toBe(400);
    expect(body.height).toBe(280);
    expect(body.html).toContain('width="400"');
  });

  it('builds a discovery href on the web origin', () => {
    expect(publicAtlasOembedHref(DOGFOOD)).toBe(
      `${ORIGIN}${OEMBED_PATH}?url=${encodeURIComponent(DOGFOOD)}&format=json`,
    );
  });

  it('installs an application/json+oembed link tag', () => {
    const attrs = new Map<string, string>();
    const link = { setAttribute(name: string, value: string) { attrs.set(name, value); } };
    const head = {
      querySelector: () => null,
      appendChild: () => undefined,
    };
    installPublicAtlasOembedDiscovery(DOGFOOD, head, () => link);
    expect(attrs.get('rel')).toBe('alternate');
    expect(attrs.get('type')).toBe(OEMBED_JSON_TYPE);
    expect(attrs.get('href')).toBe(publicAtlasOembedHref(DOGFOOD));
  });

  it('derives the atlas origin from Host, never a scan-process bind', () => {
    expect(oembedRequestOrigin({ host: 'localhost:4173' })).toBe('http://localhost:4173');
    expect(oembedRequestOrigin({
      host: '127.0.0.1:4180',
      'x-forwarded-host': 'localhost:4173',
      'x-forwarded-proto': 'https',
    })).toBe('https://localhost:4173');
  });

  it('wires discovery into the public /r boot path and serves /oembed from Vite', () => {
    const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
    expect(main).toContain('installPublicAtlasOembedDiscovery');
    const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');
    expect(viteConfig).toContain('okieOembedPlugin');
    expect(viteConfig).toContain(OEMBED_PATH);
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
      rewrites: Array<{ source: string; destination: string }>;
    };
    expect(vercel.rewrites).toEqual(expect.arrayContaining([
      { source: '/oembed', destination: '/api/oembed' },
    ]));
    const fn = readFileSync(new URL('../api/oembed.ts', import.meta.url), 'utf8');
    expect(fn).toContain('handleOembedRequest');
    expect(fn).not.toMatch(/apiKey|OPENROUTER_API_KEY|GITHUB_TOKEN|GH_TOKEN/);
  });
});
