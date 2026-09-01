import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { githubClientForAccess, resolveScanGithubAccess } from "./githubAccess.js";

const FAKE_OPERATOR_GHO = "gho_okieTestOperatorTokenCla30xxxx";
const FAKE_OPERATOR_GHP = "ghp_okieTestOperatorTokenCla30yyyy";
const FAKE_USER_BEARER = "gho_okieTestUserTokenCla30zzzz";

test("hosted scan identity is anonymous even when Authorization and operator tokens are present", () => {
  const previousGithub = process.env.GITHUB_TOKEN;
  const previousGh = process.env.GH_TOKEN;
  process.env.GITHUB_TOKEN = FAKE_OPERATOR_GHO;
  process.env.GH_TOKEN = FAKE_OPERATOR_GHP;
  try {
    assert.deepEqual(resolveScanGithubAccess({}), { kind: "anonymous" });
    assert.deepEqual(
      resolveScanGithubAccess({ authorization: `Bearer ${FAKE_USER_BEARER}` }),
      { kind: "anonymous" },
    );
  } finally {
    if (previousGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previousGithub;
    if (previousGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGh;
  }
});

test("githubClientForAccess never sends operator or request tokens and never shells out to gh", async () => {
  const originalFetch = globalThis.fetch;
  const originalPath = process.env.PATH ?? "";
  const work = mkdtempSync(join(tmpdir(), "okie-gh-access-"));
  const bin = join(work, "bin");
  const sentinel = join(work, "gh-invoked");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(sentinel)}\nexit 1\n`);
  chmodSync(join(bin, "gh"), 0o755);

  const authorizationHeaders: string[] = [];
  globalThis.fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    if (authorization) authorizationHeaders.push(authorization);
    return new Response("Not Found", { status: 404, headers: { "content-type": "application/json" } });
  };
  process.env.PATH = `${bin}:${originalPath}`;
  process.env.GITHUB_TOKEN = FAKE_OPERATOR_GHO;
  process.env.GH_TOKEN = FAKE_OPERATOR_GHP;

  try {
    const anonymous = githubClientForAccess(resolveScanGithubAccess({
      authorization: `Bearer ${FAKE_USER_BEARER}`,
    }));
    const json = await anonymous.getJson("/repos/acme/secret");
    assert.equal(json.ok, false);
    assert.deepEqual(authorizationHeaders, [], "anonymous hosted scans must not attach a Bearer token");
    assert.equal(existsSync(sentinel), false, "operator gh CLI must not run for hosted anonymous access");

    // The github-identity seam exists but is not wired this PR — a token on the
    // access object still must not hit the wire or the operator CLI.
    const unwired = githubClientForAccess({ kind: "github", source: "oauth", token: FAKE_USER_BEARER });
    await unwired.getJson("/repos/acme/secret");
    assert.deepEqual(authorizationHeaders, []);
    assert.equal(existsSync(sentinel), false);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.PATH = originalPath;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    rmSync(work, { recursive: true, force: true });
  }
});
