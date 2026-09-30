import { backendUnavailable, devBackendOrigin, proxiedRequest, publicBackendResponse, type Backend } from './backend';
import type { BudgetBucket } from './budget';
import { accountsEnabled, handleAuthRoute } from './auth';
import { askEnabled, type EdgeEnv } from './env';
import { budgetStub, reportedAskCost, runGuards, type Guard, type GuardContext } from './guards';
import { jsonResponse, notFoundJson } from './http';

/**
 * `/api/*` at the edge (CLA-266). `/api/auth/*` and `/api/account/*` are GitHub sign-in (auth.ts, CLA-316):
 * without its secrets and D1 binding `/api/auth/me` answers the public shape and the rest 404. Ask status and the (always empty) Ask thread are answered here too.
 * Only `POST /api/ask` and `POST /api/block-plan` can reach the container, behind the guard chain, and
 * only with `ASK_ENABLED=1`; otherwise (the browse-only launch) they 404. Every other `/api/*`
 * (operator, scans) is a 404.
 */

type ApiRoute = 'ask-status' | 'ask-thread' | { bucket: BudgetBucket };

function apiRoute(method: string, pathname: string): ApiRoute | undefined {
  const read = method === 'GET' || method === 'HEAD';
  if (read && pathname === '/api/ask') return 'ask-status';
  if (read && pathname === '/api/ask/thread') return 'ask-thread';
  if (method === 'POST' && pathname === '/api/ask') return { bucket: 'ask' };
  if (method === 'POST' && pathname === '/api/block-plan') return { bucket: 'block-plan' };
  return undefined;
}

export type ApiRouteContext = {
  /** undefined = no container / dev backend bound (the browse-only deploy). */
  backend: Backend | undefined;
  guards: readonly Guard[];
  now: () => Date;
  waitUntil(promise: Promise<unknown>): void;
  /** Upstream fetch (GitHub OAuth in auth.ts); defaults to the global fetch. */
  fetch?: typeof fetch;
};

/**
 * `GET /api/ask` without a container probe: connected only when Ask is enabled, a backend exists and
 * the gateway key is configured (the key lives in the container env; a dev backend holds its own).
 */
export function askConnected(env: EdgeEnv, backend: Backend | undefined): boolean {
  if (!askEnabled(env) || !backend) return false;
  return Boolean(env.OKIE_LLM_API_KEY?.trim()) || devBackendOrigin(env) !== undefined;
}

// Same rules as apps/server askThreads.ts `sanitizeAskAtlasIdentity`.
const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const COMMIT_SHA = /^[A-Za-z0-9._-]{1,80}$/;

function askThreadIdentity(search: URLSearchParams): { owner: string; repo: string; commitSha: string } | undefined {
  const name = (value: string | null) => {
    const trimmed = (value ?? '').trim();
    return GITHUB_NAME.test(trimmed) && trimmed !== '.' && trimmed !== '..' ? trimmed : undefined;
  };
  const owner = name(search.get('owner'));
  const repo = name(search.get('repo'));
  const commitSha = (search.get('commitSha') ?? '').trim();
  return owner && repo && COMMIT_SHA.test(commitSha) ? { owner, repo, commitSha } : undefined;
}

export async function handleApiRoute(request: Request, env: EdgeEnv, context: ApiRouteContext): Promise<Response> {
  const url = new URL(request.url);
  const auth = await handleAuthRoute(request, env, { now: context.now(), ...(context.fetch ? { fetch: context.fetch } : {}) });
  if (auth) return auth;
  // With accounts on, the signed-in SPA's account menu asks whether this user is an operator
  // (OperatorMenuLink). The hosted deployment has no operators; without accounts it stays a 404 as before.
  if (request.method.toUpperCase() === 'GET' && url.pathname === '/api/operator/session' && accountsEnabled(env, url)) {
    return jsonResponse(200, { operator: false });
  }
  const route = apiRoute(request.method.toUpperCase(), url.pathname);
  if (!route) return notFoundJson();
  if (route === 'ask-status') return jsonResponse(200, { connected: askConnected(env, context.backend) });
  if (!askEnabled(env)) return notFoundJson();
  if (route === 'ask-thread') {
    // Public mode has no identity, so there is never a persisted thread (the client keeps its turns).
    const atlas = askThreadIdentity(url.searchParams);
    if (!atlas) return jsonResponse(400, { error: 'Ask thread needs atlas identity {owner, repo, commitSha}.' });
    return jsonResponse(200, { thread: { ...atlas, turns: [] } });
  }
  if (!context.backend) return backendUnavailable();

  const guardContext: GuardContext = {
    bucket: route.bucket,
    clientIp: request.headers.get('cf-connecting-ip')?.trim() || 'unknown',
    now: context.now(),
  };
  const refused = await runGuards(context.guards, request, env, guardContext);
  if (refused) return refused;

  const reservationId = guardContext.reservationId;
  const settle = (dollars: number | undefined) => {
    const stub = reservationId ? budgetStub(env) : undefined;
    if (stub && reservationId) context.waitUntil(Promise.resolve(stub.settle(reservationId, dollars)).catch(() => undefined));
  };
  let response: Response;
  try {
    response = await context.backend.fetch(proxiedRequest(request, context.backend.origin, url.pathname, url.search));
  } catch {
    settle(0); // nothing was spent: the container never answered
    return backendUnavailable();
  }
  settle(reportedAskCost(response));
  return publicBackendResponse(response);
}
