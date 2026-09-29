import type { AtlasBudget } from './budget';
import type { AtlasApiContainer } from './container';

/**
 * Bindings and vars of the `sourcefor-atlas` Worker (apps/edge/wrangler.jsonc). Secrets
 * (`OKIE_LLM_API_KEY`, `JEV_API`, `TURNSTILE_SECRET_KEY`) are set with `wrangler secret put`, never in
 * the config. `DEV_*` names only ever come from a local `.dev.vars`.
 */
export interface EdgeEnv {
  /** Workers Static Assets: the apps/web build. */
  ASSETS: Fetcher;
  /** Published atlases, keyed per apps/server/src/publishedStoreLayout.ts. */
  ATLAS_BUCKET: R2Bucket;
  /**
   * The read-only Ask / block-plan API container (one named instance). Only the local top-level env
   * binds it; the browse-only staging/production launch has no container, so every browse path must
   * work without it (a missing binding = "backend unavailable").
   */
  ATLAS_API?: DurableObjectNamespace<AtlasApiContainer>;
  /** Daily request + dollar budget (single SQLite Durable Object). */
  ATLAS_BUDGET?: DurableObjectNamespace<AtlasBudget>;
  /** Workers Rate Limiting binding; absent in some local setups (tolerated). */
  ASK_RATE_LIMITER?: RateLimit;

  /** "1" turns on Ask + block-plan. Anything else (the code default) = browse-only: those routes 404 at the edge. */
  ASK_ENABLED?: string;

  /** https://staging.sourcefor.dev / https://sourcefor.dev — the only non-loopback share origin. */
  OKIE_PUBLIC_ORIGIN?: string;

  // Forwarded into the container (see containerEnvVars).
  OKIE_LLM_API_KEY?: string;
  JEV_API?: string;
  OKIE_LLM_MODEL?: string;
  OKIE_JEV_BLOCK_PLANNER?: string;
  OKIE_ASK_PER_IP_WINDOW?: string;

  // Edge budget knobs (placeholder defaults pending the final numbers; see BUDGET_DEFAULTS in guards.ts).
  ASK_DAILY_MAX_REQUESTS?: string;
  BLOCK_PLAN_DAILY_MAX_REQUESTS?: string;
  ASK_DAILY_MAX_DOLLARS?: string;
  ASK_ESTIMATED_DOLLARS_PER_REQUEST?: string;

  // Turnstile guard (off unless TURNSTILE_ENABLED=1).
  TURNSTILE_ENABLED?: string;
  TURNSTILE_SECRET_KEY?: string;

  // Local-only escape hatches; must never be set in wrangler.jsonc.
  DEV_BACKEND_ORIGIN?: string;
  DEV_STORE_ROUTE?: string;
}

/** Ask (and block-plan) are on only with `ASK_ENABLED=1`; the Worker's default is off. */
export function askEnabled(env: Pick<EdgeEnv, 'ASK_ENABLED'>): boolean {
  return env.ASK_ENABLED?.trim() === '1';
}

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends EdgeEnv {}
  }
}
