import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runClaimCheckEvaluation, scoreClaimCheckEvaluation, type HeldoutFixture } from "./claimCheckEvaluation.js";
import { createJevProvider } from "./operatorJudgments.js";

const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/judgments/cla145/heldout.json", import.meta.url), "utf8")) as HeldoutFixture & { labelOrigin: string };
const replay = JSON.parse(readFileSync(new URL("../../../fixtures/judgments/cla145/replay.json", import.meta.url), "utf8")) as { synthetic: boolean; origin: string; model: string; usagePerQuestion: { input_tokens: number; output_tokens: number }; answers: Record<string, unknown> };

test("CLA-145 held-out set: labels fixed, sources pinned, every category covered", () => {
  assert.ok(fixture.cases.length >= 24 && fixture.cases.length <= 30);
  assert.equal(new Set([...fixture.cases, ...fixture.codeChecks].map(row => row.id)).size, fixture.cases.length + fixture.codeChecks.length);
  for (const category of ["supported", "wrong-assertion", "negation", "dependency-as-runtime", "compound-one-false", "incomplete-coverage", "contradictory-context"]) assert.ok(fixture.cases.some(row => row.category === category), category);
  for (const source of Object.values(fixture.sources)) {
    assert.match(source.commit, /^[a-f0-9]{40}$/); assert.equal(source.repository, "thiss/okie");
    assert.equal(source.text.split("\n").length, source.endLine - source.startLine + 1);
  }
  for (const row of [...fixture.cases, ...fixture.codeChecks]) assert.ok(row.rationale.length > 20 && fixture.sources[row.source], row.id);
  assert.match(fixture.labelOrigin, /before any live/);
});

test("CI replay (recorded live jev-1.13.0 answers, no network): the real pipeline reproduces the CLA-145 evaluation numbers", async t => {
  // replay.json holds raw answers recorded by `scripts/evaluate-claim-checks.mjs --live --write-replay`; labels never came from it.
  assert.equal(replay.synthetic, false); assert.match(replay.origin, /^LIVE/); assert.equal(replay.model, "jev-1.13.0");
  const root = mkdtempSync(join(tmpdir(), "okie-claim-eval-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const byClaim = new Map(fixture.cases.map(row => [row.claim, row.id]));
  const sent: string[] = [];
  const provider = createJevProvider({ JEV_API: "fake-replay-key" }, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { state: unknown; questions: Record<string, { instructions: { question: string } }> };
    const text = JSON.stringify(body.state);
    for (const row of [...fixture.cases, ...fixture.codeChecks]) assert.ok(!text.includes(row.rationale), "labels and rationales never reach the provider");
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      const claim = JSON.parse(/Claim: (".*")$/.exec(question.instructions.question)![1]!) as string;
      sent.push(claim);
      return [id, replay.answers[byClaim.get(claim)!]];
    }));
    const count = Object.keys(answers).length;
    return Response.json({ model: replay.model, answers, usage: { input_tokens: replay.usagePerQuestion.input_tokens * count, output_tokens: replay.usagePerQuestion.output_tokens * count } });
  })!;
  const result = await runClaimCheckEvaluation({ fixture, root, provider });
  assert.equal(result.outcome, "accepted");
  assert.equal(result.rows.length, fixture.cases.length + fixture.codeChecks.length);
  assert.equal(sent.length, fixture.cases.length, "only judged cases were asked");
  assert.ok(result.requests.length <= Object.keys(fixture.sources).length + 1, "claims batch per scope");
  for (const row of fixture.codeChecks) {
    const predicted = result.rows.find(item => item.id === row.id)!;
    assert.equal(predicted.source, "code"); assert.equal(predicted.predicted, row.expected, row.id); assert.equal(predicted.reason, row.expectedReason, row.id);
  }
  const report = scoreClaimCheckEvaluation(result.rows, result.requests);
  assert.equal(report.codeChecksReachedJev, 0);
  // The recorded live evaluation at the shipped threshold (0.7): these are the numbers the threshold was chosen from.
  assert.equal(report.overall.n, 33); assert.equal(report.overall.correct, 32);
  assert.equal(report.overall.falseAcceptance, 0); assert.equal(report.overall.falseAlarm, 0);
  const misses = result.rows.filter(row => row.predicted !== row.expected);
  assert.deepEqual(misses.map(row => row.id), ["finished-detail-cost"], "the single miss");
  for (const threshold of [0.3, 0.5, 0.6, 0.7]) {
    const row = report.thresholds.find(item => item.threshold === threshold)!;
    assert.deepEqual([row.falseAcceptance, row.falseAlarm, row.uncertain], [0, 0, 0], `threshold ${threshold}`);
  }
  const strict = report.thresholds.find(row => row.threshold === 0.8)!;
  assert.deepEqual([strict.falseAcceptance, strict.uncertain], [0, 1], "0.8 turns the 0.75-confidence supported answer uncertain");
  assert.ok(strict.reviewLoad! > report.overall.reviewLoad!, "a stricter threshold only adds review load here");
  assert.equal(report.cost.kind, "estimated");
});
