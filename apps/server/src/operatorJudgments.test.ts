import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import test from "node:test";
import { choice } from "@typesafe-ai/sdk";
import { createJevProvider, JEV_MODEL, runOperatorJudgments, validateJudgmentAnswers, type JudgmentRequest, type JudgmentProvider } from "./operatorJudgments.js";
import { createOperatorRunner } from "./operatorRunner.js";
import { createOperatorBudgetLedger } from "./operatorBudget.js";
import { OperatorStore } from "./operatorStore.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { readArtifactScopes } from "./operatorWorkflow.js";

const questions = { relation: choice("Does the supplied evidence support the claim?", { supports: "Direct support", contradicts: "Direct contradiction", unknown: "Insufficient or conflicting evidence" }) };
const answer = { type: "choice", choice: "contradicts", probabilities: { supports: 0.15, contradicts: 0.8, unknown: 0.05 }, confidence: 0.62 };
const json = { model: JEV_MODEL, answers: { relation: answer } };
const provider: JudgmentProvider = { modelId: JEV_MODEL, async evaluate() { return { json, usage: { inputTokens: 17, outputTokens: 9 } }; } };
function setup(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "okie-judgments-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new OperatorStore(root);
  const publication = new OperatorPublicationService(store);
  const run = store.createRun({ idempotencyKey: "judgment", source: { repositoryId: "repo:o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
  const artifact = store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: "pinned-source", files: {
    "atlas.okie.json": "unchanged atlas bytes",
    "snapshot.json": JSON.stringify({ entities: [{ id: "component:a", name: "A", sourceExcerpts: [{ path: "a.ts", lines: ["return null;"] }] }], relations: [] }),
    "operator-explanations.json": JSON.stringify({ scopes: [{ scopeId: "component:a", name: "A" }], explanations: [] }),
  } });
  const draft = publication.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
  store.updateRun(run.runId, { state: "awaiting_review" });
  const request: JudgmentRequest = { runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeId: "component:a", batchId: "evaluation", questionVersion: "v1", questions, inputs: { claim: "Returns a number" } };
  return { root, store, publication, request, artifact };
}

test("real SDK uses System One with explicit server credential, batched questions, no logs or hidden retries", async () => {
  const secret = "test-only-jev-credential";
  let calls = 0;
  const client = createJevProvider({ JEV_API: secret, TYPESAFE_BASE_URL: "https://invalid.example", TYPESAFE_LOG_LEVEL: "debug" }, async (url, init) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, JEV_MODEL);
    assert.deepEqual(Object.keys(body.questions), ["relation", "second"]);
    assert.ok(!String(init?.body).includes(secret));
    assert.equal(body.max_tokens, undefined);
    return Response.json({ error: secret, usage: { input_tokens: 31, output_tokens: 7 } }, { status: 429 });
  })!;
  assert.equal(createJevProvider({ TYPESAFE_API_KEY: secret }), undefined);
  assert.ok(!inspect(client, { showHidden: true }).includes(secret));
  const result = await client.evaluate({ state: { text: secret, password: "other-private-value" }, questions: { ...questions, second: questions.relation } }, new AbortController().signal);
  assert.equal(calls, 1);
  assert.deepEqual(result, { failed: true, usage: { inputTokens: 31, outputTokens: 7 } });
  assert.ok(!JSON.stringify(result).includes(secret));
});

