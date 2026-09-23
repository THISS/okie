import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ArchitectureSnapshot } from "@okie/architecture";
import { buildSectionState, readSectionProfile, runSectionProfile } from "./sectionProfiles.js";
import { JEV_MODEL, type JudgmentProvider } from "./operatorJudgments.js";
import { OperatorStore } from "./operatorStore.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { createOperatorRunner } from "./operatorRunner.js";

const commit = "a".repeat(40);
function snapshot() {
  const excerpt = { path: "a.ts", startLine: 3, endLine: 3, lines: ["if (!valid) throw Error();"], text: "if (!valid) throw Error();", frozenRevision: commit, language: "typescript", highlightLine: 3 };
  return { entities: [
    { id: "container:parent", kind: "container", name: "Parent", sourceRefs: [] },
    { id: "component:a", parentId: "container:parent", kind: "component", name: "Database", sourceRefs: [{ path: "a.ts", startLine: 3, endLine: 3, commitSha: commit }], sourceExcerpts: [excerpt] },
    { id: "component:b", parentId: "container:parent", kind: "component", name: "Missing", sourceRefs: [] },
  ], relations: [{ id: "rel:a", from: "component:a", to: "component:b", kind: "calls" }] } as unknown as ArchitectureSnapshot;
}
function setup(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "okie-profiles-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new OperatorStore(root);
  const publication = new OperatorPublicationService(store);
  const run = store.createRun({ idempotencyKey: "profile", source: { repositoryId: "repo:o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
  const artifact = store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: commit, files: { "snapshot.json": JSON.stringify(snapshot()), "atlas.okie.json": "original" } });
  const draft = publication.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId, coverage: { total: 3, accepted: 1, failed: 1, stale: 1 } });
  store.updateRun(run.runId, { state: "awaiting_review" });
  let calls = 0;
  const provider: JudgmentProvider = { modelId: JEV_MODEL, async evaluate(request) {
    calls++;
    const answers = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => {
      const selected = key === "validation" ? Object.keys(question.criteria).find(id => id.startsWith("e"))! : "unknown";
      return [key, { type: "choice", choice: selected, confidence: 0.9, probabilities: Object.fromEntries(Object.keys(question.criteria).map(id => [id, id === selected ? 1 : 0])) }];
    }));
    return { json: { model: JEV_MODEL, answers }, usage: { inputTokens: 123 } };
  } };
  return { store, publication, runId: run.runId, draftRevisionId: draft.draftRevisionId, provider, calls: () => calls, pin: { repositoryId: run.source.repositoryId }, artifact };
}
test("bounded canonical evidence rejects stale/range/text mismatches; labels and names do not infer roles", () => {
  const value = snapshot();
  const state = buildSectionState(value, "container:parent", commit);
  assert.equal(state.evidence.length, 1);
  assert.deepEqual(state.observedRelationKinds, ["calls"]);
  assert.equal(state.coverage.missingSourceCount, 2);
  const entity = value.entities[1]!;
  entity.sourceExcerpts![0]!.endLine++;
  assert.equal(buildSectionState(value, "component:a", commit).coverage.invalidExcerpts, 1);
  entity.sourceExcerpts![0]!.endLine--;
  entity.sourceExcerpts![0]!.text = "different";
  assert.equal(buildSectionState(value, "component:a", commit).evidence.length, 0);
  assert.equal(buildSectionState(snapshot(), "component:a", "b".repeat(40)).evidence.length, 0);
  const many = snapshot();
  many.entities[1]!.sourceExcerpts = Array.from({ length: 7 }, (_, i) => ({ ...snapshot().entities[1]!.sourceExcerpts![0]!, symbol: `s${i}` }));
  assert.equal(buildSectionState(many, "component:a", commit).evidence.length, 6);
  assert.equal(buildSectionState(many, "component:a", commit).coverage.omittedExcerpts, 1);
});
test("immutable pinned read, provider-free reuse, child retry stales ancestors only in new draft", async t => {
  const ctx = setup(t);
  assert.equal(readSectionProfile(ctx.store, { ...ctx.pin, draftRevisionId: ctx.draftRevisionId }, "component:a").state, "missing");
  const parent = await runSectionProfile({ ...ctx, scopeId: "container:parent" });
  assert.equal(parent.state, "accepted"); if (parent.state !== "accepted" || !("profile" in parent)) return;
  const frozen = ctx.publication.publishDraft({ ...ctx.pin, draftRevisionId: parent.draftRevisionId, acknowledgeCoverage: true });
  assert.equal(frozen.ok, true); if (!frozen.ok) return;
  const child = await runSectionProfile({ ...ctx, draftRevisionId: parent.draftRevisionId, scopeId: "component:a" });
  assert.equal(child.state, "accepted"); if (child.state !== "accepted" || !("profile" in child)) return;
  assert.equal(child.profile.roles.validation.status, "inferred");
  assert.equal(child.profile.roles.persistence.status, "unknown");
  assert.equal(readSectionProfile(ctx.store, { ...ctx.pin, draftRevisionId: child.draftRevisionId }, "container:parent").state, "stale");
  assert.equal(readSectionProfile(ctx.store, { ...ctx.pin, publicationVersionId: frozen.publication.versionId }, "container:parent").state, "ready");
  const { provider: _provider, ...withoutProvider } = ctx;
  const replayed = await runSectionProfile({ ...withoutProvider, draftRevisionId: child.draftRevisionId, scopeId: "component:a" });
  assert.equal(replayed.state, "accepted");
  assert.ok("replayed" in replayed && replayed.replayed);
  assert.equal(ctx.calls(), 2);
  assert.deepEqual(ctx.store.snapshot().drafts.at(-1)!.coverage, { total: 3, accepted: 1, failed: 1, stale: 1 });
  assert.equal(ctx.store.readArtifactFile(ctx.artifact.artifactRevisionId, "atlas.okie.json")!.toString(), "original");
  assert.throws(() => readSectionProfile(ctx.store, { repositoryId: "repo:other/repo", draftRevisionId: child.draftRevisionId }, "component:a"));
});
test("missing evidence uses no model; malformed selection, unavailable provider, cancelled and stale requests never write profiles", async t => {
  const ctx = setup(t);
  assert.equal((await runSectionProfile({ ...ctx, scopeId: "component:b" })).state, "insufficient-evidence");
  assert.equal(ctx.calls(), 0);
  assert.equal((await runSectionProfile({ ...ctx, draftRevisionId: "old", scopeId: "component:a" })).state, "conflict");
  const { provider: _provider, ...withoutProvider } = ctx;
  assert.equal((await runSectionProfile({ ...withoutProvider, scopeId: "component:a" })).state, "unavailable");
  const bad: JudgmentProvider = { modelId: JEV_MODEL, async evaluate() { return { json: { model: JEV_MODEL, answers: { validation: { choice: "invented" } } }, usage: {} }; } };
  assert.equal((await runSectionProfile({ ...ctx, provider: bad, scopeId: "component:a" })).state, "failed");
  assert.equal(readSectionProfile(ctx.store, { ...ctx.pin, draftRevisionId: ctx.draftRevisionId }, "component:a").state, "missing");
  const controller = new AbortController(); controller.abort();
  assert.equal((await runSectionProfile({ ...ctx, signal: controller.signal, scopeId: "component:a" })).state, "cancelled");
});

