import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';
import { budgetConfig, budgetGuard, clientRateLimitKey, defaultGuards, rateLimitGuard, turnstileGuard, utcDay } from '../src/guards';
import type { EdgeEnv } from '../src/env';
import { edgeEnv, edgeFetch, recordingBackend } from './helpers';

/** Ask on (the local/dev opt-in); staging/production and the code default are off. */
const ON = { ASK_ENABLED: '1' } as const;
const SHA = 'a'.repeat(40);

const ASK_BODY = JSON.stringify({ question: 'What is this?', atlas: { owner: 'acme', repo: 'app', commitSha: 'abc' } });

function post(headers: Record<string, string> = {}) {
  return { init: { method: 'POST', body: ASK_BODY, headers: { 'content-type': 'application/json', ...headers } } };
}

describe('/api at the edge', () => {
  it('answers /api/auth/me itself in public mode, with ask reflecting ASK_ENABLED', async () => {
    const { backend, seen } = recordingBackend();
    const response = await edgeFetch('/api/auth/me', { backend });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authenticated: false, mode: 'public', oauthConfigured: false, ask: false });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await (await edgeFetch('/api/auth/me', { backend, env: ON })).json()).toMatchObject({ ask: true });
    expect(await (await edgeFetch('/api/auth/me', { backend, env: { ASK_ENABLED: 'true' } })).json()).toMatchObject({ ask: false });
    expect(seen).toHaveLength(0);
  });

  it('browse-only (ASK_ENABLED unset or "0"): Ask status at the edge, every other Ask/block-plan route 404', async () => {
    const { backend, seen } = recordingBackend();
    for (const env of [{ ASK_ENABLED: '0' }, { ASK_ENABLED: undefined }]) {
      const status = await edgeFetch('/api/ask', { backend, env });
      expect(status.status).toBe(200);
      expect(await status.json()).toEqual({ connected: false });
      const thread = await edgeFetch(`/api/ask/thread?owner=acme&repo=app&commitSha=${SHA}`, { backend, env });
      expect(thread.status).toBe(404);
      expect(await thread.json()).toEqual({ error: 'not found' });
      for (const path of ['/api/ask', '/api/block-plan']) {
        const response = await edgeFetch(path, { backend, env, guards: defaultGuards(), ...post() });
        expect(response.status, path).toBe(404);
        expect(await response.json()).toEqual({ error: 'not found' });
      }
    }
    expect(seen).toHaveLength(0);
  });

  it('answers GET /api/ask and the (always empty) thread at the edge when Ask is enabled', async () => {
    const { backend, seen } = recordingBackend();
    expect(await (await edgeFetch('/api/ask', { backend, env: { ...ON, OKIE_LLM_API_KEY: undefined } })).json()).toEqual({ connected: false });
    expect(await (await edgeFetch('/api/ask', { backend, env: { ...ON, OKIE_LLM_API_KEY: 'k' } })).json()).toEqual({ connected: true });
    expect(await (await edgeFetch('/api/ask', { backend, env: { ...ON, DEV_BACKEND_ORIGIN: 'http://127.0.0.1:4195' } })).json()).toEqual({ connected: true });
    expect(await (await edgeFetch('/api/ask', { backend: undefined, env: { ...ON, OKIE_LLM_API_KEY: 'k' } })).json()).toEqual({ connected: false });
    const thread = await edgeFetch(`/api/ask/thread?owner=acme&repo=app&commitSha=${SHA}`, { backend, env: ON });
    expect(thread.status).toBe(200);
    expect(await thread.json()).toEqual({ thread: { owner: 'acme', repo: 'app', commitSha: SHA, turns: [] } });
    const bad = await edgeFetch('/api/ask/thread?owner=acme', { backend, env: ON });
    expect(bad.status).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('answers 503 for Ask when enabled but no container is bound (browse-only deploy)', async () => {
    const response = await edgeFetch('/api/ask', { backend: undefined, env: ON, ...post() });
    expect(response.status).toBe(503);
    expect((await edgeFetch('/api/block-plan', { backend: undefined, env: ON, ...post() })).status).toBe(503);
  });

  it('404s every other /api route without waking the container', async () => {
    const { backend, seen } = recordingBackend();
    for (const [method, path] of [
      ['GET', '/api/nope'],
      ['GET', '/api/auth/github'],
      ['GET', '/api/auth/logout'],
      ['GET', '/api/operator/session'],
      ['POST', '/api/scans'],
      ['GET', '/api/scans'],
      ['GET', '/api/block-plan'],
      ['DELETE', '/api/ask'],
      ['POST', '/api/ask/thread'],
      ['POST', '/api/auth/me'],
    ] as const) {
      const response = await edgeFetch(path, { backend, env: ON, init: { method, ...(method === 'GET' ? {} : { body: '{}' }) } });
      expect(response.status, `${method} ${path}`).toBe(404);
      expect(await response.json()).toEqual({ error: 'not found' });
    }
    expect(seen).toHaveLength(0);
  });

  it('proxies POST Ask / block-plan with credentials stripped and the client IP forwarded', async () => {
    const { backend, seen } = recordingBackend();
    const sensitive = {
      cookie: 'okie_session=secret',
      authorization: 'Bearer secret',
      'x-forwarded-for': '6.6.6.6',
      'x-real-ip': '6.6.6.6',
      forwarded: 'for=6.6.6.6',
      'cf-connecting-ip': '203.0.113.9',
      'x-okie-client-ip': '6.6.6.6',
      'cf-turnstile-response': 'token',
      accept: 'application/json',
    };
    await edgeFetch('/api/ask', { backend, env: ON, init: { headers: sensitive } });
    await edgeFetch('/api/ask/thread?owner=acme&repo=app&commitSha=abc', { backend, env: ON, init: { headers: sensitive } });
    await edgeFetch('/api/ask', { backend, env: ON, ...post(sensitive) });
    await edgeFetch('/api/block-plan', { backend, env: ON, ...post(sensitive) });
    expect(seen.map(request => `${request.method} ${request.url}`)).toEqual([
      'POST http://backend.test/api/ask',
      'POST http://backend.test/api/block-plan',
    ]);
    for (const request of seen) {
      expect(request.headers.get('cf-connecting-ip')).toBe('203.0.113.9');
      expect(request.headers.get('x-okie-client-ip')).toBe('203.0.113.9');
      expect(request.headers.get('accept')).toBe('application/json');
      for (const name of ['cookie', 'authorization', 'x-forwarded-for', 'x-real-ip', 'forwarded', 'cf-turnstile-response']) {
        expect(request.headers.get(name), name).toBeNull();
      }
    }
    expect(await seen[0]!.text()).toBe(ASK_BODY);
    // No edge-observed address: a client-supplied x-okie-client-ip is dropped, never forwarded.
    await edgeFetch('/api/ask', { backend, env: ON, ...post({ 'x-okie-client-ip': '6.6.6.6' }) });
    expect(seen.at(-1)!.headers.get('x-okie-client-ip')).toBeNull();
  });

  it('strips the container cost headers and cookies from responses', async () => {
    const { backend } = recordingBackend(() => new Response('{"connected":true}\n', {
      headers: { 'content-type': 'application/json', 'x-okie-ask-cost-usd': '0.004', 'x-okie-ask-tokens': '1200', 'set-cookie': 'a=b' },
    }));
    const response = await edgeFetch('/api/ask', { backend, env: ON, ...post() });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-okie-ask-cost-usd')).toBeNull();
    expect(response.headers.get('x-okie-ask-tokens')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(await response.text()).toBe('{"connected":true}\n');
  });

  it('answers 503 when the container cannot be reached', async () => {
    const backend = { origin: 'http://backend.test', fetch: async () => { throw new Error('no container'); } };
    const response = await edgeFetch('/api/ask', { backend, env: ON, ...post() });
    expect(response.status).toBe(503);
  });
});

describe('guard chain', () => {
  it('rate-limits POST Ask (429 + retry-after) and block-plan (200 unavailable) per IP; GETs are never counted', async () => {
    const calls: string[] = [];
    const limiter = { limit: async ({ key }: { key: string }) => { calls.push(key); return { success: false }; } } as unknown as RateLimit;
    const { backend, seen } = recordingBackend();
    const env = { ...ON, ASK_RATE_LIMITER: limiter, ATLAS_BUDGET: undefined };
    const ask = await edgeFetch('/api/ask', { backend, env, guards: [rateLimitGuard], ...post({ 'cf-connecting-ip': '203.0.113.1' }) });
    expect(ask.status).toBe(429);
    expect(ask.headers.get('retry-after')).toBe('60');
    expect(await ask.json()).toEqual({ error: 'Ask has reached its limit for now; try again later.' });
    const plan = await edgeFetch('/api/block-plan', { backend, env, guards: [rateLimitGuard], ...post({ 'cf-connecting-ip': '203.0.113.1' }) });
    expect(plan.status).toBe(200);
    expect(await plan.json()).toEqual({ state: 'unavailable', reason: 'rate-limited' });
    await edgeFetch('/api/ask', { backend, env, guards: [rateLimitGuard] });
    // IPv6 clients are keyed by their /64, IPv4-mapped IPv6 by the IPv4 address.
    await edgeFetch('/api/ask', { backend, env, guards: [rateLimitGuard], ...post({ 'cf-connecting-ip': '2001:db8:1:2:aaaa::1' }) });
    await edgeFetch('/api/ask', { backend, env, guards: [rateLimitGuard], ...post({ 'cf-connecting-ip': '::ffff:203.0.113.1' }) });
    expect(calls).toEqual(['ask:203.0.113.1', 'block-plan:203.0.113.1', 'ask:2001:db8:1:2::/64', 'ask:203.0.113.1']);
    expect(seen).toHaveLength(0);
  });

  it('tolerates a missing rate-limit binding and uses the real one from wrangler.jsonc', async () => {
    expect(await rateLimitGuard(new Request('http://x/api/ask'), { ...edgeEnv, ASK_RATE_LIMITER: undefined }, { bucket: 'ask', clientIp: '1.1.1.1', now: new Date() })).toBeUndefined();
    expect(edgeEnv.ASK_RATE_LIMITER).toBeDefined();
    const outcome = await edgeEnv.ASK_RATE_LIMITER!.limit({ key: 'ask:probe' });
    expect(typeof outcome.success).toBe('boolean');
  });

  it('caps daily requests per bucket in the AtlasBudget Durable Object', async () => {
    const env = { ...ON, ASK_DAILY_MAX_REQUESTS: '2', BLOCK_PLAN_DAILY_MAX_REQUESTS: '1', ASK_DAILY_MAX_DOLLARS: '100' };
    const now = () => new Date('2031-01-05T23:59:00Z');
    const { backend, seen } = recordingBackend();
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await edgeFetch('/api/ask', { backend, env, now, guards: [budgetGuard], ...post() })).status);
    expect(statuses).toEqual([200, 200, 429]);
    const refused = await edgeFetch('/api/ask', { backend, env, now, guards: [budgetGuard], ...post() });
    expect(refused.headers.get('retry-after')).toBe('60');
    const planOk = await edgeFetch('/api/block-plan', { backend, env, now, guards: [budgetGuard], ...post() });
    expect(planOk.status).toBe(200);
    const planCapped = await edgeFetch('/api/block-plan', { backend, env, now, guards: [budgetGuard], ...post() });
    expect(await planCapped.json()).toEqual({ state: 'unavailable', reason: 'rate-limited' });
    // A new UTC day starts fresh.
    const tomorrow = await edgeFetch('/api/ask', { backend, env, now: () => new Date('2031-01-06T00:00:01Z'), guards: [budgetGuard], ...post() });
    expect(tomorrow.status).toBe(200);
    expect(seen).toHaveLength(4);
  });

  it('reserves Ask dollars, settles to x-okie-ask-cost-usd, and refuses past the dollar cap', async () => {
    const env = { ...ON, ASK_DAILY_MAX_REQUESTS: '1000', ASK_DAILY_MAX_DOLLARS: '0.05', ASK_ESTIMATED_DOLLARS_PER_REQUEST: '0.02' };
    const now = () => new Date('2031-02-01T10:00:00Z');
    const day = utcDay(now());
    const stub = edgeEnv.ATLAS_BUDGET!.getByName('global');
    let cost: string | undefined = '0.001';
    const { backend } = recordingBackend(() => new Response('{}', { headers: cost ? { 'x-okie-ask-cost-usd': cost } : {} }));

    expect((await edgeFetch('/api/ask', { backend, env, now, guards: [budgetGuard], ...post() })).status).toBe(200);
    let usage = await stub.usage(day);
    expect(usage.spentDollars).toBeCloseTo(0.001);
    expect(usage.openReservations).toBe(0);

    cost = undefined; // no header → the estimate stands
    expect((await edgeFetch('/api/ask', { backend, env, now, guards: [budgetGuard], ...post() })).status).toBe(200);
    usage = await stub.usage(day);
    expect(usage.spentDollars).toBeCloseTo(0.021);

    cost = 'not-a-number';
    expect((await edgeFetch('/api/ask', { backend, env, now, guards: [budgetGuard], ...post() })).status).toBe(200);
    usage = await stub.usage(day);
    expect(usage.spentDollars).toBeCloseTo(0.041);

    // 0.041 spent + 0.02 estimate > 0.05 cap.
    const refused = await edgeFetch('/api/ask', { backend, env, now, guards: [budgetGuard], ...post() });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'Ask has reached its limit for now; try again later.' });
    expect((await stub.usage(day)).requests.ask).toBe(3);
  });

  it('counts an open reservation against the cap and releases it at zero when the container is unreachable', async () => {
    const stub = edgeEnv.ATLAS_BUDGET!.getByName('global');
    const day = '2031-03-01';
    const first = await stub.admit({ bucket: 'ask', day, maxRequests: 10, dollars: { estimate: 1, max: 1.5 } });
    expect(first.ok).toBe(true);
    expect(await stub.admit({ bucket: 'ask', day, maxRequests: 10, dollars: { estimate: 1, max: 1.5 } })).toEqual({ ok: false, reason: 'dollars' });
    await stub.settle((first as { reservationId: string }).reservationId, 0.25);
    expect(await stub.usage(day)).toMatchObject({ spentDollars: 0.25, reservedDollars: 0, openReservations: 0 });

    const env = { ...ON, ASK_DAILY_MAX_DOLLARS: '1', ASK_ESTIMATED_DOLLARS_PER_REQUEST: '0.5' };
    const now = () => new Date('2031-03-02T00:00:00Z');
    const down = { origin: 'http://backend.test', fetch: async () => { throw new Error('down'); } };
    expect((await edgeFetch('/api/ask', { backend: down, env, now, guards: [budgetGuard], ...post() })).status).toBe(503);
    expect(await stub.usage('2031-03-02')).toMatchObject({ spentDollars: 0, openReservations: 0 });
  });

  it('Turnstile is off unless TURNSTILE_ENABLED=1, then verifies the header token (fail closed)', async () => {
    const verified: Array<Record<string, string>> = [];
    let success = true;
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const form = init?.body as FormData;
      verified.push(Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)])));
      return new Response(JSON.stringify({ success }));
    }) as typeof fetch;
    const guard = turnstileGuard(fakeFetch);
    const { backend, seen } = recordingBackend();

    expect((await edgeFetch('/api/ask', { backend, env: ON, guards: [guard], ...post() })).status).toBe(200);
    expect(verified).toHaveLength(0);

    const on = { ...ON, TURNSTILE_ENABLED: '1', TURNSTILE_SECRET_KEY: 'test-secret' };
    const missing = await edgeFetch('/api/ask', { backend, env: on, guards: [guard], ...post() });
    expect(missing.status).toBe(403);
    const ok = await edgeFetch('/api/ask', { backend, env: on, guards: [guard], ...post({ 'cf-turnstile-response': 'tok', 'cf-connecting-ip': '198.51.100.4' }) });
    expect(ok.status).toBe(200);
    expect(verified.at(-1)).toEqual({ secret: 'test-secret', response: 'tok', remoteip: '198.51.100.4' });
    success = false;
    const bad = await edgeFetch('/api/block-plan', { backend, env: on, guards: [guard], ...post({ 'cf-turnstile-response': 'tok' }) });
    expect(await bad.json()).toEqual({ state: 'unavailable', reason: 'rate-limited' });
    const noSecret = await edgeFetch('/api/ask', { backend, env: { ...ON, TURNSTILE_ENABLED: '1', TURNSTILE_SECRET_KEY: undefined }, guards: [guard], ...post({ 'cf-turnstile-response': 'tok' }) });
    expect(noSecret.status).toBe(403);
    const throwing = turnstileGuard((async () => { throw new Error('network'); }) as typeof fetch);
    expect((await edgeFetch('/api/ask', { backend, env: on, guards: [throwing], ...post({ 'cf-turnstile-response': 'tok' }) })).status).toBe(403);
    expect(seen).toHaveLength(2);
  });

  it('treats a "0" cap as zero (refuse all), not as the default', async () => {
    expect(budgetConfig({ ...edgeEnv, ASK_DAILY_MAX_REQUESTS: '0', BLOCK_PLAN_DAILY_MAX_REQUESTS: '0', ASK_DAILY_MAX_DOLLARS: '0' })).toMatchObject({
      askMaxRequests: 0, blockPlanMaxRequests: 0, askMaxDollars: 0,
    });
    expect(budgetConfig({ ...edgeEnv, ASK_DAILY_MAX_REQUESTS: '-1', ASK_DAILY_MAX_DOLLARS: 'x', ASK_ESTIMATED_DOLLARS_PER_REQUEST: '0' })).toMatchObject({
      askMaxRequests: 500, askMaxDollars: 2, askEstimateDollars: 0.01,
    });
    const { backend, seen } = recordingBackend();
    const now = () => new Date('2031-04-01T00:00:00Z');
    const ask = await edgeFetch('/api/ask', { backend, env: { ...ON, ASK_DAILY_MAX_REQUESTS: '0' }, now, guards: [budgetGuard], ...post() });
    expect(ask.status).toBe(429);
    const dollars = await edgeFetch('/api/ask', { backend, env: { ...ON, ASK_DAILY_MAX_DOLLARS: '0' }, now, guards: [budgetGuard], ...post() });
    expect(dollars.status).toBe(429);
    const plan = await edgeFetch('/api/block-plan', { backend, env: { ...ON, BLOCK_PLAN_DAILY_MAX_REQUESTS: '0' }, now, guards: [budgetGuard], ...post() });
    expect(await plan.json()).toEqual({ state: 'unavailable', reason: 'rate-limited' });
    expect(seen).toHaveLength(0);
  });

  it('keys rate limits by IPv4, IPv4-mapped IPv6 → IPv4, and IPv6 → /64', () => {
    expect(clientRateLimitKey('203.0.113.7')).toBe('203.0.113.7');
    expect(clientRateLimitKey(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(clientRateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientRateLimitKey('::FFFF:cb00:7107')).toBe('203.0.113.7');
    expect(clientRateLimitKey('0:0:0:0:0:ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(clientRateLimitKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(clientRateLimitKey('2001:DB8:1:2::99')).toBe('2001:db8:1:2::/64');
    expect(clientRateLimitKey('2001:0db8:0001:0002:ffff::1')).toBe('2001:db8:1:2::/64');
    expect(clientRateLimitKey('[2001:db8::1]')).toBe('2001:db8:0:0::/64');
    expect(clientRateLimitKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
    expect(clientRateLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(clientRateLimitKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64');
    expect(clientRateLimitKey('unknown')).toBe('unknown');
    expect(clientRateLimitKey('')).toBe('unknown');
    expect(clientRateLimitKey('1:2:3')).toBe('1:2:3');
  });

  it('runs the default chain in order: turnstile, rate limit, budget', () => {
    const chain = defaultGuards();
    expect(chain).toHaveLength(3);
    expect(chain[1]).toBe(rateLimitGuard);
    expect(chain[2]).toBe(budgetGuard);
  });
});

describe('the real Worker entry (default export, production deps)', () => {
  async function workerFetch(path: string, env: Partial<EdgeEnv>, init?: RequestInit): Promise<Response> {
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(new URL(path, 'http://127.0.0.1:4196'), init) as Request<unknown, IncomingRequestCfProperties>, { ...edgeEnv, ...env } as EdgeEnv, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  }

  it('ASK_ENABLED=0 (the deployed default): Ask and block-plan 404, Ask status is disconnected', async () => {
    expect(edgeEnv.ASK_ENABLED).toBe('0');
    expect((await workerFetch('/api/ask', {}, { method: 'POST', body: ASK_BODY })).status).toBe(404);
    expect((await workerFetch('/api/block-plan', {}, { method: 'POST', body: '{}' })).status).toBe(404);
    expect(await (await workerFetch('/api/ask', {})).json()).toEqual({ connected: false });
    expect(await (await workerFetch('/api/auth/me', {})).json()).toMatchObject({ mode: 'public', ask: false });
  });

  it('ASK_ENABLED=1 runs the default guard chain: Turnstile on without a token → 403 before any backend', async () => {
    const response = await workerFetch('/api/ask', { ASK_ENABLED: '1', TURNSTILE_ENABLED: '1', TURNSTILE_SECRET_KEY: 'x' }, { method: 'POST', body: ASK_BODY });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Ask needs a quick verification; reload the page and try again.' });
  });

  it('with no container binding, an enabled Ask is a 503 and browsing still works', async () => {
    const response = await workerFetch('/api/ask', { ASK_ENABLED: '1', ATLAS_API: undefined }, { method: 'POST', body: ASK_BODY });
    expect(response.status).toBe(503);
    expect((await workerFetch('/scan/nobody__here/neighborhood.json', { ATLAS_API: undefined })).status).toBe(404);
  });
});
