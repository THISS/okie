import type { AtlasBudget } from './budget';
import type { AtlasApiContainer } from './container';

/**
 * Bindings and vars of the `sourcefor-atlas` Worker (apps/edge/wrangler.jsonc). Secrets
 * (`OKIE_LLM_API_KEY`, `JEV_API`, `TURNSTILE_SECRET_KEY`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
 * `SESSION_SIGNING_KEY`) are set with `wrangler secret put`, never in the config. `DEV_*` names only
 * ever come from a local `.dev.vars`.
 */
export interface EdgeEnv {
  /** Workers Static Assets: the apps/web build. */
  ASSETS: Fetcher;
  /** Published atlases, keyed per apps/server/src/publishedStoreLayout.ts. */
  ATLAS_BUCKET: R2Bucket;
  /**
   * The read-only Ask API container (one named instance). Browse paths must work without it;
   * a missing binding makes enabled Ask unavailable.
   */
  ATLAS_API?: DurableObjectNamespace<AtlasApiContainer>;
  /** Daily request + dollar budget (single SQLite Durable Object). */
  ATLAS_BUDGET?: DurableObjectNamespace<AtlasBudget>;
  /** Workers Rate Limiting binding; absent in some local setups (tolerated). */
  ASK_RATE_LIMITER?: RateLimit;
  /** Public agent reads: independent per-IP limiter, never charges Ask allowance. */
  AGENT_RATE_LIMITER?: RateLimit;
  /** "1" enables read-only /mcp and /api/atlas/query. */
  AGENT_READS_ENABLED?: string;

  /**
   * Accounts (CLA-316): one row per GitHub user who signed in (migrations/0001_users.sql). Sign-in is
   * off unless this is bound AND the GitHub OAuth secrets and SESSION_SIGNING_KEY are set (auth.ts).
   */
  USERS_DB?: D1Database;

  /** "1" turns on signed-in Ask. The optional planner has its own flag below; default is browse-only. */
  ASK_ENABLED?: string;
  /** Independently opt in to the optional block ordering planner. */
  BLOCK_PLAN_ENABLED?: string;

  /** "1" (staging only): every response carries `X-Robots-Tag: noindex, nofollow` and robots.txt disallows all. */
  ROBOTS_NOINDEX?: string;

  /** https://staging.sourcefor.dev / https://sourcefor.dev — the only non-loopback share origin. */
  OKIE_PUBLIC_ORIGIN?: string;

  /**
   * Cloudflare Web Analytics site token (public: it ships in page HTML). Set → the beacon is added to
   * every HTML document the Worker serves (analytics.ts); unset, blank or not /^[A-Za-z0-9]{16,64}$/ → no
   * analytics. Production only; staging stays without.
   */
  WEB_ANALYTICS_TOKEN?: string;

  // Forwarded into the container (see containerEnvVars).
  OKIE_LLM_API_KEY?: string;
  JEV_API?: string;
  OKIE_LLM_MODEL?: string;
  OKIE_JEV_BLOCK_PLANNER?: string;
  OKIE_ASK_PER_IP_WINDOW?: string;

  // Edge global budget knobs (the five requests per account per day are a hard code limit).
  ASK_DAILY_MAX_REQUESTS?: string;
  BLOCK_PLAN_DAILY_MAX_REQUESTS?: string;
  ASK_DAILY_MAX_DOLLARS?: string;
  ASK_ESTIMATED_DOLLARS_PER_REQUEST?: string;

  // Turnstile guard (off unless TURNSTILE_ENABLED=1).
  TURNSTILE_ENABLED?: string;
  TURNSTILE_SECRET_KEY?: string;

  // GitHub sign-in (CLA-316; secrets, `wrangler secret put --env <env>`).
  /** The GitHub OAuth app's client id (one app per environment; its callback is <origin>/api/auth/github/callback). */
  GITHUB_CLIENT_ID?: string;
  /** The GitHub OAuth app's client secret. */
  GITHUB_CLIENT_SECRET?: string;
  /**
   * HMAC-SHA256 key for the session and OAuth-state cookies; at least 32 characters (shorter = sign-in
   * stays off). Rotating it signs everyone out.
   */
  SESSION_SIGNING_KEY?: string;

  // Local-only escape hatches; must never be set in wrangler.jsonc.
  DEV_BACKEND_ORIGIN?: string;
  DEV_STORE_ROUTE?: string;
  /**
   * "1" (with SESSION_SIGNING_KEY + USERS_DB, and OKIE_PUBLIC_ORIGIN unset or loopback): GET
   * /api/auth/github/test-login signs in a fixed test user without GitHub. Never honoured off loopback.
   */
  DEV_AUTH_TEST_LOGIN?: string;
}

/** Ask is on only with `ASK_ENABLED=1`; the Worker's default is off. */
export function askEnabled(env: Pick<EdgeEnv, 'ASK_ENABLED'>): boolean {
  return env.ASK_ENABLED?.trim() === '1';
}

declare global {
  namespace Cloudflare {
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends EdgeEnv {}
  }
}
