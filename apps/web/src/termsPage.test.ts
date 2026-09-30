import { describe, expect, it } from 'vitest';
import privacySource from './privacyPage.ts?raw';
import { PRIVACY_COPY_PENDING, SITE_OPERATOR } from './privacyPage';
import { LEGAL_CONTACT_EMAIL as CONTACT_EMAIL, TERMS_VERSION } from './siteMeta';
import termsSource from './termsPage.ts?raw';
import { TERMS_COPY, termsHttpOutput, termsPageHtml } from './termsPage';

describe('CLA-316 terms page', () => {
  const html = termsPageHtml();

  it('renders the copy: last-updated date from TERMS_VERSION, every section, mailto links, no script', () => {
    expect(TERMS_VERSION).toBe('2026-09-30');
    expect(html).toContain('<h1>Terms of use</h1>');
    expect(html).toContain('<title>Terms of use · Source For Atlas</title>');
    expect(html).toContain('Last updated <time datetime="2026-09-30">30 September 2026</time>');
    expect(TERMS_COPY.sections.map(section => section.heading)).toEqual([
      'What the Service is',
      'Other people’s code',
      'AI-generated explanations',
      'Acceptable use',
      'Accounts',
      'No warranty',
      'Limitation of liability',
      'Changes',
      'Governing law',
      'Contact',
    ]);
    for (const section of TERMS_COPY.sections) expect(html).toContain(`>${section.heading}</h2>`);
    const mailto = `<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>`;
    expect(html).toContain(`want its atlas corrected or removed, email ${mailto}.`);
    expect(html).toContain(`<p>Questions about these terms: ${mailto}</p>`);
    expect(html).not.toContain('[CONTACT');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\ssrc="/);
    expect(html).not.toContain('noindex');
    expect(html).not.toContain('data-cookie-notice');
  });

  it('names the operator from the one SITE_OPERATOR constant (filled in: no pending marker left)', () => {
    expect(html).toContain(`<p>These terms are an agreement between you and ${SITE_OPERATOR} (&quot;we&quot;, &quot;us&quot;) and cover your use of Source For Atlas at sourcefor.dev (the &quot;Service&quot;).`);
    expect(SITE_OPERATOR).not.toContain(PRIVACY_COPY_PENDING);
    // The literal marker lives only in privacyPage.ts, which the deploy check searches (with termsPage.ts).
    expect(termsSource).not.toContain(PRIVACY_COPY_PENDING);
    expect(privacySource).not.toContain(PRIVACY_COPY_PENDING);
  });

  it('keeps the owner-approved wording: acceptable use as a list, ACL carve-out, liability excluded as far as the law allows (no dollar cap), Queensland law, a link to /privacy', () => {
    expect(html).toContain('<p>Don’t:</p>\n        <ul><li>scrape or download the Service in bulk, or put load on it that degrades it for others;</li>');
    expect(html).toContain('<li>misrepresent an atlas as the official documentation of a project.</li></ul>');
    expect(html).toContain('<strong>Australian Consumer Law.</strong> Nothing in these terms excludes');
    expect(html).toContain('<p>The Service is free. To the maximum extent permitted by law, we are not liable for any loss or damage arising from your use of, or inability to use, the Service, including indirect or consequential loss, lost data or lost profits.</p>');
    expect(html).toContain('<p>Where liability can’t be excluded (including under the Australian Consumer Law), our liability is limited, where the law allows, to supplying the Service again or paying the cost of having it supplied again.</p>');
    expect(html).not.toContain('AUD');
    expect(html).toContain('These terms are governed by the laws of Queensland, Australia.');
    expect(html).toContain('Our <a href="/privacy">Privacy</a> page explains what we collect and why.');
    expect(html).toContain('Each atlas page shows the repository’s licence and a link back to its source.');
  });

  it('canonicalizes to the request origin only when the deployment owns it, else production', () => {
    expect(html).toContain('<link rel="canonical" href="https://sourcefor.dev/terms" />');
    const at = (requestOrigin: string, allowedOrigins: string[]) => termsPageHtml({ requestOrigin, allowedOrigins });
    expect(at('https://staging.sourcefor.dev', ['https://staging.sourcefor.dev'])).toContain('<link rel="canonical" href="https://staging.sourcefor.dev/terms" />');
    expect(at('https://evil.example', ['https://staging.sourcefor.dev'])).toContain('<link rel="canonical" href="https://sourcefor.dev/terms" />');
    expect(at('http://localhost:8787', [])).toContain('<link rel="canonical" href="http://localhost:8787/terms" />');
  });

  it('is shared-cacheable for 5 minutes; HEAD has no body', () => {
    const head = termsHttpOutput('HEAD');
    expect(head.body).toBe('');
    expect(head.headers).toEqual({ 'cache-control': 'public, max-age=300', 'content-type': 'text/html; charset=utf-8' });
    expect(termsHttpOutput('GET').body).toBe(html);
  });
});