test("support threshold retains raw uncertainty on both sides of 0.8", async t => {
  for (const probability of [0.79, 0.8]) {
    const ctx = setup(t);
    const uncertain: JudgmentProvider = { modelId: JEV_MODEL, async evaluate(request) {
      const answers = Object.fromEntries(Object.entries(request.questions).map(([role, question]) => {
        const candidate = Object.keys(question.criteria).find(id => id.startsWith("e"))!;
        return [role, { type: "choice", choice: candidate, confidence: 0.95, probabilities: Object.fromEntries(Object.keys(question.criteria).map(id => [id, id === candidate ? probability : id === "unknown" ? 1 - probability : 0])) }];
      }));
      return { json: { model: JEV_MODEL, answers }, usage: {} };
    } };
    const result = await runSectionProfile({ ...ctx, provider: uncertain, scopeId: "component:a" });
    assert.equal(result.state, "accepted"); if (result.state !== "accepted") continue;
    const role = result.profile.roles.validation;
    assert.equal(role.status, probability === 0.8 ? "inferred" : "unknown");
    assert.equal(role.answer.probabilities[role.answer.choice], probability);
    assert.equal(Boolean(role.evidenceId), probability === 0.8);
  }
});

test("omitted evidence changes invalidate state; deterministic sampling reaches beyond headers", () => {
  const value = snapshot();
  const example = value.entities[1]!;
  example.sourceExcerpts = Array.from({ length: 8 }, (_, index) => ({ ...example.sourceExcerpts![0]!, symbol: `s${index}`, startLine: index + 1, endLine: index + 1 }));
  example.sourceRefs = example.sourceExcerpts.map(ref => ({ path: ref.path, startLine: ref.startLine, endLine: ref.endLine, commitSha: commit }));
  const before = buildSectionState(value, "container:parent", commit);
  assert.equal(before.evidence.length, 6);
  assert.ok(before.evidence.some(ref => ref.startLine === 8));
  const omitted = example.sourceExcerpts.find(ref => !before.evidence.some(selected => selected.startLine === ref.startLine))!;
  omitted.lines = ["return 3;"]; omitted.text = "return 3;";
  const after = buildSectionState(value, "container:parent", commit);
  assert.notEqual(after.scopeDigest, before.scopeDigest);
  assert.deepEqual(after.evidence, before.evidence);
});

