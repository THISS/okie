import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import {
  CALLBACK_PATH,
  LOGIN_PATH,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  TEST_LOGIN_PATH,
  createGithubAuthService,
  githubAuthorizeUrl,
  oauthCallbackUrl,
  resolveGithubOAuthConfig,
  safeReturnPath,
} from "./githubOAuth.js";

const FAKE_CLIENT_ID = "Iv1.okieTestGithubClientIdCla30";
const FAKE_CLIENT_SECRET = "okie-test-github-client-secret-cla30-fake";
const FAKE_ACCESS_TOKEN = "gho_okieTestOauthAccessTokenCla30xx";

function cookieFromSetCookie(setCookie: string | string[] | undefined, name: string): string | undefined {
  const headers = setCookie === undefined ? [] : Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const header of headers) {
    if (header.startsWith(`${name}=`)) return header.split(";")[0]!.slice(`${name}=`.length);
  }
  return undefined;
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected tcp address");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}

test("OAuth config never reads GITHUB_TOKEN / GH_TOKEN and defaults test-double on loopback", () => {
  const previousGithub = process.env.GITHUB_TOKEN;
  const previousGh = process.env.GH_TOKEN;
  process.env.GITHUB_TOKEN = "gho_okieTestOperatorTokenCla30xxxx";
  process.env.GH_TOKEN = "ghp_okieTestOperatorTokenCla30yyyy";
  try {
    const loopback = resolveGithubOAuthConfig({}, "127.0.0.1");
    assert.equal(loopback.oauthConfigured, false);
    assert.equal(loopback.testDouble, true);
    assert.equal(loopback.clientSecret, undefined);
    const publicBind = resolveGithubOAuthConfig({}, "0.0.0.0");
    assert.equal(publicBind.testDouble, false);
    const configured = resolveGithubOAuthConfig({
      OKIE_GITHUB_CLIENT_ID: FAKE_CLIENT_ID,
      OKIE_GITHUB_CLIENT_SECRET: FAKE_CLIENT_SECRET,
      OKIE_PUBLIC_ORIGIN: "https://atlas.example.test",
    }, "127.0.0.1");
    assert.equal(configured.oauthConfigured, true);
    assert.equal(configured.testDouble, false);
    assert.equal(configured.publicOrigin, "https://atlas.example.test");
    assert.equal(oauthCallbackUrl(configured), "https://atlas.example.test/api/auth/github/callback");
  } finally {
    if (previousGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithub;
    if (previousGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGh;
  }
});

test("OAuth authorize URL uses configured origin, not a Host header, and omits the secret", () => {
  const config = resolveGithubOAuthConfig({
    OKIE_GITHUB_CLIENT_ID: FAKE_CLIENT_ID,
    OKIE_GITHUB_CLIENT_SECRET: FAKE_CLIENT_SECRET,
    OKIE_PUBLIC_ORIGIN: "http://localhost:4173",
  }, "127.0.0.1");
  const url = githubAuthorizeUrl(config, "a".repeat(64));
  assert.match(url, /client_id=Iv1\.okieTestGithubClientIdCla30/);
  assert.match(url, /redirect_uri=http%3A%2F%2Flocalhost%3A4173%2Fapi%2Fauth%2Fgithub%2Fcallback/);
  assert.equal(url.includes(FAKE_CLIENT_SECRET), false);
  assert.equal(safeReturnPath("https://evil.example/"), "/new");
  assert.equal(safeReturnPath("//evil.example"), "/new");
  assert.equal(safeReturnPath("/r/THISS/okie"), "/r/THISS/okie");
});

test("OAuth callback rejects a missing or mismatched CSRF state", async () => {
  const auth = createGithubAuthService({
    bind: "127.0.0.1",
    env: {
      OKIE_GITHUB_CLIENT_ID: FAKE_CLIENT_ID,
      OKIE_GITHUB_CLIENT_SECRET: FAKE_CLIENT_SECRET,
      OKIE_GITHUB_TEST_DOUBLE: "0",
      OKIE_PUBLIC_ORIGIN: "http://localhost:4173",
    },
    adapter: {
      exchangeCode: async () => FAKE_ACCESS_TOKEN,
      fetchUser: async () => ({ login: "octocat", id: 1 }),
    },
  });
  const http = await listen((request, response) => {
    void auth.handle(request, response, new URL(request.url ?? "/", "http://localhost"));
  });
  try {
    const start = await fetch(`${http.origin}${LOGIN_PATH}`, { redirect: "manual" });
    assert.equal(start.status, 302);
    const location = start.headers.get("location") ?? "";
    assert.equal(location.includes(FAKE_CLIENT_SECRET), false);
    assert.equal(location.includes("evil.example"), false);
    const stateCookie = cookieFromSetCookie(start.headers.getSetCookie(), OAUTH_STATE_COOKIE);
    assert.ok(stateCookie);

    const missing = await fetch(`${http.origin}${CALLBACK_PATH}?code=okie-test-code&state=nope`);
    assert.equal(missing.status, 400);
    assert.match(await missing.text(), /state mismatch/i);

    const mismatched = await fetch(`${http.origin}${CALLBACK_PATH}?code=okie-test-code&state=nope`, {
      headers: { cookie: `${OAUTH_STATE_COOKIE}=${stateCookie}` },
    });
    assert.equal(mismatched.status, 400);

    const startUrl = new URL(location);
    const ok = await fetch(`${http.origin}${CALLBACK_PATH}?code=okie-test-code&state=${startUrl.searchParams.get("state")}`, {
      headers: { cookie: `${OAUTH_STATE_COOKIE}=${stateCookie}` },
      redirect: "manual",
    });
    assert.equal(ok.status, 302);
    const redirectTo = ok.headers.get("location") ?? "";
    assert.equal(redirectTo, "http://localhost:4173/new");
    assert.equal(redirectTo.includes(FAKE_ACCESS_TOKEN), false);
    assert.equal(redirectTo.includes("okie-test-code"), false);
    const session = cookieFromSetCookie(ok.headers.getSetCookie(), SESSION_COOKIE);
    assert.ok(session);

    const me = await fetch(`${http.origin}/api/auth/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    const body = await me.json() as { authenticated: boolean; login: string; token?: string; accessToken?: string };
    assert.equal(body.authenticated, true);
    assert.equal(body.login, "octocat");
    assert.equal("token" in body, false);
    assert.equal("accessToken" in body, false);
    assert.equal(JSON.stringify(body).includes(FAKE_ACCESS_TOKEN), false);
    assert.equal(JSON.stringify(body).includes(FAKE_CLIENT_SECRET), false);
  } finally {
    await http.close();
  }
});

test("loopback test-double login sets a session and is absent when bind is not loopback", async () => {
  const loopback = createGithubAuthService({
    bind: "127.0.0.1",
    env: { OKIE_GITHUB_TEST_DOUBLE: "1", OKIE_PUBLIC_ORIGIN: "http://localhost:4173" },
  });
  const remote = createGithubAuthService({
    bind: "0.0.0.0",
    env: { OKIE_GITHUB_TEST_DOUBLE: "1", OKIE_PUBLIC_ORIGIN: "http://localhost:4173" },
  });
  const http = await listen((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const service = url.searchParams.get("mode") === "remote" ? remote : loopback;
    void service.handle(request, response, url);
  });
  try {
    const denied = await fetch(`${http.origin}${TEST_LOGIN_PATH}?mode=remote`);
    assert.equal(denied.status, 404);
    const ok = await fetch(`${http.origin}${TEST_LOGIN_PATH}`, { redirect: "manual" });
    assert.equal(ok.status, 302);
    const location = ok.headers.get("location") ?? "";
    assert.equal(location.includes("gho_"), false);
    const session = cookieFromSetCookie(ok.headers.getSetCookie(), SESSION_COOKIE);
    assert.ok(session);
    const me = await fetch(`${http.origin}/api/auth/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${session}` },
    });
    const body = await me.json() as { authenticated: boolean; login: string; source: string };
    assert.equal(body.login, "okie-test-user");
    assert.equal(body.source, "test-double");
  } finally {
    await http.close();
  }
});
