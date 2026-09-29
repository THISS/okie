import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AtlasApiContainer, containerEnvVars } from '../src/container';
import { CONTAINER_INSTANCE_NAME, CONTAINER_ORIGIN, devBackendOrigin, selectBackend } from '../src/backend';
import { STORE_HOST, atlasStoreOutbound } from '../src/store';
import { edgeEnv, edgeFetch, seedAtlas } from './helpers';

describe('AtlasApiContainer', () => {
  it('runs the server read-only on 8080, sleeping after 10 minutes, env built from the Worker env', async () => {
    // Miniflare has no container runtime here, so construct the class against a real Durable Object
    // state (a throwaway AtlasBudget instance) with a stand-in `ctx.container`.
    const stub = edgeEnv.ATLAS_BUDGET!.getByName('container-constructor-probe');
    await runInDurableObject(stub, async (_budget, state) => {
      Object.defineProperty(state, 'container', { value: { running: false }, configurable: true });
      const ctx = state;
      const instance = new AtlasApiContainer(ctx as never, edgeEnv);
      expect(instance.defaultPort).toBe(8080);
      expect(instance.sleepAfter).toBe('10m');
      expect(instance.enableInternet).toBe(true);
      expect(instance.envVars).toEqual(containerEnvVars(edgeEnv));
      expect(instance.envVars).toMatchObject({ OKIE_SERVER_MODE: 'public-readonly', OKIE_PUBLISHED_STORE_URL: 'http://atlas-store.internal' });
      await instance.applyOutboundInterceptionPromise;
      await state.storage.deleteAlarm();
    });
  });

  it('builds container env vars from the Worker env, forwarding secrets only when set', () => {
    expect(containerEnvVars({})).toEqual({
      OKIE_SERVER_MODE: 'public-readonly',
      OKIE_SERVER_HOST: '0.0.0.0',
      OKIE_SERVER_PORT: '8080',
      OKIE_TRUSTED_PROXY: 'cloudflare',
      OKIE_PUBLISHED_STORE_URL: 'http://atlas-store.internal',
    });
    const vars = containerEnvVars({
      OKIE_LLM_API_KEY: 'k',
      JEV_API: 'j',
      OKIE_LLM_MODEL: 'm',
      OKIE_JEV_BLOCK_PLANNER: '1',
      OKIE_ASK_PER_IP_WINDOW: '20',
      DEV_BACKEND_ORIGIN: 'http://127.0.0.1:4195',
      TURNSTILE_SECRET_KEY: 'never-forwarded',
      OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev',
    });
    expect(vars).toMatchObject({ OKIE_LLM_API_KEY: 'k', JEV_API: 'j', OKIE_LLM_MODEL: 'm', OKIE_JEV_BLOCK_PLANNER: '1', OKIE_ASK_PER_IP_WINDOW: '20' });
    expect(Object.keys(vars)).not.toContain('DEV_BACKEND_ORIGIN');
    expect(Object.keys(vars)).not.toContain('TURNSTILE_SECRET_KEY');
    expect(containerEnvVars({ OKIE_LLM_API_KEY: '' })).not.toHaveProperty('OKIE_LLM_API_KEY');
  });

  it('registers the atlas-store.internal outbound handler (public AND private, GET/HEAD only)', async () => {
    const handlers = AtlasApiContainer.outboundByHost;
    expect(Object.keys(handlers ?? {})).toEqual([STORE_HOST]);
    await seedAtlas({ slug: 'acme__mirror', versionId: 'v1', files: { 'snapshot.json': '{"s":1}' }, privateFiles: { 'operator-explanations.json': '{"private":true}' } });
    const handler = handlers![STORE_HOST]!;
    const ctx = { containerId: 'x', className: 'AtlasApiContainer' };
    const priv = await handler(new Request(`http://${STORE_HOST}/atlas/v1/repos/acme__mirror/versions/v1/private/operator-explanations.json`), edgeEnv, ctx);
    expect(priv.status).toBe(200);
    expect(await priv.text()).toBe('{"private":true}');
    const pub = await handler(new Request(`http://${STORE_HOST}/atlas/v1/repos/acme__mirror/latest.json`), edgeEnv, ctx);
    expect(await pub.json()).toMatchObject({ versionId: 'v1' });
    const head = await handler(new Request(`http://${STORE_HOST}/atlas/v1/repos/acme__mirror/versions/v1/public/snapshot.json`, { method: 'HEAD' }), edgeEnv, ctx);
    expect(head.headers.get('content-length')).toBe('7');
    const ranged = await atlasStoreOutbound(new Request(`http://${STORE_HOST}/atlas/v1/repos/acme__mirror/versions/v1/public/snapshot.json`, { headers: { range: 'bytes=1-3' } }), edgeEnv.ATLAS_BUCKET);
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe('"s"');
    expect(ranged.headers.get('content-range')).toBe('bytes 1-3/7');
    await edgeEnv.ATLAS_BUCKET.put('other/secret.txt', 'nope');
    for (const path of ['/other/secret.txt', '/atlas/v1/../other/secret.txt', '/atlas/v1/repos/acme__mirror/missing.json', '/atlas/v1/']) {
      expect((await atlasStoreOutbound(new Request(`http://${STORE_HOST}${path}`), edgeEnv.ATLAS_BUCKET)).status, path).toBe(404);
    }
    const put = await atlasStoreOutbound(new Request(`http://${STORE_HOST}/atlas/v1/index.json`, { method: 'PUT', body: 'x' }), edgeEnv.ATLAS_BUCKET);
    expect(put.status).toBe(405);
  });

  it('routes all container traffic to one named instance unless DEV_BACKEND_ORIGIN is set', () => {
    expect(CONTAINER_INSTANCE_NAME).toBe('atlas-api');
    expect(selectBackend({ ...edgeEnv, DEV_BACKEND_ORIGIN: undefined })?.origin).toBe(CONTAINER_ORIGIN);
    expect(selectBackend({ ...edgeEnv, DEV_BACKEND_ORIGIN: 'http://127.0.0.1:4195/' })?.origin).toBe('http://127.0.0.1:4195');
    // Browse-only staging/production bind no container: no backend at all.
    expect(selectBackend({ ...edgeEnv, ATLAS_API: undefined, DEV_BACKEND_ORIGIN: undefined })).toBeUndefined();
    expect(devBackendOrigin({ DEV_BACKEND_ORIGIN: 'file:///etc/passwd' })).toBeUndefined();
    expect(devBackendOrigin({ DEV_BACKEND_ORIGIN: '' })).toBeUndefined();
  });
});

describe('DEV_* gates', () => {
  it('is unset in the test env (which is wrangler.jsonc)', () => {
    expect(edgeEnv.DEV_BACKEND_ORIGIN).toBeUndefined();
    expect(edgeEnv.DEV_STORE_ROUTE).toBeUndefined();
  });

  it('keeps /__store closed unless DEV_STORE_ROUTE=1', async () => {
    await seedAtlas({ slug: 'acme__devstore', versionId: 'v1', privateFiles: { 'operator-explanations.json': '{"private":true}' } });
    const path = '/__store/atlas/v1/repos/acme__devstore/versions/v1/private/operator-explanations.json';
    const closed = await edgeFetch(path);
    expect(closed.status).toBe(404);
    expect(await closed.json()).toEqual({ error: 'not found' });
    expect((await edgeFetch(path, { env: { DEV_STORE_ROUTE: 'true' } })).status).toBe(404);
    const open = await edgeFetch(path, { env: { DEV_STORE_ROUTE: '1' } });
    expect(open.status).toBe(200);
    expect(await open.text()).toBe('{"private":true}');
  });
});
