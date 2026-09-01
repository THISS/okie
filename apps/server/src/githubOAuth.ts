import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { scrubGithubTokens } from "@okie/scan";

/**
 * GitHub OAuth + optional App-install redirects for hosted scan (CLA-30).
 *
 * Vercel-like abuse gate: a real GitHub user session (OAuth) or a loopback
 * test-double. Callback `state` is CSRF-bound to an HttpOnly cookie. Tokens
 * live in the in-memory session store — never in URLs, logs, or `/healthz`.
 * OAuth `redirect_uri` is built from `OKIE_PUBLIC_ORIGIN`, never the Host header.
 */

export const SESSION_COOKIE = "okie_session";
export const OAUTH_STATE_COOKIE = "okie_oauth_state";
export const LOGIN_PATH = "/api/auth/github";
export const CALLBACK_PATH = "/api/auth/github/callback";
export const LOGOUT_PATH = "/api/auth/logout";
export const ME_PATH = "/api/auth/me";
export const TEST_LOGIN_PATH = "/api/auth/github/test-login";
export const INSTALL_PATH = "/api/auth/github/install";
export const SETUP_PATH = "/api/auth/github/setup";

const STATE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_OAUTH = 256;
const SESSION_TTL_SEC = 7 * 24 * 60 * 60;
const DEFAULT_PUBLIC_ORIGIN = "http://localhost:4173";
const DEFAULT_RETURN_PATH = "/new";
const TEST_DOUBLE_LOGIN = "okie-test-user";
const TEST_DOUBLE_USER_ID = "0";
const TEST_DOUBLE_TOKEN = "gho_okieTestDoubleTokenCla30xxxxx";

export type GithubIdentitySource = "oauth" | "app" | "test-double";

export interface GithubSession {
  id: string;
  login: string;
  userId: string;
  source: GithubIdentitySource;
  /** GitHub access token. Never serialize, log, or put on the wire. */
  token: string;
  createdAt: number;
}

export interface GithubOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  publicOrigin: string;
  appSlug?: string;
  scopes: string;
  testDouble: boolean;
  secureCookies: boolean;
  oauthConfigured: boolean;
}

export interface PublicGithubAuthView {
  authenticated: boolean;
  login?: string;
  source?: GithubIdentitySource;
  loginPath: string;
  logoutPath: string;
  oauthConfigured: boolean;
  testLoginPath?: string;
  installPath?: string;
}

export interface GithubOAuthAdapter {
  exchangeCode(code: string, redirectUri: string): Promise<string>;
  fetchUser(accessToken: string): Promise<{ login: string; id: number }>;
}

export interface SessionStore {
  create(input: Omit<GithubSession, "id" | "createdAt">): GithubSession;
  get(id: string): GithubSession | undefined;
  delete(id: string): void;
}

type PendingOauth = { returnTo: string; createdAt: number };

