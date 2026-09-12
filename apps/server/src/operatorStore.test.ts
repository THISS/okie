import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore } from "./operatorStore.js";

const source = { repositoryId: "repo:acme/app", owner: "acme", repo: "app", slug: "acme__app", commitSha: "a".repeat(40) };
function setup() { const root = mkdtempSync(join(tmpdir(), "okie-operator-")); let at = 100; return { root, store: new OperatorStore(root, () => ++at), source }; }
function draft(store: OperatorStore) { const run = store.createRun({ idempotencyKey: "request-1", source }).run; const artifact = store.writeArtifactRevision({ repositoryId: source.repositoryId, sourceCommitSha: source.commitSha, files: { "snapshot.json": "{\"first\":true}" } }); return store.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId }); }

test("CLA-132: idempotency, immutable artifact bytes, and restart interruption recovery", () => {
  const { root, store } = setup();
  try {
    const first = store.createRun({ idempotencyKey: "request-1", source });
    assert.equal(store.createRun({ idempotencyKey: "request-1", source }).run.runId, first.run.runId);
    const artifact = store.writeArtifactRevision({ repositoryId: source.repositoryId, files: { "snapshot.json": "one" } });
    assert.equal(store.readArtifactFile(artifact.artifactRevisionId, "snapshot.json")?.toString(), "one");
    assert.throws(() => store.writeArtifactRevision({ repositoryId: source.repositoryId, files: { "../outside": "no" } }));
    store.updateRun(first.run.runId, { state: "running" });
    const restarted = new OperatorStore(root, () => 999);
    assert.equal(restarted.snapshot().runs[0]?.state, "interrupted");
    assert.equal(existsSync(join(root, "outside")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLA-132: publication is CAS guarded, coverage is explicit, and old artifacts stay pinned", () => {
  const { root, store } = setup();
  try {
    const first = draft(store); const publisher = new OperatorPublicationService(store);
    assert.equal(publisher.publishDraft({ repositoryId: source.repositoryId, draftRevisionId: first.draftRevisionId }).ok, true);
    const publication = publisher.currentPublication(source.repositoryId);
    assert.ok(publication);
    const second = draft(store);
    const stale = publisher.publishDraft({ repositoryId: source.repositoryId, draftRevisionId: second.draftRevisionId });
    assert.deepEqual(stale, { ok: false, reason: "stale_publication", currentVersionId: publication.versionId });
    const current = publisher.resolveCurrent(source.repositoryId);
    assert.equal(current?.artifactRevisionId, publication.artifactRevisionId);
    assert.equal(store.readArtifactFile(publication.artifactRevisionId, "snapshot.json")?.toString(), "{\"first\":true}");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLA-132: legacy directories remain resolvable until migration", () => {
  const { root, store } = setup(); const legacy = join(root, "legacy");
  try { writeFileSync(join(root, "placeholder"), "x"); mkdirSync(join(legacy, source.slug), { recursive: true }); assert.deepEqual(new OperatorPublicationService(store, legacy).resolveCurrent(source.repositoryId, source.slug), { kind: "legacy", legacyDirectory: join(legacy, source.slug) }); }
  finally { rmSync(root, { recursive: true, force: true }); }
});
