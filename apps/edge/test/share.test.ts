import { describe, expect, it } from 'vitest';
import { pngDimensions, pngSignatureOk } from '../../web/src/atlasCard';
import { canonicalHostRedirect } from '../src/index';
import { edgeFetch, seedAtlas } from './helpers';

const ORIGIN = 'http://127.0.0.1:4196';

describe('share pages at the edge', () => {
  it('injects Open Graph tags into the static index.html for a published slug', async () => {
    await seedAtlas({ slug: 'acme__shared', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    const response = await edgeFetch('/r/acme/shared');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await response.text();
    expect(html).toContain('<title>acme/shared architecture atlas</title>');
    expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/og/acme/shared" />`);
    expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/r/acme/shared" />`);
    expect(html).toContain('application/json+oembed');
    expect(html).toContain('/assets/index-abc123.js'); // the real shell, scripts intact
    expect(html).not.toContain('Atlas · Okie architecture');
    // WebMCP host headers on the HTML the Worker renders; framed views drop origin-keying.
    expect(response.headers.get('permissions-policy')).toBe('tools=(self)');
    expect(response.headers.get('origin-agent-cluster')).toBe('?1');
    const framed = await edgeFetch('/r/acme/shared', { init: { headers: { 'sec-fetch-dest': 'iframe' } } });
    expect(framed.headers.get('permissions-policy')).toBe('tools=(self)');
    expect(framed.headers.get('origin-agent-cluster')).toBeNull();
  });

  it('404s an unpublished slug with the generic body (dogfood THISS/okie is always public)', async () => {
    const response = await edgeFetch('/r/nobody/unpublished');
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Atlas not found');
    expect((await edgeFetch('/r/THISS/okie')).status).toBe(200);
    // A version written but not yet pointed to by latest.json is not public.
    await seedAtlas({ slug: 'acme__pending', versionId: 'v1', files: { 'snapshot.json': '{}' }, latest: false });
    expect((await edgeFetch('/r/acme/pending')).status).toBe(404);
  });

  it('only trusts the configured public origin (plus loopback)', async () => {
    await seedAtlas({ slug: 'acme__origin', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    const forged = await edgeFetch('https://evil.example/r/acme/origin');
    expect(forged.status).toBe(404);
    const prod = await edgeFetch('https://sourcefor.dev/r/acme/origin', { env: { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev' } });
    expect(prod.status).toBe(200);
    expect(await prod.text()).toContain('content="https://sourcefor.dev/og/acme/origin"');
  });

  it('renders the OG PNG in workerd (node:zlib via nodejs_compat)', async () => {
    await seedAtlas({ slug: 'acme__card', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    const response = await edgeFetch('/og/acme/card');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(pngSignatureOk(bytes)).toBe(true);
    expect(pngDimensions(bytes)).toEqual({ width: 1200, height: 630 });
    expect(response.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect((await edgeFetch('/og/nobody/unpublished')).status).toBe(404);
  });

  it('answers oEmbed JSON for a published atlas and 404s others', async () => {
    await seedAtlas({ slug: 'acme__embed', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    const response = await edgeFetch(`/oembed?url=${encodeURIComponent(`${ORIGIN}/r/acme/embed`)}&format=json`);
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ version: '1.0', type: 'rich', thumbnail_url: `${ORIGIN}/og/acme/embed` });
    expect(String(body.html)).toContain(`src="${ORIGIN}/r/acme/embed?embed=1"`);
    const miss = await edgeFetch(`/oembed?url=${encodeURIComponent(`${ORIGIN}/r/nobody/unpublished`)}`);
    expect(miss.status).toBe(404);
  });

  it('leaves everything else to static assets (SPA fallback for /new)', async () => {
    const landing = await edgeFetch('/new');
    expect(landing.status).toBe(200);
    expect(await landing.text()).toContain('<div id="root"></div>');
    const wasm = await edgeFetch('/assets/atlas_wasm_bg-abc123.wasm');
    expect(wasm.headers.get('content-type')).toBe('application/wasm');
  });

  it('301s www.<canonical host> to OKIE_PUBLIC_ORIGIN (same path + query) before anything else', async () => {
    const env = { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev' };
    for (const path of ['/', '/r/acme/shared?sel=x', '/scan/index.json', '/api/auth/me', '/og/acme/shared']) {
      const response = await edgeFetch(new Request(`https://www.sourcefor.dev${path}`), { env });
      expect(response.status, path).toBe(301);
      expect(response.headers.get('location'), path).toBe(`https://sourcefor.dev${path}`);
    }
    // The apex, other hosts and an unset origin are untouched.
    expect((await edgeFetch(new Request('https://sourcefor.dev/api/auth/me'), { env })).status).toBe(200);
    expect((await edgeFetch(new Request('https://www.example.com/api/auth/me'), { env })).status).toBe(200);
    expect((await edgeFetch(new Request('https://www.sourcefor.dev/api/auth/me'), { env: { OKIE_PUBLIC_ORIGIN: undefined } })).status).toBe(200);
    expect(canonicalHostRedirect(new URL('https://WWW.SourceFor.dev/x'), env)?.headers.get('location')).toBe('https://sourcefor.dev/x');
  });
});
