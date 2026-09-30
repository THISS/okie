import { escapeHtml } from './homePage';
import { SITE_FOOTER_CSS, siteBrandLinkHtml, siteFooterHtml } from './notFoundPage';
import { CONTACT_EMAIL, SITE_NAME } from './siteMeta';

/**
 * `/account` on sourcefor.dev (CLA-316): who you are signed in as, the email we hold (GitHub's primary
 * verified address, or none), the product-updates opt-in and account deletion. One self-contained HTML
 * document like the 404 page: inline CSS, no script (the CSP forbids inline scripts), no external
 * resources, plain HTML forms that POST to the edge Worker. Runtime-agnostic (no DOM, no Node).
 *
 * The opt-in checkbox is unticked unless the stored value is opted in: signing in never implies consent.
 * `welcome` is the variant shown once, straight after a first sign-in: the same checkbox with a
 * "Continue" button that saves and returns to where sign-in started.
 */

export type AccountPageInput = {
  login: string;
  email: string | null;
  productUpdatesOptIn: boolean;
  /** First sign-in: the "You're signed in" variant, returning to `returnTo` on Continue. */
  welcome?: boolean;
  /** A safe same-origin path (the caller sanitizes it). */
  returnTo?: string;
  /** `?saved=1`: the preferences were just saved. */
  saved?: boolean;
  /** `?delete=confirm`: a delete was submitted without ticking the confirmation. */
  deleteNeedsConfirm?: boolean;
};

export const ACCOUNT_CACHE_CONTROL = 'private, no-store';
export const PRODUCT_UPDATES_LABEL = 'Email me occasional product updates';
export const NO_EMAIL_COPY = 'Your GitHub account has no verified primary email, so we don’t have one on file.';

const STYLE = `
      *{box-sizing:border-box}
      html,body{margin:0;min-height:100%;background:#070a0b;color:#eef4f2}
      body{font:16px/1.6 "IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
      main{max-width:640px;margin:0 auto;padding:3.5rem 1rem 2rem}
      .brand{display:inline-flex;align-items:center;gap:.6rem;margin-bottom:2rem;color:#f1f7f4;text-decoration:none;letter-spacing:-.02em}
      .brand strong{font-weight:600}.brand span span{color:#97a5a0}
      h1{margin:0 0 .5rem;font-size:1.8rem;line-height:1.25}
      h2{margin:0 0 .5rem;font-size:1.1rem}
      p{margin:0 0 .75rem;color:#b7c3c0}
      a{color:#79dfd4}
      section{margin-top:1.75rem;padding:1.25rem;border:1px solid #1d2a28;border-radius:10px;background:#0d1413}
      dl{display:grid;grid-template-columns:auto 1fr;gap:.35rem 1rem;margin:0}
      dt{color:#97a5a0}dd{margin:0;color:#eef4f2}
      form{margin:0}
      label.check{display:flex;align-items:flex-start;gap:.6rem;margin:.25rem 0 1rem;color:#eef4f2;cursor:pointer}
      label.check input{width:1.15rem;height:1.15rem;margin:.2rem 0 0;flex:none;accent-color:#d9ff70}
      button{min-height:44px;padding:.55rem 1.1rem;border:1px solid #d9ff70;border-radius:8px;background:#d9ff70;color:#0d1a17;font:inherit;font-weight:600;cursor:pointer}
      button:hover{border-color:#79dfd4;background:#79dfd4}
      button.danger{border-color:#ff8a80;background:transparent;color:#ff8a80}
      button.danger:hover{background:#2a1413}
      button:focus-visible,label.check input:focus-visible,a:focus-visible{outline:2px solid #79dfd4;outline-offset:2px}
      .notice{padding:.6rem .9rem;border:1px solid #2a3a37;border-radius:8px;color:#eef4f2}
      .notice.warn{border-color:#ff8a80}
      nav{display:flex;flex-wrap:wrap;gap:1rem;margin-top:1.75rem;font-size:.95rem}
      .help{margin-top:1.75rem}
      .site-footer{max-width:640px;margin:0 auto;padding:1.5rem 1rem 3rem;border-top:1px solid #1d2a28;font-size:.85rem;display:grid;gap:.4rem;color:#b7c3c0}
      .site-footer p{margin:0}
      .site-footer a{color:#79dfd4}
      ${SITE_FOOTER_CSS}
      @media (min-width:720px){main,.site-footer{padding-left:1.5rem;padding-right:1.5rem}}
    `;

function emailHtml(email: string | null): string {
  return email ? escapeHtml(email) : escapeHtml(NO_EMAIL_COPY);
}