test("acceptance is immutable, separate from facts, replayable across restart and frozen into publication", async t => {
  const ctx = setup(t);
  const runner = createOperatorRunner({ ...ctx, judgmentProvider: provider });
  const first = await runner.judge(ctx.request);
  assert.equal(first.state, "accepted"); if (first.state !== "accepted") return;
  assert.notEqual(first.draftRevisionId, ctx.request.draftRevisionId);
  assert.deepEqual(first.artifact.answers, { relation: answer });
  assert.equal(ctx.store.snapshot().explanations.length, 0);
  const selected = ctx.store.snapshot().drafts.find(row => row.draftRevisionId === first.draftRevisionId)!;
  assert.equal(ctx.store.readArtifactFile(selected.artifactRevisionId, "atlas.okie.json")!.toString(), "unchanged atlas bytes");
  assert.equal(ctx.store.readArtifactFile(ctx.artifact.artifactRevisionId, "operator-judgments.json"), undefined);
  const frozen = ctx.store.readArtifactFile(selected.artifactRevisionId, "operator-judgments.json")!.toString();
  const published = ctx.publication.publishDraft({ repositoryId: "repo:o/r", draftRevisionId: first.draftRevisionId });
  assert.equal(published.ok, true);
  ctx.store.updateRun(ctx.request.runId, { state: "complete" });
  const restarted = new OperatorStore(ctx.root);
  const replay = await runOperatorJudgments({ store: restarted, publication: new OperatorPublicationService(restarted), request: { ...ctx.request, draftRevisionId: first.draftRevisionId } });
  assert.equal(replay.state, "accepted"); if (replay.state !== "accepted") return;
  assert.equal(replay.replayed, true);
  assert.equal(restarted.snapshot().attempts.length, 1);
  assert.deepEqual(restarted.snapshot().attempts[0]!.usage, { inputTokens: 17, outputTokens: 9 });
  assert.equal(readArtifactScopes(restarted, ctx.artifact.artifactRevisionId, restarted.snapshot().attempts)[0]!.state, "failed", "judgment must not masquerade as an explanation");
  const changed = await runOperatorJudgments({ ...ctx, provider, request: { ...ctx.request, draftRevisionId: first.draftRevisionId, inputs: { claim: "Other claim" } } });
  assert.equal(changed.state, "accepted");
  assert.equal(ctx.store.snapshot().runs[0]!.state, "awaiting_review");
  assert.equal(ctx.store.readArtifactFile(selected.artifactRevisionId, "operator-judgments.json")!.toString(), frozen);
  assert.equal(ctx.publication.currentPublication("repo:o/r")!.artifactRevisionId, selected.artifactRevisionId);
});

test("evidence, model, question version, schema and relevant inputs invalidate reuse", async t => {
  for (const change of ["evidence", "model", "version", "schema", "inputs", "question"] as const) {
    const ctx = setup(t);
    const first = await runOperatorJudgments({ ...ctx, provider });
    assert.equal(first.state, "accepted"); if (first.state !== "accepted") continue;
    const request = { ...ctx.request, draftRevisionId: first.draftRevisionId };
    let modelId = JEV_MODEL;
    if (change === "inputs") request.inputs = { claim: "changed" };
    if (change === "version") request.questionVersion = "v2";
    if (change === "question") request.questions = { relation: choice("Different semantic meaning", questions.relation.criteria) };
    if (change === "model") modelId = "jev-1.14.0";
    if (change === "evidence" || change === "schema") {
      const prior = ctx.store.snapshot().drafts.find(row => row.draftRevisionId === first.draftRevisionId)!;
      const artifact = ctx.store.snapshot().artifacts.find(row => row.artifactRevisionId === prior.artifactRevisionId)!;
      const files = Object.fromEntries(artifact.files.map(file => [file, ctx.store.readArtifactFile(artifact.artifactRevisionId, file)!.toString()]));
      if (change === "evidence") files["snapshot.json"] = files["snapshot.json"]!.replace("return null;", "return 42;");
      else files["operator-judgments.json"] = files["operator-judgments.json"]!.replaceAll("operator-choice/v1", "operator-choice/v0");
      const next = ctx.store.writeArtifactRevision({ repositoryId: "repo:o/r", sourceCommitSha: "pinned-source", files });
      request.draftRevisionId = ctx.publication.createDraftRevision({ runId: request.runId, artifactRevisionId: next.artifactRevisionId }).draftRevisionId;
    }
    let calls = 0;
    const second = await runOperatorJudgments({ ...ctx, request, provider: { modelId, async evaluate() { calls++; return { json: { ...json, model: modelId }, usage: {} }; } } });
    assert.equal(second.state, "accepted", change);
    assert.equal(calls, 1, change);
  }
});

