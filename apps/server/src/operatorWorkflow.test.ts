import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorStore } from "./operatorStore.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorWorkflow } from "./operatorWorkflow.js";

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
    assert.equal(detail.scopes[1]?.state, "failed");
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
