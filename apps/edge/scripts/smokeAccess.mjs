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
  return { headers: { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret } };
}

/**
 * True when a response is Cloudflare Access turning the request away: a redirect to the team's
 * `*.cloudflareaccess.com` login, or Access's own 401/403 (it names itself in `cf-access-*` headers or
 * the `www-authenticate` realm).
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
  if (response.status === 401 || response.status === 403) {
    return response.headers.get('cf-access-domain') !== null || /cloudflare-access/i.test(response.headers.get('www-authenticate') ?? '');
  }
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
