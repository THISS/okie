import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GithubClient } from "@okie/scan";
import { createScanJobQueue } from "./jobs.js";
import { createDefaultEnricherFactory, createScanJobRunner } from "./scanService.js";

test("HTTP scan runner fails closed on a private-repo 404 without an explicit token", async () => {
  const calls: string[] = [];
  const client: GithubClient = {
    async getJson(apiPath) {
      calls.push(apiPath);
      return { ok: false, status: 404, rateLimited: false, message: "Not Found" };
    },
    async downloadTarball() {
      calls.push("tarball");
      throw new Error("downloadTarball must not run without a resolved commit");
    },
  };
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-root-"));
  try {
    const queue = createScanJobQueue(createScanJobRunner({ scanRoot, enrich: "off", githubClient: client }));
    queue.submit({ owner: "acme", repo: "secret", slug: "acme__secret" });
    await queue.idle();
    const job = queue.list()[0]!;
    assert.equal(job.stage, "failed");
    assert.match(job.error ?? "", /not found.*public/i);
    assert.deepEqual(calls, ["/repos/acme/secret"]);
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
  }
});

test("HTTP scan runner does not invoke operator gh auth on a private-repo 404", async () => {
  const originalFetch = globalThis.fetch;
  const originalPath = process.env.PATH ?? "";
  const work = mkdtempSync(join(tmpdir(), "okie-http-scan-"));
  const scanRoot = join(work, "scan-root");
  const bin = join(work, "bin");
  const sentinel = join(work, "gh-invoked");
  mkdirSync(bin, { recursive: true });
  mkdirSync(scanRoot, { recursive: true });
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(sentinel)}\nexit 1\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);

  globalThis.fetch = async () => new Response("Not Found", {
    status: 404,
    headers: { "content-type": "application/json" },
  });
  process.env.PATH = `${bin}:${originalPath}`;

  try {
    const queue = createScanJobQueue(createScanJobRunner({ scanRoot, enrich: "off" }));
    queue.submit({ owner: "acme", repo: "secret", slug: "acme__secret" });
    await queue.idle();
    const job = queue.list()[0]!;
    assert.equal(job.stage, "failed");
    assert.match(job.error ?? "", /not found.*public/i);
    assert.equal(existsSync(sentinel), false, "operator gh CLI must not run on the unauthenticated HTTP path");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.PATH = originalPath;
    rmSync(work, { recursive: true, force: true });
  }
});

const FAKE_GATEWAY_KEY = "okie-test-llm-key-cla20-fake";

test("auto enricher factory skips without a key and constructs a client when a gateway key is set", () => {
  const skipped = createDefaultEnricherFactory("auto", {})(() => {});
  assert.equal(skipped, undefined);

  const anthropicOnly = createDefaultEnricherFactory("auto", { ANTHROPIC_API_KEY: "okie-test-anthropic-key-cla20-fake" })(() => {});
  assert.ok(anthropicOnly);

  const gateway = createDefaultEnricherFactory("auto", { OPENROUTER_API_KEY: FAKE_GATEWAY_KEY })(() => {});
  assert.ok(gateway);
});

test("auto enricher factory fails closed on an empty model id instead of substituting the default", async () => {
  const hook = createDefaultEnricherFactory("auto", {
    OPENROUTER_API_KEY: FAKE_GATEWAY_KEY,
    OPENROUTER_MODEL: "  ",
  })(() => {});
  assert.ok(hook);
  await assert.rejects(() => hook({
    packets: [],
    manifest: { promptVersion: "okie-enrichment/v2", packets: [] },
  }), /empty model id/);
});