test("unavailable, provider errors and invalid answers are not negative findings; explicit retry succeeds", async t => {
  const ctx = setup(t);
  const unavailable = await createOperatorRunner({ ...ctx, judgmentProvider: null }).judge(ctx.request);
  assert.deepEqual(unavailable, { state: "unavailable" });
  const invalid = createJevProvider({ JEV_API: "test-key" }, async () => Response.json({ ...json, answers: {}, usage: { input_tokens: 123, output_tokens: 12, cost_usd: 0.001 } }))!;
  assert.deepEqual(await runOperatorJudgments({ ...ctx, provider: invalid }), { state: "failed" });
  assert.deepEqual(ctx.store.snapshot().attempts.at(-1)!.usage, { inputTokens: 123, outputTokens: 12, measuredCostUsd: 0.001 });
  assert.deepEqual(await runOperatorJudgments({ ...ctx, provider: { modelId: JEV_MODEL, async evaluate() { throw new Error("private payload and credential"); } } }), { state: "failed" });
  assert.ok(!JSON.stringify(ctx.store.snapshot()).includes("private payload"));
  assert.equal(ctx.store.snapshot().drafts.length, 1);
  assert.equal((await runOperatorJudgments({ ...ctx, provider })).state, "accepted");
  assert.equal(ctx.store.snapshot().attempts.length, 4);
  const ledger = createOperatorBudgetLedger({ maxRequests: 4, maxTokens: 300_000, maxDollars: 1 }, { store: ctx.store, runId: ctx.request.runId });
  assert.equal(ledger.snapshot().requests, 3, "no-provider attempt reserves nothing");
  assert.equal(ledger.snapshot().unknownCostRequests, 2);
  assert.equal(ledger.snapshot().reservedCostUsd, 0.006);
});

test("strict validation keeps probabilities, rejects mismatched distributions and strips extraneous output", () => {
  assert.deepEqual(validateJudgmentAnswers({ ...json, answers: { relation: { ...answer, private: "discard" } } }, questions, JEV_MODEL), { relation: answer });
  for (const changed of [
    { ...answer, choice: "unknown" }, { ...answer, type: "noul" }, { ...answer, confidence: NaN },
    { ...answer, probabilities: { supports: 0.1, contradicts: 0.8, unknown: 0.3 } },
    { ...answer, probabilities: { supports: -0.1, contradicts: 1, unknown: 0.1 } },
    { ...answer, probabilities: { supports: 0.2, contradicts: 0.8 } },
  ]) assert.throws(() => validateJudgmentAnswers({ model: JEV_MODEL, answers: { relation: changed } }, questions, JEV_MODEL));
});

test("independent questions batch once; dependent state and retries preserve unrelated accepted batches", async t => {
  const ctx = setup(t);
  const batched = { ...ctx.request, questions: { ...questions, other: questions.relation }, inputs: { first: 1, second: 2 } };
  let calls = 0;
  const paired: JudgmentProvider = { modelId: JEV_MODEL, async evaluate(body) {
    calls++;
    assert.deepEqual(Object.keys(body.questions), ["relation", "other"]);
    return { json: { ...json, answers: { relation: answer, other: { ...answer, choice: "supports", probabilities: { supports: 0.7, contradicts: 0.2, unknown: 0.1 } } } }, usage: {} };
  } };
  const first = await runOperatorJudgments({ ...ctx, request: batched, provider: paired });
  assert.equal(first.state, "accepted"); if (first.state !== "accepted") return;
  const replayed = await runOperatorJudgments({ ...ctx, provider: paired, request: { ...batched, draftRevisionId: first.draftRevisionId, inputs: { second: 2, first: 1 } } });
  assert.equal(replayed.state, "accepted"); if (replayed.state !== "accepted") return;
  assert.equal(replayed.replayed, true);
  assert.equal(calls, 1);
  const second = await runOperatorJudgments({ ...ctx, provider, request: { ...ctx.request, batchId: "dependent", draftRevisionId: first.draftRevisionId, inputs: { selected: first.artifact.answers.other!.choice } } });
  assert.equal(second.state, "accepted"); if (second.state !== "accepted") return;
  const draft = ctx.store.snapshot().drafts.find(row => row.draftRevisionId === second.draftRevisionId)!;
  const rows = JSON.parse(ctx.store.readArtifactFile(draft.artifactRevisionId, "operator-judgments.json")!.toString()).judgments;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], first.artifact);
  const aborted = new AbortController(); aborted.abort();
  assert.deepEqual(await runOperatorJudgments({ ...ctx, provider, signal: aborted.signal, request: { ...ctx.request, draftRevisionId: second.draftRevisionId } }), { state: "cancelled" });
  assert.equal(ctx.store.snapshot().attempts.length, 2);
});

