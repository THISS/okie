import { describe, expect, it } from 'vitest';
import { AccessChallengeError, accessChallengeMessage, accessHeaders, isAccessChallenge, redactHeaderValues, smokeRequester } from '../scripts/smokeAccess.mjs';

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

  it('refuses a value that fetch would quote in its error (a line break from .env), naming the key only', () => {
    for (const bad of ['abc\ndef-SECRET', 'abc\rdef-SECRET', 'abc def-SECRET', 'abc\u0000def-SECRET']) {
      const result = accessHeaders('staging', { STAGING_ACCESS_CLIENT_ID: 'id.access', STAGING_ACCESS_CLIENT_SECRET: bad });
      expect(result.error).toMatch(/^STAGING_ACCESS_CLIENT_SECRET contains characters not allowed/);
      expect(result.error).not.toContain('SECRET-');
      expect(result.error).not.toContain('def-SECRET');
    }
    expect(accessHeaders('staging', { STAGING_ACCESS_CLIENT_ID: 'bad\nid', STAGING_ACCESS_CLIENT_SECRET: 'ok' }).error).toMatch(/^STAGING_ACCESS_CLIENT_ID /);
  });

  it('requests without following redirects, with the headers, and stops on the Access login', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const answers = [new Response('home'), redirect('https://sourcefor.cloudflareaccess.com/cdn-cgi/access/login/staging.sourcefor.dev')];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return answers.shift()!;
    }) as unknown as typeof fetch;
    const headers = { 'CF-Access-Client-Id': 'id.access', 'CF-Access-Client-Secret': 'shh' };
    const get = smokeRequester({ origin: 'https://staging.sourcefor.dev', headers, fetch: fakeFetch });
    expect(await (await get('/')).text()).toBe('home');
    const denied = get('/new', 'HEAD');
    await expect(denied).rejects.toBeInstanceOf(AccessChallengeError);
    await expect(denied).rejects.toThrow('rejected the service token');
    expect(calls.map(call => [call.url, call.init.method, call.init.redirect, call.init.headers])).toEqual([
      ['https://staging.sourcefor.dev/', 'GET', 'manual', headers],
      ['https://staging.sourcefor.dev/new', 'HEAD', 'manual', headers],
    ]);
  });

  it('permits the expected signed-out Ask 401 while preserving Access redirect detection', async () => {
    let request: RequestInit | undefined;
    const answers = [new Response(null, { status: 401 }), redirect('https://sourcefor.cloudflareaccess.com/cdn-cgi/access/login/staging.sourcefor.dev')];
    const get = smokeRequester({ origin: 'https://staging.sourcefor.dev', headers: {}, fetch: (async (_url, init) => {
      request = init;
      return answers.shift()!;
    }) as typeof fetch });
    expect((await get('/api/ask', 'POST', { allowUnauthorized: true, headers: { origin: 'https://staging.sourcefor.dev' }, body: '{}' })).status).toBe(401);
    expect(request).toMatchObject({ method: 'POST', body: '{}', redirect: 'manual', headers: { origin: 'https://staging.sourcefor.dev' } });
    await expect(get('/api/ask', 'POST', { allowUnauthorized: true })).rejects.toBeInstanceOf(AccessChallengeError);
  });

  it('redacts header values from printed errors', () => {
    expect(redactHeaderValues('bad value "shh-123" here', { 'CF-Access-Client-Secret': 'shh-123' })).toBe('bad value "[redacted]" here');
    expect(redactHeaderValues('nothing to hide', {})).toBe('nothing to hide');
  });

  it('recognises the Access login redirect and Access denials', () => {
    expect(isAccessChallenge(redirect('https://atlas.cloudflareaccess.com/cdn-cgi/access/login/staging.sourcefor.dev?kid=x'))).toBe(true);
    expect(isAccessChallenge(redirect('/cdn-cgi/access/login/staging.sourcefor.dev', 303))).toBe(true);
    // The app's "401 Response for Service Auth policies" option answers 401 instead of redirecting.
    expect(isAccessChallenge(new Response(null, { status: 401 }))).toBe(true);
    // Assumed shape (not observed live): a 403 that names the Access domain.
    expect(isAccessChallenge(new Response('Forbidden', { status: 403, headers: { 'cf-access-domain': 'staging.sourcefor.dev' } }))).toBe(true);
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
