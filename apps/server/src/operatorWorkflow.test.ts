import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorStore } from "./operatorStore.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorWorkflow, readArtifactScopes } from "./operatorWorkflow.js";

test("draft scope metadata preserves full immutable explanations and untouched scopes", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-workflow-"));
  try {
    const store = new OperatorStore(root);
    const publications = new OperatorPublicationService(store);
    const run = store.createRun({ idempotencyKey: "workflow", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
    const explanation = { summary: "Handles requests", roleWithinParent: "API boundary", evidence: [{ entityId: "code:a", path: "a.ts" }], diagram: { nodes: ["code:a"], edges: [] } };
    const artifact = store.writeArtifactRevision({ repositoryId: "o/r", files: { "operator-explanations.json": JSON.stringify({ scopes: [{ scopeId: "code:a", name: "handle", parentScopeId: "component:a" }, { scopeId: "code:b", name: "unvisited" }], explanations: [{ scopeId: "code:a", content: explanation, explanationVersionId: "explanation-original" }] }) } });
    const draft = publications.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
    store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: "code:a", kind: "enrichment", state: "accepted", usage: { measuredCostUsd: 0, inputTokens: 10, outputTokens: 5 } });
    const workflow = new OperatorWorkflow({ store, publications, enqueue() {} });
    const detail = workflow.draftDetail(draft.draftRevisionId)!;
    assert.equal(detail.scopes.length, 2);
    assert.equal(detail.scopes[0]?.name, "handle");
    assert.deepEqual(detail.scopes[0]?.explanation, explanation);
    assert.equal(detail.scopes[0]?.explanationVersionId, "explanation-original");
    assert.equal(detail.scopes[1]?.state, "not run", "a scope with no attempt and no explanation was never run");
    assert.equal(detail.usage.measuredCostUsd, 0);
    assert.equal(detail.usage.costStatus, "measured");

    const retry = publications.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
    store.createAttempt({ draftRevisionId: retry.draftRevisionId, scopeId: "code:a", kind: "retry", state: "failed" });
    const combined = workflow.runDetail(run.runId)!;
    assert.equal(combined.attempts.length, 2);
    assert.equal(combined.usage.inputTokens, 10);
    assert.equal(combined.usage.costStatus, "unknown");
    assert.equal(combined.usage.unknownCostAttempts, 1);
    assert.deepEqual(workflow.draftDetail(draft.draftRevisionId)?.scopes[0]?.explanation, explanation);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the enriched sidecar's per-scope state is authoritative for a draft with no attempts of its own", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-workflow-states-"));
  try {
    const store = new OperatorStore(root);
    const publications = new OperatorPublicationService(store);
    const run = store.createRun({ idempotencyKey: "states", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
    const scopes = [{ scopeId: "a", name: "a", state: "accepted" }, { scopeId: "b", name: "b", state: "failed" }, { scopeId: "c", name: "c", state: "not run" }, { scopeId: "d", name: "d", state: "accepted", stale: true }];
    const content = { summary: "ok", evidence: [] };
    const artifact = store.writeArtifactRevision({ repositoryId: "o/r", files: { "operator-explanations.json": JSON.stringify({ scopes, explanations: [{ scopeId: "a", content }, { scopeId: "d", content }] }) } });
    const first = publications.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
    store.createAttempt({ draftRevisionId: first.draftRevisionId, scopeId: "b", kind: "enrichment", state: "failed" });
    const enriched = publications.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
    const detail = new OperatorWorkflow({ store, publications, enqueue() {} }).draftDetail(enriched.draftRevisionId)!;
    assert.deepEqual(detail.scopes.map(scope => [scope.scopeId, scope.state, scope.stale]), [["a", "accepted", false], ["b", "failed", false], ["c", "not run", false], ["d", "accepted", true]]);
    const running = store.createAttempt({ draftRevisionId: enriched.draftRevisionId, scopeId: "b", kind: "retry", state: "running" });
    store.createAttempt({ draftRevisionId: enriched.draftRevisionId, scopeId: "c", kind: "retry", state: "cancelled" });
    store.createAttempt({ draftRevisionId: enriched.draftRevisionId, scopeId: "a", kind: "retry", state: "failed" });
    const live = new OperatorWorkflow({ store, publications, enqueue() {} }).draftDetail(enriched.draftRevisionId)!;
    assert.deepEqual(live.scopes.map(scope => [scope.scopeId, scope.state]), [["a", "accepted"], ["b", "running"], ["c", "cancelled"], ["d", "accepted"]], "running/queued/cancelled attempts win; a settled attempt does not override the sidecar");
    store.updateAttempt(running.attemptId, { state: "queued" });
    assert.equal(new OperatorWorkflow({ store, publications, enqueue() {} }).draftDetail(enriched.draftRevisionId)!.scopes[1]?.state, "queued");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("scope DTOs carry the primary source path for list search and tooltips (CLA-259)", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-workflow-path-"));
  try {
    const store = new OperatorStore(root);
    const artifact = store.writeArtifactRevision({ repositoryId: "o/r", files: { "operator-explanations.json": JSON.stringify({ scopes: [{ scopeId: "container:web", name: "@okie/web", kind: "container", sourceRefs: [{ path: "apps/web" }] }, { scopeId: "component:share", name: "api/share.ts", kind: "component", parentScopeId: "container:web", sourceRefs: [{ path: "apps/web/api/share.ts", startLine: 1 }, { path: "other.ts" }] }, { scopeId: "component:bare", name: "bare", kind: "component", sourceRefs: [] }], explanations: [] }) } });
    const scopes = readArtifactScopes(store, artifact.artifactRevisionId);
    assert.deepEqual(scopes.map(scope => scope.path), ["apps/web", "apps/web/api/share.ts", undefined]);
    assert.equal("path" in scopes[2]!, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("operator draft detail summarizes per-scope metrics, including an enriched sidecar whose attempts live on the pre-enrichment draft (CLA-259)", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-workflow-metrics-"));
  try {
    const store = new OperatorStore(root);
    const publications = new OperatorPublicationService(store);
    const run = store.createRun({ idempotencyKey: "metrics", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
    const scan = store.writeArtifactRevision({ repositoryId: "o/r", files: { "operator-explanations.json": JSON.stringify({ scopes: [{ scopeId: "component:a", name: "a.ts", kind: "component" }], explanations: [] }) } });
    const pre = publications.createDraftRevision({ runId: run.runId, artifactRevisionId: scan.artifactRevisionId });
    const produced = store.createAttempt({ draftRevisionId: pre.draftRevisionId, scopeId: "component:a", kind: "enrichment", state: "accepted", usage: { inputTokens: 277, outputTokens: 260, measuredCostUsd: 0.0003 } });
    // The enriched sidecar names the producing attempt (on the pre-enrichment draft) and its install time.
    const enriched = store.writeArtifactRevision({ repositoryId: "o/r", files: { "operator-explanations.json": JSON.stringify({ scopes: [{ scopeId: "component:a", name: "a.ts", kind: "component" }, { scopeId: "component:b", name: "b.ts", kind: "component" }, { scopeId: "component:c", name: "c.ts", kind: "component" }], explanations: [
      { scopeId: "component:a", attemptId: produced.attemptId, explanationVersionId: "explanation-a", createdAt: produced.updatedAt + 5, content: { summary: "A", evidence: [] } },
      { scopeId: "component:b", attemptId: "attempt-missing", explanationVersionId: "explanation-b", createdAt: 42, content: { summary: "B", evidence: [] } },
    ] }) } });
    const draft = publications.createDraftRevision({ runId: run.runId, artifactRevisionId: enriched.artifactRevisionId });
    const workflow = new OperatorWorkflow({ store, publications, enqueue() {} });
    const scopes = workflow.draftDetail(draft.draftRevisionId)!.scopes;
    assert.equal(scopes[0]!.attempts, undefined, "enriched scopes carry no attempts on this draft");
    assert.deepEqual(scopes[0]!.metrics, { costUsd: 0.0003, totalTokens: 537, updatedAt: produced.updatedAt + 5 });
    assert.deepEqual(scopes[1]!.metrics, { updatedAt: 42 }, "an unknown attempt still reports the install time");
    assert.equal("metrics" in scopes[2]!, false, "no attempt and no explanation: no metrics");

    // A retry on this draft replaces the sidecar attempt as the source of the scope's current state.
    store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: "component:a", kind: "retry", state: "failed", usage: { inputTokens: 10, outputTokens: 0, estimatedCostUsd: 0.01 } });
    const retried = workflow.draftDetail(draft.draftRevisionId)!.scopes[0]!;
    assert.equal(retried.metrics?.costUsd, 0.01); assert.equal(retried.metrics?.totalTokens, 10);
    // Public reads (published explanations) never include operator metrics.
    assert.equal(readArtifactScopes(store, enriched.artifactRevisionId).some(scope => "metrics" in scope), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