test("bounded fan-out shares durable admission; late completion cannot overwrite a newer draft", async t => {
  const ctx = setup(t);
  let finish!: (value: Awaited<ReturnType<JudgmentProvider["evaluate"]>>) => void;
  let calls = 0;
  const pending: JudgmentProvider = { modelId: JEV_MODEL, evaluate() { calls++; return new Promise(resolve => { finish = resolve; }); } };
  const first = runOperatorJudgments({ ...ctx, provider: pending, limits: { maxConcurrent: 1 } });
  await Promise.resolve();
  assert.equal(calls, 1);
  const second = await runOperatorJudgments({ ...ctx, provider: pending, limits: { maxConcurrent: 1 }, request: { ...ctx.request, batchId: "second" } });
  assert.deepEqual(second, { state: "limit" });
  assert.equal(calls, 1);
  // Publishing in flight freezes old bytes; a newer draft wins the current-pointer CAS.
  const published = ctx.publication.publishDraft({ repositoryId: "repo:o/r", draftRevisionId: ctx.request.draftRevisionId });
  assert.equal(published.ok, true);
  ctx.publication.createDraftRevision({ runId: ctx.request.runId, artifactRevisionId: ctx.artifact.artifactRevisionId });
  finish({ json, usage: { inputTokens: 2, outputTokens: 1 } });
  assert.deepEqual(await first, { state: "conflict" });
  assert.equal(ctx.store.readArtifactFile(ctx.artifact.artifactRevisionId, "operator-judgments.json"), undefined);
  assert.deepEqual(ctx.store.snapshot().attempts[0]!.usage, { inputTokens: 2, outputTokens: 1 });
});

test("cancellation aborts in-flight I/O and deadlines bound even an uncooperative provider", async t => {
  for (const reason of ["cancel", "timeout"] as const) {
    const ctx = setup(t);
    let signal: AbortSignal | undefined;
    const pending: JudgmentProvider = { modelId: JEV_MODEL, evaluate(_body, value) { signal = value; return new Promise(() => {}); } };
    const result = runOperatorJudgments({ ...ctx, provider: pending, limits: { timeoutMs: reason === "timeout" ? 10 : 1000 } });
    await Promise.resolve();
    if (reason === "cancel") ctx.store.updateRun(ctx.request.runId, { state: "cancelled" });
    assert.deepEqual(await result, { state: reason === "cancel" ? "cancelled" : "failed" });
    assert.equal(signal?.aborted, true);
    assert.equal(ctx.store.snapshot().drafts.length, 1);
    assert.deepEqual(ctx.store.snapshot().attempts[0]!.usage, {});
  }
});

test("a provider that synchronously aborts and throws cannot lose cancellation or produce an unhandled rejection", async t => {
  const ctx = setup(t);
  const controller = new AbortController();
  const provider: JudgmentProvider = { modelId: JEV_MODEL, evaluate() { controller.abort(); throw new Error("synchronous transport failure"); } };
  assert.deepEqual(await runOperatorJudgments({ ...ctx, provider, signal: controller.signal }), { state: "cancelled" });
  assert.equal(ctx.store.snapshot().drafts.length, 1);
});

test("input bounds, every budget dimension and secret redaction are enforced before I/O", async t => {
  const ctx = setup(t);
  for (const limits of [{ maxRequests: 0 }, { maxTokens: 81_919 }, { maxDollars: 0.0029 }, { maxConcurrent: 0 }]) {
    assert.deepEqual(await runOperatorJudgments({ ...ctx, provider, limits }), { state: "limit" });
  }
  assert.equal(ctx.store.snapshot().events.filter(row => row.type === "budget.reserved").length, 0);
  assert.deepEqual(await runOperatorJudgments({ ...ctx, provider, request: { ...ctx.request, inputs: "a".repeat(24_000) } }), { state: "failed" });
  assert.deepEqual(await runOperatorJudgments({ ...ctx, provider, request: { ...ctx.request, questions: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`q${i}`, questions.relation])) } }), { state: "failed" });
  await assert.rejects(runOperatorJudgments({ ...ctx, provider, limits: { maxRequests: Infinity } }), /invalid judgment limits/);
  const secret = "unit-private-value";
  let body = "";
  const result = await runOperatorJudgments({ ...ctx, secrets: [secret], request: { ...ctx.request, inputs: { claim: `text ${secret}`, password: "dont-forward", url: "https://user:pass@example.com/path?auth=credential" } }, provider: { modelId: JEV_MODEL, async evaluate(request) { body = JSON.stringify(request); return { json, usage: {} }; } } });
  assert.equal(result.state, "accepted");
  for (const value of [secret, "dont-forward", "user:pass", "auth=credential"]) assert.ok(!body.includes(value));
  assert.ok(!JSON.stringify(ctx.store.snapshot()).includes(secret));
});

