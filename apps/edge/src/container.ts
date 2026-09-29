import { Container } from '@cloudflare/containers';
import type { EdgeEnv } from './env';
import { STORE_HOST, atlasStoreOutbound } from './store';

/**
 * The read-only Ask / block-plan API (apps/server built from apps/server/Dockerfile) as a Cloudflare
 * Container (CLA-266). The server mirrors published atlases from `http://atlas-store.internal/<key>`,
 * which never leaves Cloudflare: the outbound handler below answers it straight from the Worker's R2
 * binding (public AND private objects under `atlas/v1/`, GET/HEAD only). Everything else egresses
 * normally (the LLM / Jev providers).
 */

/** Runtime env for the container, built from the Worker env; secrets only when set. */
export function containerEnvVars(env: Partial<EdgeEnv>): Record<string, string> {
  const vars: Record<string, string> = {
    OKIE_SERVER_MODE: 'public-readonly',
    OKIE_SERVER_HOST: '0.0.0.0',
    OKIE_SERVER_PORT: '8080',
    OKIE_TRUSTED_PROXY: 'cloudflare',
    OKIE_PUBLISHED_STORE_URL: `http://${STORE_HOST}`,
  };
  for (const name of ['OKIE_LLM_API_KEY', 'JEV_API', 'OKIE_LLM_MODEL', 'OKIE_JEV_BLOCK_PLANNER', 'OKIE_ASK_PER_IP_WINDOW'] as const) {
    const value = env[name];
    if (typeof value === 'string' && value !== '') vars[name] = value;
  }
  return vars;
}

export class AtlasApiContainer extends Container<EdgeEnv> {
  override defaultPort = 8080;
  override sleepAfter = '10m';
  override enableInternet = true;

  constructor(ctx: ConstructorParameters<typeof Container<EdgeEnv>>[0], env: EdgeEnv) {
    super(ctx, env);
    this.envVars = containerEnvVars(env);
  }
}

// Assigned through the inherited static setter (which registers the handler by class name); a
// `static outboundByHost = …` class field would define an own property and bypass that registry.
AtlasApiContainer.outboundByHost = {
  [STORE_HOST]: (request: Request, env: unknown) => atlasStoreOutbound(request, (env as EdgeEnv).ATLAS_BUCKET),
};
