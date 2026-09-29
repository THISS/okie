// Cloudflare Access helpers for the smoke checks (CLA-318). Pure (no Node imports) so the edge tests can
// run them in workerd. staging.sourcefor.dev sits behind Cloudflare Access; the smoke checks get through
// with the `atlas-staging-smoke` service token, read from STAGING_ACCESS_CLIENT_ID /
// STAGING_ACCESS_CLIENT_SECRET. Never log the values, only the key names.

export const ACCESS_CLIENT_ID_KEY = 'STAGING_ACCESS_CLIENT_ID';
export const ACCESS_CLIENT_SECRET_KEY = 'STAGING_ACCESS_CLIENT_SECRET';

/**
 * The service-token headers for `target`, or an error naming the key that is missing.
 * Only staging sends them: production is public, and the token must never leave for another host.
 * @param {'staging' | 'production'} target
 * @param {Record<string, string | undefined>} env
 * @returns {{ headers: Record<string, string>, error?: undefined } | { headers?: undefined, error: string }}
 */
export function accessHeaders(target, env) {
  if (target !== 'staging') return { headers: {} };
  const id = env[ACCESS_CLIENT_ID_KEY]?.trim();
  const secret = env[ACCESS_CLIENT_SECRET_KEY]?.trim();
  if (!id && !secret) return { headers: {} };
  if (!id || !secret) {
    const missing = id ? ACCESS_CLIENT_SECRET_KEY : ACCESS_CLIENT_ID_KEY;
    return { error: `${missing} is not set (set both ${ACCESS_CLIENT_ID_KEY} and ${ACCESS_CLIENT_SECRET_KEY}, or neither)` };
  }
  // A value fetch rejects (CR, LF, NUL…) would be quoted whole in its error: refuse it here, by key name.
  for (const [key, value] of [[ACCESS_CLIENT_ID_KEY, id], [ACCESS_CLIENT_SECRET_KEY, secret]]) {
    if (!HEADER_VALUE.test(value)) return { error: `${key} contains characters not allowed in an HTTP header (check .env for a line break or stray quote)` };
  }
  return { headers: { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret } };
}

/** Service-token ids and secrets are printable ASCII without spaces. */
const HEADER_VALUE = /^[\x21-\x7E]+$/;

/** Thrown when Access answers instead of the site; its message names keys only. */
export class AccessChallengeError extends Error {}

/**
 * A GET/HEAD against `origin` that never follows redirects, so an Access redirect is seen on every request
 * (and the token never goes to another host). Throws AccessChallengeError when Access answers.
 * @param {{ origin: string, headers: Record<string, string>, fetch?: typeof fetch }} options
 * @returns {(path: string, method?: 'GET' | 'HEAD') => Promise<Response>}
 */
export function smokeRequester({ origin, headers, fetch: fetchImpl = fetch }) {
  const sentToken = Object.keys(headers).length > 0;
  return async (path, method = 'GET') => {
    const response = await fetchImpl(`${origin}${path}`, { method, redirect: 'manual', headers });
    if (isAccessChallenge(response)) throw new AccessChallengeError(accessChallengeMessage(sentToken));
    return response;
  };
}

/**
 * Replaces any header value in `text` (a caught error message) with a placeholder, as a second guard.
 * @param {string} text
 * @param {Record<string, string>} headers
 */
export function redactHeaderValues(text, headers) {
  let out = text;
  for (const value of Object.values(headers)) if (value) out = out.split(value).join('[redacted]');
  return out;
}

/**
 * True when a response is Cloudflare Access turning the request away. Without a token, and with a
 * rejected one, Access redirects to the team's `*.cloudflareaccess.com/cdn-cgi/access/login/...`; with the
 * app's "401 Response for Service Auth policies" option on, it answers 401 instead. A 403 counts only when
 * it names an Access domain (`cf-access-domain`, an assumption: not observed live).
 * @param {{ status: number, headers: { get(name: string): string | null } }} response
 */
export function isAccessChallenge(response) {
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) return false;
    let url;
    try {
      url = new URL(location, 'https://origin.invalid');
    } catch {
      return false;
    }
    const host = url.hostname.toLowerCase();
    return host.endsWith('.cloudflareaccess.com') || url.pathname.startsWith('/cdn-cgi/access/');
  }
  // 401: Access's "401 Response for Service Auth policies" option. The site never answers 401 on a smoke route.
  if (response.status === 401) return true;
  if (response.status === 403) return response.headers.get('cf-access-domain') !== null;
  return false;
}

/**
 * The one-line error for an Access challenge. Names keys only.
 * @param {boolean} sentToken whether the request carried the service-token headers
 */
export function accessChallengeMessage(sentToken) {
  return sentToken
    ? `staging answered with the Cloudflare Access login: it rejected the service token from ${ACCESS_CLIENT_ID_KEY} / ${ACCESS_CLIENT_SECRET_KEY}. Check the token is current and the app has a Service Auth policy for atlas-staging-smoke (docs/deploy/cloudflare-runbook.md).`
    : `staging is behind Cloudflare Access and answered with its login. Set ${ACCESS_CLIENT_ID_KEY} and ${ACCESS_CLIENT_SECRET_KEY} (the atlas-staging-smoke service token) in the repo-root .env (docs/deploy/cloudflare-runbook.md).`;
}