function preferencesFormHtml(input: AccountPageInput): string {
  const checked = input.productUpdatesOptIn ? ' checked' : '';
  const returnField = input.welcome ? `\n          <input type="hidden" name="return" value="${escapeHtml(input.returnTo ?? '/')}" />` : '';
  return `<form method="post" action="/api/account/preferences" data-account-preferences>${returnField}
          <label class="check"><input type="checkbox" name="product_updates" value="1"${checked} /> <span>${PRODUCT_UPDATES_LABEL}</span></label>
          <button type="submit">${input.welcome ? 'Continue' : 'Save'}</button>
        </form>`;
}

export function accountPageHtml(input: AccountPageInput): string {
  const e = escapeHtml;
  const login = e(input.login);
  const welcome = input.welcome === true;
  const title = welcome ? `You’re signed in · ${SITE_NAME}` : `Your account · ${SITE_NAME}`;
  const notices = [
    input.saved && !welcome ? '<p class="notice" role="status" data-account-saved>Your preferences are saved.</p>' : '',
    input.deleteNeedsConfirm && !welcome ? '<p class="notice warn" role="alert" data-account-delete-confirm>Tick the confirmation box to delete your account.</p>' : '',
  ].filter(Boolean).join('\n      ');
  const body = welcome
    ? `<h1>You’re signed in</h1>
      <p>Signed in as <strong>@${login}</strong>. ${input.email ? `The email on file is <strong>${emailHtml(input.email)}</strong>, your GitHub primary address.` : emailHtml(null)}</p>
      <section aria-labelledby="updates-heading">
        <h2 id="updates-heading">Product updates</h2>
        <p>Off unless you tick it. You can change this any time on your account page.</p>
        ${preferencesFormHtml(input)}
      </section>`
    : `<h1>Your account</h1>
      ${notices}
      <section aria-labelledby="profile-heading">
        <h2 id="profile-heading">Signed in with GitHub</h2>
        <dl>
          <dt>GitHub</dt><dd data-account-login>@${login}</dd>
          <dt>Email</dt><dd data-account-email>${emailHtml(input.email)}</dd>
        </dl>
      </section>
      <section aria-labelledby="updates-heading">
        <h2 id="updates-heading">Product updates</h2>
        ${preferencesFormHtml(input)}
      </section>
      <section aria-labelledby="delete-heading">
        <h2 id="delete-heading">Delete my account</h2>
        <p>Deletes your account record (GitHub login, email and preferences) straight away and signs you out.</p>
        <form method="post" action="/api/account/delete" data-account-delete>
          <label class="check"><input type="checkbox" name="confirm" value="1" required /> <span>Yes, delete my account</span></label>
          <button class="danger" type="submit">Delete my account</button>
        </form>
      </section>
      <nav aria-label="More">
        <a href="/api/auth/logout?return=/">Sign out</a>
      </nav>`;
  return pageShell(title, welcome ? 'welcome' : 'account', body);
}

function pageShell(title: string, kind: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <meta name="color-scheme" content="dark" />
    <title>${title}</title>
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <style>${STYLE}</style>
  </head>
  <body>
    <main data-account="${kind}">
      ${siteBrandLinkHtml('brand')}
      ${body}
      <p class="help">Questions or requests about your data: <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>. <a href="/">Back to the home page</a></p>
    </main>
    ${siteFooterHtml()}
  </body>
</html>
`;
}

/** Where the session-ended page's link starts sign-in (back to /account afterwards). */
export const SIGN_IN_AGAIN_HREF = '/api/auth/github?return=%2Faccount';

/**
 * The answer to an account form POST without a valid session (expired, signed out elsewhere, deleted).
 * A page with a link rather than a redirect: the CSP's `form-action 'self'` would block a form
 * submission's redirect chain on to github.com.
 */
export function sessionEndedPageHtml(): string {
  return pageShell(`Session ended \u00b7 ${SITE_NAME}`, 'session-ended', `<h1>Your session has ended</h1>
      <p>Nothing was changed. Sign in again to manage your account.</p>
      <nav aria-label="Sign in">
        <a href="${SIGN_IN_AGAIN_HREF}">Sign in again</a>
      </nav>`);
}

export type AccountHttpOutput = { status: 200; headers: Record<string, string>; body: string };

/** The account page for GET/HEAD; HEAD gets the headers only. Never cached anywhere. */
export function accountHttpOutput(method: string, input: AccountPageInput): AccountHttpOutput {
  return {
    status: 200,
    headers: { 'cache-control': ACCOUNT_CACHE_CONTROL, 'content-type': 'text/html; charset=utf-8' },
    body: method.toUpperCase() === 'HEAD' ? '' : accountPageHtml(input),
  };
}
