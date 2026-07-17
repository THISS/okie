import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateArchitectureExtraction, validateSnapshot, validateStory, validateView } from "@okie/architecture";
import { scanRepository } from "./scan.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

test("scanning Okie passes every architecture gate cleanly", () => {
  const { extraction, snapshot, view, story } = scanRepository(repoRoot, { systemName: "Okie", repositorySlug: "okie" });

  assert.deepEqual(validateArchitectureExtraction(extraction), [], "extraction must satisfy the intake gate");
  assert.deepEqual(validateSnapshot(snapshot), [], "materialized snapshot must be valid");
  assert.deepEqual(validateView(snapshot, view), [], "synthetic view must be valid");
  assert.deepEqual(validateStory(snapshot, view, story), [], "overview story must be valid");

  const kinds = new Set(snapshot.entities.map(entity => entity.kind));
  for (const kind of ["softwareSystem", "container", "component", "code"]) {
    assert.ok(kinds.has(kind as never), `snapshot is missing a ${kind} entity`);
  }
  assert.equal(snapshot.entities.filter(entity => entity.kind === "softwareSystem").length, 1, "exactly one system root");
  // The overview story cites no sourceRefs, so it cannot invent evidence.
  assert.equal(story.steps[0]!.sourceRefs, undefined);
});
