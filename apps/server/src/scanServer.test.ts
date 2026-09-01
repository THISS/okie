import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GithubClient } from "@okie/scan";
import { createGithubAuthService, SESSION_COOKIE, TEST_LOGIN_PATH } from "./githubOAuth.js";
import { createScanJobQueue, createSubmitLimiter } from "./jobs.js";
import { createScanHttpHandler } from "./scanServer.js";
import { createScanJobRunner } from "./scanService.js";

const FAKE_TOKEN = "gho_okieTestOauthAccessTokenCla30xx";
const FAKE_SECRET = "okie-test-github-client-secret-cla30-fake";

function cookieFromSetCookie(setCookie: string[], name: string): string | undefined {
  for (const header of setCookie) {
    if (header.startsWith(`${name}=`)) return header.split(";")[0]!.slice(`${name}=`.length);
  }
  return undefined;
}

async function withServer(
  handler: ReturnType<typeof createScanHttpHandler>,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected tcp address");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function mockGithubClient(): GithubClient {
  return {
    async getJson(apiPath) {
      if (apiPath === "/repos/lukeed/clsx") return { ok: true, json: { default_branch: "master" } };
      return { ok: false, status: 404, rateLimited: false, message: "Not Found" };
    },
    async downloadTarball() {
      throw new Error("download should not run in the auth-gate test");
    },
  };
}

test("unauthenticated POST /api/scans is denied and does not enqueue", async () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-auth-"));
  const submitted: string[] = [];
  const queue = createScanJobQueue(async job => {
    submitted.push(job.slug);
  });
  const auth = createGithubAuthService({
    bind: "127.0.0.1",
    env: { OKIE_GITHUB_TEST_DOUBLE: "0", OKIE_PUBLIC_ORIGIN: "http://localhost:4173" },
  });
  const handler = createScanHttpHandler({
    queue,
    allowSubmit: createSubmitLimiter(),
    auth,
    scanRoot,
    llm: { baseUrl: "https://openrouter.ai/api/v1", modelId: "anthropic/claude-sonnet-4", keySource: "none" },
    enrich: "off",
    bind: "127.0.0.1",
  });
  try {
    await withServer(handler, async origin => {
      const denied = await fetch(`${origin}/api/scans`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${FAKE_TOKEN}` },
        body: JSON.stringify({ url: "https://github.com/lukeed/clsx" }),
      });
      assert.equal(denied.status, 401);
      const body = await denied.json() as { error: string; auth: { required: boolean; loginPath: string }; job?: unknown };
      assert.match(body.error, /Sign in with GitHub/);
      assert.equal(body.auth.required, true);
      assert.equal("job" in body, false);
      assert.equal(JSON.stringify(body).includes(FAKE_TOKEN), false);
      assert.deepEqual(submitted, []);

      const health = await fetch(`${origin}/healthz`);
      const healthBody = await health.json() as Record<string, unknown>;
      assert.equal(healthBody.ok, true);
      assert.equal("token" in healthBody, false);
      assert.equal("clientSecret" in healthBody, false);
      assert.equal(JSON.stringify(healthBody).includes(FAKE_TOKEN), false);
      assert.equal(JSON.stringify(healthBody).includes(FAKE_SECRET), false);

      const objects = await fetch(`${origin}/scan/index.json`);
      assert.equal(objects.status, 404);
    });
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
  }
});

test("authenticated POST /api/scans enqueues and never puts the token on the job JSON", async () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-auth-ok-"));
  const queue = createScanJobQueue(createScanJobRunner({
    scanRoot,
    enrich: "off",
    githubClient: mockGithubClient(),
  }));
  const auth = createGithubAuthService({
    bind: "127.0.0.1",
    env: {
      OKIE_GITHUB_TEST_DOUBLE: "1",
      OKIE_PUBLIC_ORIGIN: "http://localhost:4173",
    },
  });
  const handler = createScanHttpHandler({
    queue,
    allowSubmit: createSubmitLimiter(),
    auth,
    scanRoot,
    llm: { baseUrl: "https://openrouter.ai/api/v1", modelId: "anthropic/claude-sonnet-4", keySource: "none" },
    enrich: "off",
    bind: "127.0.0.1",
  });
  try {
    await withServer(handler, async origin => {
      const login = await fetch(`${origin}${TEST_LOGIN_PATH}`, { redirect: "manual" });
      const session = cookieFromSetCookie(login.headers.getSetCookie(), SESSION_COOKIE);
      assert.ok(session);

      const posted = await fetch(`${origin}/api/scans`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=${session}`,
        },
        body: JSON.stringify({ url: "https://github.com/lukeed/clsx" }),
      });
      assert.equal(posted.status, 202);
      const body = await posted.json() as { job: { slug: string; githubAccess?: unknown; token?: unknown } };
      assert.equal(body.job.slug, "lukeed__clsx");
      assert.equal("githubAccess" in body.job, false);
      assert.equal("token" in body.job, false);
      const json = JSON.stringify(body);
      assert.equal(json.includes("gho_"), false);
      await queue.idle();
    });
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
  }
});
