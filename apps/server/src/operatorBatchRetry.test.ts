import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanRepository } from "@okie/scan";
import type { GithubAuthService, GithubSession } from "./githubOAuth.js";
import { LlmGatewayError } from "./llmGateway.js";
import { createOperatorBudgetLedger } from "./operatorBudget.js";
import { handleOperatorApi, MAX_RETRY_SCOPES } from "./operatorApi.js";
import { coverageFor, sidecarState } from "./operatorContracts.js";
import { runOperatorEnrichment, type OperatorEnrichmentAttempt, type OperatorEnrichmentGateway, type OperatorEnrichmentScope, type OperatorEnrichmentStore, type OperatorExplanation } from "./operatorEnrichment.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { createOperatorRunner } from "./operatorRunner.js";
import { OperatorStore } from "./operatorStore.js";
import { OperatorWorkflow, type OperatorWorkflowJob } from "./operatorWorkflow.js";

/* ---------- engine: batch retry + re-reduce ---------- */

class MemoryStore implements OperatorEnrichmentStore {
  readonly attempts = new Map<string, OperatorEnrichmentAttempt>();
  readonly current = new Map<string, OperatorExplanation>();
  readonly stale: string[] = [];
  async createAttempt(attempt: OperatorEnrichmentAttempt): Promise<void> { this.attempts.set(attempt.attemptId, { ...attempt }); }
  async updateAttempt(id: string, patch: Partial<Pick<OperatorEnrichmentAttempt, "state" | "updatedAt" | "usage" | "error">>): Promise<void> { Object.assign(this.attempts.get(id)!, patch); }
  async latestAttempt(scopeId: string): Promise<OperatorEnrichmentAttempt | undefined> { return [...this.attempts.values()].filter(attempt => attempt.scopeId === scopeId).at(-1); }
  async putAcceptedExplanation(scopeId: string, explanation: OperatorExplanation): Promise<{ explanationVersionId: string }> { this.current.set(scopeId, explanation); return { explanationVersionId: `v:${scopeId}` }; }
  async getAcceptedExplanation(scopeId: string): Promise<OperatorExplanation | undefined> { return this.current.get(scopeId); }
  async markStale(scopeIds: readonly string[]): Promise<void> { this.stale.push(...scopeIds); }
}
const scope = (scopeId: string, kind: OperatorEnrichmentScope["kind"], parentScopeId?: string): OperatorEnrichmentScope => ({ scopeId, ...(parentScopeId ? { parentScopeId } : {}), name: scopeId, kind, facts: {}, allowedEvidence: [{ entityId: scopeId }] });
const promptScope = (body: Record<string, unknown>) => (JSON.parse(String((body.messages as Array<{ content: string }>)[1]!.content)) as { scope: { scopeId: string } }).scope.scopeId;
const reply = (scopeId: string) => ({ json: { choices: [{ message: { content: JSON.stringify({ summary: `${scopeId} new`, evidence: [{ entityId: scopeId }] }) } }] }, usage: { totalTokens: 3, costUsd: 0.01 } });
const malformed = { json: { choices: [{ message: { content: "not json" } }] }, usage: { totalTokens: 1 } };
/** system → area-a → {a1, a2}; system → area-b → {b1}; every scope starts with an accepted explanation. */
const tree = [scope("system", "softwareSystem"), scope("area-a", "container", "system"), scope("area-b", "container", "system"), scope("a1", "component", "area-a"), scope("a2", "component", "area-a"), scope("b1", "component", "area-b")];
function seeded(): MemoryStore { const store = new MemoryStore(); for (const value of tree) store.current.set(value.scopeId, { summary: `${value.scopeId} old`, evidence: [{ entityId: value.scopeId }] }); return store; }

test("batch retry: targets run concurrently, an ancestor re-reduces only when a descendant changed, the rest are skipped at no cost", async () => {
  const store = seeded(); const calls: string[] = []; let active = 0; let peak = 0;
  const gateway: OperatorEnrichmentGateway = { modelId: "m", async chatCompletions(body) {
    const scopeId = promptScope(body); calls.push(scopeId); active += 1; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 5)); active -= 1;
    return scopeId === "b1" ? malformed : reply(scopeId);
  } };
  let admitted = 0;
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: tree, store, gateway, retryScopeIds: ["a1", "b1", "a1"], reReduceAncestors: true, admitRequest: () => { admitted += 1; return true; } });
  assert.equal(result.stopped, "complete");
  assert.ok(peak > 1, "selected targets ran concurrently through the pool");
  assert.deepEqual(calls.slice(0, 2).sort(), ["a1", "b1"]);
  assert.deepEqual(calls.slice(2), ["area-a", "system"], "area-a (a1 changed) and then system re-reduce; area-b is skipped because b1 failed");
  assert.equal(admitted, 4, "the skipped ancestor was never admitted");
  assert.deepEqual(result.skippedScopes, ["area-b"]);
  assert.deepEqual(result.staleScopes, [], "re-reduced ancestors are fresh; a skipped ancestor is not marked stale");
  assert.deepEqual(store.stale, []);
  assert.equal(store.current.get("area-a")?.summary, "area-a new"); assert.equal(store.current.get("area-b")?.summary, "area-b old");
  assert.equal(result.attempts.find(attempt => attempt.scopeId === "b1")?.state, "failed");
});

test("batch retry: a budget stop mid-batch keeps finished results and marks changed-but-unreduced ancestors stale", async () => {
  const store = seeded(); const calls: string[] = [];
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: tree, store, limits: { maxScopes: 2, maxConcurrent: 1 }, gateway: { modelId: "m", async chatCompletions(body) { const scopeId = promptScope(body); calls.push(scopeId); return reply(scopeId); } }, retryScopeIds: ["a1", "a2", "b1"], reReduceAncestors: true });
  assert.equal(result.stopped, "limit");
  assert.deepEqual(calls, ["a1", "a2"], "the third target is refused before any row or request");
  assert.equal(result.attempts.length, 2); assert.ok(result.attempts.every(attempt => attempt.state === "accepted"));
  assert.deepEqual(result.staleScopes.sort(), ["area-a", "system"], "ancestors of changed scopes whose re-run was refused are honestly stale");
  assert.ok(!result.staleScopes.includes("area-b"), "nothing under area-b changed");
});

