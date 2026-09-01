import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { githubClientForAccess, resolveScanGithubAccess, scanQuotaKey } from "./githubAccess.js";
import type { GithubSession } from "./githubOAuth.js";

const FAKE_OPERATOR_GHO = "gho_okieTestOperatorTokenCla30xxxx";
const FAKE_OPERATOR_GHP = "ghp_okieTestOperatorTokenCla30yyyy";
const FAKE_USER_BEARER = "gho_okieTestUserTokenCla30zzzz";
const FAKE_TEST_DOUBLE = "gho_okieTestDoubleTokenCla30xxxxx";

const oauthSession: GithubSession = {
  id: "session-oauth",
  login: "octocat",
  userId: "1",
  source: "oauth",
  token: FAKE_USER_BEARER,
  createdAt: 1,
};

const testDoubleSession: GithubSession = {
  id: "session-test",
  login: "okie-test-user",
  userId: "0",
  source: "test-double",
  token: FAKE_TEST_DOUBLE,
  createdAt: 1,
};

test("hosted scan identity is unauthenticated without a session even when Authorization and operator tokens are present", () => {
  const previousGithub = process.env.GITHUB_TOKEN;
  const previousGh = process.env.GH_TOKEN;
  process.env.GITHUB_TOKEN = FAKE_OPERATOR_GHO;
  process.env.GH_TOKEN = FAKE_OPERATOR_GHP;
  try {
    assert.deepEqual(resolveScanGithubAccess({}), { kind: "unauthenticated" });
    assert.deepEqual(
      resolveScanGithubAccess({ headers: { authorization: `Bearer ${FAKE_USER_BEARER}` } }),
      { kind: "unauthenticated" },
    );
  } finally {
    if (previousGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithub;
    if (previousGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGh;
  }
});

test("a GitHub session is the only hosted scan grant", () => {
  const access = resolveScanGithubAccess({
    session: oauthSession,
    headers: { authorization: `Bearer ${FAKE_OPERATOR_GHO}` },
  });
  assert.equal(access.kind, "github");
  if (access.kind !== "github") throw new Error("expected github access");
  assert.equal(access.login, "octocat");
  assert.equal(access.source, "oauth");
  assert.equal(access.token, FAKE_USER_BEARER);
  assert.equal(scanQuotaKey(access), "gh:1");
});

test("githubClientForAccess sends Bearer for OAuth and never shells out to gh", async () => {
  const originalFetch = globalThis.fetch;
  const originalPath = process.env.PATH ?? "";
  const work = mkdtempSync(join(tmpdir(), "okie-gh-access-"));
  const bin = join(work, "bin");
  const sentinel = join(work, "gh-invoked");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(sentinel)}\nexit 1\n`);
  chmodSync(join(bin, "gh"), 0o755);

  const authorizationHeaders: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    if (authorization) authorizationHeaders.push(authorization);
    assert.equal(url.includes(FAKE_USER_BEARER), false);
    return new Response("Not Found", { status: 404, headers: { "content-type": "application/json" } });
  };
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.GITHUB_TOKEN = FAKE_OPERATOR_GHO;
  process.env.GH_TOKEN = FAKE_OPERATOR_GHP;

  try {
    const client = githubClientForAccess(resolveScanGithubAccess({ session: oauthSession }));
    await client.getJson("/repos/acme/public");
    assert.deepEqual(authorizationHeaders, [`Bearer ${FAKE_USER_BEARER}`]);
    assert.equal(existsSync(sentinel), false, "operator gh CLI must not run for hosted OAuth access");

    authorizationHeaders.length = 0;
    const testDouble = githubClientForAccess(resolveScanGithubAccess({ session: testDoubleSession }));
    await testDouble.getJson("/repos/acme/public");
    assert.deepEqual(authorizationHeaders, [], "test-double tokens must not be sent to GitHub");
    assert.equal(existsSync(sentinel), false);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.PATH = originalPath;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    rmSync(work, { recursive: true, force: true });
  }
});

test("githubClientForAccess throws for unauthenticated hosted scan", () => {
  assert.throws(() => githubClientForAccess({ kind: "unauthenticated" }), /GitHub sign-in/);
});
