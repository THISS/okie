import { ACCOUNT_PAGE_STYLE } from './accountPage';
import { escapeHtml } from './homePage';
import { siteBrandLinkHtml, siteFooterHtml } from './notFoundPage';
import { trustedPageOrigin } from './openGraph';
import { formatPolicyDate, LEGAL_PAGE_STYLE, privacyInlineHtml, SITE_OPERATOR } from './privacyPage';
import { CANONICAL_ORIGIN, PRIVACY_PATH, SITE_NAME, TERMS_PATH, TERMS_VERSION } from './siteMeta';

/**
 * The terms of use (CLA-316), built like the privacy page (privacyPage.ts): the words in one structure the
 * owner edits in place, the same inline markup (`code`, **bold**, [text](/site-path), [CONTACT_EMAIL]), the
 * same look. The operator is privacyPage.ts's SITE_OPERATOR (one line to fill in for both pages); while it
 * holds the pending marker, `deploy.mjs production` refuses to deploy. "Last updated" is TERMS_VERSION.
 */
export const TERMS_COPY = {
  title: 'Terms of use',
  lastUpdatedLead: 'Last updated',
  intro: [
    `These terms are an agreement between you and ${SITE_OPERATOR} ("we", "us") and cover your use of Source For Atlas at sourcefor.dev (the "Service"). By using the Service you agree to them. If you don’t agree, please don’t use it.`,
  ],
  sections: [
    {
      heading: 'What the Service is',
      blocks: [
        { kind: 'p', text: 'Source For Atlas publishes explorable architecture maps ("atlases") of public GitHub repositories. You can browse every atlas without an account.' },
      ],
    },
    {
      heading: 'Other people’s code',
      blocks: [
        { kind: 'p', text: 'Each atlas is generated from a public repository. The code, names and trademarks in it belong to its authors and remain under that repository’s own licence. Each atlas page shows the repository’s licence and a link back to its source. Our publishing an atlas doesn’t mean the authors endorse us, or that we endorse them. If you maintain a repository and want its atlas corrected or removed, email [CONTACT_EMAIL].' },
      ],
    },
    {
      heading: 'AI-generated explanations',
      blocks: [
        { kind: 'p', text: 'Some descriptions and summaries in the Service, and Ask’s answers, are generated with AI from the repository’s code. They can be incomplete or wrong. They aren’t professional, security or legal advice. Check the linked source before you rely on them.' },
      ],
    },
    {
      heading: 'Acceptable use',
      blocks: [
        { kind: 'p', text: 'Don’t:' },
        {
          kind: 'list',
          items: [
            'scrape or download the Service in bulk, or put load on it that degrades it for others;',
            'probe, attack, or try to get around the limits on the Service, including Ask and its usage caps;',
            'use the Service to break the law or anyone’s rights;',
            'misrepresent an atlas as the official documentation of a project.',
          ],
        },
        { kind: 'p', text: 'We may block access that breaks these rules.' },
      ],
    },
    {
      heading: 'Accounts',
      blocks: [
        { kind: 'p', text: `Signing in with GitHub is optional. You’re responsible for activity under your account. You can delete your account at any time from the Account page. We may suspend accounts used to break these terms. Our [Privacy](${PRIVACY_PATH}) page explains what we collect and why.` },
      ],
    },
    {
      heading: 'No warranty',
      blocks: [
        { kind: 'p', text: 'The Service is provided "as is" and "as available", without warranties of any kind, including that it will be accurate, uninterrupted or error-free.' },
        { kind: 'p', text: '**Australian Consumer Law.** Nothing in these terms excludes, restricts or modifies any guarantee, right or remedy you have under the Australian Consumer Law or any other law that can’t lawfully be excluded.' },
      ],
    },
    {
      heading: 'Limitation of liability',
      blocks: [
        { kind: 'p', text: 'To the maximum extent permitted by law, we aren’t liable for any indirect, incidental, special, consequential or punitive damages, or for loss of data, profits or goodwill. The Service is free, and our total liability for any claim relating to it is limited to AUD 100.' },
      ],
    },
    {
      heading: 'Changes',
      blocks: [
        { kind: 'p', text: 'We may update these terms. We’ll post changes here and update the date at the top. If you keep using the Service after a change, you accept the updated terms.' },
      ],
    },
    {
      heading: 'Governing law',
      blocks: [
        { kind: 'p', text: 'These terms are governed by the laws of Queensland, Australia. You agree to the non-exclusive jurisdiction of the courts of Queensland, Australia, to the extent permitted by law.' },
      ],
    },
    {
      heading: 'Contact',
      blocks: [
        { kind: 'p', text: 'Questions about these terms: [CONTACT_EMAIL]' },
      ],
    },
  ],
  description: 'The terms for using Source For Atlas: other people’s code, AI-generated explanations, acceptable use, accounts and liability.',
} as const satisfies TermsCopy;