test("batch retry: retry-once still applies inside the pass", async () => {
  const store = seeded(); let calls = 0;
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: tree, store, gateway: { modelId: "m", async chatCompletions(body) { const scopeId = promptScope(body); if (scopeId === "b1" && (calls += 1) === 1) throw new LlmGatewayError("llm gateway timeout after 5ms", { kind: "timeout" }); return reply(scopeId); } }, retryScopeIds: ["b1"], reReduceAncestors: true });
  assert.equal(calls, 2);
  assert.deepEqual(result.attempts.map(attempt => [attempt.scopeId, attempt.state]), [["b1", "accepted"], ["area-b", "accepted"], ["system", "accepted"]]);
});

test("batch retry: an ancestor with a still-not-run child is not re-reduced (incomplete-parent policy) and goes stale", async () => {
  const store = seeded(); store.current.delete("a2"); const calls: string[] = [];
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: tree, store, gateway: { modelId: "m", async chatCompletions(body) { const scopeId = promptScope(body); calls.push(scopeId); return reply(scopeId); } }, retryScopeIds: ["a1"], reReduceAncestors: true });
  assert.deepEqual(calls, ["a1"]);
  assert.deepEqual(result.skippedScopes, ["area-a", "system"]);
  assert.deepEqual(result.staleScopes.sort(), ["area-a", "system"]);
});

test("batch retry: a selected ancestor that fails after its child changed keeps its old explanation and goes stale", async () => {
  const store = seeded();
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: tree, store, gateway: { modelId: "m", async chatCompletions(body) { const scopeId = promptScope(body); return scopeId === "area-a" ? malformed : reply(scopeId); } }, retryScopeIds: ["a1", "area-a"], reReduceAncestors: true });
  assert.equal(result.attempts.find(attempt => attempt.scopeId === "area-a")?.state, "failed");
  assert.deepEqual(result.staleScopes.sort(), ["area-a", "system"]);
  assert.equal(store.current.get("area-a")?.summary, "area-a old");
});

test("batch retry: a scope that throws mid-pass still leaves changed ancestors marked stale before the pass rejects", async () => {
  const store = seeded();
  const pass = runOperatorEnrichment({ draftRevisionId: "d", scopes: tree, store, limits: { maxConcurrent: 1 }, gateway: { modelId: "m", async chatCompletions(body) { return reply(promptScope(body)); } }, admitRequest: ({ scopeId }) => { if (scopeId === "a2") throw new Error("ledger unavailable"); return true; }, retryScopeIds: ["a1", "a2"], reReduceAncestors: true });
  await assert.rejects(pass, /ledger unavailable/);
  assert.equal(store.current.get("a1")?.summary, "a1 new");
  assert.deepEqual([...store.stale].sort(), ["area-a", "system"]);
});

test("sidecar state and coverage: below cap is separate from not run and out of scope", () => {
  assert.equal(sidecarState(false, false, undefined, true), "below cap");
  assert.equal(sidecarState(false, false, "below cap", false), "below cap", "untouched below-cap scopes stay below cap");
  assert.equal(sidecarState(true, true, "below cap", true), "accepted", "an explicitly retried below-cap scope counts like any other");
  assert.equal(sidecarState(false, true, "below cap", true), "failed");
  assert.equal(sidecarState(false, false, "failed", true), "failed");
  assert.equal(sidecarState(false, false, undefined, false), "not run");
  assert.deepEqual(coverageFor([{ scopeId: "a", state: "accepted" }, { scopeId: "b", state: "below cap" }, { scopeId: "c", state: "not run" }, { scopeId: "d", state: "running" }], [{ scopeId: "d" }]), { total: 4, accepted: 2, failed: 0, notRun: 1, stale: 0, belowCap: 1 });
});

/* ---------- store/runner/workflow/API fixtures ---------- */