function makeTarball(topDir: string, files: Record<string, string>): { tgz: string; cleanup: () => void } {
  const work = mkdtempSync(join(tmpdir(), "okie-scan-tar-"));
  for (const [relative, content] of Object.entries(files)) {
    const full = join(work, topDir, relative);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  const tgz = join(work, "archive.tar.gz");
  execFileSync("tar", ["-czf", tgz, "-C", work, topDir]);
  return { tgz, cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

test("no LLM key skips enrichment and still publishes the deterministic atlas", async () => {
  const fixture = makeTarball("acme-app-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
    "package.json": JSON.stringify({ name: "acme-app" }),
    "src/index.ts": "export const ping = () => 'pong';\n",
  });
  const commitSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const client: GithubClient = {
    async getJson(apiPath) {
      if (apiPath === "/repos/acme/app") return { ok: true, json: { default_branch: "main" } };
      if (apiPath === "/repos/acme/app/commits/main" || apiPath === `/repos/acme/app/commits/${commitSha}`) {
        return {
          ok: true,
          json: {
            sha: commitSha,
            commit: { committer: { date: "2024-01-01T00:00:00Z" }, tree: { sha: "tree-sha" } },
          },
        };
      }
      return { ok: false, status: 404, rateLimited: false, message: "not found" };
    },
    async downloadTarball(_owner, _repo, _sha, destFile) {
      copyFileSync(fixture.tgz, destFile);
      return statSync(destFile).size;
    },
  };
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-root-"));
  const logs: string[] = [];
  try {
    const queue = createScanJobQueue(createScanJobRunner({
      scanRoot,
      enrich: "auto",
      env: {},
      githubClient: client,
      log: line => logs.push(line),
    }));
    queue.submit({ owner: "acme", repo: "app", slug: "acme__app" });
    await queue.idle();
    const job = queue.list()[0]!;
    assert.equal(job.stage, "complete");
    assert.equal(job.atlasReady, true);
    assert.equal(job.enrichment.state, "skipped");
    assert.match(job.enrichment.note ?? "", /no LLM credentials visible/);
    assert.doesNotMatch(job.enrichment.note ?? "", /ANTHROPIC_API_KEY=\S+/);
    assert.ok(existsSync(join(scanRoot, "acme__app", "snapshot.json")));
    assert.ok(existsSync(join(scanRoot, "index.json")));
    assert.ok(logs.every(line => !line.includes(FAKE_GATEWAY_KEY)));
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("job logs redact a gateway key if a provider error echoes it", async () => {
  const fixture = makeTarball("acme-app-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", {
    "package.json": JSON.stringify({ name: "acme-app" }),
    "src/index.ts": "export const ping = () => 'pong';\n",
  });
  const commitSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const client: GithubClient = {
    async getJson(apiPath) {
      if (apiPath === "/repos/acme/app") return { ok: true, json: { default_branch: "main" } };
      if (apiPath === "/repos/acme/app/commits/main" || apiPath === `/repos/acme/app/commits/${commitSha}`) {
        return {
          ok: true,
          json: {
            sha: commitSha,
            commit: { committer: { date: "2024-01-01T00:00:00Z" }, tree: { sha: "tree-sha" } },
          },
        };
      }
      return { ok: false, status: 404, rateLimited: false, message: "not found" };
    },
    async downloadTarball(_owner, _repo, _sha, destFile) {
      copyFileSync(fixture.tgz, destFile);
      return statSync(destFile).size;
    },
  };
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-root-"));
  const logs: string[] = [];
  try {
    const queue = createScanJobQueue(createScanJobRunner({
      scanRoot,
      enrich: "auto",
      env: { OPENROUTER_API_KEY: FAKE_GATEWAY_KEY },
      githubClient: client,
      log: line => logs.push(line),
      enricherFactory: () => async () => {
        throw new Error(`unauthorized: ${FAKE_GATEWAY_KEY}`);
      },
    }));
    queue.submit({ owner: "acme", repo: "app", slug: "acme__app" });
    await queue.idle();
    const job = queue.list()[0]!;
    assert.equal(job.atlasReady, true);
    assert.equal(job.enrichment.state, "failed");
    assert.doesNotMatch(job.enrichment.note ?? "", new RegExp(FAKE_GATEWAY_KEY));
    assert.match(job.enrichment.note ?? "", /\[redacted-llm-key\]/);
    assert.ok(logs.every(line => !line.includes(FAKE_GATEWAY_KEY)));
    assert.ok(existsSync(join(scanRoot, "acme__app", "snapshot.json")));
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
    fixture.cleanup();
  }
});

function githubClientForTarball(commitSha: string, tgz: string): GithubClient {
  return {
    async getJson(apiPath) {
      if (apiPath === "/repos/acme/app") return { ok: true, json: { default_branch: "main" } };
      if (apiPath === "/repos/acme/app/commits/main" || apiPath === `/repos/acme/app/commits/${commitSha}`) {
        return {
          ok: true,
          json: {
            sha: commitSha,
            commit: { committer: { date: "2024-01-01T00:00:00Z" }, tree: { sha: "tree-sha" } },
          },
        };
      }
      return { ok: false, status: 404, rateLimited: false, message: "not found" };
    },
    async downloadTarball(_owner, _repo, _sha, destFile) {
      copyFileSync(tgz, destFile);
      return statSync(destFile).size;
    },
  };
}

test("empty model id fails enrichment only; deterministic atlas still publishes", async () => {
  const fixture = makeTarball("acme-app-cccccccccccccccccccccccccccccccccccccccc", {
    "package.json": JSON.stringify({ name: "acme-app" }),
    "src/index.ts": "export const ping = () => 'pong';\n",
  });
  const commitSha = "cccccccccccccccccccccccccccccccccccccccc";
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-root-"));
  const logs: string[] = [];
  try {
    const queue = createScanJobQueue(createScanJobRunner({
      scanRoot,
      enrich: "auto",
      env: { OPENROUTER_API_KEY: FAKE_GATEWAY_KEY, OPENROUTER_MODEL: "" },
      githubClient: githubClientForTarball(commitSha, fixture.tgz),
      log: line => logs.push(line),
    }));
    queue.submit({ owner: "acme", repo: "app", slug: "acme__app" });
    await queue.idle();
    const job = queue.list()[0]!;
    assert.equal(job.stage, "complete");
    assert.equal(job.atlasReady, true);
    assert.equal(job.enrichment.state, "failed");
    assert.match(job.enrichment.note ?? "", /empty model id/);
    assert.equal(job.error, undefined);
    assert.ok(existsSync(join(scanRoot, "acme__app", "snapshot.json")));
    assert.ok(existsSync(join(scanRoot, "index.json")));
    assert.ok(logs.some(line => line.includes("deterministic atlas stands")));
    assert.ok(logs.every(line => !line.includes(FAKE_GATEWAY_KEY)));
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("invalid model id fails enrichment only; deterministic atlas still publishes", async () => {
  const fixture = makeTarball("acme-app-dddddddddddddddddddddddddddddddddddddddd", {
    "package.json": JSON.stringify({ name: "acme-app" }),
    "src/index.ts": "export const ping = () => 'pong';\n",
  });
  const commitSha = "dddddddddddddddddddddddddddddddddddddddd";
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-root-"));
  const logs: string[] = [];
  try {
    const queue = createScanJobQueue(createScanJobRunner({
      scanRoot,
      enrich: "auto",
      env: { OPENROUTER_API_KEY: FAKE_GATEWAY_KEY, OPENROUTER_MODEL: "not-a-real-model" },
      githubClient: githubClientForTarball(commitSha, fixture.tgz),
      log: line => logs.push(line),
      enricherFactory: () => async () => {
        throw new Error("llm gateway 400: model not-a-real-model is not a valid model ID");
      },
    }));
    queue.submit({ owner: "acme", repo: "app", slug: "acme__app" });
    await queue.idle();
    const job = queue.list()[0]!;
    assert.equal(job.stage, "complete");
    assert.equal(job.atlasReady, true);
    assert.equal(job.enrichment.state, "failed");
    assert.match(job.enrichment.note ?? "", /not-a-real-model/);
    assert.equal(job.error, undefined);
    assert.ok(existsSync(join(scanRoot, "acme__app", "snapshot.json")));
    assert.ok(logs.every(line => !line.includes(FAKE_GATEWAY_KEY)));
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
    fixture.cleanup();
  }
});
