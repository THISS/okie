import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
    assert.equal(artifact.sizeBytes, 3);
    assert.throws(() => store.writeArtifactRevision({ repositoryId: source.repositoryId, files: { "../outside": "no" } }));
    store.updateRun(first.run.runId, { state: "running" });
    assert.deepEqual(store.snapshot().events.at(-1)?.detail, { previous: "queued", state: "running" });
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

test("publication pointers are bounded for maximum GitHub names and advance twice", () => {
  const { root, store } = setup();
  const repositoryId = `repo:acme/${"r".repeat(95)}`;
  const longSource = { repositoryId, owner: "acme", repo: "r".repeat(95), slug: `acme__${"r".repeat(95)}`, commitSha: "a".repeat(40) };
  try {
    const firstRun = store.createRun({ idempotencyKey: "long-one", source: longSource }).run;
    const firstArtifact = store.writeArtifactRevision({ repositoryId, files: { "snapshot.json": "one" } });
    const firstDraft = store.createDraftRevision({ runId: firstRun.runId, artifactRevisionId: firstArtifact.artifactRevisionId });
    const publisher = new OperatorPublicationService(store);
    const first = publisher.publishDraft({ repositoryId, draftRevisionId: firstDraft.draftRevisionId });
    assert.equal(first.ok, true);
    const secondRun = store.createRun({ idempotencyKey: "long-two", source: longSource }).run;
    const secondArtifact = store.writeArtifactRevision({ repositoryId, files: { "snapshot.json": "two" } });
    const secondDraft = publisher.createDraftRevision({ runId: secondRun.runId, artifactRevisionId: secondArtifact.artifactRevisionId });
    const second = publisher.publishDraft({ repositoryId, draftRevisionId: secondDraft.draftRevisionId, expectedCurrentVersionId: first.publication.versionId });
    assert.equal(second.ok, true);
    assert.equal(publisher.currentPublication(repositoryId)?.versionId, second.publication.versionId);
    assert.equal(publisher.artifactForVersion(repositoryId, first.publication.versionId)?.artifactRevisionId, first.publication.artifactRevisionId, "pinned reads keep the first publication");
    const pointers = readdirSync(join(store.root, "current"));
    assert.equal(pointers.length, 1);
    assert.ok(pointers[0]!.length <= 70);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("case-variant durable pointers resolve and migrate onto one canonical publication key", () => {
  const { root, store } = setup();
  try {
    const firstRun = store.createRun({ idempotencyKey: "legacy-case", source }).run;
    const artifact = store.writeArtifactRevision({ repositoryId: source.repositoryId, files: { "snapshot.json": "old" } });
    const draft = store.createDraftRevision({ runId: firstRun.runId, artifactRevisionId: artifact.artifactRevisionId });
    const publisher = new OperatorPublicationService(store);
    const first = publisher.publishDraft({ repositoryId: source.repositoryId, draftRevisionId: draft.draftRevisionId });
    assert.equal(first.ok, true);
    const canonicalPointer = readdirSync(join(store.root, "current"))[0]!;
    const oldRepositoryId = "repo:Acme/app";
    const oldPointer = `${Buffer.from(oldRepositoryId).toString("hex")}.json`;
    renameSync(join(store.root, "current", canonicalPointer), join(store.root, "current", oldPointer));
    const statePath = join(store.root, "state.json");
    writeFileSync(statePath, readFileSync(statePath, "utf8").replaceAll(source.repositoryId, oldRepositoryId));
    const restarted = new OperatorStore(root);
    const restartedPublisher = new OperatorPublicationService(restarted);
    assert.equal(restartedPublisher.currentPublication(source.repositoryId)?.versionId, first.publication.versionId, "legacy case pointer remains readable");
    const secondRun = restarted.createRun({ idempotencyKey: "canonical-case", source: { ...source, repositoryId: "repo:ACME/app", owner: "ACME" } }).run;
    assert.equal(secondRun.source.repositoryId, source.repositoryId, "new intake canonicalizes case variants");
    const secondArtifact = restarted.writeArtifactRevision({ repositoryId: source.repositoryId, files: { "snapshot.json": "new" } });
    const secondDraft = restartedPublisher.createDraftRevision({ runId: secondRun.runId, artifactRevisionId: secondArtifact.artifactRevisionId });
    const second = restartedPublisher.publishDraft({ repositoryId: source.repositoryId, draftRevisionId: secondDraft.draftRevisionId, expectedCurrentVersionId: first.publication.versionId });
    assert.equal(second.ok, true);
    assert.equal(restartedPublisher.currentPublication("repo:ACME/APP")?.versionId, second.publication.versionId);
    assert.ok(readdirSync(join(restarted.root, "current")).some(name => /^[a-f0-9]{64}\.json$/.test(name)), "the next publish installs the bounded canonical pointer");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("legacy mixed-case runs can create canonical artifact drafts during retry", () => {
  const { root, store } = setup();
  const thiss = { ...source, repositoryId: "repo:thiss/okie", owner: "thiss", repo: "okie", slug: "thiss__okie" };
  try {
    const run = store.createRun({ idempotencyKey: "legacy-retry", source: thiss }).run;
    const statePath = join(store.root, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { runs: Array<{ runId: string; source: { repositoryId: string; owner: string; repo: string } }>; drafts: Array<{ repositoryId: string }> };
    const persisted = state.runs.find(value => value.runId === run.runId)!;
    persisted.source.repositoryId = "repo:THISS/okie";
    persisted.source.owner = "THISS";
    state.drafts = Array.from({ length: 10 }, () => ({ repositoryId: "repo:THISS/okie" }));
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);
    const restarted = new OperatorStore(root);
    const artifact = restarted.writeArtifactRevision({ repositoryId: thiss.repositoryId, files: { "snapshot.json": "retry" } });
    const retryDraft = restarted.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
    assert.equal(retryDraft.repositoryId, thiss.repositoryId);
    assert.equal(retryDraft.revision, 11, "legacy case-variant drafts continue the canonical revision sequence");
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
