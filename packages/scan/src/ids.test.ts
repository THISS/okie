import assert from "node:assert/strict";
import test from "node:test";
import { BOUNDED_ID_SUFFIX_HEADROOM, boundStableId, MAX_STABLE_ID_CHARACTERS, pathSlug, resolveCollisions, slug, typedId, unboundedTypedId } from "./ids.js";

// Mirrors @okie/architecture's extraction gate `stableIdPattern`.
const stableIdPattern = /^[a-z][a-z0-9]*(?::[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

test("slug splits camelCase, lowercases, and hyphenates non-alnum runs", () => {
  assert.equal(slug("ArchitectureSnapshot"), "architecture-snapshot");
  assert.equal(slug("canonicalNavigationUrl"), "canonical-navigation-url");
  assert.equal(slug("create_atlas_renderer"), "create-atlas-renderer");
  assert.equal(slug("WASMBridge"), "wasm-bridge");
  assert.equal(pathSlug("apps/web/src/App.tsx"), "apps-web-src-app-tsx");
  assert.equal(slug("__weird$$name__"), "weird-name");
  assert.equal(slug("!!!"), "x", "never emits an empty slug");
});

test("typedId produces gate-valid stable IDs", () => {
  const id = typedId("code", "apps/web/src/App.tsx", "CanvasViewport");
  assert.equal(id, "code:apps-web-src-app-tsx:canvas-viewport");
  for (const candidate of [
    typedId("system", "Okie"),
    typedId("container", "packages/architecture"),
    typedId("component", "packages/scene-compiler/src/compile-story.ts"),
    typedId("relation", "apps/web/src/App.tsx", "apps/web/src/storyPlayback.ts"),
    id,
  ]) {
    assert.match(candidate, stableIdPattern, `${candidate} must match stableIdPattern`);
  }
});

test("resolveCollisions suffixes later duplicates deterministically", () => {
  assert.deepEqual(resolveCollisions(["a", "a"]), ["a", "a-2"]);
  assert.deepEqual(resolveCollisions(["x", "x", "x", "y"]), ["x", "x-2", "x-3", "y"]);
  // A desired id that itself already ends in a used suffix keeps growing predictably.
  assert.deepEqual(resolveCollisions(["a-2", "a-2"]), ["a-2", "a-2-2"]);
  assert.deepEqual(resolveCollisions([]), []);
});

// CLA-299: generated trees (trpc's heyapi clients) produce relation ids that concatenate
// two long path slugs and blow the gate's 192-character limit.
const longDir = "packages/openapi/test/routers/defaultErrorFormatterRouter-heyapi/client/core/generated/very/deeply/nested/directory/structure";

test("boundStableId is the identity for any id within the limit", () => {
  for (const id of ["code:apps-web-src-app-tsx:canvas-viewport", `relation:${"a".repeat(MAX_STABLE_ID_CHARACTERS - "relation:".length)}`]) {
    assert.ok(id.length <= MAX_STABLE_ID_CHARACTERS);
    assert.equal(boundStableId(id), id);
  }
  const exact = typedId("component", "x".repeat(MAX_STABLE_ID_CHARACTERS - "component:".length));
  assert.equal(exact.length, MAX_STABLE_ID_CHARACTERS, "an id of exactly 192 characters is kept verbatim");
});

test("long entity and relation ids are bounded, readable, pattern-valid and deterministic", () => {
  const from = `${longDir}/types.gen.ts`;
  const to = `${longDir}/sdk.gen.ts`;
  const unbounded = `relation:${slug(from)}:${slug(to)}`;
  assert.ok(unbounded.length > MAX_STABLE_ID_CHARACTERS, "fixture really overflows");
  const relation = typedId("relation", from, to);
  assert.ok(relation.length <= MAX_STABLE_ID_CHARACTERS - BOUNDED_ID_SUFFIX_HEADROOM, relation);
  assert.match(relation, stableIdPattern);
  assert.match(relation, /^relation:packages-openapi-test-routers-default-error-formatter-router-heyapi-/, "keeps a readable head");
  assert.match(relation, /-[0-9a-f]{16}$/, "ends in a hash of the full id");
  assert.equal(typedId("relation", from, to), relation, "deterministic across calls");
  // Cut at a token boundary: the head is a prefix of the full id ending right before a separator.
  const head = relation.slice(0, -17);
  assert.ok(unbounded.startsWith(head));
  assert.match(unbounded.charAt(head.length), /[-:]/);

  const entity = typedId("code", `${longDir}/${"nested/".repeat(12)}index.ts`, "createClient");
  assert.ok(entity.length <= MAX_STABLE_ID_CHARACTERS);
  assert.match(entity, stableIdPattern);
});

test("distinct long ids sharing a head stay distinct", () => {
  const base = `${longDir}/${"shared/".repeat(10)}`;
  const ids = ["a.ts", "b.ts", "c.ts", "zz.ts"].map(file => typedId("relation", base + file, base + "target.ts"));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(ids.map(id => id.slice(0, -17))).size, 1, "same readable head, distinguished only by the hash");
  // A single unbroken token longer than the budget is hard-cut but still valid.
  const token = typedId("code", "x".repeat(400));
  assert.match(token, stableIdPattern);
  assert.ok(token.length <= MAX_STABLE_ID_CHARACTERS);
});

test("resolveCollisions never pushes an id past the limit", () => {
  const nearLimit = `relation:${"a".repeat(MAX_STABLE_ID_CHARACTERS - "relation:".length - 1)}`; // 191 characters
  const bounded = typedId("relation", `${longDir}/a.ts`, `${longDir}/b.ts`);
  const resolved = resolveCollisions([nearLimit, nearLimit, nearLimit, bounded, bounded]);
  assert.equal(resolved[0], nearLimit, "the canonically-first keeps the bare id");
  assert.equal(new Set(resolved).size, resolved.length);
  for (const id of resolved) {
    assert.ok(id.length <= MAX_STABLE_ID_CHARACTERS, id);
    assert.match(id, stableIdPattern);
  }
  assert.equal(resolved[4], `${bounded}-2`, "a bounded id has headroom for a plain -N suffix");
  assert.deepEqual(resolveCollisions([nearLimit, nearLimit, nearLimit]), resolved.slice(0, 3), "deterministic");
});

test("unboundedTypedId (snapshot-only duplicates overlay) keeps already-published long ids verbatim", () => {
  const long = unboundedTypedId("relation", "dup", `code:${longDir}/a.ts:x`, `code:${longDir}/b.ts:y`);
  assert.ok(long.length > MAX_STABLE_ID_CHARACTERS);
  assert.equal(long, `relation:dup:${slug(`code:${longDir}/a.ts:x`)}:${slug(`code:${longDir}/b.ts:y`)}`);
  assert.equal(typedId("relation", "dup", `code:${longDir}/a.ts:x`, `code:${longDir}/b.ts:y`), boundStableId(long));
});
