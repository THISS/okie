import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  acquireGithubTree,
  commitApiPath,
  createAnonymousGithubClient,
  GithubAcquisitionError,
  interpretCommitResponse,
  interpretRepoResponse,
  isGithubSource,
  parseGithubSource,
  repoApiPath,
  resolveGithubCommit,
  tarballUrl,
  type GithubClient,
  type GithubJsonResult,
} from "./github.js";

test("isGithubSource / parseGithubSource cover owner/repo, refs, .git, and rejects", () => {
  assert.equal(isGithubSource("gh:colinhacks/zod"), true);
  assert.equal(isGithubSource("/local/path"), false);

  assert.deepEqual(parseGithubSource("gh:colinhacks/zod"), { owner: "colinhacks", repo: "zod", dirSlug: "colinhacks__zod" });
  assert.deepEqual(parseGithubSource("gh:colinhacks/zod@v3.22.4"), { owner: "colinhacks", repo: "zod", ref: "v3.22.4", dirSlug: "colinhacks__zod" });
  // A ref may contain slashes (branch names).
  assert.deepEqual(parseGithubSource("gh:acme/app@release/1.x"), { owner: "acme", repo: "app", ref: "release/1.x", dirSlug: "acme__app" });
  // Trailing .git is stripped; owner/repo are slugified for the dir.
  assert.deepEqual(parseGithubSource("gh:My_Org/Cool.Repo.git"), { owner: "My_Org", repo: "Cool.Repo", dirSlug: "my-org__cool-repo" });

  assert.equal(parseGithubSource("not-a-gh-source"), undefined);
  assert.equal(parseGithubSource("gh:missing-repo"), undefined);
  assert.equal(parseGithubSource("gh:/nope"), undefined);
});

test("URL/path builders match the GitHub REST + codeload shapes", () => {
  assert.equal(repoApiPath("o", "r"), "/repos/o/r");
  assert.equal(commitApiPath("o", "r", "main"), "/repos/o/r/commits/main");
  // Slashes in a ref are encoded so a branch like release/1.x forms one path segment value.
  assert.equal(commitApiPath("o", "r", "release/1.x"), "/repos/o/r/commits/release%2F1.x");
  assert.equal(tarballUrl("o", "r", "abc123"), "https://codeload.github.com/o/r/tar.gz/abc123");
});

test("interpretCommitResponse pins sha/tree and normalizes the committer date", () => {
  const resolved = interpretCommitResponse({
    sha: "1111111111111111111111111111111111111111",
    commit: { committer: { date: "2024-01-15T10:30:00Z" }, tree: { sha: "tree-sha" } },
  });
  assert.equal(resolved.sha, "1111111111111111111111111111111111111111");
  assert.equal(resolved.treeSha, "tree-sha");
  // Normalized through Date so it matches the local pin's `git show %cI` formatting exactly.
  assert.equal(resolved.generatedAt, "2024-01-15T10:30:00.000Z");
});

test("interpretCommitResponse falls back to author date and throws on a malformed response", () => {
  const authorOnly = interpretCommitResponse({
    sha: "abc",
    commit: { author: { date: "2020-05-05T00:00:00Z" }, tree: { sha: "t" } },
  });
  assert.equal(authorOnly.generatedAt, "2020-05-05T00:00:00.000Z");

  assert.throws(() => interpretCommitResponse({ sha: "abc" }), GithubAcquisitionError);
  assert.throws(() => interpretCommitResponse("<html>rate limited</html>"), GithubAcquisitionError);
});

test("interpretRepoResponse reads default_branch (and rejects a private/404 shape)", () => {
  assert.equal(interpretRepoResponse({ default_branch: "trunk" }), "trunk");
  assert.throws(() => interpretRepoResponse({ message: "Not Found" }), GithubAcquisitionError);
});

/** A GithubClient stub that answers from a recorded map and records the endpoints hit. */
function stubClient(responses: Record<string, GithubJsonResult>): GithubClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getJson(apiPath) {
      calls.push(apiPath);
      return responses[apiPath] ?? { ok: false, status: 404, rateLimited: false, message: "stub: not found" };
    },
    async downloadTarball() {
      throw new Error("downloadTarball not used in this test");
    },
  };
}

const COMMIT_JSON = {
  sha: "2222222222222222222222222222222222222222",
  commit: { committer: { date: "2023-03-03T03:03:03Z" }, tree: { sha: "tree2" } },
};

test("resolveGithubCommit resolves the default branch when no ref is given", async () => {
  const client = stubClient({
    "/repos/o/r": { ok: true, json: { default_branch: "main" } },
    "/repos/o/r/commits/main": { ok: true, json: COMMIT_JSON },
  });
  const resolved = await resolveGithubCommit({ owner: "o", repo: "r", dirSlug: "o__r" }, client);
  assert.deepEqual(client.calls, ["/repos/o/r", "/repos/o/r/commits/main"]);
  assert.equal(resolved.sha, COMMIT_JSON.sha);
  assert.equal(resolved.generatedAt, "2023-03-03T03:03:03.000Z");
});

