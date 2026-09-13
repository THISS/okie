import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parsePortableAtlas } from "@okie/architecture";
import { scanRepository } from "@okie/scan";
import { OperatorPublicationService } from "./operatorPublication.js";
import { createOperatorRunner } from "./operatorRunner.js";
import { OperatorStore } from "./operatorStore.js";

test("runner writes parseable deterministic and immutable enriched drafts", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-"));
  try {
    const store = new OperatorStore(root);
    const run = store.createRun({ idempotencyKey: "x", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
    const artifacts = scanRepository(process.cwd(), { systemName: "Okie", repositorySlug: "okie" });
    const runner = createOperatorRunner({ store, publication: new OperatorPublicationService(store), githubClient: () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }) as never, scan: async () => ({ commitSha: "abc", artifacts }), gateway: { modelId: "fake/model", async chatCompletions(body) {
      const message = JSON.parse(String((body.messages as Array<{ content: string }>)[1]!.content)) as { role?: string; directChildren?: string[]; scope?: { scopeId: string; allowedEvidence: unknown[] } };
      if (message.role === "coordinator") return { json: { choices: [{ message: { content: JSON.stringify({ assignments: (message.directChildren ?? []).map(scopeId => ({ scopeId })) }) } }] } };
      return { json: { choices: [{ message: { content: JSON.stringify({ summary: `Summary ${message.scope!.scopeId}`, evidence: message.scope!.allowedEvidence.slice(0, 1) }) } }] }, usage: { totalTokens: 2 } };
    } } });
    await runner.enqueue({ kind: "run", runId: run.runId, githubAccess: { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } });
    const drafts = store.snapshot().drafts;
    assert.equal(drafts.length, 2);
    const deterministic = store.readArtifactFile(drafts[0]!.artifactRevisionId, "atlas.okie.json")!;
    parsePortableAtlas(deterministic.toString());
    const sidecar = JSON.parse(store.readArtifactFile(drafts[1]!.artifactRevisionId, "operator-explanations.json")!.toString()) as { explanations: Array<{ content: { summary: string } }> };
    assert.match(sidecar.explanations[0]!.content.summary, /^Summary/);
    assert.deepEqual(deterministic, store.readArtifactFile(drafts[0]!.artifactRevisionId, "atlas.okie.json"));
    assert.equal(store.snapshot().publications.length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runner retries only the selected scope into a new immutable draft", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-retry-"));
  try {
    const store = new OperatorStore(root);
    const run = store.createRun({ idempotencyKey: "retry", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r", commitSha: "abc" } }).run;
    const scopes = [
      { scopeId: "system", name: "System", kind: "softwareSystem", sourceRefs: [{ path: "system.ts" }] },
      { scopeId: "component", parentScopeId: "system", name: "Component", kind: "component", sourceRefs: [{ path: "component.ts" }] },
      { scopeId: "target", parentScopeId: "component", name: "Target", kind: "code", sourceRefs: [{ path: "target.ts", startLine: 1, endLine: 2 }] },
      { scopeId: "sibling", parentScopeId: "component", name: "Sibling", kind: "code", sourceRefs: [{ path: "sibling.ts" }] },
    ];
    const oldSidecar = JSON.stringify({ schemaVersion: 1, scopes, explanations: [
      { scopeId: "target", explanationVersionId: "target-original", content: { summary: "old target", evidence: [{ entityId: "target", path: "target.ts", startLine: 1, endLine: 2 }] } },
      { scopeId: "sibling", explanationVersionId: "sibling-original", content: { summary: "old sibling", evidence: [{ entityId: "sibling", path: "sibling.ts" }] } },
    ] });
    const snapshot = JSON.stringify({ schemaVersion: 1, id: "snapshot", repositoryId: "o/r", commitSha: "abc", generatedAt: "2026-01-01T00:00:00.000Z", entities: scopes.map(scope => ({ id: scope.scopeId, ...(scope.parentScopeId ? { parentId: scope.parentScopeId } : {}), name: scope.name, kind: scope.kind, sourceRefs: scope.sourceRefs.map(ref => ({ ...ref, commitSha: "abc" })) })), relations: [] });
    const artifact = store.writeArtifactRevision({ repositoryId: "o/r", sourceCommitSha: "abc", files: { "snapshot.json": snapshot, "operator-explanations.json": oldSidecar, "atlas.okie.json": "old atlas" } });
    const draft = store.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId, coverage: { total: 4, accepted: 4, failed: 0, stale: 0 } });
    for (const scopeId of ["system", "component", "target", "sibling"]) store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId, kind: "enrichment", state: "accepted" });
    const calls: string[] = [];
    const runner = createOperatorRunner({
      store,
      publication: new OperatorPublicationService(store),
      scan: async () => { throw new Error("retry must not rescan"); },
      gateway: { modelId: "fake/model", async chatCompletions(body) {
        const message = JSON.parse(String((body.messages as Array<{ content: string }>)[1]!.content)) as { scope: { scopeId: string; allowedEvidence: unknown[] } };
        calls.push(message.scope.scopeId);
        return { json: { choices: [{ message: { content: JSON.stringify({ summary: "new target", evidence: message.scope.allowedEvidence }) } }] } };
      } },
    });
    const oldBytes = store.readArtifactFile(artifact.artifactRevisionId, "operator-explanations.json")!;
    await runner.enqueue({ kind: "retry", runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeIds: ["target"], githubAccess: { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } });

    assert.deepEqual(calls, ["target"]);
    assert.equal(store.readArtifactFile(artifact.artifactRevisionId, "operator-explanations.json")!.compare(oldBytes), 0);
    const active = store.snapshot().runs.find(value => value.runId === run.runId)!;
    assert.notEqual(active.draftRevisionId, draft.draftRevisionId);
    const nextDraft = store.snapshot().drafts.find(value => value.draftRevisionId === active.draftRevisionId)!;
    assert.notEqual(nextDraft.artifactRevisionId, artifact.artifactRevisionId);
    const next = JSON.parse(store.readArtifactFile(nextDraft.artifactRevisionId, "operator-explanations.json")!.toString()) as { scopes: Array<{ scopeId: string; stale?: boolean }>; explanations: Array<{ scopeId: string; explanationVersionId: string; content: { summary: string } }> };
    assert.deepEqual(next.explanations.find(value => value.scopeId === "sibling"), { scopeId: "sibling", explanationVersionId: "sibling-original", content: { summary: "old sibling", evidence: [{ entityId: "sibling", path: "sibling.ts" }] } });
    assert.equal(next.explanations.find(value => value.scopeId === "target")?.content.summary, "new target");
    assert.notEqual(next.explanations.find(value => value.scopeId === "target")?.explanationVersionId, "target-original");
    assert.deepEqual(next.scopes.filter(scope => scope.stale).map(scope => scope.scopeId), ["system", "component"]);
    assert.equal(nextDraft.coverage.stale, 2);
    for (const scopeId of ["system", "component"]) assert.ok(store.listAttempts(draft.draftRevisionId, scopeId).every(attempt => !attempt.stale));

    await createOperatorRunner({ store, publication: new OperatorPublicationService(store) }).enqueue({ kind: "retry", runId: run.runId, draftRevisionId: nextDraft.draftRevisionId, scopeIds: ["target"], githubAccess: { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } });
    assert.equal(store.listAttempts(nextDraft.draftRevisionId, "target").at(-1)?.error, "no enrichment gateway configured");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runner reserves its durable budget before gateway calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-budget-")); const old = process.env.OKIE_LLM_MAX_SCOPES;
  try {
    process.env.OKIE_LLM_MAX_SCOPES = "1";
    const store = new OperatorStore(root); const run = store.createRun({ idempotencyKey: "budget", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
    const artifacts = scanRepository(process.cwd(), { systemName: "Okie", repositorySlug: "okie" }); let calls = 0;
    await createOperatorRunner({ store, publication: new OperatorPublicationService(store), githubClient: () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }) as never, scan: async () => ({ commitSha: "abc", artifacts }), gateway: { modelId: "fake/model", async chatCompletions() { calls += 1; return { json: { choices: [{ message: { content: "{}" } }] }, usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }; } } }).enqueue({ kind: "run", runId: run.runId, githubAccess: { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } });
    assert.equal(calls, 1);
    assert.equal(store.snapshot().events.filter(event => event.type === "budget.reserved").length, 1);
    assert.equal(store.snapshot().events.filter(event => event.type === "budget.settled").length, 1);
  } finally { if (old === undefined) delete process.env.OKIE_LLM_MAX_SCOPES; else process.env.OKIE_LLM_MAX_SCOPES = old; rmSync(root, { recursive: true, force: true }); }
});