const access = { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } as const;
const commit = "a".repeat(40);
type SidecarScope = { scopeId: string; parentScopeId?: string; name: string; kind: string; state?: string; stale?: boolean; sourceRefs: Array<{ path: string }> };
const row = (scopeId: string, kind: string, parentScopeId?: string, state?: string): SidecarScope => ({ scopeId, ...(parentScopeId ? { parentScopeId } : {}), name: scopeId, kind, ...(state ? { state } : {}), sourceRefs: [{ path: `${scopeId}.ts` }] });
function portable(): string {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/architecture/demo-${name}.json`, import.meta.url), "utf8").replaceAll("golden-worktree-okie-2026-07-14-v1", commit));
  return JSON.stringify({ format: "okie-atlas", version: 1, repository: { commitSha: commit, treeHash: "b".repeat(40), url: "https://github.com/acme/demo" }, snapshot: read("snapshot"), view: read("view"), story: read("story"), stories: [], analysis: { mode: "quick", adapters: [{ language: "typescript", tool: "typescript", version: "5.9.3", coverage: "syntax", limitations: [] }] } });
}
/** A publishable artifact carrying the given sidecar; `snapshot.json` is the portable snapshot plus the sidecar's entities for retries. */
function fixture(root: string, scopes: SidecarScope[], options: { explained?: string[]; maxKind?: "component" | "code"; publishable?: boolean; coverage?: { total: number; accepted: number; failed: number; notRun: number; stale: number; belowCap?: number }; now?: () => number } = {}) {
  const store = new OperatorStore(root, options.now ?? (() => Date.now())); const publications = new OperatorPublicationService(store);
  const run = store.createRun({ idempotencyKey: `k-${Math.random()}`, source: { repositoryId: "repo:acme/demo", owner: "acme", repo: "demo", slug: "acme-demo", commitSha: commit } }).run;
  const sidecar = JSON.stringify({ schemaVersion: 1, ...(options.maxKind ? { maxKind: options.maxKind } : {}), scopes, explanations: (options.explained ?? []).map(scopeId => ({ scopeId, explanationVersionId: `${scopeId}-v1`, content: { summary: `old ${scopeId}`, evidence: [{ entityId: scopeId, path: `${scopeId}.ts` }] } })) });
  let files: Record<string, string>;
  if (options.publishable) {
    const atlas = portable(); const bundle = JSON.parse(atlas) as { snapshot: unknown; view: unknown; story: unknown };
    files = { "atlas.okie.json": atlas, "snapshot.json": JSON.stringify(bundle.snapshot), "view.json": JSON.stringify(bundle.view), "story.json": JSON.stringify(bundle.story), "scene.json": "{}", "stories.json": "{}", "timeline.json": "{}", "operator-explanations.json": sidecar };
  } else {
    files = { "atlas.okie.json": "atlas", "operator-explanations.json": sidecar, "snapshot.json": JSON.stringify({ schemaVersion: 1, id: "snapshot", repositoryId: "o/r", commitSha: commit, generatedAt: "2026-01-01T00:00:00.000Z", entities: scopes.map(value => ({ id: value.scopeId, ...(value.parentScopeId ? { parentId: value.parentScopeId } : {}), name: value.name, kind: value.kind, sourceRefs: value.sourceRefs.map(ref => ({ ...ref, commitSha: commit })) })), relations: [] }) };
  }
  const artifact = store.writeArtifactRevision({ repositoryId: "repo:acme/demo", sourceCommitSha: commit, files });
  const draft = publications.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId, ...(options.coverage ? { coverage: options.coverage } : {}) });
  store.updateRun(run.runId, { state: "awaiting_review" });
  return { store, publications, run, draft, artifact };
}
const summaryGateway = (calls: string[], fail: ReadonlySet<string> = new Set(), cost = 0.002): OperatorEnrichmentGateway => ({ modelId: "fake/model", async chatCompletions(body) {
  const message = JSON.parse(String((body.messages as Array<{ content: string }>)[1]!.content)) as { scope: { scopeId: string; allowedEvidence: unknown[] } };
  calls.push(message.scope.scopeId);
  return { json: { choices: [{ message: { content: fail.has(message.scope.scopeId) ? "{}" : JSON.stringify({ summary: `new ${message.scope.scopeId}`, evidence: message.scope.allowedEvidence.slice(0, 1) }) } }] }, usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5, costUsd: cost } };
} });
const envKeys = ["OKIE_LLM_OPERATOR_MAX_REQUESTS", "OKIE_LLM_OPERATOR_MAX_DOLLARS", "OKIE_LLM_MAX_CONCURRENT", "OKIE_LLM_ENRICH_DEPTH"] as const;
async function withEnv(values: Partial<Record<(typeof envKeys)[number], string>>, work: () => Promise<void>): Promise<void> {
  const old = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  try { for (const key of envKeys) { if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; } await work(); }
  finally { for (const key of envKeys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } }
}
const sidecarOf = (store: OperatorStore, draftRevisionId: string) => JSON.parse(store.readArtifactFile(store.snapshot().drafts.find(value => value.draftRevisionId === draftRevisionId)!.artifactRevisionId, "operator-explanations.json")!.toString()) as { maxKind?: string; scopes: SidecarScope[]; explanations: Array<{ scopeId: string; content: { summary: string } }> };
/** system → container → {c1 (failed), c2, c3}; c1 → {code1, code2} below the component cap. */
const runnerScopes = () => [row("system", "softwareSystem", undefined, "accepted"), row("container", "container", "system", "accepted"), row("c1", "component", "container", "failed"), row("c2", "component", "container", "failed"), row("c3", "component", "container", "accepted"), row("code1", "code", "c1", "below cap"), row("code2", "code", "c1", "below cap")];

test("runner batch retry: one pass, ancestors re-reduced, one new draft, below-cap scopes untouched, completion recorded", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-batch-runner-"));
  try {
    await withEnv({}, async () => {
      const { store, publications, run, draft } = fixture(root, runnerScopes(), { explained: ["system", "container", "c3"], maxKind: "component" });
      const calls: string[] = [];
      await createOperatorRunner({ store, publication: publications, gateway: summaryGateway(calls, new Set(["c2"])) }).enqueue({ kind: "retry", batch: true, runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeIds: ["c1", "c2"], githubAccess: access });
      assert.deepEqual(calls.slice(0, 2).sort(), ["c1", "c2"]); assert.deepEqual(calls.slice(2), ["container", "system"]);
      const state = store.snapshot(); assert.equal(state.drafts.length, 2, "exactly one new draft revision");
      const current = state.runs.find(value => value.runId === run.runId)!; assert.equal(current.error, "Retry: 1 of 2 selected scopes failed.", "c2 failed and had no previous explanation"); assert.equal(current.state, "awaiting_review");
      const next = sidecarOf(store, current.draftRevisionId!);
      assert.equal(next.maxKind, "component");
      assert.deepEqual(next.scopes.map(value => [value.scopeId, value.state, Boolean(value.stale)]), [["system", "accepted", false], ["container", "accepted", false], ["c1", "accepted", false], ["c2", "failed", false], ["c3", "accepted", false], ["code1", "below cap", false], ["code2", "below cap", false]]);
      assert.equal(next.explanations.find(value => value.scopeId === "system")?.content.summary, "new system");
      const nextDraft = state.drafts.at(-1)!; assert.deepEqual(nextDraft.coverage, { total: 7, accepted: 4, failed: 1, notRun: 0, stale: 0, belowCap: 2 });
      const finished = state.events.filter(event => event.type === "enrichment.finished");
      assert.equal(finished.length, 1);
      assert.deepEqual({ ...finished[0]!.detail, durationMs: 0 }, { kind: "retry", stopped: "complete", accepted: 4, failed: 1, notRun: 0, belowCap: 2, inScope: 5, durationMs: 0, selected: 2, retried: 2, retryAccepted: 1, retryFailed: 1, retryKept: 0, installed: true, costUsd: finished[0]!.detail!.costUsd });
      assert.ok(Math.abs(Number(finished[0]!.detail!.costUsd) - 0.008) < 1e-9, "the pass's own cost: four calls at $0.002");

      // An explicitly retried below-cap scope becomes in scope; its component re-reduces; the other code scope stays below cap.
      const calls2: string[] = [];
      await createOperatorRunner({ store, publication: publications, gateway: summaryGateway(calls2) }).enqueue({ kind: "retry", batch: true, runId: run.runId, draftRevisionId: nextDraft.draftRevisionId, scopeIds: ["code1"], githubAccess: access });
      assert.deepEqual(calls2, ["code1", "c1", "container", "system"]);
      const third = sidecarOf(store, store.snapshot().runs[0]!.draftRevisionId!);
      assert.deepEqual(third.scopes.filter(value => value.kind === "code").map(value => [value.scopeId, value.state]), [["code1", "accepted"], ["code2", "below cap"]]);
      assert.equal(store.snapshot().drafts.at(-1)!.coverage.belowCap, 1);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runner batch retry: a budget stop mid-batch keeps finished results, installs the draft, and says how far it got", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-batch-budget-"));
  try {
    await withEnv({ OKIE_LLM_OPERATOR_MAX_REQUESTS: "2", OKIE_LLM_MAX_CONCURRENT: "1" }, async () => {
      const scopes = [row("system", "softwareSystem", undefined, "accepted"), row("c1", "component", "system", "failed"), row("c2", "component", "system", "failed"), row("c3", "component", "system", "failed")];
      const { store, publications, run, draft } = fixture(root, scopes, { explained: ["system"], maxKind: "component" });
      const calls: string[] = [];
      await createOperatorRunner({ store, publication: publications, gateway: summaryGateway(calls) }).enqueue({ kind: "retry", batch: true, runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeIds: ["c1", "c2", "c3"], githubAccess: access });
      assert.deepEqual(calls, ["c1", "c2"]);
      const state = store.snapshot(); const current = state.runs[0]!;
      assert.equal(state.drafts.length, 2); assert.notEqual(current.draftRevisionId, draft.draftRevisionId);
      assert.match(current.error ?? "", /^Retried 2 of 3 selected scopes: stopped at the run budget/);
      const next = sidecarOf(store, current.draftRevisionId!);
      assert.deepEqual(next.scopes.map(value => [value.scopeId, value.state, Boolean(value.stale)]), [["system", "accepted", true], ["c1", "accepted", false], ["c2", "accepted", false], ["c3", "failed", false]]);
      assert.deepEqual(state.events.filter(event => event.type === "enrichment.budget_reached").map(event => event.detail), [{ accepted: 2, attempted: 2, ledger: "run", scopes: 3 }]);
      const finished = state.events.find(event => event.type === "enrichment.finished")!;
      assert.equal(finished.detail?.stopped, "limit"); assert.equal(finished.detail?.retried, 2); assert.equal(finished.detail?.selected, 3);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runner batch retry: a child refreshed in the same pass counts as fresh for its re-run parent", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-batch-fresh-"));
  try {
    await withEnv({}, async () => {
      const scopes = [{ ...row("system", "softwareSystem", undefined, "accepted"), stale: true }, { ...row("container", "container", "system", "accepted"), stale: true }, row("c1", "component", "container", "accepted")];
      const { store, publications, run, draft } = fixture(root, scopes, { explained: ["system", "container", "c1"], maxKind: "component" });
      const calls: string[] = [];
      await createOperatorRunner({ store, publication: publications, gateway: summaryGateway(calls) }).enqueue({ kind: "retry", batch: true, runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeIds: ["container", "system"], githubAccess: access });
      assert.deepEqual(calls, ["container", "system"]);
      const next = sidecarOf(store, store.snapshot().runs[0]!.draftRevisionId!);
      assert.deepEqual(next.scopes.map(value => [value.scopeId, Boolean(value.stale)]), [["system", false], ["container", false], ["c1", false]]);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a retry keeps a code-opt-in legacy sidecar uncapped, and stamps the component cap only on a component-capped legacy sidecar", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-batch-legacy-cap-"));
  try {
    await withEnv({}, async () => {
      const optIn = fixture(mkdtempSync(join(root, "optin-")), [row("system", "softwareSystem", undefined, "accepted"), row("c1", "component", "system", "failed"), row("code1", "code", "c1", "accepted"), row("code2", "code", "c1", "not run")], { explained: ["system", "code1"] });
      const workflow = new OperatorWorkflow({ store: optIn.store, publications: optIn.publications, enqueue() {} });
      assert.equal(workflow.draftDetail(optIn.draft.draftRevisionId)!.scopes.find(value => value.scopeId === "code2")?.state, "not run", "an accepted code scope marks a code-opt-in run: nothing is inferred below cap");
      await createOperatorRunner({ store: optIn.store, publication: optIn.publications, gateway: summaryGateway([]) }).enqueue({ kind: "retry", batch: true, runId: optIn.run.runId, draftRevisionId: optIn.draft.draftRevisionId, scopeIds: ["c1"], githubAccess: access });
      const optInNext = sidecarOf(optIn.store, optIn.store.snapshot().runs[0]!.draftRevisionId!);
      assert.equal(optInNext.maxKind, undefined); assert.equal(optInNext.scopes.find(value => value.scopeId === "code2")?.state, "not run");

      const capped = fixture(mkdtempSync(join(root, "capped-")), [row("system", "softwareSystem", undefined, "accepted"), row("c1", "component", "system", "failed"), row("code1", "code", "c1", "not run")], { explained: ["system"] });
      await createOperatorRunner({ store: capped.store, publication: capped.publications, gateway: summaryGateway([]) }).enqueue({ kind: "retry", batch: true, runId: capped.run.runId, draftRevisionId: capped.draft.draftRevisionId, scopeIds: ["c1"], githubAccess: access });
      const cappedNext = sidecarOf(capped.store, capped.store.snapshot().runs[0]!.draftRevisionId!);
      assert.equal(cappedNext.maxKind, "component"); assert.equal(cappedNext.scopes.find(value => value.scopeId === "code1")?.state, "below cap");
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a retry whose selected scopes all fail installs no revision, keeps the old explanation, and says so", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-batch-allfail-"));
  try {
    await withEnv({}, async () => {
      const { store, publications, run, draft } = fixture(root, runnerScopes(), { explained: ["system", "container", "c3"], maxKind: "component" });
      const states: string[] = [];
      const gateway = summaryGateway([], new Set(["c3"])); const watching: OperatorEnrichmentGateway = { modelId: gateway.modelId, async chatCompletions(body) { states.push(store.snapshot().runs[0]!.state); return gateway.chatCompletions(body); } };
      await createOperatorRunner({ store, publication: publications, gateway: watching }).enqueue({ kind: "retry", batch: true, runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeIds: ["c3"], githubAccess: access });
      assert.deepEqual(states, ["running"], "the retry is visibly running while it executes");
      const state = store.snapshot(); const current = state.runs[0]!;
      assert.equal(state.drafts.length, 1, "nothing changed: no new revision"); assert.equal(current.draftRevisionId, draft.draftRevisionId);
      assert.equal(current.state, "awaiting_review"); assert.equal(current.error, "Retry: 1 of 1 selected scope failed; previous explanation was kept.");
      const finished = state.events.find(event => event.type === "enrichment.finished")!;
      assert.equal(finished.detail?.stopped, "complete"); assert.equal(finished.detail?.retryAccepted, 0); assert.equal(finished.detail?.retryFailed, 1); assert.equal(finished.detail?.retryKept, 1); assert.equal(finished.detail?.installed, false);
      assert.equal(sidecarOf(store, draft.draftRevisionId).explanations.find(value => value.scopeId === "c3")?.content.summary, "old c3");
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refresh enters running while it executes; a stale-base job releases the queued mark", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-batch-running-"));
  try {
    await withEnv({}, async () => {
      const scopes = [{ ...row("system", "softwareSystem", undefined, "accepted"), stale: true }, row("c1", "component", "system", "accepted")];
      const { store, publications, run, draft, artifact } = fixture(root, scopes, { explained: ["system", "c1"], maxKind: "component" });
      const states: string[] = [];
      const gateway = summaryGateway([]); const watching: OperatorEnrichmentGateway = { modelId: gateway.modelId, async chatCompletions(body) { states.push(store.snapshot().runs[0]!.state); return gateway.chatCompletions(body); } };
      await createOperatorRunner({ store, publication: publications, gateway: watching }).enqueue({ kind: "refresh", runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeIds: ["system"], githubAccess: access });
      assert.deepEqual(states, ["running"]); assert.equal(store.snapshot().runs[0]!.state, "awaiting_review");
      store.updateRun(run.runId, { state: "queued" });
      publications.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
      await createOperatorRunner({ store, publication: publications, gateway: watching }).enqueue({ kind: "retry", batch: true, runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeIds: ["c1"], githubAccess: access });
      assert.equal(store.snapshot().runs[0]!.state, "awaiting_review");
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runner batch retry refuses a stale base revision and installs nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-batch-stale-"));
  try {
    await withEnv({}, async () => {
      const { store, publications, run, draft, artifact } = fixture(root, runnerScopes(), { explained: ["system", "container", "c3"], maxKind: "component" });
      publications.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
      const calls: string[] = [];
      await createOperatorRunner({ store, publication: publications, gateway: summaryGateway(calls) }).enqueue({ kind: "retry", batch: true, runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeIds: ["c1", "c2"], githubAccess: access });
      assert.deepEqual(calls, []); assert.equal(store.snapshot().drafts.length, 2);
      assert.equal(store.snapshot().events.filter(event => event.type === "draft.conflict" && event.detail?.reason === "stale_retry_base").length, 1);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ---------- workflow: legacy inference, derived coverage, run budget ---------- */

test("legacy sidecars infer below cap for unattempted code scopes; kind and depth are exposed; coverage is derived", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-batch-legacy-"));
  try {
    const scopes = [row("system", "softwareSystem", undefined, "accepted"), row("c1", "component", "system", "accepted"), row("c2", "component", "system", "not run"), row("code1", "code", "c1", "not run"), row("code2", "code", "c1", "not run")];
    const { store, publications, draft } = fixture(root, scopes, { explained: ["system", "c1"], coverage: { total: 5, accepted: 2, failed: 0, notRun: 3, stale: 0 } });
    const workflow = new OperatorWorkflow({ store, publications, enqueue() {} });
    const detail = workflow.draftDetail(draft.draftRevisionId)!;
    assert.deepEqual(detail.scopes.map(value => [value.scopeId, value.kind, value.depth, value.state]), [["system", "softwareSystem", 0, "accepted"], ["c1", "component", 1, "accepted"], ["c2", "component", 1, "not run"], ["code1", "code", 2, "below cap"], ["code2", "code", 2, "below cap"]]);
    assert.deepEqual(detail.draft.coverage, { total: 5, accepted: 2, failed: 0, notRun: 1, stale: 0, belowCap: 2 });
    // Draft attempts never flip the (sidecar-only) inference: an in-flight code retry shows as running, the rest stay below cap.
    store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: "code2", kind: "retry", state: "running" });
    const inFlight = workflow.draftDetail(draft.draftRevisionId)!;
    assert.deepEqual(inFlight.scopes.slice(3).map(value => value.state), ["below cap", "running"]);
    assert.deepEqual(inFlight.draft.coverage, { total: 5, accepted: 2, failed: 0, notRun: 2, stale: 0, belowCap: 1 });
    assert.equal(store.snapshot().drafts[0]!.coverage.belowCap, undefined, "the stored legacy coverage is not rewritten");

    const recorded = fixture(mkdtempSync(join(root, "new-")), [row("system", "softwareSystem", undefined, "accepted"), row("code1", "code", "system", "not run")], { explained: ["system"], maxKind: "code" });
    assert.equal(new OperatorWorkflow({ store: recorded.store, publications: recorded.publications, enqueue() {} }).draftDetail(recorded.draft.draftRevisionId)!.scopes[1]!.state, "not run", "a recorded cap is authoritative: no inference when the run opted code in");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("run detail exposes the run ledger budget and the average cost per attempted scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-batch-budget-detail-"));
  try {
    await withEnv({ OKIE_LLM_OPERATOR_MAX_DOLLARS: "5", OKIE_LLM_OPERATOR_MAX_REQUESTS: "100" }, async () => {
      const { store, publications, run, draft } = fixture(root, runnerScopes(), { explained: ["system"] });
      const workflow = new OperatorWorkflow({ store, publications, enqueue() {} });
      const empty = workflow.runDetail(run.runId)!;
      assert.equal(empty.avgCostPerScopeUsd, undefined); assert.deepEqual({ ...empty.budget }, { maxDollars: 5, spentDollars: 0, maxRequests: 100, requests: 0, remainingRequests: 100, maxTokens: empty.budget.maxTokens, tokens: 0 });
      const ledger = createOperatorBudgetLedger({ maxRequests: 100, maxTokens: 1_000_000, maxDollars: 5 }, { store, runId: run.runId });
      ledger.settle(ledger.reserve(10)!, { inputTokens: 3, outputTokens: 2, measuredCostUsd: 0.25 });
      store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: "c1", kind: "retry", state: "accepted", usage: { inputTokens: 3, outputTokens: 2, measuredCostUsd: 0.25 } });
      store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: "c2", kind: "retry", state: "accepted", usage: { inputTokens: 3, outputTokens: 2, estimatedCostUsd: 0.05 } });
      store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: "c3", kind: "retry", state: "failed" });
      const detail = workflow.runDetail(run.runId)!;
      assert.deepEqual({ ...detail.budget, maxTokens: 0 }, { maxDollars: 5, spentDollars: 0.25, maxRequests: 100, requests: 1, remainingRequests: 99, maxTokens: 0, tokens: 5 });
      assert.equal(detail.avgCostPerScopeUsd, 0.15, "(0.25 + 0.05) / 2 attempts that reported a cost");
      assert.deepEqual(detail.progress, { accepted: 2, failed: 1, inFlight: 0 });
      assert.equal(detail.budget.globalRemainingDollars, undefined, "no global cap configured");
      const global = createOperatorBudgetLedger({ maxRequests: 100, maxTokens: 1_000_000, maxDollars: 2 }, { store, runId: "global-operator-enrichment" });
      global.settle(global.reserve(10)!, { measuredCostUsd: 1.5 });
      const withGlobal = new OperatorWorkflow({ store, publications, enqueue() {}, globalBudget: { maxDollars: 2, ledger: global } }).runDetail(run.runId)!;
      assert.equal(withGlobal.budget.globalRemainingDollars, 0.5); assert.equal(withGlobal.budget.globalRemainingRequests, undefined, "no global request cap");
      const withGlobalRequests = new OperatorWorkflow({ store, publications, enqueue() {}, globalBudget: { maxDollars: 2, maxRequests: 3, ledger: global } }).runDetail(run.runId)!;
      assert.equal(withGlobalRequests.budget.globalRemainingRequests, 2);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/* ---------- API: batch validation and the publish gate ---------- */

const session: GithubSession = { id: "operator-session", login: "operator", userId: "42", source: "test-double", token: "test-token", createdAt: 0 };
const auth = { config: { publicOrigin: "http://fixture.test" }, sessionFromRequest: () => session, publicView: () => ({ authenticated: true }), handle: async () => false } as unknown as GithubAuthService;
const post = { method: "POST", headers: { origin: "http://fixture.test" } } as unknown as IncomingMessage;
function api(store: OperatorStore, publications: OperatorPublicationService, jobs: OperatorWorkflowJob[] = []) {
  return (path: string, body: unknown) => handleOperatorApi({ auth, allowedGithubIds: new Set(["42"]), publicOrigin: "http://fixture.test", store, publications, enqueue: job => { jobs.push(job); } }, post, path, body);
}

test("batch retry API validates the selection and keeps the single-scope form", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-batch-api-"));
  try {
    const { store, publications, draft } = fixture(root, runnerScopes(), { explained: ["system", "container", "c3"], maxKind: "component" });
    const jobs: OperatorWorkflowJob[] = []; const call = api(store, publications, jobs); const path = `/api/operator/drafts/${draft.draftRevisionId}/retry`;
    const rejected = async (body: unknown, pattern: RegExp) => { const result = await call(path, body); assert.equal(result?.status, 422, JSON.stringify(body).slice(0, 60)); assert.match((result?.body as { error: string }).error, pattern); };
    await rejected({ scopeIds: "c1" }, /must be an array/);
    await rejected({}, /must be an array/);
    await rejected({ scopeIds: [] }, /must not be empty/);
    await rejected({ scopeIds: ["c1", 7] }, /only strings/);
    await rejected({ scopeIds: ["c1", "nope"] }, /unknown scope id: nope/);
    await rejected({ scopeIds: Array.from({ length: MAX_RETRY_SCOPES + 1 }, (_, index) => `s${index}`) }, /at most 1024/);
    await rejected({ scopeIds: ["c1", "code1"] }, /below-cap scopes require explicit opt-in/);
    await rejected({ scopeId: "nope" }, /known scope id required/);
    await rejected({ scopeId: "code1" }, /below-cap scopes require explicit opt-in/);
    assert.equal(jobs.length, 0);
    assert.equal((await call(path, { scopeIds: ["c1", "c2", "c1"] }))?.status, 202);
    assert.equal((await call(path, { scopeIds: ["code1"], includeBelowCap: true }))?.status, 202);
    assert.equal((await call(path, { scopeId: "c1" }))?.status, 202);
    assert.equal((await call(path, { scopeId: "code1", includeBelowCap: true }))?.status, 202);
    assert.deepEqual(jobs.map(job => [job.scopeIds, job.batch ?? false]), [[["c1", "c2"], true], [["code1"], true], [["c1"], false], [["code1"], false]], "duplicates removed; the single form keeps CLA-134 semantics");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("batch retry API answers 409 for a running action and for a non-current revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-batch-api-409-"));
  try {
    const { store, publications, run, draft, artifact } = fixture(root, runnerScopes(), { maxKind: "component" });
    const call = api(store, publications); const path = `/api/operator/drafts/${draft.draftRevisionId}/retry`;
    store.updateRun(run.runId, { state: "queued" });
    const running = await call(path, { scopeIds: ["c1"] }); assert.equal(running?.status, 409); assert.deepEqual(running?.body, { error: "operator action already running" });
    store.updateRun(run.runId, { state: "awaiting_review" });
    const newer = publications.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
    const stale = await call(path, { scopeIds: ["c1"] }); assert.equal(stale?.status, 409); assert.deepEqual(stale?.body, { error: "draft is no longer current", currentDraftRevisionId: newer.draftRevisionId });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publish gate: below-cap scopes never need acknowledgement (new and legacy drafts); in-scope gaps still do", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-batch-publish-"));
  try {
    const publish = (store: OperatorStore, publications: OperatorPublicationService, draftId: string, acknowledgeCoverage = false) => api(store, publications)(`/api/operator/drafts/${draftId}/publish`, { acknowledgeCoverage });
    // Legacy (CLA-254) shape: code scopes recorded "not run", no maxKind, stored coverage counts them as not run.
    const legacy = fixture(mkdtempSync(join(root, "legacy-")), [row("system", "softwareSystem", undefined, "accepted"), row("c1", "component", "system", "accepted"), row("code1", "code", "c1", "not run")], { explained: ["system", "c1"], publishable: true, coverage: { total: 3, accepted: 2, failed: 0, notRun: 1, stale: 0 } });
    assert.equal((await publish(legacy.store, legacy.publications, legacy.draft.draftRevisionId))?.status, 200, "the derived coverage treats the legacy code scope as below cap");
    // New shape with belowCap recorded.
    const recorded = fixture(mkdtempSync(join(root, "new-")), [row("system", "softwareSystem", undefined, "accepted"), row("code1", "code", "system", "below cap")], { explained: ["system"], maxKind: "component", publishable: true, coverage: { total: 2, accepted: 1, failed: 0, notRun: 0, stale: 0, belowCap: 1 } });
    assert.equal((await publish(recorded.store, recorded.publications, recorded.draft.draftRevisionId))?.status, 200);
    const again = recorded.publications.createDraftRevision({ runId: recorded.run.runId, artifactRevisionId: recorded.artifact.artifactRevisionId, coverage: { total: 2, accepted: 1, failed: 0, notRun: 0, stale: 0, belowCap: 1 } });
    assert.equal(recorded.publications.publishDraft({ repositoryId: again.repositoryId, draftRevisionId: again.draftRevisionId, expectedCurrentVersionId: recorded.publications.currentPublication(again.repositoryId)!.versionId }).ok, true, "the stored new-shape coverage also passes the store gate");
    const storedLegacy = recorded.publications.createDraftRevision({ runId: recorded.run.runId, artifactRevisionId: recorded.artifact.artifactRevisionId, coverage: { total: 2, accepted: 1, failed: 0, notRun: 1, stale: 0 } });
    assert.equal(recorded.publications.publishDraft({ repositoryId: storedLegacy.repositoryId, draftRevisionId: storedLegacy.draftRevisionId, expectedCurrentVersionId: recorded.publications.currentPublication(storedLegacy.repositoryId)!.versionId }).ok, false, "without derived coverage the store gate counts a legacy not-run scope");
    // An in-scope not-run component still requires acknowledgement.
    const gap = fixture(mkdtempSync(join(root, "gap-")), [row("system", "softwareSystem", undefined, "accepted"), row("c1", "component", "system", "not run"), row("code1", "code", "c1", "below cap")], { explained: ["system"], maxKind: "component", publishable: true });
    assert.equal((await publish(gap.store, gap.publications, gap.draft.draftRevisionId))?.status, 422);
    assert.equal((await publish(gap.store, gap.publications, gap.draft.draftRevisionId, true))?.status, 200);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("publish gate: the pre-enrichment draft cannot pass as complete from its accepted attempts (no explanation rows)", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-batch-predraft-"));
  try {
    const scopes = [row("system", "softwareSystem"), row("c1", "component", "system"), row("code1", "code", "c1")];
    const { store, publications, draft } = fixture(root, scopes, { maxKind: "component", publishable: true, coverage: { total: 3, accepted: 0, failed: 0, notRun: 2, stale: 0, belowCap: 1 } });
    for (const scopeId of ["system", "c1"]) store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId, kind: "enrichment", state: "accepted" });
    const detail = new OperatorWorkflow({ store, publications, enqueue() {} }).draftDetail(draft.draftRevisionId)!;
    assert.deepEqual(detail.scopes.map(value => value.state), ["not run", "not run", "below cap"], "an accepted attempt without an explanation row is not accepted");
    assert.deepEqual(detail.draft.coverage, { total: 3, accepted: 0, failed: 0, notRun: 2, stale: 0, belowCap: 1 });
    const result = await api(store, publications)(`/api/operator/drafts/${draft.draftRevisionId}/publish`, {});
    assert.equal(result?.status, 422);
    assert.equal(store.snapshot().drafts[0]!.state, "open");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a full run records its cap, marks code scopes below cap, and appends enrichment.finished", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-batch-full-"));
  try {
    await withEnv({}, async () => {
      const store = new OperatorStore(root); const run = store.createRun({ idempotencyKey: "full", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
      const artifacts = scanRepository(process.cwd(), { systemName: "Okie", repositorySlug: "okie" });
      await createOperatorRunner({ store, publication: new OperatorPublicationService(store), githubClient: () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }) as never, scan: async () => ({ commitSha: "abc", artifacts }), gateway: summaryGateway([]) }).enqueue({ kind: "run", runId: run.runId, githubAccess: access });
      const state = store.snapshot(); const current = state.runs[0]!;
      assert.equal(current.state, "awaiting_review");
      const sidecar = sidecarOf(store, current.draftRevisionId!);
      assert.equal(sidecar.maxKind, "component");
      const code = sidecar.scopes.filter(value => value.kind === "code"); assert.ok(code.length > 0);
      assert.ok(code.every(value => value.state === "below cap"));
      assert.equal(sidecarOf(store, state.drafts[0]!.draftRevisionId).maxKind, "component", "the pre-enrichment sidecar records the cap too");
      assert.equal(state.drafts[0]!.coverage.belowCap, code.length);
      const finished = state.events.filter(event => event.type === "enrichment.finished");
      assert.equal(finished.length, 1);
      const inScope = sidecar.scopes.length - code.length;
      assert.deepEqual({ ...finished[0]!.detail, durationMs: 0, costUsd: 0 }, { kind: "run", stopped: "complete", accepted: inScope, failed: 0, notRun: 0, belowCap: code.length, inScope, durationMs: 0, costUsd: 0 });
      assert.ok(Math.abs(Number(finished[0]!.detail!.costUsd) - inScope * 0.002) < 1e-9, "the pass cost is the sum of its attempts' reported cost");
      assert.equal(typeof finished[0]!.detail?.durationMs, "number");
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("an opted-in below-cap scope with an attempt on the draft stays in scope mid-pass; accepted still needs an explanation row", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-batch-belowcap-live-"));
  try {
    const scopes = [row("system", "softwareSystem", undefined, "accepted"), row("c1", "component", "system", "accepted"), row("code1", "code", "c1", "below cap"), row("code2", "code", "c1", "below cap"), row("code3", "code", "c1", "below cap"), row("code4", "code", "c1", "below cap")];
    const { store, publications, run, draft } = fixture(root, scopes, { explained: ["system", "c1"], maxKind: "component" });
    const workflow = new OperatorWorkflow({ store, publications, enqueue() {} });
    store.updateRun(run.runId, { state: "running", draftRevisionId: draft.draftRevisionId });
    store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: "code1", kind: "retry", state: "accepted" });
    store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: "code2", kind: "retry", state: "failed" });
    store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: "code3", kind: "retry", state: "running" });
    const live = workflow.draftDetail(draft.draftRevisionId)!;
    // Settled accepted (not installed yet) reads as pending, settled failed as failed; code4 (no attempt) stays below cap.
    assert.deepEqual(live.scopes.slice(2).map(value => value.state), ["running", "failed", "running", "below cap"]);
    assert.deepEqual(live.draft.coverage, { total: 6, accepted: 2, failed: 1, notRun: 2, stale: 0, belowCap: 1 }, "in-scope total stays 5; accepted is not raised");
    store.updateRun(run.runId, { state: "awaiting_review" });
    const settled = workflow.draftDetail(draft.draftRevisionId)!;
    assert.deepEqual(settled.scopes.slice(2).map(value => value.state), ["not run", "failed", "running", "below cap"], "no live pass: an uninstalled accepted attempt is not run, never accepted");
    assert.equal(settled.draft.coverage.accepted, 2); assert.equal(settled.draft.coverage.belowCap, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("run progress counts only attempts created since the current pass entered running", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-batch-progress-pass-"));
  try {
    let clock = 1_000; const now = () => clock;
    const { store, publications, run, draft } = fixture(root, runnerScopes(), { explained: ["system"], now });
    const workflow = new OperatorWorkflow({ store, publications, enqueue() {} });
    clock = 2_000; store.updateRun(run.runId, { state: "running", draftRevisionId: draft.draftRevisionId });
    clock = 2_500; store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: "c1", kind: "retry", state: "accepted" });
    store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: "c2", kind: "retry", state: "failed" });
    clock = 3_000; store.updateRun(run.runId, { state: "awaiting_review" });
    assert.deepEqual(workflow.runDetail(run.runId)!.progress, { accepted: 1, failed: 1, inFlight: 0 });
    clock = 4_000; store.updateRun(run.runId, { state: "running" });
    clock = 4_500; store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: "c3", kind: "retry", state: "failed" });
    store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: "c1", kind: "retry", state: "running" });
    assert.deepEqual(workflow.runDetail(run.runId)!.progress, { accepted: 0, failed: 1, inFlight: 1 }, "the earlier pass on the same draft is not counted");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
