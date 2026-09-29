import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadLandingSession, ScanLandingScreen, scanLandingChrome } from './scanLanding';
import { CONTACT_EMAIL, GITHUB_REPO_URL } from './siteMeta';

describe('scan landing hosted public mode (CLA-266)', () => {
  it('hides scanning, sign-in and operator chrome when /api/auth/me says mode "public"', () => {
    const chrome = scanLandingChrome({ mode: 'public' }, false);
    expect(chrome).toEqual({
      publicMode: true,
      heading: 'Explore how open-source software is built',
      showScanCard: false,
      showAuthStatus: false,
      publishedHeading: 'Published atlases',
    });
    expect(scanLandingChrome({ mode: 'public' }, true).showScanCard).toBe(false);
  });

  it('keeps the local operator landing unchanged otherwise', () => {
    expect(scanLandingChrome({}, false)).toMatchObject({ publicMode: false, heading: 'Map a repository', showScanCard: true, showAuthStatus: true });
    expect(scanLandingChrome({}, true).showAuthStatus).toBe(false);
    expect(scanLandingChrome(undefined, undefined)).toMatchObject({ publicMode: false, showScanCard: true, showAuthStatus: false, publishedHeading: 'Already mapped' });
  });

  it('never asks /api/operator/session in public mode (QA B4), still does elsewhere', async () => {
    const respond = (me: unknown) => vi.fn(async (url: RequestInfo | URL) => new Response(JSON.stringify(String(url) === '/api/auth/me' ? me : { operator: true }), { status: 200 }));
    const publicFetch = respond({ authenticated: false, mode: 'public' });
    expect(await loadLandingSession(publicFetch as unknown as typeof fetch)).toEqual({ auth: { authenticated: false, mode: 'public' }, operator: false });
    expect(publicFetch.mock.calls.map(call => String(call[0]))).toEqual(['/api/auth/me']);
    const operatorFetch = respond({ authenticated: true, login: 'octo' });
    expect((await loadLandingSession(operatorFetch as unknown as typeof fetch)).operator).toBe(true);
    expect(operatorFetch.mock.calls.map(call => String(call[0]))).toEqual(['/api/auth/me', '/api/operator/session']);
    const down = vi.fn(async () => { throw new Error('offline'); });
    expect(await loadLandingSession(down as unknown as typeof fetch)).toEqual({ auth: undefined, operator: false });
  });

  it('closes with the site footer (CLA-318): GitHub, contact, licence note', () => {
    const html = renderToStaticMarkup(createElement(ScanLandingScreen));
    expect(html).toContain('data-testid="site-footer"');
    expect(html).toContain(`href="${GITHUB_REPO_URL}"`);
    expect(html).toContain(CONTACT_EMAIL);
    expect(html).toContain('under its own licence');
  });
});
