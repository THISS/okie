import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRepoInput } from "./repoUrl.js";

test("normalizeRepoInput accepts the shapes a user actually pastes", () => {
  for (const input of [
    "https://github.com/colinhacks/zod",
    "https://github.com/colinhacks/zod.git",
    "https://github.com/colinhacks/zod/",
    "http://github.com/colinhacks/zod",
    "github.com/colinhacks/zod",
    "www.github.com/colinhacks/zod",
    "colinhacks/zod",
    "gh:colinhacks/zod",
    "  https://github.com/colinhacks/zod  ",
  ]) {
    const parsed = normalizeRepoInput(input);
    assert.ok(parsed, `should parse: ${input}`);
    assert.equal(parsed.owner, "colinhacks");
    assert.equal(parsed.repo, "zod");
    assert.equal(parsed.ref, undefined);
    assert.equal(parsed.dirSlug, "colinhacks__zod");
  }
});

test("normalizeRepoInput carries a ref from /tree/, /commit/, and @ forms", () => {
  assert.equal(normalizeRepoInput("https://github.com/colinhacks/zod/tree/v3")?.ref, "v3");
  assert.equal(normalizeRepoInput("https://github.com/colinhacks/zod/tree/release/v4")?.ref, "release/v4");
  assert.equal(normalizeRepoInput("https://github.com/colinhacks/zod/commit/abc123")?.ref, "abc123");
  assert.equal(normalizeRepoInput("colinhacks/zod@main")?.ref, "main");
  assert.equal(normalizeRepoInput("gh:colinhacks/zod@main")?.ref, "main");
});

test("normalizeRepoInput ignores deep non-ref paths but keeps the repo identity", () => {
  const parsed = normalizeRepoInput("https://github.com/colinhacks/zod/issues/123");
  assert.ok(parsed);
  assert.equal(parsed.repo, "zod");
  assert.equal(parsed.ref, undefined);
});

test("normalizeRepoInput rejects non-GitHub and malformed input", () => {
  for (const input of [
    "",
    "   ",
    "https://gitlab.com/owner/repo",
    "https://example.com/owner/repo",
    "https://github.com/onlyowner",
    "not a url at all",
    "ftp://github.com/owner/repo",
    `https://github.com/${"a".repeat(600)}/repo`,
  ]) {
    assert.equal(normalizeRepoInput(input), undefined, `should reject: ${input}`);
  }
});