function replaceArtifact(ctx: ReturnType<typeof setup>, files: Record<string, string>) {
  const artifact = ctx.store.writeArtifactRevision({ repositoryId: ctx.pin.repositoryId, sourceCommitSha: commit, files });
  return ctx.publication.createDraftRevision({ runId: ctx.runId, artifactRevisionId: artifact.artifactRevisionId }).draftRevisionId;
}

test("corrupt sidecars/snapshots and missing snapshot return typed failures on read and run", async t => {
  const version = "section-capabilities/v2";
  const cases: Array<{ files: Record<string, string>; state: "corrupt" | "unavailable"; file: string }> = [
    ...["{", JSON.stringify({ schemaVersion: version, profiles: {} }), JSON.stringify({ schemaVersion: version, profiles: [null] }), JSON.stringify({ schemaVersion: version, profiles: [{ scopeId: "component:a" }] })].map(sidecar => ({ files: { "snapshot.json": JSON.stringify(snapshot()), "section-profiles.json": sidecar }, state: "corrupt" as const, file: "section-profiles.json" })),
    { files: { "section-profiles.json": JSON.stringify({ schemaVersion: version, profiles: [] }) }, state: "unavailable", file: "snapshot.json" },
    ...["{", "null", JSON.stringify({ entities: {}, relations: [] }), JSON.stringify({ entities: [null], relations: [] })].map(value => ({ files: { "snapshot.json": value }, state: "corrupt" as const, file: "snapshot.json" })),
  ];
  for (const row of cases) {
    const ctx = setup(t);
    const draftRevisionId = replaceArtifact(ctx, row.files);
    const expected = { state: row.state, file: row.file };
    assert.deepEqual(readSectionProfile(ctx.store, { ...ctx.pin, draftRevisionId }, "component:a"), expected);
    assert.deepEqual(await runSectionProfile({ ...ctx, draftRevisionId, scopeId: "component:a" }), expected);
    assert.equal(ctx.calls(), 0);
    assert.equal(ctx.store.snapshot().attempts.length, 0);
    assert.throws(() => readSectionProfile(ctx.store, { ...ctx.pin, draftRevisionId: "unknown" }, "component:a"), /unknown profile pin/);
  }
  const io = setup(t);
  io.store.readArtifactFile = () => { throw new Error("simulated unavailable filesystem"); };
  assert.deepEqual(readSectionProfile(io.store, { ...io.pin, draftRevisionId: io.draftRevisionId }, "component:a"), { state: "unavailable", file: "snapshot.json" });
  assert.deepEqual(await runSectionProfile({ ...io, scopeId: "component:a" }), { state: "unavailable", file: "snapshot.json" });
});

test("hub sizing returns an explicit coverage limit before the foundation/provider", async t => {
  const ctx = setup(t);
  const hub = snapshot();
  hub.relations = Array.from({ length: 80 }, (_, index) => ({ ...hub.relations[0]!, id: `rel:${index}`, description: "captured relation evidence ".repeat(40) }));
  const draftRevisionId = replaceArtifact(ctx, { "snapshot.json": JSON.stringify(hub) });
  const outcome = await runSectionProfile({ ...ctx, draftRevisionId, scopeId: "component:a" });
  assert.equal(outcome.state, "oversized"); if (outcome.state !== "oversized") return;
  assert.ok(outcome.requestBytes > outcome.maxRequestBytes);
  assert.equal(outcome.maxRequestBytes, 24000);
  assert.match(outcome.observed.coverage.limitations.at(-1)!, /no provider request/);
  assert.equal(ctx.calls(), 0);
  assert.equal(ctx.store.snapshot().attempts.length, 0);
  assert.equal(ctx.store.snapshot().runs[0]!.draftRevisionId, draftRevisionId);
});

