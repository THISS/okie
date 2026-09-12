import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

test("CLA-132: fixed clocks cannot collide and a failed pointer rename retries the frozen transaction", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-operator-"));
  try {
    const one = new OperatorStore(root, () => 1);
    const two = new OperatorStore(root, () => 1);
    const first = one.createRun({ idempotencyKey: "one", source }).run;
    const second = two.createRun({ idempotencyKey: "two", source }).run;
    assert.notEqual(first.runId, second.runId);
    const artifact = one.writeArtifactRevision({ repositoryId: source.repositoryId, files: { "snapshot.json": "fixed" } });
    const revision = one.createDraftRevision({ runId: first.runId, artifactRevisionId: artifact.artifactRevisionId });
    let fail = true;
    const publisher = new OperatorPublicationService(one, undefined, { rename: (from, to) => { if (fail) { fail = false; throw new Error("simulated pointer crash"); } renameSync(from, to); } });
    assert.throws(() => publisher.publishDraft({ repositoryId: source.repositoryId, draftRevisionId: revision.draftRevisionId }));
    assert.equal(one.snapshot().drafts.find(value => value.draftRevisionId === revision.draftRevisionId)?.state, "frozen");
    const recovered = publisher.publishDraft({ repositoryId: source.repositoryId, draftRevisionId: revision.draftRevisionId });
    assert.equal(recovered.ok, true);
    assert.ok(publisher.currentPublication(source.repositoryId));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLA-132: dead lock owners recover, while a live owner is never stolen", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-operator-"));
  try {
    const stale = new OperatorStore(root, { pid: 9, isProcessAlive: () => false });
    writeFileSync(join(stale.root, ".lock"), JSON.stringify({ pid: 999 }));
    assert.ok(stale.createRun({ idempotencyKey: "dead-owner", source }).run.runId);
    writeFileSync(join(stale.root, ".lock"), JSON.stringify({ pid: 888 }));
    assert.throws(() => new OperatorStore(root, { pid: 10, isProcessAlive: () => true }), /busy/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
