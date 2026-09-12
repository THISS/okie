import assert from "node:assert/strict";
import test from "node:test";
import { adaptArchitectureExtraction, type ArchitectureExtraction, type PortableAtlas } from "@okie/architecture";
import { buildOverviewStory } from "./overview-story.js";
import { enrichPortableAtlas } from "./portable-enrich.js";

const commit = "a".repeat(40);

function bundle(): PortableAtlas {
  const extraction: ArchitectureExtraction = {
    schemaVersion: 1,
    entities: [
      { id: "system:acme", kind: "softwareSystem", name: "Acme", sourceRefs: [] },
      { id: "container:acme-app", kind: "container", parentId: "system:acme", name: "App", sourceRefs: [] },
      { id: "component:acme-app-src-main-ts", kind: "component", parentId: "container:acme-app", name: "src/main.ts", sourceRefs: [{ path: "src/main.ts" }] },
      { id: "code:acme-app-src-main-ts:run", kind: "code", parentId: "component:acme-app-src-main-ts", name: "run", sourceRefs: [{ path: "src/main.ts", symbol: "run", startLine: 1, endLine: 1 }] },
    ], relations: [],
  };
  const snapshot = adaptArchitectureExtraction(extraction, { snapshotId: "snapshot:acme:aaaaaaaaaaaa", repositoryId: "repo:acme", commitSha: commit, generatedAt: "2026-01-01T00:00:00.000Z" });
  const view = {
    schemaVersion: 1 as const, id: "view:acme:hierarchy", snapshotId: snapshot.id, name: "Acme scan", rootEntityId: "system:acme",
    entityIds: snapshot.entities.map(entity => entity.id), relationIds: [],
    layout: { nodes: Object.fromEntries(snapshot.entities.map((entity, index) => [entity.id, { x: index * 10, y: 0, width: 5, height: 5 }])) },
  };
  const story = buildOverviewStory(snapshot, view, "system:acme", "acme", "Acme");
  return { format: "okie-atlas", version: 1, repository: { commitSha: commit, treeHash: "b".repeat(40) }, snapshot, view, story, stories: [story], analysis: { mode: "quick", adapters: [] } };
}

function summaryDoc(): unknown {
  return {
    schemaVersion: 1,
    entities: [
      { id: "system:acme", kind: "softwareSystem", name: "Acme", sourceRefs: [] },
      { id: "container:acme-app", kind: "container", parentId: "system:acme", name: "App", responsibility: "Runs the application.", sourceRefs: [] },
      { id: "component:acme-app-src-main-ts", kind: "component", parentId: "container:acme-app", name: "src/main.ts", responsibility: "Contains the entry point.", sourceRefs: [] },
    ], relations: [],
  };
}

function bundleWithBoundary(): PortableAtlas {
  const value = bundle();
  value.snapshot.entities.push({ id: "boundary:acme", kind: "boundary", name: "Acme boundary", sourceRefs: [] });
  value.view.entityIds.push("boundary:acme");
  value.view.layout.nodes["boundary:acme"] = { x: 50, y: 50, width: 5, height: 5 };
  return value;
}

test("portable enrichment reruns gates without rescanning and retains commit-pinned observed facts", () => {
  const before = bundle();
  const outcome = enrichPortableAtlas(before, new Map([["container:acme-app", summaryDoc()]]));
  assert.deepEqual(outcome.report.enrichedContainers, ["container:acme-app"]);
  assert.equal(outcome.bundle.repository.commitSha, commit);
  assert.equal(outcome.bundle.snapshot.commitSha, commit);
  assert.equal(outcome.bundle.snapshot.entities.find(entity => entity.id === "container:acme-app")?.responsibility, "Runs the application.");
  assert.deepEqual(
    outcome.bundle.snapshot.entities.find(entity => entity.id === "code:acme-app-src-main-ts:run")?.sourceRefs,
    before.snapshot.entities.find(entity => entity.id === "code:acme-app-src-main-ts:run")?.sourceRefs,
  );
  assert.deepEqual(outcome.bundle.view, before.view, "unchanged graph preserves the authored portable view");
  assert.notDeepEqual(outcome.bundle.story, before.story, "accepted summary refreshes narration");
});

test("rejected portable enrichment leaves the original validated bundle byte-equivalent", () => {
  const before = bundle();
  const outcome = enrichPortableAtlas(before, new Map([["container:acme-app", { schemaVersion: 1, entities: [], relations: [] }]]));
  assert.equal(outcome.report.results[0]?.accepted, false);
  assert.deepEqual(outcome.bundle, before);
});

test("accepted portable enrichment preserves snapshot-only boundaries and observed relations", () => {
  const before = bundleWithBoundary();
  const observed = {
    id: "relation:acme:observed",
    lineageId: "lineage:observed",
    fingerprint: "observed-fingerprint",
    from: "container:acme-app",
    to: "component:acme-app-src-main-ts",
    kind: "calls" as const,
    label: "observed call",
    technology: "Rust",
    optional: true,
    confidence: 0.8,
    evidence: [{ source: { path: "src/main.ts", commitSha: commit, startLine: 1, endLine: 1 }, reason: "observed" }],
  };
  before.snapshot.relations.push(observed);
  before.view.relationIds.push(observed.id);
  const outcome = enrichPortableAtlas(before, new Map([["container:acme-app", summaryDoc()]]));
  assert.deepEqual(outcome.bundle.snapshot.entities.find(entity => entity.id === "boundary:acme"), before.snapshot.entities.find(entity => entity.id === "boundary:acme"));
  assert.deepEqual(outcome.bundle.snapshot.relations.find(relation => relation.id === observed.id), observed);
});

test("actor-only enrichment retains original observed relation metadata after the merge rebuild", () => {
  const before = bundle();
  const observed = {
    id: "relation:acme:observed",
    lineageId: "lineage:observed",
    fingerprint: "observed-fingerprint",
    from: "container:acme-app",
    to: "component:acme-app-src-main-ts",
    kind: "calls" as const,
    label: "observed call",
    technology: "Rust",
    optional: true,
    confidence: 0.8,
    evidence: [{ source: { path: "src/main.ts", commitSha: commit, startLine: 1, endLine: 1 }, reason: "observed" }],
  };
  before.snapshot.relations.push(observed);
  before.view.relationIds.push(observed.id);
  const actor = {
    schemaVersion: 1,
    entities: [
      { id: "system:acme", kind: "softwareSystem", name: "Acme", sourceRefs: [] },
      { id: "person:reader", kind: "person", name: "Reader", sourceRefs: [] },
    ],
    relations: [],
  };
  const outcome = enrichPortableAtlas(before, new Map([["system:acme", actor]]));
  assert.equal(outcome.report.systemScope?.accepted, true, JSON.stringify(outcome.report));
  assert.deepEqual(outcome.bundle.snapshot.relations.find(relation => relation.id === observed.id), observed);
  assert.ok(outcome.bundle.snapshot.entities.some(entity => entity.id === "person:reader"));
});