test("runner seam forwards provider, budget and cancellation; pinned nondefault model reads/reuses", async t => {
  const ctx = setup(t);
  const input = { runId: ctx.runId, draftRevisionId: ctx.draftRevisionId, scopeId: "component:a" };
  assert.equal((await createOperatorRunner({ ...ctx, judgmentProvider: null }).profile(input)).state, "unavailable");
  assert.equal((await createOperatorRunner({ ...ctx, judgmentProvider: ctx.provider, judgmentLimits: { maxRequests: 0 } }).profile(input)).state, "limit");
  const controller = new AbortController(); controller.abort();
  assert.equal((await createOperatorRunner({ ...ctx, judgmentProvider: ctx.provider }).profile(input, controller.signal)).state, "cancelled");
  assert.equal(ctx.calls(), 0);
  const otherModel: JudgmentProvider = { modelId: "jev-9.9.9", async evaluate(request, signal) {
    const reply = await ctx.provider.evaluate(request, signal);
    return { ...reply, json: { ...(reply.json as object), model: "jev-9.9.9" } };
  } };
  const outcome = await createOperatorRunner({ ...ctx, judgmentProvider: otherModel }).profile(input);
  assert.equal(outcome.state, "accepted"); if (outcome.state !== "accepted") return;
  assert.equal(outcome.profile.modelId, "jev-9.9.9");
  assert.equal(readSectionProfile(ctx.store, { ...ctx.pin, draftRevisionId: outcome.draftRevisionId }, input.scopeId).state, "ready");
  const replay = await createOperatorRunner({ ...ctx, judgmentProvider: null }).profile({ ...input, draftRevisionId: outcome.draftRevisionId });
  assert.equal(replay.state, "accepted");
  assert.ok("replayed" in replay && replay.replayed);
  assert.equal(ctx.calls(), 1);
});

test("interrupted sidecar promotion replays its judgment and excludes opaque descendant identities", async t => {
  const ctx = setup(t);
  const first = await runSectionProfile({ ...ctx, scopeId: "component:a" });
  assert.equal(first.state, "accepted"); if (first.state !== "accepted") return;
  // The preceding immutable draft has the judgment but not the derived profile.
  const judgmentDraft = ctx.store.snapshot().drafts.at(-2)!;
  const artifact = ctx.store.snapshot().artifacts.find(row => row.artifactRevisionId === judgmentDraft.artifactRevisionId)!;
  const files = Object.fromEntries(artifact.files.map(file => [file, ctx.store.readArtifactFile(artifact.artifactRevisionId, file)!.toString()]));
  const draftRevisionId = replaceArtifact(ctx, files);
  const restored = await runSectionProfile({ ...ctx, draftRevisionId, scopeId: "component:a" });
  assert.equal(restored.state, "accepted");
  assert.ok("replayed" in restored && restored.replayed);
  assert.equal(ctx.calls(), 1);
  if (restored.state !== "accepted") return;
  let sawState = false;
  const inspecting: JudgmentProvider = { modelId: JEV_MODEL, async evaluate(request, signal) {
    const state = request.state as { inputs: { section: Record<string, unknown> } };
    assert.ok(!Object.hasOwn(state.inputs.section, "scopeDigest"));
    assert.ok(!Object.hasOwn(state.inputs.section, "descendantProfiles"));
    sawState = true;
    return ctx.provider.evaluate(request, signal);
  } };
  const parent = await runSectionProfile({ ...ctx, provider: inspecting, draftRevisionId: restored.draftRevisionId, scopeId: "container:parent" });
  assert.equal(parent.state, "accepted"); assert.ok(sawState);
  if (parent.state === "accepted") assert.equal(parent.profile.observed.descendantProfiles.length, 1);
});

test("concurrent draft callers conflict without lost writes; serial retry preserves winner", async t => {
  const ctx = setup(t);
  const releases: Array<() => void> = [];
  let entered!: () => void;
  const bothEntered = new Promise<void>(resolve => { entered = resolve; });
  const gated: JudgmentProvider = { modelId: JEV_MODEL, async evaluate(request, signal) {
    await new Promise<void>(resolve => { releases.push(resolve); if (releases.length === 2) entered(); });
    return ctx.provider.evaluate(request, signal);
  } };
  const limits = { maxRequests: 6, maxTokens: 600000, maxDollars: 0.03 };
  const first = runSectionProfile({ ...ctx, provider: gated, limits, scopeId: "component:a" });
  const second = runSectionProfile({ ...ctx, provider: gated, limits, scopeId: "container:parent" });
  await bothEntered;
  releases[0]!();
  const winner = await first;
  assert.equal(winner.state, "accepted"); if (winner.state !== "accepted") { releases[1]!(); await second; return; }
  releases[1]!();
  assert.equal((await second).state, "conflict");
  const pinnedWinner = readSectionProfile(ctx.store, { ...ctx.pin, draftRevisionId: winner.draftRevisionId }, "component:a");
  const retry = await runSectionProfile({ ...ctx, limits, draftRevisionId: winner.draftRevisionId, scopeId: "container:parent" });
  assert.equal(retry.state, "accepted"); if (retry.state !== "accepted") return;
  assert.deepEqual(readSectionProfile(ctx.store, { ...ctx.pin, draftRevisionId: retry.draftRevisionId }, "component:a"), pinnedWinner);
  assert.equal(readSectionProfile(ctx.store, { ...ctx.pin, draftRevisionId: retry.draftRevisionId }, "container:parent").state, "ready");
  assert.equal(ctx.calls(), 3, "losing concurrent work is not secretly replayed or scheduled");
});
