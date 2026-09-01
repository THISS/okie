import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GithubClient } from "@okie/scan";
import { createScanJobQueue, toPublicJob } from "./jobs.js";
import { createDefaultEnricherFactory, createScanJobRunner, type ScanServiceOptions } from "./scanService.js";

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

test("hosted scan refuses a private tree even when the GitHub token can see it", async () => {
  const calls: string[] = [];
  const client: GithubClient = {
    async getJson(apiPath) {
      calls.push(apiPath);
      return { ok: true, json: { default_branch: "main", private: true } };
    },
    async downloadTarball() {
      calls.push("tarball");
      throw new Error("downloadTarball must not run for a private hosted tree");
    },
  };
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-root-"));
  try {
    const queue = createScanJobQueue(createScanJobRunner({ scanRoot, enrich: "off", githubClient: client }));
    queue.submit({
      owner: "acme",
      repo: "secret",
      slug: "acme__secret",
      githubAccess: {
        kind: "github",
        source: "oauth",
        token: "gho_okieTestUserTokenCla30zzzz",
        login: "octocat",
        userId: "1",
      },
    });
    await queue.idle();
    const job = queue.list()[0]!;
    assert.equal(job.stage, "failed");
    assert.match(job.error ?? "", /private/i);
    assert.equal(JSON.stringify(toPublicJob(job)).includes("gho_okieTestUserTokenCla30zzzz"), false);
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
    queue.submit({
      owner: "acme",
      repo: "secret",
      slug: "acme__secret",
      githubAccess: {
        kind: "github",
        source: "test-double",
        token: "gho_okieTestDoubleTokenCla30xxxxx",
        login: "okie-test-user",
        userId: "0",
      },
    });
    await queue.idle();
    const job = queue.list()[0]!;
    assert.equal(job.stage, "failed");
    assert.match(job.error ?? "", /public/i);
    assert.equal(existsSync(sentinel), false, "operator gh CLI must not run on the hosted HTTP path");
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
    assert.equal(job.enrichment.modelId, undefined);
    assert.equal(job.enrichment.provider, undefined);
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
    assert.equal(job.enrichment.modelId, "anthropic/claude-sonnet-4");
    assert.equal(job.enrichment.provider, "openrouter.ai");
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
    assert.equal(job.enrichment.modelId, undefined);
    assert.equal(job.enrichment.provider, "openrouter.ai");
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
    assert.equal(job.enrichment.modelId, "not-a-real-model");
    assert.equal(job.enrichment.provider, "openrouter.ai");
    assert.equal(job.error, undefined);
    assert.ok(existsSync(join(scanRoot, "acme__app", "snapshot.json")));
    assert.ok(logs.every(line => !line.includes(FAKE_GATEWAY_KEY)));
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("gateway 429 fails enrichment only; deterministic atlas still publishes", async () => {
  const fixture = makeTarball("acme-app-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", {
    "package.json": JSON.stringify({ name: "acme-app" }),
    "src/index.ts": "export const ping = () => 'pong';\n",
  });
  const commitSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-root-"));
  const logs: string[] = [];
  try {
    const queue = createScanJobQueue(createScanJobRunner({
      scanRoot,
      enrich: "auto",
      env: { OPENROUTER_API_KEY: FAKE_GATEWAY_KEY },
      githubClient: githubClientForTarball(commitSha, fixture.tgz),
      log: line => logs.push(line),
      enricherFactory: () => async () => {
        throw new Error(`enrichment failed (llm gateway 429: quota ${FAKE_GATEWAY_KEY}); remaining scopes skipped`);
      },
    }));
    queue.submit({ owner: "acme", repo: "app", slug: "acme__app" });
    await queue.idle();
    const job = queue.list()[0]!;
    assert.equal(job.stage, "complete");
    assert.equal(job.atlasReady, true);
    assert.equal(job.enrichment.state, "failed");
    assert.match(job.enrichment.note ?? "", /429/);
    assert.match(job.enrichment.note ?? "", /remaining scopes skipped/);
    assert.doesNotMatch(job.enrichment.note ?? "", new RegExp(FAKE_GATEWAY_KEY));
    assert.equal(job.error, undefined);
    assert.ok(existsSync(join(scanRoot, "acme__app", "snapshot.json")));
    assert.ok(logs.some(line => line.includes("deterministic atlas stands")));
    assert.ok(logs.every(line => !line.includes(FAKE_GATEWAY_KEY)));
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("off and rejected enrichment publish the same overview story; accepted summaries polish narration", async () => {
  const fixture = makeTarball("acme-app-ffffffffffffffffffffffffffffffffffffffff", {
    "package.json": JSON.stringify({ name: "acme-app" }),
    "README.md": "# Acme\nTiny ping library.\n",
    "src/index.ts": "export const ping = () => 'pong';\n",
  });
  const commitSha = "ffffffffffffffffffffffffffffffffffffffff";
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-root-"));
  const logs: string[] = [];
  const run = async (slug: string, enricherFactory?: ScanServiceOptions["enricherFactory"]) => {
    const queue = createScanJobQueue(createScanJobRunner({
      scanRoot,
      enrich: enricherFactory ? "auto" : "off",
      env: enricherFactory ? { OPENROUTER_API_KEY: FAKE_GATEWAY_KEY } : {},
      githubClient: githubClientForTarball(commitSha, fixture.tgz),
      log: line => logs.push(line),
      ...(enricherFactory ? { enricherFactory } : {}),
    }));
    queue.submit({ owner: "acme", repo: "app", slug });
    await queue.idle();
    return queue.list()[0]!;
  };
  try {
    const off = await run("acme__app-off");
    assert.equal(off.stage, "complete");
    assert.equal(off.atlasReady, true);
    assert.equal(off.enrichment.state, "skipped");
    assert.equal(off.enrichment.modelId, undefined);
    const offStory = readFileSync(join(scanRoot, "acme__app-off", "story.json"), "utf8");

    const rejected = await run("acme__app-reject", () => async packets => {
      const containerId = packets.packets[0]?.containerId ?? "container:missing";
      return new Map([[containerId, {
        schemaVersion: 1,
        entities: [
          { id: "system:not-the-base", kind: "softwareSystem", name: "Nope", sourceRefs: [] },
          { id: "component:ghost", kind: "component", parentId: containerId, name: "Ghost", sourceRefs: [] },
        ],
        relations: [],
      }]]);
    });
    assert.equal(rejected.stage, "complete");
    assert.equal(rejected.atlasReady, true);
    assert.ok(rejected.enrichment.state === "complete" || rejected.enrichment.state === "failed");
    const rejectedStory = readFileSync(join(scanRoot, "acme__app-reject", "story.json"), "utf8");
    assert.equal(rejectedStory, offStory, "rejected enrichment must not change the overview story");

    const accepted = await run("acme__app-summary", () => async packets => {
      const systemId = packets.systemPacket?.systemId;
      const packet = packets.packets[0];
      if (!systemId || !packet) return new Map();
      return new Map([[packet.containerId, {
        schemaVersion: 1,
        entities: [
          { id: systemId, kind: "softwareSystem", name: packets.systemPacket!.systemName, sourceRefs: [] },
          {
            id: packet.containerId, kind: "container", parentId: systemId, name: packet.containerName,
            responsibility: "Tiny ping library.", sourceRefs: [],
          },
          ...packet.components.map(component => ({
            id: component.id, kind: "component", parentId: packet.containerId, name: component.name,
            responsibility: `Hosts ${component.path}.`, sourceRefs: [],
          })),
        ],
        relations: [],
      }]]);
    });
    assert.equal(accepted.stage, "complete");
    assert.equal(accepted.atlasReady, true);
    assert.equal(accepted.enrichment.state, "complete");
    assert.equal(accepted.enrichment.modelId, "anthropic/claude-sonnet-4");
    assert.equal(accepted.enrichment.provider, "openrouter.ai");
    const acceptedStory = readFileSync(join(scanRoot, "acme__app-summary", "story.json"), "utf8");
    type OverviewStory = {
      steps: Array<{ id: string; title: string; reveal?: string; focusEntityIds: string[]; narration: string }>;
    };
    const spine = (raw: string) => JSON.parse(raw) as OverviewStory;
    const offParsed = spine(offStory);
    const acceptedParsed = spine(acceptedStory);
    assert.deepEqual(
      acceptedParsed.steps.map(step => ({
        id: step.id, title: step.title, reveal: step.reveal, focusEntityIds: step.focusEntityIds,
      })),
      offParsed.steps.map(step => ({
        id: step.id, title: step.title, reveal: step.reveal, focusEntityIds: step.focusEntityIds,
      })),
      "accepted summaries must not change the overview tour spine",
    );
    assert.ok(
      acceptedParsed.steps.some(step => step.narration.includes("Tiny ping library.")),
      "accepted container summary must appear in overview narration",
    );
    assert.notEqual(acceptedStory, offStory);
    const snapshot = JSON.parse(readFileSync(join(scanRoot, "acme__app-summary", "snapshot.json"), "utf8")) as {
      entities: Array<{ id: string; kind: string; responsibility?: string }>;
    };
    assert.ok(snapshot.entities.some(entity => entity.kind === "container" && entity.responsibility === "Tiny ping library."));
    assert.ok(logs.every(line => !line.includes(FAKE_GATEWAY_KEY)));
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("job.error and logs scrub gateway error strings (gh token + operator key)", async () => {
  const planted = "gho_okieTestPlantedSecretCla25xxxx";
  const client: GithubClient = {
    async getJson() {
      throw new Error(`llm gateway 401: ${planted} ${FAKE_GATEWAY_KEY}`);
    },
    async downloadTarball() {
      throw new Error("downloadTarball must not run");
    },
  };
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-root-"));
  const logs: string[] = [];
  try {
    const queue = createScanJobQueue(createScanJobRunner({
      scanRoot,
      enrich: "off",
      env: { OPENROUTER_API_KEY: FAKE_GATEWAY_KEY },
      githubClient: client,
      log: line => logs.push(line),
    }));
    queue.submit({ owner: "acme", repo: "app", slug: "acme__app" });
    await queue.idle();
    const job = queue.list()[0]!;
    assert.equal(job.stage, "failed");
    assert.equal((job.error ?? "").includes(planted), false);
    assert.equal((job.error ?? "").includes(FAKE_GATEWAY_KEY), false);
    assert.match(job.error ?? "", /\[redacted-token\]/);
    assert.match(job.error ?? "", /\[redacted-llm-key\]/);
    assert.ok(logs.every(line => !line.includes(planted)));
    assert.ok(logs.every(line => !line.includes(FAKE_GATEWAY_KEY)));
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
  }
});

test("enrichment notes and logs strip tokenized gateway URLs", async () => {
  const fixture = makeTarball("acme-app-cla29aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
    "package.json": JSON.stringify({ name: "acme-app" }),
    "src/index.ts": "export const ping = () => 'pong';\n",
  });
  const commitSha = "cla29aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const urlToken = "okie-test-url-token-cla29-fake";
  const queryToken = "okie-test-query-token-cla29-fake";
  const tokenized = `https://okietest:${urlToken}@example.invalid/v1?api_key=${queryToken}`;
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-root-"));
  const logs: string[] = [];
  try {
    const queue = createScanJobQueue(createScanJobRunner({
      scanRoot,
      enrich: "auto",
      env: { OPENROUTER_API_KEY: FAKE_GATEWAY_KEY, OKIE_LLM_BASE_URL: tokenized },
      githubClient: githubClientForTarball(commitSha, fixture.tgz),
      log: line => logs.push(line),
      enricherFactory: () => async () => {
        throw new Error(`llm gateway 401 from ${tokenized}`);
      },
    }));
    queue.submit({ owner: "acme", repo: "app", slug: "acme__app" });
    await queue.idle();
    const job = queue.list()[0]!;
    assert.equal(job.stage, "complete");
    assert.equal(job.enrichment.state, "failed");
    assert.equal(job.enrichment.provider, "example.invalid");
    assert.equal(job.enrichment.modelId, "anthropic/claude-sonnet-4");
    assert.equal((job.enrichment.note ?? "").includes(urlToken), false);
    assert.equal((job.enrichment.note ?? "").includes(queryToken), false);
    assert.match(job.enrichment.note ?? "", /example\.invalid/);
    assert.ok(logs.every(line => !line.includes(urlToken)));
    assert.ok(logs.every(line => !line.includes(queryToken)));
    assert.ok(logs.every(line => !line.includes(FAKE_GATEWAY_KEY)));
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("force enrichment without a visible key records provider anthropic, not openrouter.ai", async () => {
  const fixture = makeTarball("acme-app-cla29bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", {
    "package.json": JSON.stringify({ name: "acme-app" }),
    "src/index.ts": "export const ping = () => 'pong';\n",
  });
  const commitSha = "cla29bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-root-"));
  try {
    const queue = createScanJobQueue(createScanJobRunner({
      scanRoot,
      enrich: "force",
      env: {},
      githubClient: githubClientForTarball(commitSha, fixture.tgz),
      enricherFactory: () => async () => {
        throw new Error("profile auth unavailable");
      },
    }));
    queue.submit({ owner: "acme", repo: "app", slug: "acme__app" });
    await queue.idle();
    const job = queue.list()[0]!;
    assert.equal(job.stage, "complete");
    assert.equal(job.enrichment.state, "failed");
    assert.equal(job.enrichment.provider, "anthropic");
    assert.equal(job.enrichment.modelId, "anthropic/claude-sonnet-4");
    assert.notEqual(job.enrichment.provider, "openrouter.ai");
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
    fixture.cleanup();
  }
});