type TermsBlock = { kind: 'p'; text: string } | { kind: 'list'; items: readonly string[] };
type TermsCopy = {
  title: string;
  lastUpdatedLead: string;
  intro: readonly string[];
  sections: ReadonlyArray<{ heading: string; blocks: readonly TermsBlock[] }>;
  description: string;
};

/** As for the privacy page: the canonical link follows the request origin when the deployment owns it (OKIE_PUBLIC_ORIGIN). */
export type TermsPageInput = { requestOrigin?: string; allowedOrigins?: readonly string[] };

export const TERMS_CACHE_CONTROL = 'public, max-age=300';

function blockHtml(block: TermsBlock): string {
  if (block.kind === 'p') return `<p>${privacyInlineHtml(block.text)}</p>`;
  return `<ul>${block.items.map(item => `<li>${privacyInlineHtml(item)}</li>`).join('')}</ul>`;
}

export function termsPageHtml(input: TermsPageInput = {}): string {
  const copy = TERMS_COPY;
  const canonical = new URL(TERMS_PATH, trustedPageOrigin(input.requestOrigin ?? '', input.allowedOrigins) ?? CANONICAL_ORIGIN).href;
  const sections = copy.sections.map((section, index) => `<section aria-labelledby="terms-${index}">
        <h2 id="terms-${index}">${escapeHtml(section.heading)}</h2>
        ${section.blocks.map(blockHtml).join('\n        ')}
      </section>`);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>${escapeHtml(copy.title)} · ${SITE_NAME}</title>
    <meta name="description" content="${escapeHtml(copy.description)}" />
    <link rel="canonical" href="${escapeHtml(canonical)}" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <style>${ACCOUNT_PAGE_STYLE}${LEGAL_PAGE_STYLE}</style>
  </head>
  <body>
    <main data-terms="true">
      ${siteBrandLinkHtml('brand')}
      <article>
      <h1>${escapeHtml(copy.title)}</h1>
      <p class="updated">${escapeHtml(copy.lastUpdatedLead)} <time datetime="${escapeHtml(TERMS_VERSION)}">${escapeHtml(formatPolicyDate(TERMS_VERSION))}</time></p>
      ${copy.intro.map(text => `<p>${privacyInlineHtml(text)}</p>`).join('\n      ')}
      ${sections.join('\n      ')}
      </article>
      <p class="help"><a href="/">Back to the home page</a></p>
    </main>
    ${siteFooterHtml()}
  </body>
</html>
`;
}

export type TermsHttpOutput = { status: 200; headers: Record<string, string>; body: string };

/** GET/HEAD; HEAD gets the headers only. Shared-cacheable: nothing on it depends on the visitor. */
export function termsHttpOutput(method: string, input: TermsPageInput = {}): TermsHttpOutput {
  return {
    status: 200,
    headers: { 'cache-control': TERMS_CACHE_CONTROL, 'content-type': 'text/html; charset=utf-8' },
    body: method.toUpperCase() === 'HEAD' ? '' : termsPageHtml(input),
  };
}