export function isLoopbackBind(bind: string): boolean {
  const host = bind.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackBind(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function sanitizePublicOrigin(raw: string): string {
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    if (url.username || url.password || url.search || url.hash) return DEFAULT_PUBLIC_ORIGIN;
    if (url.protocol !== "http:" && url.protocol !== "https:") return DEFAULT_PUBLIC_ORIGIN;
    return url.origin;
  } catch {
    return DEFAULT_PUBLIC_ORIGIN;
  }
}

export function resolveGithubOAuthConfig(
  env: NodeJS.Dict<string> = process.env,
  bind = "127.0.0.1",
): GithubOAuthConfig {
  const publicOrigin = sanitizePublicOrigin(trimToUndefined(env.OKIE_PUBLIC_ORIGIN) ?? DEFAULT_PUBLIC_ORIGIN);
  const clientId = trimToUndefined(env.OKIE_GITHUB_CLIENT_ID);
  const clientSecret = trimToUndefined(env.OKIE_GITHUB_CLIENT_SECRET);
  const oauthConfigured = Boolean(clientId && clientSecret);
  const loopback = isLoopbackBind(bind) && isLoopbackOrigin(publicOrigin);
  let testDouble = false;
  if (loopback) {
    if (env.OKIE_GITHUB_TEST_DOUBLE === "0") testDouble = false;
    else if (env.OKIE_GITHUB_TEST_DOUBLE === "1") testDouble = true;
    else testDouble = !oauthConfigured;
  }
  const appSlug = trimToUndefined(env.OKIE_GITHUB_APP_SLUG);
  return {
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    publicOrigin,
    ...(appSlug ? { appSlug } : {}),
    scopes: trimToUndefined(env.OKIE_GITHUB_OAUTH_SCOPES) ?? "read:user",
    testDouble,
    secureCookies: publicOrigin.startsWith("https://"),
    oauthConfigured,
  };
}

export function createSessionStore(now: () => number = () => Date.now()): SessionStore {
  const sessions = new Map<string, GithubSession>();
  return {
    create(input) {
      const session: GithubSession = {
        ...input,
        id: randomBytes(32).toString("hex"),
        createdAt: now(),
      };
      sessions.set(session.id, session);
      return session;
    },
    get: id => sessions.get(id),
    delete: id => {
      sessions.delete(id);
    },
  };
}

export function parseCookieHeader(header: string | string[] | undefined): Record<string, string> {
  const raw = Array.isArray(header) ? header.join("; ") : header ?? "";
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function safeReturnPath(raw: string | null | undefined): string {
  if (!raw) return DEFAULT_RETURN_PATH;
  if (!raw.startsWith("/")) return DEFAULT_RETURN_PATH;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return DEFAULT_RETURN_PATH;
  if (raw.includes("://") || raw.includes("\\")) return DEFAULT_RETURN_PATH;
  return raw;
}

export function oauthCallbackUrl(config: GithubOAuthConfig): string {
  return `${config.publicOrigin}${CALLBACK_PATH}`;
}

export function githubAuthorizeUrl(config: GithubOAuthConfig, state: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.clientId ?? "");
  url.searchParams.set("redirect_uri", oauthCallbackUrl(config));
  url.searchParams.set("state", state);
  url.searchParams.set("scope", config.scopes);
  return url.toString();
}

export function githubAppInstallUrl(config: GithubOAuthConfig, state: string): string | undefined {
  if (!config.appSlug) return undefined;
  const url = new URL(`https://github.com/apps/${encodeURIComponent(config.appSlug)}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Installation-token minting is the private-tree follow-up. This slice stores
 * GitHub identity only; private trees stay closed until a token can be minted.
 */
export async function mintGithubInstallationToken(_input: {
  appId: string;
  privateKey: string;
  installationId: string;
}): Promise<string | undefined> {
  void _input;
  return undefined;
}

function cookieHeader(name: string, value: string, options: { maxAge: number; secure: boolean }): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${options.maxAge}`,
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function clearCookieHeader(name: string, secure: boolean): string {
  return cookieHeader(name, "", { maxAge: 0, secure });
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

function sendJson(response: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string | string[]> = {}): void {
  const headers: Record<string, string | string[]> = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  };
  response.writeHead(status, headers);
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function sendRedirect(response: ServerResponse, location: string, cookies: string[] = []): void {
  const headers: Record<string, string | string[]> = {
    location,
    "cache-control": "no-store",
  };
  if (cookies.length === 1) headers["set-cookie"] = cookies[0]!;
  else if (cookies.length > 1) headers["set-cookie"] = cookies;
  response.writeHead(302, headers);
  response.end();
}

export function createGithubOAuthAdapter(
  config: GithubOAuthConfig,
  fetchImpl: typeof fetch = fetch,
): GithubOAuthAdapter {
  return {
    async exchangeCode(code, redirectUri) {
      if (!config.clientId || !config.clientSecret) {
        throw new Error("GitHub OAuth is not configured");
      }
      const response = await fetchImpl("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "okie-scan",
        },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });
      const json = (await response.json()) as { access_token?: unknown; error?: unknown };
      const token = typeof json.access_token === "string" ? json.access_token.trim() : "";
      if (!token) throw new Error("GitHub OAuth token exchange failed");
      return token;
    },
    async fetchUser(accessToken) {
      const response = await fetchImpl("https://api.github.com/user", {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "okie-scan",
          Authorization: `Bearer ${accessToken}`,
        },
      });
      const json = (await response.json()) as { login?: unknown; id?: unknown };
      const login = typeof json.login === "string" ? json.login : "";
      const id = typeof json.id === "number" ? json.id : Number.NaN;
      if (!login || !Number.isFinite(id)) throw new Error("GitHub user profile was missing login");
      return { login, id };
    },
  };
}

export interface GithubAuthService {
  config: GithubOAuthConfig;
  sessionFromRequest(request: IncomingMessage): GithubSession | undefined;
  publicView(request: IncomingMessage): PublicGithubAuthView;
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>;
}

export function createGithubAuthService(options: {
  env?: NodeJS.Dict<string>;
  bind: string;
  adapter?: GithubOAuthAdapter;
  store?: SessionStore;
  now?: () => number;
  fetch?: typeof fetch;
}): GithubAuthService {
  const now = options.now ?? (() => Date.now());
  const config = resolveGithubOAuthConfig(options.env ?? process.env, options.bind);
  const store = options.store ?? createSessionStore(now);
  const adapter = options.adapter ?? createGithubOAuthAdapter(config, options.fetch ?? fetch);
  const pending = new Map<string, PendingOauth>();

  const sessionFromRequest = (request: IncomingMessage): GithubSession | undefined => {
    const cookies = parseCookieHeader(request.headers.cookie);
    const id = cookies[SESSION_COOKIE];
    return id ? store.get(id) : undefined;
  };

  const publicView = (request: IncomingMessage): PublicGithubAuthView => {
    const session = sessionFromRequest(request);
    return {
      authenticated: Boolean(session),
      ...(session ? { login: session.login, source: session.source } : {}),
      loginPath: LOGIN_PATH,
      logoutPath: LOGOUT_PATH,
      oauthConfigured: config.oauthConfigured,
      ...(config.testDouble ? { testLoginPath: TEST_LOGIN_PATH } : {}),
      ...(config.appSlug ? { installPath: INSTALL_PATH } : {}),
    };
  };

  const beginState = (returnTo: string): string => {
    const cutoff = now() - STATE_TTL_MS;
    for (const [key, row] of pending) {
      if (row.createdAt < cutoff) pending.delete(key);
    }
    while (pending.size >= MAX_PENDING_OAUTH) {
      const oldest = pending.keys().next().value;
      if (oldest === undefined) break;
      pending.delete(oldest);
    }
    const state = randomBytes(32).toString("hex");
    pending.set(state, { returnTo: safeReturnPath(returnTo), createdAt: now() });
    return state;
  };

  const consumeState = (state: string | null, cookieState: string | undefined): PendingOauth | undefined => {
    if (!state || !cookieState || !sameSecret(state, cookieState)) return undefined;
    const row = pending.get(state);
    pending.delete(state);
    if (!row || now() - row.createdAt > STATE_TTL_MS) return undefined;
    return row;
  };

  const issueSessionCookies = (session: GithubSession, extra: string[] = []): string[] => [
    cookieHeader(SESSION_COOKIE, session.id, { maxAge: SESSION_TTL_SEC, secure: config.secureCookies }),
    clearCookieHeader(OAUTH_STATE_COOKIE, config.secureCookies),
    ...extra,
  ];

  return {
    config,
    sessionFromRequest,
    publicView,
    async handle(request, response, url) {
      const pathname = url.pathname;

      if (request.method === "GET" && pathname === ME_PATH) {
        sendJson(response, 200, publicView(request));
        return true;
      }

      if ((request.method === "POST" || request.method === "GET") && pathname === LOGOUT_PATH) {
        const session = sessionFromRequest(request);
        if (session) store.delete(session.id);
        const cookies = [
          clearCookieHeader(SESSION_COOKIE, config.secureCookies),
          clearCookieHeader(OAUTH_STATE_COOKIE, config.secureCookies),
        ];
        if (request.method === "GET") {
          sendRedirect(response, safeReturnPath(url.searchParams.get("return")), cookies);
          return true;
        }
        sendJson(response, 200, { authenticated: false, loginPath: LOGIN_PATH }, { "set-cookie": cookies });
        return true;
      }

      if (request.method === "GET" && pathname === TEST_LOGIN_PATH) {
        if (!config.testDouble) {
          sendJson(response, 404, { error: "not found" });
          return true;
        }
        const session = store.create({
          login: TEST_DOUBLE_LOGIN,
          userId: TEST_DOUBLE_USER_ID,
          source: "test-double",
          token: TEST_DOUBLE_TOKEN,
        });
        sendRedirect(response, `${config.publicOrigin}${safeReturnPath(url.searchParams.get("return"))}`, issueSessionCookies(session));
        return true;
      }

      if (request.method === "GET" && pathname === LOGIN_PATH) {
        const returnTo = safeReturnPath(url.searchParams.get("return"));
        if (!config.oauthConfigured) {
          if (config.testDouble) {
            sendRedirect(response, `${TEST_LOGIN_PATH}?return=${encodeURIComponent(returnTo)}`);
            return true;
          }
          sendJson(response, 503, {
            error: "GitHub OAuth is not configured. Set OKIE_GITHUB_CLIENT_ID and OKIE_GITHUB_CLIENT_SECRET.",
            loginPath: LOGIN_PATH,
          });
          return true;
        }
        const state = beginState(returnTo);
        sendRedirect(response, githubAuthorizeUrl(config, state), [
          cookieHeader(OAUTH_STATE_COOKIE, state, { maxAge: STATE_TTL_MS / 1000, secure: config.secureCookies }),
        ]);
        return true;
      }

      if (request.method === "GET" && pathname === CALLBACK_PATH) {
        const cookies = parseCookieHeader(request.headers.cookie);
        const pendingRow = consumeState(url.searchParams.get("state"), cookies[OAUTH_STATE_COOKIE]);
        if (!pendingRow) {
          sendJson(response, 400, { error: "OAuth state mismatch. Start sign-in again." });
          return true;
        }
        const denied = url.searchParams.get("error");
        if (denied) {
          sendRedirect(response, `${config.publicOrigin}${pendingRow.returnTo}`, [
            clearCookieHeader(OAUTH_STATE_COOKIE, config.secureCookies),
          ]);
          return true;
        }
        const code = url.searchParams.get("code")?.trim();
        if (!code) {
          sendJson(response, 400, { error: "OAuth code missing. Start sign-in again." });
          return true;
        }
        try {
          const token = await adapter.exchangeCode(code, oauthCallbackUrl(config));
          const user = await adapter.fetchUser(token);
          const session = store.create({
            login: user.login,
            userId: String(user.id),
            source: "oauth",
            token,
          });
          sendRedirect(response, `${config.publicOrigin}${pendingRow.returnTo}`, issueSessionCookies(session));
        } catch (error) {
          const raw = error instanceof Error ? error.message : String(error);
          sendJson(response, 502, { error: scrubGithubTokens(raw) });
        }
        return true;
      }

      if (request.method === "GET" && pathname === INSTALL_PATH) {
        const returnTo = safeReturnPath(url.searchParams.get("return"));
        if (!config.appSlug) {
          sendJson(response, 503, { error: "GitHub App install is not configured. Set OKIE_GITHUB_APP_SLUG." });
          return true;
        }
        const state = beginState(returnTo);
        sendRedirect(response, githubAppInstallUrl(config, state)!, [
          cookieHeader(OAUTH_STATE_COOKIE, state, { maxAge: STATE_TTL_MS / 1000, secure: config.secureCookies }),
        ]);
        return true;
      }

      if (request.method === "GET" && pathname === SETUP_PATH) {
        const cookies = parseCookieHeader(request.headers.cookie);
        const pendingRow = consumeState(url.searchParams.get("state"), cookies[OAUTH_STATE_COOKIE]);
        const returnTo = pendingRow?.returnTo ?? DEFAULT_RETURN_PATH;
        sendRedirect(response, `${config.publicOrigin}${returnTo}`, [
          clearCookieHeader(OAUTH_STATE_COOKIE, config.secureCookies),
        ]);
        return true;
      }

      return false;
    },
  };
}
