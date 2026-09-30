import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../../web/src/securityHeaders';
import { edgeFetch } from './helpers';

const ACCOUNTS = { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', SESSION_SIGNING_KEY: 'k'.repeat(32) };

describe('/terms at the edge (CLA-316)', () => {
  it('serves the terms with or without accounts: shared-cacheable, CSP, no script, no cookie notice', async () => {
    for (const env of [{}, ACCOUNTS]) {
      const response = await edgeFetch('https://sourcefor.dev/terms', { env });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('public, max-age=300');
      expect(response.headers.get('content-security-policy')).toBe(contentSecurityPolicy({ framable: false }));
      expect(response.headers.get('set-cookie')).toBeNull();
      const html = await response.text();
      expect(html).toContain('<h1>Terms of use</h1>');
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toContain('data-cookie-notice');
    }
    expect((await edgeFetch('/terms/')).status).toBe(200);
  });

  it('canonicalizes to the deployment\'s public origin (OKIE_PUBLIC_ORIGIN), else to production', async () => {
    const canonical = async (url: string, env: Record<string, string> = {}) =>
      /<link rel="canonical" href="([^"]*)" \/>/.exec(await (await edgeFetch(url, { env })).text())?.[1];
    expect(await canonical('https://sourcefor.dev/terms', { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev' })).toBe('https://sourcefor.dev/terms');
    expect(await canonical('https://staging.sourcefor.dev/terms', { OKIE_PUBLIC_ORIGIN: 'https://staging.sourcefor.dev' })).toBe('https://staging.sourcefor.dev/terms');
    expect(await canonical('https://sourcefor-atlas.example.workers.dev/terms', { OKIE_PUBLIC_ORIGIN: 'https://staging.sourcefor.dev' })).toBe('https://sourcefor.dev/terms');
    expect(await canonical('https://evil.example/terms/', { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev' })).toBe('https://sourcefor.dev/terms');
  });

  it('HEAD has no body; other methods fall through like any unknown path', async () => {
    const head = await edgeFetch('/terms', { init: { method: 'HEAD' } });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const post = await edgeFetch('/terms', { init: { method: 'POST' } });
    const unknown = await edgeFetch('/no-such-page', { init: { method: 'POST' } });
    expect(post.status).toBe(unknown.status);
  });

  it('is in the sitemap; the 404 footer and /privacy link it', async () => {
    expect(await (await edgeFetch('/sitemap.xml', { env: { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev' } })).text()).toContain('<loc>https://sourcefor.dev/terms</loc>\n    <lastmod>2026-09-30</lastmod>');
    const notFound = await edgeFetch('/no-such-page');
    expect(notFound.status).toBe(404);
    expect(await notFound.text()).toContain('<a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>');
    expect(await (await edgeFetch('/privacy')).text()).toContain('covered by our <a href="/terms">Terms of use</a>.');
  });
});