test("judgment budget ignores GLM history while aggregate enrichment safety still counts every request", async t => {
  const ctx = setup(t);
  const aggregate = createOperatorBudgetLedger({ maxRequests: 5, maxTokens: 1_000_000, maxDollars: 1 }, { store: ctx.store, runId: ctx.request.runId });
  for (let i = 0; i < 4; i++) aggregate.settle(aggregate.reserve(10)!, { inputTokens: 5, outputTokens: 5, measuredCostUsd: 0.01 });
  assert.equal((await runOperatorJudgments({ ...ctx, provider })).state, "accepted");
  assert.equal(aggregate.snapshot().requests, 5);
  assert.equal(aggregate.reserve(1), undefined);
  const scoped = createOperatorBudgetLedger({ maxRequests: 4, maxTokens: 300_000, maxDollars: 0.02 }, { store: ctx.store, runId: ctx.request.runId, kind: "judgment" });
  assert.equal(scoped.snapshot().requests, 1);
  assert.equal(scoped.snapshot().measuredCostUsd, undefined);
});

test("recovery releases orphan concurrency but retains unknown tokens and cost", async t => {
  const ctx = setup(t);
  const limits = { maxRequests: 4, maxTokens: 300_000, maxDollars: 0.02, maxConcurrent: 2 };
  const ledger = createOperatorBudgetLedger(limits, { store: ctx.store, runId: ctx.request.runId, kind: "judgment" });
  for (let i = 0; i < 2; i++) {
    const attempt = ctx.store.createAttempt({ draftRevisionId: ctx.request.draftRevisionId, scopeId: `judgment:orphan${i}`, kind: "judgment", state: "running" });
    assert.ok(ledger.reserve(81_920, 0.003, attempt.attemptId));
  }
  assert.equal(ledger.reserve(1), undefined);
  const store = new OperatorStore(ctx.root);
  assert.ok(store.snapshot().attempts.every(row => row.state === "interrupted"));
  assert.equal((await runOperatorJudgments({ ...ctx, store, publication: new OperatorPublicationService(store), provider })).state, "accepted");
  assert.equal(ledger.snapshot().reservedTokens, 163_840);
  assert.ok(Math.abs(ledger.snapshot().reservedCostUsd - 0.009) < 1e-12);
  assert.equal(ledger.snapshot().unknownCostRequests, 3);
});

test("schema vocabulary is unchanged, data credential fields redact exactly, and short credentials never bypass protection", async t => {
  const ctx = setup(t);
  const schema = { token: choice("Classify authorization behavior", { token: "A token parser", authorization: "An authorization check" }) };
  let seen: unknown;
  const result = await runOperatorJudgments({ ...ctx, secrets: ["Q7"], request: { ...ctx.request, questions: schema, inputs: { tokenizer: "retained", authorizationModel: "retained", token: "private-value", authorization: "Bearer private", note: "Q7" } }, provider: { modelId: JEV_MODEL, async evaluate(body) {
    seen = body;
    return { json: { model: JEV_MODEL, answers: { token: { type: "choice", choice: "token", probabilities: { token: 0.8, authorization: 0.2 }, confidence: 0.5 } } }, usage: {} };
  } } });
  assert.equal(result.state, "accepted");
  const body = seen as { questions: unknown; state: { inputs: Record<string, string> } };
  assert.deepEqual(body.questions, schema);
  assert.deepEqual(body.state.inputs, { tokenizer: "retained", authorizationModel: "retained", token: "[redacted]", authorization: "[redacted]", note: "[redacted-llm-key]" });
  let calls = 0;
  const sdk = createJevProvider({ JEV_API: "Q7" }, async () => { calls++; return Response.json(json); })!;
  const denied = await sdk.evaluate({ state: "public", questions: { relation: choice("Contains Q7", questions.relation.criteria) } }, new AbortController().signal);
  assert.equal(denied.failed, true);
  assert.equal(calls, 0, "secret-bearing trusted schema is rejected, not silently rewritten");
});

