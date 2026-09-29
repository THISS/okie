import { describe, expect, it } from 'vitest';
import { accessChallengeMessage, accessHeaders, isAccessChallenge } from '../scripts/smokeAccess.mjs';

const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } });

describe('smoke checks behind Cloudflare Access (CLA-318)', () => {
  it('sends the service token to staging only, when both keys are set', () => {
    const env = { STAGING_ACCESS_CLIENT_ID: 'id.access', STAGING_ACCESS_CLIENT_SECRET: 'shh' };
    expect(accessHeaders('staging', env)).toEqual({ headers: { 'CF-Access-Client-Id': 'id.access', 'CF-Access-Client-Secret': 'shh' } });
    expect(accessHeaders('production', env)).toEqual({ headers: {} });
    expect(accessHeaders('staging', {})).toEqual({ headers: {} });
    expect(accessHeaders('staging', { STAGING_ACCESS_CLIENT_ID: '  ', STAGING_ACCESS_CLIENT_SECRET: '' })).toEqual({ headers: {} });
  });

  it('names the missing key, never a value, when only one is set', () => {
    const onlyId = accessHeaders('staging', { STAGING_ACCESS_CLIENT_ID: 'id.access' });
    expect(onlyId.error).toMatch(/^STAGING_ACCESS_CLIENT_SECRET is not set/);
    expect(onlyId.error).not.toContain('id.access');
    const onlySecret = accessHeaders('staging', { STAGING_ACCESS_CLIENT_SECRET: 'shh' });
    expect(onlySecret.error).toMatch(/^STAGING_ACCESS_CLIENT_ID is not set/);
    expect(onlySecret.error).not.toContain('shh');
  });

  it('recognises the Access login redirect and Access denials', () => {
    expect(isAccessChallenge(redirect('https://atlas.cloudflareaccess.com/cdn-cgi/access/login/staging.sourcefor.dev?kid=x'))).toBe(true);
    expect(isAccessChallenge(redirect('/cdn-cgi/access/login/staging.sourcefor.dev', 303))).toBe(true);
    expect(isAccessChallenge(new Response('Forbidden', { status: 403, headers: { 'cf-access-domain': 'staging.sourcefor.dev' } }))).toBe(true);
    expect(isAccessChallenge(new Response(null, { status: 401, headers: { 'www-authenticate': 'Cloudflare-Access realm="x"' } }))).toBe(true);
  });

  it("leaves the site's own redirects and errors alone", () => {
    expect(isAccessChallenge(redirect('/', 301))).toBe(false);
    expect(isAccessChallenge(redirect('https://sourcefor.dev/r/burnt-sushi/ripgrep', 301))).toBe(false);
    expect(isAccessChallenge(redirect('https://evil.example/cloudflareaccess.com'))).toBe(false);
    expect(isAccessChallenge(redirect('https://notcloudflareaccess.com/'))).toBe(false);
    expect(isAccessChallenge(new Response('nope', { status: 404 }))).toBe(false);
    expect(isAccessChallenge(new Response('nope', { status: 403 }))).toBe(false);
    expect(isAccessChallenge(new Response('ok'))).toBe(false);
  });

  it('points at the right fix in the error, by key name', () => {
    expect(accessChallengeMessage(false)).toContain('Set STAGING_ACCESS_CLIENT_ID and STAGING_ACCESS_CLIENT_SECRET');
    expect(accessChallengeMessage(true)).toContain('rejected the service token');
  });
});
