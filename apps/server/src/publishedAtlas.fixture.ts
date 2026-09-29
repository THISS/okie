import assert from "node:assert/strict";
import type { ArchitectureEntity, ArchitectureRelation, ArchitectureSnapshot, ArchitectureView, EntityKind } from "@okie/architecture";
import type { OperatorPublication } from "./operatorContracts.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore } from "./operatorStore.js";
import type { PublishStoreClient } from "./publishAtlas.js";
import type { PublishedLicense } from "./publishedStoreLayout.js";

/** CLA-266 test fixture: a small operator store with one published repository (not a test file itself). */
export const FIXTURE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
export const FIXTURE_REPOSITORY_ID = "repo:acme/demo";
export const FIXTURE_SLUG = "acme__demo";
export const FIXTURE_CLAIM = "operator-only claim text";
export const FIXTURE_LICENSE: PublishedLicense = { spdxId: "MIT", name: "MIT License", url: `https://github.com/acme/demo/blob/${FIXTURE_COMMIT}/LICENSE` };

function entity(id: string, kind: EntityKind, parentId?: string, excerpt = false): ArchitectureEntity {
  const path = `src/${id.replaceAll(":", "/")}.ts`;
  const lines = excerpt ? [`export const ${id.replace(/\W/g, "_")} = 1;`, "export const y = 2;"] : undefined;
  return {
    id,
    name: id,
    kind,
    sourceRefs: [{ path, commitSha: FIXTURE_COMMIT }],
    ...(parentId ? { parentId } : {}),
    ...(lines ? { sourceExcerpts: [{ path, language: "typescript" as const, startLine: 1, endLine: 2, highlightLine: 1, frozenRevision: FIXTURE_COMMIT, lines, text: lines.join("\n") }] } : {}),
  };
}

export function fixtureTrio(label = "Original"): { snapshot: ArchitectureSnapshot; view: ArchitectureView; story: unknown } {
  const entities: ArchitectureEntity[] = [
    entity("system:root", "softwareSystem"),
    entity("actor:dev", "person"),
    entity("container:web", "container", "system:root"),
    entity("container:arch", "container", "system:root"),
    entity("component:web-app", "component", "container:web"),
    entity("component:arch-model", "component", "container:arch"),
  ];
  const relations: ArchitectureRelation[] = [
    { id: "rel:dev-root", from: "actor:dev", to: "system:root", kind: "uses", evidence: [{ source: { path: "src/actor/dev.ts", commitSha: FIXTURE_COMMIT } }] },
  ];
  for (let index = 0; index < 12; index += 1) {
    entities.push(entity(`code:web-${index}`, "code", "component:web-app", true));
    if (index > 0) relations.push({ id: `rel:web-${index}`, from: `code:web-${index - 1}`, to: `code:web-${index}`, kind: "uses", evidence: [{ source: { path: `src/code/web-${index}.ts`, commitSha: FIXTURE_COMMIT } }] });
  }
  entities.push(entity("code:arch-model", "code", "component:arch-model", true));
  const snapshot: ArchitectureSnapshot = {
    schemaVersion: 1,
    id: "snapshot:demo",
    repositoryId: "repo:acme-demo",
    commitSha: FIXTURE_COMMIT,
    generatedAt: "2026-01-01T00:00:00.000Z",
    entities: entities.map(value => ({ ...value, name: value.kind === "softwareSystem" ? `${label} system` : value.name })),
    relations,
  };
  const view: ArchitectureView = {
    schemaVersion: 1,
    id: "view:demo",
    snapshotId: snapshot.id,
    name: "demo",
    rootEntityId: "system:root",
    entityIds: entities.map(value => value.id),
    relationIds: relations.map(value => value.id),
    layout: { nodes: Object.fromEntries(entities.map((value, index) => [value.id, { x: index, y: 0, width: 4, height: 4 }])) },
  };
  const story = { schemaVersion: 1, id: "story:demo", snapshotId: snapshot.id, viewId: view.id, title: "Overview", steps: [{ id: "step:1", title: "Start", focusEntityIds: ["system:root"], narration: "The system.", reveal: "context" }] };
  return { snapshot, view, story };
}

export function fixtureSidecar(): string {
  return JSON.stringify({
    scopes: [{ scopeId: "container:web", name: "Web", kind: "container", state: "accepted", sourceRefs: [{ path: "src/container/web.ts" }] }],
    explanations: [{ scopeId: "container:web", content: { summary: "The web shell renders the atlas.", claims: [{ text: FIXTURE_CLAIM }] } }],
  });
}

/** Publishes one more version of the fixture repository; returns the publication. */
export function publishFixtureVersion(store: OperatorStore, publications: OperatorPublicationService, runId: string, label: string, expectedCurrentVersionId?: string): OperatorPublication {
  const trio = fixtureTrio(label);
  const artifact = store.writeArtifactRevision({
    repositoryId: FIXTURE_REPOSITORY_ID,
    sourceCommitSha: FIXTURE_COMMIT,
    files: {
      "snapshot.json": JSON.stringify(trio.snapshot),
      "view.json": JSON.stringify(trio.view),
      "story.json": JSON.stringify(trio.story),
      "operator-explanations.json": fixtureSidecar(),
      // Not a public scan file: never published.
      "atlas.okie.json": JSON.stringify({ private: true }),
    },
  });
  const draft = publications.createDraftRevision({ runId, artifactRevisionId: artifact.artifactRevisionId });
  const result = publications.publishDraft({ repositoryId: FIXTURE_REPOSITORY_ID, draftRevisionId: draft.draftRevisionId, ...(expectedCurrentVersionId ? { expectedCurrentVersionId } : {}) });
  assert.ok(result.ok);
  return result.publication;
}

/** An operator store under `scanRoot` with one published version of acme/demo. */
export function createPublishedOperatorFixture(scanRoot: string): { store: OperatorStore; publications: OperatorPublicationService; runId: string; publication: OperatorPublication } {
  const store = new OperatorStore(scanRoot);
  const publications = new OperatorPublicationService(store);
  const run = store.createRun({ idempotencyKey: "fixture", source: { repositoryId: FIXTURE_REPOSITORY_ID, owner: "acme", repo: "demo", slug: FIXTURE_SLUG, commitSha: FIXTURE_COMMIT } }).run;
  store.updateRun(run.runId, { state: "complete" });
  return { store, publications, runId: run.runId, publication: publishFixtureVersion(store, publications, run.runId, "Original") };
}

/** In-memory published store (what R2 holds), with the order objects were written in. */
export function memoryStoreClient(): PublishStoreClient & { objects: Map<string, Buffer>; order: string[] } {
  const objects = new Map<string, Buffer>();
  const order: string[] = [];
  return {
    objects,
    order,
    async get(key) { return objects.get(key); },
    async put(key, bytes) { objects.set(key, Buffer.from(bytes)); order.push(key); },
  };
}