test("run-state admission and locked completion reject active, failed and interrupted owners", async t => {
  for (const state of ["queued", "running", "failed", "interrupted"] as const) {
    const ctx = setup(t);
    ctx.store.updateRun(ctx.request.runId, { state });
    assert.deepEqual(await runOperatorJudgments({ ...ctx, provider }), { state: "conflict" });
    assert.equal(ctx.store.snapshot().attempts.length, 0);
    ctx.store.updateRun(ctx.request.runId, { state: "awaiting_review" });
    const racing: JudgmentProvider = { modelId: JEV_MODEL, async evaluate() { ctx.store.updateRun(ctx.request.runId, { state }); return { json, usage: { inputTokens: 3, outputTokens: 2 } }; } };
    assert.deepEqual(await runOperatorJudgments({ ...ctx, provider: racing }), { state: "conflict" });
    assert.equal(ctx.store.snapshot().runs[0]!.state, state);
    assert.equal(ctx.store.snapshot().drafts.length, 1);
  }
});

test("canonical identity is locale independent and configured SDK deadline exceeds the SDK default", async t => {
  const ctx = setup(t);
  const original = String.prototype.localeCompare;
  String.prototype.localeCompare = () => { throw new Error("locale ordering must not be used"); };
  try { assert.equal((await runOperatorJudgments({ ...ctx, provider, request: { ...ctx.request, inputs: { z: 1, aa: 2, b: 3 } } })).state, "accepted"); }
  finally { String.prototype.localeCompare = original; }
  const slow = createJevProvider({ JEV_API: "fake-deadline" }, async (_url, init) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 10_100);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
    });
    return Response.json({ ...json, usage: { input_tokens: 1, output_tokens: 1 } });
  })!;
  const selected = ctx.store.snapshot().runs[0]!.draftRevisionId!;
  const outcome = await runOperatorJudgments({ ...ctx, provider: slow, limits: { timeoutMs: 12_000 }, request: { ...ctx.request, draftRevisionId: selected, inputs: "fresh" } });
  assert.equal(outcome.state, "accepted", "configured 12s must not be cut off at SDK default 10s");
});

test("unknown scopes and corrupted cached data become durable failures without exposing payloads", async t => {
  const ctx = setup(t);
  assert.deepEqual(await runOperatorJudgments({ ...ctx, provider, request: { ...ctx.request, scopeId: "missing" } }), { state: "failed" });
  const first = await runOperatorJudgments({ ...ctx, provider });
  assert.equal(first.state, "accepted"); if (first.state !== "accepted") return;
  const selected = ctx.store.snapshot().drafts.find(row => row.draftRevisionId === first.draftRevisionId)!;
  const files = { "snapshot.json": ctx.store.readArtifactFile(selected.artifactRevisionId, "snapshot.json")!, "operator-explanations.json": ctx.store.readArtifactFile(selected.artifactRevisionId, "operator-explanations.json")!, "operator-judgments.json": JSON.stringify({ judgments: [{ ...first.artifact, answers: "private-corrupt-payload" }] }) };
  const artifact = ctx.store.writeArtifactRevision({ repositoryId: "repo:o/r", sourceCommitSha: "pinned-source", files });
  const draft = ctx.publication.createDraftRevision({ runId: ctx.request.runId, artifactRevisionId: artifact.artifactRevisionId });
  assert.deepEqual(await runOperatorJudgments({ ...ctx, provider, request: { ...ctx.request, draftRevisionId: draft.draftRevisionId } }), { state: "failed" });
  assert.equal(ctx.store.snapshot().attempts.at(-1)!.error, "judgment invalid data");
  assert.ok(!JSON.stringify(ctx.store.snapshot()).includes("private-corrupt-payload"));
});
