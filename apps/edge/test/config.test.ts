import { describe, expect, it } from 'vitest';
// Vite inlines the raw text at transform time (tests run inside workerd, which has no filesystem).
import wranglerText from '../wrangler.jsonc?raw';
import packageText from '../package.json?raw';
import devVarsExample from '../.dev.vars.example?raw';
import { WEB_ANALYTICS_TOKEN_PATTERN } from '../src/analytics';

type Env = {
  vars?: Record<string, string>;
  r2_buckets?: Array<{ binding: string; bucket_name: string }>;
  durable_objects?: { bindings: Array<{ name: string; class_name: string }> };
  containers?: Array<Record<string, unknown>>;
  ratelimits?: Array<{ name: string }>;
  migrations?: Array<{ new_sqlite_classes?: string[] }>;
  routes?: Array<{ pattern: string; custom_domain?: boolean }>;
};
type Config = Env & {
  name: string;
  account_id: string;
  compatibility_flags: string[];
  assets: { directory: string; binding: string; not_found_handling: string; run_worker_first: string[] };
  dev: { enable_containers: boolean; port: number };
  env: Record<string, Env>;
};

const lines = wranglerText.split('\n');
const config = JSON.parse(lines.filter(line => !line.trim().startsWith('//')).join('\n')) as Config;

describe('wrangler.jsonc', () => {
  it('uses only full-line comments (the vitest config strips them that way)', () => {
    for (const line of lines) {
      if (line.trim().startsWith('//')) continue;
      expect(line.replace(/"(?:[^"\\]|\\.)*"/g, '""'), line).not.toContain('//');
    }
  });

  it('never sets the DEV_* escape hatches', () => {
    expect(wranglerText).not.toMatch(/"DEV_BACKEND_ORIGIN"|"DEV_STORE_ROUTE"/);
    for (const env of [config, ...Object.values(config.env)]) {
      expect(env.vars ?? {}).not.toHaveProperty('DEV_BACKEND_ORIGIN');
      expect(env.vars ?? {}).not.toHaveProperty('DEV_STORE_ROUTE');
    }
    expect(devVarsExample).toContain('DEV_BACKEND_ORIGIN=');
    expect(devVarsExample).toContain('DEV_STORE_ROUTE=');
  });

  it('serves the web build as an SPA, with the Worker first on every path', () => {
    expect(config.name).toBe('sourcefor-atlas');
    expect(config.account_id).toBe('204e6bcb5ef0c760a064a57f8e4dd1c0');
    expect(config.compatibility_flags).toContain('nodejs_compat');
    expect(config.assets).toEqual({
      directory: '../web/dist',
      binding: 'ASSETS',
      not_found_handling: 'single-page-application',
      run_worker_first: true,
    });
    expect(config.dev).toMatchObject({ enable_containers: false, port: 4196 });
  });

  it('repeats every non-inherited binding in each environment', () => {
    const expected = {
      '': { bucket: 'sourcefor-atlas-local', origin: undefined },
      staging: { bucket: 'sourcefor-atlas-staging', origin: 'https://staging.sourcefor.dev' },
      production: { bucket: 'sourcefor-atlas', origin: 'https://sourcefor.dev' },
    } as const;
    for (const [name, want] of Object.entries(expected)) {
      const env = name ? config.env[name]! : config;
      expect(env.r2_buckets, name).toEqual([{ binding: 'ATLAS_BUCKET', bucket_name: want.bucket }]);
      expect(env.vars?.OKIE_PUBLIC_ORIGIN, name).toBe(want.origin);
      expect(env.ratelimits?.map(r => r.name), name).toEqual(['ASK_RATE_LIMITER']);
      expect(env.vars?.ASK_ENABLED, name).toBe('0');
      for (const key of ['ASK_DAILY_MAX_REQUESTS', 'BLOCK_PLAN_DAILY_MAX_REQUESTS', 'ASK_DAILY_MAX_DOLLARS', 'ASK_ESTIMATED_DOLLARS_PER_REQUEST']) {
        expect(env.vars?.[key], `${name} ${key}`).toBeDefined();
      }
      expect(env.vars?.TURNSTILE_ENABLED, name).toBe('0');
    }
    // Local top level keeps the container (the signed-in-Ask follow-up stays testable locally).
    expect(config.durable_objects?.bindings.map(b => `${b.name}:${b.class_name}`)).toEqual(['ATLAS_API:AtlasApiContainer', 'ATLAS_BUDGET:AtlasBudget']);
    expect(config.containers).toEqual([{ class_name: 'AtlasApiContainer', image: '../server/Dockerfile', image_build_context: '../..', instance_type: 'basic', max_instances: 2 }]);
    expect(config.migrations?.[0]?.new_sqlite_classes).toEqual(['AtlasApiContainer', 'AtlasBudget']);
    expect(config.env.staging!.routes).toEqual([{ pattern: 'staging.sourcefor.dev', custom_domain: true }]);
    // Only staging opts out of search engines.
    expect(config.env.staging!.vars?.ROBOTS_NOINDEX).toBe('1');
    expect(config.env.production!.vars?.ROBOTS_NOINDEX).toBeUndefined();
    expect(config.vars?.ROBOTS_NOINDEX).toBeUndefined();
    expect(config.env.production!.routes).toEqual([
      { pattern: 'sourcefor.dev', custom_domain: true },
      { pattern: 'www.sourcefor.dev', custom_domain: true },
    ]);
  });

  it('deploys staging/production browse-only: no container, no ATLAS_API, Ask off, no DEV_* vars', () => {
    for (const name of ['staging', 'production']) {
      const env = config.env[name]!;
      expect(env.containers, name).toBeUndefined();
      expect(env.durable_objects?.bindings, name).toEqual([{ name: 'ATLAS_BUDGET', class_name: 'AtlasBudget' }]);
      // v1 was applied by the first deploy with both classes; it must never change.
      expect(env.migrations, name).toEqual([{ tag: 'v1', new_sqlite_classes: ['AtlasApiContainer', 'AtlasBudget'] }]);
      expect(env.vars?.ASK_ENABLED, name).toBe('0');
      expect(Object.keys(env.vars ?? {}).filter(key => key.startsWith('DEV_')), name).toEqual([]);
    }
  });

  it('turns Web Analytics on in production only', () => {
    // Staging and local dev never report page views; production's token must be a plain site token.
    expect(config.vars?.WEB_ANALYTICS_TOKEN).toBeUndefined();
    expect(config.env.staging!.vars?.WEB_ANALYTICS_TOKEN).toBeUndefined();
    expect(config.env.production!.vars?.WEB_ANALYTICS_TOKEN).toMatch(WEB_ANALYTICS_TOKEN_PATTERN);
  });

  it('keeps local dev off Docker', () => {
    const pkg = JSON.parse(packageText) as { scripts: Record<string, string> };
    expect(pkg.scripts.dev).toContain('--enable-containers=false');
    expect(pkg.scripts.dev).toContain('4196');
  });
});
