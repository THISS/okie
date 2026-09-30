import type { CSSProperties } from 'react';
import { SourceForMark } from './icons';
import { NOT_FOUND_COPY, type NotFoundKind } from './notFoundPage';
import { ATLAS_LICENCE_NOTE, BRAND_NAME, CONTACT_EMAIL, CREDIT_LEAD, CREDIT_LINK_TEXT, CREDIT_REL, CREDIT_URL, GITHUB_REPO_URL, PRIVACY_PATH, PRODUCT_NAME, SITE_HOME_HREF, SITE_HOME_LABEL, SITE_NAME } from './siteMeta';

/**
 * Site footer / about (CLA-318) for the document-style pages (the `/new` landing, the in-app 404).
 * Same words as the static 404 page's footer (notFoundPage.ts siteFooterHtml). `id="about"` is the
 * target of the atlas attribution strip's "About" link.
 */

const footerStyle: CSSProperties = {
  maxWidth: '680px',
  margin: '0 auto',
  padding: '1.5rem 1.5rem 3rem',
  borderTop: '1px solid #1d2a28',
  display: 'grid',
  gap: '0.4rem',
  color: '#b7c3c0',
  fontFamily: 'IBM Plex Sans, ui-sans-serif, system-ui, sans-serif',
  fontSize: '0.85rem',
  lineHeight: 1.6,
  overflowWrap: 'anywhere',
};
const linkStyle: CSSProperties = { color: '#79dfd4' };
/** CLA-269 fine print: #97a5a0 on the #070a0b page ground is 7.76:1 (AA small text needs 4.5:1). Focus ring: app.css a:focus-visible. */
const creditStyle: CSSProperties = { margin: '0.35rem 0 0', color: '#97a5a0', fontSize: '0.72rem', lineHeight: 1.5 };
const creditLinkStyle: CSSProperties = { color: 'inherit', textDecoration: 'underline', textUnderlineOffset: '2px' };

export function SiteFooter() {
  return <footer aria-label={`About ${SITE_NAME}`} data-testid="site-footer" id="about" style={footerStyle}>
    <p style={{ margin: 0 }}>{ATLAS_LICENCE_NOTE}</p>
    <p style={{ margin: 0 }}>
      <a href={GITHUB_REPO_URL} rel="noopener noreferrer" style={linkStyle}>{SITE_NAME} on GitHub</a>
      {' · Contact '}
      <a href={`mailto:${CONTACT_EMAIL}`} style={linkStyle}>{CONTACT_EMAIL}</a>
      {' · '}
      <a data-testid="site-footer-privacy" href={PRIVACY_PATH} style={linkStyle}>Privacy</a>
    </p>
    <p className="site-credit" data-testid="site-credit" style={creditStyle}>
      {CREDIT_LEAD}<a href={CREDIT_URL} rel={CREDIT_REL} style={creditLinkStyle}>{CREDIT_LINK_TEXT}</a>
    </p>
  </footer>;
}

/** The brand mark + wordmark, linking home (CLA-269). */
export function SiteBrand({ size = 30 }: { size?: number }) {
  return <a aria-label={SITE_HOME_LABEL} data-testid="site-brand" href={SITE_HOME_HREF} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.6rem', color: '#f1f7f4', fontSize: '1rem', letterSpacing: '-0.02em', textDecoration: 'none' }}>
    <SourceForMark size={size}/>
    <span><strong style={{ fontWeight: 600 }}>{BRAND_NAME}</strong> <span style={{ color: '#97a5a0' }}>{PRODUCT_NAME}</span></span>
  </a>;
}

const buttonLink: CSSProperties = {
  padding: '0.55rem 1rem',
  border: '1px solid #2a3a37',
  borderRadius: '8px',
  color: '#eef4f2',
  fontWeight: 600,
  textDecoration: 'none',
};

/**
 * In-app 404 for a path the SPA does not route (main.tsx). The hosted edge and the Vite servers
 * already answer those with the static 404 page and a real status; this covers anything that still
 * reaches the shell (another static host, a client-side navigation).
 */
export function NotFoundScreen({ kind = 'page' }: { kind?: NotFoundKind }) {
  const copy = NOT_FOUND_COPY[kind];
  return <>
    <main data-not-found={kind} style={{ maxWidth: '680px', margin: '0 auto', padding: '4.5rem 1.5rem 2rem', color: '#eef4f2', fontFamily: 'IBM Plex Sans, ui-sans-serif, system-ui, sans-serif' }}>
      <div style={{ marginBottom: '2.5rem' }}><SiteBrand/></div>
      <p style={{ margin: '0 0 0.25rem', color: '#d9ff70', fontFamily: 'IBM Plex Mono, ui-monospace, monospace', fontSize: '0.8rem', fontWeight: 600, letterSpacing: '0.08em' }}>404</p>
      <h1 style={{ fontSize: '1.8rem', margin: '0 0 0.5rem' }}>{copy.heading}</h1>
      <p style={{ color: '#b7c3c0', lineHeight: 1.6, margin: 0 }}>{copy.body}</p>
      <nav aria-label="Where to next" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginTop: '1.75rem' }}>
        <a href="/" style={{ ...buttonLink, background: '#d9ff70', borderColor: '#d9ff70', color: '#0d1a17' }}>Browse published atlases</a>
      </nav>
    </main>
    <SiteFooter/>
  </>;
}
