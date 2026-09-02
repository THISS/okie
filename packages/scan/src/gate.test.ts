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
  // Evidence-backed steps may cite sourceRefs; validateStory already rejects invented ones.
  assert.ok(story.steps.every(step => step.sourceRefs === undefined || step.sourceRefs.length > 0));
  assert.ok(story.steps.length > 1, "overview must be a multi-step tour");

  const code = snapshot.entities.filter(entity => entity.kind === "code");
  const withExcerpt = code.filter(entity => (entity.sourceExcerpts?.length ?? 0) > 0);
  assert.ok(code.length > 0, "scan must emit code entities");
  assert.ok(
    withExcerpt.length / code.length >= 0.9,
    `typical scanned code entities must carry a portable excerpt (${withExcerpt.length}/${code.length})`,
  );
  assert.ok(
    snapshot.entities.filter(entity => entity.kind === "container").every(entity => !entity.sourceExcerpts?.length),
    "containers stay excerpt-free so Source stays disabled",
  );

  const acceptedSummary = snapshot.entities.find(entity => entity.name === "inspectorAcceptedSummary");
  assert.ok(acceptedSummary, "self-scan must include inspectorAcceptedSummary");
  assert.equal(acceptedSummary.kind, "code");
  const excerpt = acceptedSummary.sourceExcerpts?.[0];
  assert.ok(excerpt, "inspectorAcceptedSummary must carry a portable excerpt");
  assert.ok(excerpt.text.includes("inspectorAcceptedSummary"), "excerpt must show the scanned symbol");
  assert.equal(excerpt.path, "apps/web/src/inspector/inspectorPanel.ts");
});