test("runner leaves cancelled scans and late gateway replies cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-cancel-"));
  try {
    const store = new OperatorStore(root); const run = store.createRun({ idempotencyKey: "cancel-scan", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
    const artifacts = scanRepository(process.cwd(), { systemName: "Okie", repositorySlug: "okie" });
    const cancelledDuringScan = createOperatorRunner({ store, publication: new OperatorPublicationService(store), githubClient: () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }) as never, scan: async () => { store.updateRun(run.runId, { state: "cancelled" }); return { commitSha: "abc", artifacts }; } });
    await cancelledDuringScan.enqueue({ kind: "run", runId: run.runId, githubAccess: { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } });
    assert.equal(store.snapshot().runs.find(value => value.runId === run.runId)?.state, "cancelled"); assert.equal(store.snapshot().drafts.length, 0);

    const late = store.createRun({ idempotencyKey: "cancel-gateway", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
    const cancelledDuringGateway = createOperatorRunner({ store, publication: new OperatorPublicationService(store), githubClient: () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }) as never, scan: async () => ({ commitSha: "abc", artifacts }), gateway: { modelId: "fake/model", async chatCompletions() { store.updateRun(late.runId, { state: "cancelled" }); return { json: { choices: [{ message: { content: "{}" } }] }, usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }; } } });
    await cancelledDuringGateway.enqueue({ kind: "run", runId: late.runId, githubAccess: { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } });
    assert.equal(store.snapshot().runs.find(value => value.runId === late.runId)?.state, "cancelled");
    assert.equal(store.snapshot().explanations.filter(value => value.draftRevisionId === store.snapshot().drafts.at(-1)?.draftRevisionId).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
