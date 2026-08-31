import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GithubClient } from "@okie/scan";
import { createScanJobQueue } from "./jobs.js";
import { createScanJobRunner } from "./scanService.js";

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