test("resolveGithubCommit skips the repo lookup when a ref is supplied", async () => {
  const client = stubClient({ "/repos/o/r/commits/dev": { ok: true, json: COMMIT_JSON } });
  const resolved = await resolveGithubCommit({ owner: "o", repo: "r", ref: "dev", dirSlug: "o__r" }, client);
  assert.deepEqual(client.calls, ["/repos/o/r/commits/dev"]);
  assert.equal(resolved.treeSha, "tree2");
});

test("resolveGithubCommit surfaces rate-limit and not-found distinctly", async () => {
  const limited = stubClient({
    "/repos/o/r": { ok: false, status: 403, rateLimited: true, message: "rate limit reached; install/auth gh" },
  });
  await assert.rejects(resolveGithubCommit({ owner: "o", repo: "r", dirSlug: "o__r" }, limited), /rate limit reached/);

  const missing = stubClient({
    "/repos/o/r": { ok: true, json: { default_branch: "main" } },
    "/repos/o/r/commits/main": { ok: false, status: 404, rateLimited: false, message: "nope" },
  });
  await assert.rejects(resolveGithubCommit({ owner: "o", repo: "r", dirSlug: "o__r" }, missing), /not found/i);
});

/** Builds a GitHub-style tar.gz (single top-level `<name>/` dir) and returns its path. */
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

test("acquireGithubTree extracts the single top-level dir, exposes the root, and cleans up", async () => {
  const fixture = makeTarball("zod-2222222", {
    "package.json": JSON.stringify({ name: "zod" }),
    "src/index.ts": "export const x = 1;\n",
  });
  const client: GithubClient = {
    async getJson() { throw new Error("unused"); },
    async downloadTarball(_owner, _repo, _sha, destFile) {
      copyFileSync(fixture.tgz, destFile);
      return statSync(destFile).size;
    },
  };
  const acquired = await acquireGithubTree({ owner: "colinhacks", repo: "zod", dirSlug: "colinhacks__zod" }, "2222222", client);
  try {
    assert.ok(existsSync(join(acquired.root, "package.json")), "extracted root holds package.json");
    assert.equal(JSON.parse(readFileSync(join(acquired.root, "package.json"), "utf8")).name, "zod");
    assert.ok(existsSync(join(acquired.root, "src/index.ts")), "nested source extracted");
  } finally {
    acquired.cleanup();
    fixture.cleanup();
  }
  assert.ok(!existsSync(acquired.root), "cleanup discards the ephemeral checkout");
});

test("createAnonymousGithubClient fails closed on a private-repo 404 and never mentions gh", async () => {
  const client = createAnonymousGithubClient({
    fetch: async () => new Response("Not Found", { status: 404, headers: { "content-type": "application/json" } }),
  });
  const json = await client.getJson("/repos/acme/secret");
  assert.equal(json.ok, false);
  if (json.ok) throw new Error("expected failure");
  assert.equal(json.status, 404);
  assert.equal(json.rateLimited, false);
  assert.doesNotMatch(json.message, /\bgh\b/i);

  await assert.rejects(
    resolveGithubCommit({ owner: "acme", repo: "secret", dirSlug: "acme__secret" }, client),
    /not found.*public/i,
  );

  const dest = join(mkdtempSync(join(tmpdir(), "okie-anon-")), "repo.tar.gz");
  await assert.rejects(client.downloadTarball("acme", "secret", "deadbeef", dest, 1024), /status 404/);
});

test("createAnonymousGithubClient reports anonymous rate-limits without a gh fallback hint", async () => {
  const client = createAnonymousGithubClient({
    fetch: async () => new Response("rate limited", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
    }),
  });
  const json = await client.getJson("/repos/acme/public");
  assert.equal(json.ok, false);
  if (json.ok) throw new Error("expected failure");
  assert.equal(json.rateLimited, true);
  assert.match(json.message, /anonymous access/i);
  assert.doesNotMatch(json.message, /\bgh\b/i);
});

// Live end-to-end resolution against the real GitHub API — offline-safe: skipped
// unless OKIE_SCAN_LIVE=1 so CI and sandboxes never depend on the network.
test("live: resolves a real public repo commit", { skip: !process.env.OKIE_SCAN_LIVE }, async () => {
  const { createDefaultGithubClient } = await import("./github.js");
  const resolved = await resolveGithubCommit(parseGithubSource("gh:sindresorhus/is-odd")!, createDefaultGithubClient());
  assert.match(resolved.sha, /^[0-9a-f]{40}$/);
  assert.match(resolved.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
});
