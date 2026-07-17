import assert from "node:assert/strict";
import test from "node:test";
import { pathSlug, resolveCollisions, slug, typedId } from "./ids.js";

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
