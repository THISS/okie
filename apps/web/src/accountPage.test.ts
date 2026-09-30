import { describe, expect, it } from 'vitest';
import { ACCOUNT_CACHE_CONTROL, accountHttpOutput, accountPageHtml, NO_EMAIL_COPY, PRODUCT_UPDATES_LABEL } from './accountPage';
import { contentSecurityPolicy, securityHeadersFor } from './securityHeaders';
import { CONTACT_EMAIL } from './siteMeta';

describe('CLA-316 account page', () => {
  it('escapes every user value and never loads a script or an external resource', () => {
    const html = accountPageHtml({ login: '"><script>x</script>', email: '<i>@example.com', productUpdatesOptIn: false });
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('@&quot;&gt;&lt;script&gt;x&lt;/script&gt;');
    expect(html).toContain('&lt;i&gt;@example.com');
    expect(html).not.toMatch(/\ssrc="/);
    expect(html).toContain(`mailto:${CONTACT_EMAIL}`);
    expect(html).toContain('<meta name="robots" content="noindex" />');
  });

  it('leaves the product-updates box unticked unless opted in', () => {
    const unticked = accountPageHtml({ login: 'a', email: 'a@example.com', productUpdatesOptIn: false });
    expect(unticked).toContain(`<input type="checkbox" name="product_updates" value="1" /> <span>${PRODUCT_UPDATES_LABEL}</span>`);
    expect(accountPageHtml({ login: 'a', email: null, productUpdatesOptIn: true })).toContain('name="product_updates" value="1" checked />');
    expect(accountPageHtml({ login: 'a', email: null, productUpdatesOptIn: false })).toContain(NO_EMAIL_COPY);
  });

  it('welcome variant: Continue saves and returns; no delete form', () => {
    const html = accountPageHtml({ login: 'a', email: 'a@example.com', productUpdatesOptIn: false, welcome: true, returnTo: '/r/acme/app?x="1"' });
    expect(html).toContain('You’re signed in');
    expect(html).toContain('<input type="hidden" name="return" value="/r/acme/app?x=&quot;1&quot;" />');
    expect(html).toContain('>Continue</button>');
    expect(html).not.toContain('/api/account/delete');
  });

  it('is private, never cached, HEAD without a body, and gets the non-framable CSP (form-action self)', () => {
    const output = accountHttpOutput('HEAD', { login: 'a', email: null, productUpdatesOptIn: false });
    expect(output.body).toBe('');
    expect(output.headers['cache-control']).toBe(ACCOUNT_CACHE_CONTROL);
    expect(ACCOUNT_CACHE_CONTROL).toBe('private, no-store');
    const csp = securityHeadersFor('/account', output.headers['content-type'])['content-security-policy'];
    expect(csp).toBe(contentSecurityPolicy({ framable: false }));
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("frame-ancestors 'self'");
  });
});
