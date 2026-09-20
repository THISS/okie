import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { choice } from "@typesafe-ai/sdk";
import { createJevProvider, runOperatorJudgments } from "./operatorJudgments.js";
import { OperatorStore } from "./operatorStore.js";
import { OperatorPublicationService } from "./operatorPublication.js";

interface Source { repository: string; commit: string; path: string; startLine: number; endLine: number; text: string; }
interface Case { id: string; split: "development" | "held-out"; source: string; claim: string; label: "supports" | "contradicts" | "unknown"; rationale: string; replay: string; evidenceMode?: "missing" | "stale"; conflictingNote?: string; }
const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/judgments/baseline.json", import.meta.url), "utf8")) as { sources: Record<string, Source>; cases: Case[] };
const replay = JSON.parse(readFileSync(new URL("../../../fixtures/judgments/replay.json", import.meta.url), "utf8")) as { responses: Record<string, unknown> };

test("pinned labelled evaluation: code baseline versus synthetic SDK replay (not a live quality score)", async t => {
  const root = mkdtempSync(join(tmpdir(), "okie-judgment-eval-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(new Set(fixture.cases.map(row => row.id)).size, 12);
  assert.equal(new Set(Object.values(fixture.sources).map(row => row.repository)).size, 3);
  for (const source of Object.values(fixture.sources)) {
    assert.match(source.commit, /^[a-f0-9]{40}$/);
    assert.equal(source.text.split("\n").length, source.endLine - source.startLine + 1);
  }
  const score = { development: { baselineCorrect: 0, replayCorrect: 0, requests: 0, failures: 0 }, "held-out": { baselineCorrect: 0, replayCorrect: 0, requests: 0, failures: 0 } };
  const store = new OperatorStore(root);
  const publication = new OperatorPublicationService(store);
  const predicted: Record<string, string> = {};
  for (const row of fixture.cases) {
    const source = fixture.sources[row.source]!;
    assert.ok(row.rationale.length > 20);
    // Conservative code-only baseline makes no semantic assertion from a name.
    const baseline = "unknown";
    if (row.label === baseline) score[row.split].baselineCorrect++;
    // Exact evidence availability and commit equality are code, not inference.
    const evidence = row.evidenceMode === "missing" ? "" : source.text;
    const targetCommit = row.evidenceMode === "stale" ? "0".repeat(40) : source.commit;
    if (!evidence || source.commit !== targetCommit) {
      predicted[row.id] = "unknown";
    } else {
      const run = store.createRun({ idempotencyKey: row.id, source: { repositoryId: `repo:${source.repository}`, owner: source.repository.split("/")[0]!, repo: source.repository.split("/")[1]!, slug: row.id } }).run;
      const artifact = store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: targetCommit, files: { "snapshot.json": JSON.stringify({ entities: [{ id: "component:subject", name: "Subject", sourceExcerpts: [{ path: source.path, startLine: source.startLine, endLine: source.endLine, lines: evidence.split("\n") }] }], relations: [] }) } });
      const draft = publication.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
      store.updateRun(run.runId, { state: "awaiting_review" });
      const provider = createJevProvider({ JEV_API: "fake-replay-key" }, async (_url, init) => {
        score[row.split].requests++;
        const body = String(init?.body);
        assert.ok(!body.includes(row.rationale), "labels/rationales must not leak into provider state");
        return Response.json(replay.responses[row.replay], { status: row.replay === "failure" ? 503 : 200 });
      })!;
      const outcome = await runOperatorJudgments({ store, publication, provider, request: {
        runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeId: "component:subject", batchId: "evaluation", questionVersion: "evidence-relation-v1",
        inputs: { claim: row.claim, conflictingNote: row.conflictingNote ?? null },
        questions: { relation: choice("How does the captured evidence relate to inputs.claim? Use only supplied evidence; conflicting sources without a resolution are unknown.", { supports: "Evidence directly supports the claim", contradicts: "Evidence directly contradicts the claim", unknown: "Insufficient or unresolved conflicting evidence" }) },
      } });
      if (outcome.state === "accepted") predicted[row.id] = outcome.artifact.answers.relation!.choice;
      else { predicted[row.id] = "unavailable"; score[row.split].failures++; }
    }
    if (predicted[row.id] === row.label) score[row.split].replayCorrect++;
  }
  // Asymmetric deliberately wrong answer verifies confidence != correctness.
  assert.equal(predicted["zod-wrapper"], "supports");
  assert.equal(predicted["tokio-failure"], "unavailable", "provider failure must not become unknown/contradicts");
  assert.deepEqual(score, {
    development: { baselineCorrect: 2, replayCorrect: 4, requests: 5, failures: 1 },
    "held-out": { baselineCorrect: 3, replayCorrect: 6, requests: 4, failures: 0 },
  });
  t.diagnostic(`SYNTHETIC REPLAY ONLY: ${JSON.stringify(score)}; live requests=0; live cost/latency/quality=unmeasured`);
});
