import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChoiceQuestion, ChoiceResponse } from "@typesafe-ai/sdk";
import {
  BLOCK_PLAN_OMIT_THRESHOLD, blockPlanCacheKey, blockPlanJob, blockPlanQuestions, blockPlanState, buildBlockPlanIndex, createBlockPlanReplayStore, createBlockPlanService, deriveBlockPlan,
  derivedBlockCandidates, JEV_PLANNER_IP_WINDOW_MS, JEV_PLANNER_REQUESTS_PER_ACCOUNT, JEV_PLANNER_REQUESTS_PER_IP, JEV_PLANNER_WINDOW_KEYS, leadSummaryId, parseBlockPlanRequest, publicationBlockPlanSource, resolveBlockPlannerConfig,
  type BlockPlanCandidate, type BlockPlanJob, type BlockPlannerConfig, type BlockPlanPublicationSource, type BlockPlanServiceOptions,
} from "./blockPlans.js";
import { runBlockPlanEvaluation, type EvaluationNodesFixture } from "./blockPlanEvaluation.js";
import { createGithubAuthService, SESSION_COOKIE, TEST_LOGIN_PATH } from "./githubOAuth.js";
import { createScanJobQueue, createSubmitLimiter } from "./jobs.js";
import { createOperatorBudgetLedger, type OperatorBudgetLedger } from "./operatorBudget.js";
import { createJevProvider, JEV_MODEL, type JudgmentProvider } from "./operatorJudgments.js";
import { OperatorStore } from "./operatorStore.js";
import { createScanHttpHandler } from "./scanServer.js";

type Level = "lead" | "early" | "later" | "omit";
const LEVELS: Level[] = ["lead", "early", "later", "omit"];
/** A valid Choice answer that puts `p` on `level` and spreads the rest evenly. */
function answer(level: Level, p = 1, confidence = p): ChoiceResponse {
  const rest = (1 - p) / 3;
  return { type: "choice", choice: level, confidence, probabilities: Object.fromEntries(LEVELS.map(key => [key, key === level ? p : rest])) } as ChoiceResponse;
}

// A small published scan: okie → {Web, API}; Web → App; Web calls/streams API; API notifies Web.
const SNAPSHOT = { entities: [
  { id: "system:okie", kind: "softwareSystem", name: "okie", responsibility: "Maps repositories.", sourceRefs: [] },
  { id: "container:web", kind: "container", parentId: "system:okie", name: "Web", responsibility: "Renders the atlas.", sourceRefs: [] },
  { id: "container:api", kind: "container", parentId: "system:okie", name: "API", responsibility: "No summary supplied.", sourceRefs: [] },
  { id: "component:app", kind: "component", parentId: "container:web", name: "App", sourceRefs: [] },
], relations: [
  { id: "r1", from: "container:web", to: "container:api", kind: "uses", label: "calls" },
  { id: "r2", from: "container:web", to: "container:api", kind: "uses", label: "streams" },
  { id: "r3", from: "container:api", to: "container:web", kind: "uses", label: "notifies" },
] };
const SIDECAR = { explanations: [{ scopeId: "container:web", content: { format: "v3", summary: "The **web** app renders the atlas.", keyPoints: ["Start in `App.tsx`.", "Stories are deterministic.", "Three", "Four"], diagram: "flowchart LR\n a-->b", evidence: [{ entityId: "component:app", path: "apps/web/src/App.tsx" }] } }] };
const INDEX = buildBlockPlanIndex(SNAPSHOT, SIDECAR);
const WEB_IDS = ["enrichment:summary", "enrichment:keyPoints", "nodeRefs:related", "relations:parent", "relations:dependencies", "relations:dependents", "children", "enrichment:diagram", "enrichment:evidence"];
const TYPES: Record<string, string> = { summary: "markdown", "enrichment:summary": "markdown", "enrichment:keyPoints": "keyPoints", "nodeRefs:related": "nodeRefs", "relations:parent": "relations", "relations:dependencies": "relations", "relations:dependents": "relations", children: "children", "enrichment:diagram": "mermaid", "enrichment:evidence": "evidence", "enrichment:table": "table" };
const SCAN = { slug: "thiss__okie", versionId: "publication-1" };
const body = (overrides: Record<string, unknown> = {}, ids = WEB_IDS) => ({ scan: SCAN, nodeId: "container:web", node: { kind: "container" }, context: "overview", budget: { maxBlocks: 16 }, candidates: ids.map(id => ({ id, type: TYPES[id] })), ...overrides });

/** A publication source with call counters: the cheap guards must run before it is touched. */
function fakeSource(current: { versionId: string; artifactRevisionId: string } | null = { versionId: "publication-1", artifactRevisionId: "artifact-1" }) {
  const counts = { current: 0, facts: 0 };
  const source: BlockPlanPublicationSource = {
    current: () => { counts.current += 1; return current ?? undefined; },
    facts: (_artifact, nodeId) => { counts.facts += 1; return INDEX.get(nodeId); },
  };
  return { source, counts };
}
/** A ledger that records every reservation and whether it was settled or released. */
function spyLedger(limits = { maxRequests: 100, maxTokens: Number.MAX_SAFE_INTEGER, maxDollars: 1 }) {
  const inner = createOperatorBudgetLedger(limits);
  const open = new Set<string>(); let reserved = 0;
  const ledger = {
    reserve: (tokens: number, dollars?: number, attemptId?: string) => { const id = inner.reserve(tokens, dollars, attemptId); if (id) { open.add(id); reserved += 1; } return id; },
    settle: (id: string, usage?: object) => { inner.settle(id, usage); open.delete(id); },
    release: (id: string) => { inner.release(id); open.delete(id); },
    snapshot: () => inner.snapshot(),
  } as OperatorBudgetLedger;
  return { ledger, open, reserved: () => reserved };
}
const CONFIG: BlockPlannerConfig = { enabled: true, maxRequests: 10, maxDollars: 1, timeoutMs: 1_000, perIp: 30 };
/** Fake Jev: answers every question with `pick(index)`; counts calls. */
function fakeProvider(pick: (index: number, question: ChoiceQuestion) => ChoiceResponse | undefined, extra: { json?: (answers: Record<string, unknown>) => unknown; failed?: boolean; delayMs?: number } = {}) {
  const calls: Array<{ state: unknown; questions: Record<string, ChoiceQuestion> }> = [];
  const provider: JudgmentProvider = {
    modelId: JEV_MODEL,
    async evaluate(request, signal) {
      calls.push(request as never);
      if (extra.delayMs) await new Promise((resolve, reject) => { const timer = setTimeout(resolve, extra.delayMs); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true }); });
      if (extra.failed) return { failed: true, usage: { inputTokens: 5 } };
      const answers = Object.fromEntries(Object.entries(request.questions).map(([key, question]) => [key, pick(Number(key.slice(1)), question)]));
      return { json: extra.json ? extra.json(answers) : { model: JEV_MODEL, answers }, usage: { inputTokens: 900, outputTokens: 60 } };
    },
  };
  return { provider, calls };
}
function service(overrides: Partial<BlockPlanServiceOptions> = {}) {
  const planner = spyLedger();
  return { planner, service: createBlockPlanService({ config: CONFIG, source: fakeSource().source, plannerLedger: planner.ledger, ...overrides }) };
}
function requestOf(value: unknown) { const parsed = parseBlockPlanRequest(value); if ("error" in parsed) throw new Error(parsed.error); return parsed.request; }
const state = (value: { body: unknown }) => (value.body as { state: string }).state;

test("request validation accepts only identity, ids/types and a budget", () => {
  assert.ok("request" in parseBlockPlanRequest(body()));
  const rejects: Array<[string, unknown]> = [
    ["unknown top-level key", { ...body(), explanation: "x" }],
    ["caller preview", body({ candidates: [{ id: "summary", type: "markdown", preview: "trust me" }] })],
    ["caller size", body({ node: { kind: "container", size: { children: 1, dependencies: 0, dependents: 0 } } })],
    ["unknown candidate id", body({ candidates: [{ id: "enrichment:story", type: "markdown" }] })],
    ["type mismatch", body({ candidates: [{ id: "summary", type: "table" }] })],
    ["duplicate id", body({ candidates: [{ id: "summary", type: "markdown" }, { id: "summary", type: "markdown" }] })],
    ["more than 16 candidates", body({ candidates: Array.from({ length: 17 }, () => ({ id: "summary", type: "markdown" })) })],
    ["non-block kind", body({ node: { kind: "component" } })],
    ["over-budget", body({ budget: { maxBlocks: 17 } })],
    ["ask context", body({ context: "ask" })],
    ["bad slug", body({ scan: { slug: "../etc", versionId: "v" } })],
    ["empty candidates", body({ candidates: [] })],
  ];
  for (const [label, value] of rejects) assert.ok("error" in parseBlockPlanRequest(value), label);
});

test("facts, size and previews are derived server-side from the snapshot and the explanation sidecar", () => {
  const web = INDEX.get("container:web")!;
  assert.deepEqual([...INDEX.keys()].sort(), ["container:api", "container:web", "system:okie"]);
  assert.equal(INDEX.get("container:api")!.summary, undefined); // the empty-summary placeholder is not a summary
  const previews = Object.fromEntries([...derivedBlockCandidates(web).values()].map(candidate => [candidate.id, candidate.preview]));
  assert.deepEqual(Object.keys(previews).sort(), [...WEB_IDS].sort()); // the explained summary replaces the captured one
  assert.equal(previews["enrichment:summary"], "The **web** app renders the atlas.");
  assert.equal(previews["enrichment:keyPoints"], "Worth a look: Start in `App.tsx`. | Stories are deterministic. | Three | Four");
  assert.equal(previews["relations:dependencies"], "Direct dependencies: 1 node — API (calls, streams)");
  assert.equal(previews["relations:dependents"], "Direct dependents: 1 node — API (notifies)");
  assert.equal(previews["relations:parent"], "Parent: 1 node — okie (softwareSystem)");
  assert.equal(previews["nodeRefs:related"], "Related: 1 related node — API (depends on · calls, streams; used by · …)");
  assert.equal(previews.children, "Children: 1 node — App (component)");
  assert.equal(previews["enrichment:diagram"], "Diagram: Web at a glance");
  assert.equal(previews["enrichment:evidence"], "Evidence: 1 source citation");
  const built = blockPlanJob(requestOf(body()), web);
  assert.ok("job" in built);
  assert.deepEqual(built.job.size, { children: 1, dependencies: 1, dependents: 1 });
  assert.deepEqual(built.job.candidates.map(candidate => candidate.id), ["enrichment:summary", "enrichment:keyPoints", "nodeRefs:related", "relations:parent", "relations:dependencies", "relations:dependents", "enrichment:diagram", "children", "enrichment:evidence"]);
  // A block the node cannot have in the published scan is refused.
  assert.ok("error" in blockPlanJob(requestOf(body({}, ["summary"])), web));
  assert.ok("error" in blockPlanJob(requestOf(body({ node: { kind: "softwareSystem" } })), web));
  // A long key-point list is capped at the preview limit, not at three items.
  const many = buildBlockPlanIndex(SNAPSHOT, { explanations: [{ scopeId: "container:web", content: { format: "v3", summary: "s", keyPoints: Array.from({ length: 8 }, (_, index) => `Point ${index} ${"x".repeat(80)}`) } }] });
  const long = derivedBlockCandidates(many.get("container:web")!).get("enrichment:keyPoints")!.preview;
  assert.equal(long.length, 400);
  assert.match(long, /Point 3/);
});

const CANDIDATES: BlockPlanCandidate[] = [
  { id: "enrichment:summary", type: "markdown", provenance: "enrichment", preview: "s" },
  { id: "enrichment:keyPoints", type: "keyPoints", provenance: "enrichment", preview: "k" },
  { id: "nodeRefs:related", type: "nodeRefs", provenance: "observed", preview: "n" },
  { id: "relations:dependencies", type: "relations", provenance: "observed", preview: "d" },
  { id: "children", type: "children", provenance: "observed", preview: "c" },
  { id: "enrichment:evidence", type: "evidence", provenance: "enrichment", preview: "e" },
];

test("order is the expected rank with default-order ties; omit needs the threshold; the lead summary is never omitted", () => {
  const answers: Record<string, ChoiceResponse> = {
    b0: answer("omit", 1), b1: answer("lead", 0.9), b2: answer("later", 1),
    b3: answer("omit", BLOCK_PLAN_OMIT_THRESHOLD), b4: answer("omit", 0.79), b5: answer("later", 1),
  };
  const plan = deriveBlockPlan(CANDIDATES, answers, 16);
  assert.deepEqual(plan.order, ["enrichment:keyPoints", "nodeRefs:related", "enrichment:evidence", "children", "enrichment:summary"]);
  assert.deepEqual(plan.omitted, [{ id: "relations:dependencies", why: "jev-omit" }]);
  assert.match(plan.reasons["enrichment:keyPoints"]!, /^Lead \(90%\): The first thing a reader/);
  assert.equal(leadSummaryId([{ id: "summary" }, { id: "children" }]), "summary");
  const questions = blockPlanQuestions(CANDIDATES);
  assert.deepEqual(Object.keys(questions.b0!.criteria), ["lead", "early", "later", "omit"]);
});

test("the block budget caps the order and keeps the lead summary at index 0", () => {
  const answers = Object.fromEntries(CANDIDATES.map((_, index) => [`b${index}`, index === 0 ? answer("later", 1) : answer("lead", 1)]));
  const plan = deriveBlockPlan(CANDIDATES, answers, 3);
  assert.deepEqual(plan.order, ["enrichment:summary", "enrichment:keyPoints", "nodeRefs:related"]);
  assert.deepEqual(plan.omitted.map(row => [row.id, row.why]), [["relations:dependencies", "budget"], ["children", "budget"], ["enrichment:evidence", "budget"]]);
});

test("the cache key is (version, node, sorted id+type set, question version, model): previews and budget are not part of it", () => {
  const job: BlockPlanJob = { scan: SCAN, nodeId: "container:web", name: "Web", kind: "container", size: { children: 1, dependencies: 1, dependents: 1 }, budget: { maxBlocks: 16 }, candidates: CANDIDATES };
  const key = blockPlanCacheKey(job, JEV_MODEL);
  assert.equal(blockPlanCacheKey({ ...job, candidates: [...CANDIDATES].reverse().map(candidate => ({ ...candidate, preview: "other" })) }, JEV_MODEL), key);
  assert.notEqual(blockPlanCacheKey({ ...job, candidates: CANDIDATES.slice(1) }, JEV_MODEL), key);
  assert.notEqual(blockPlanCacheKey({ ...job, scan: { ...SCAN, versionId: "publication-2" } }, JEV_MODEL), key);
  assert.notEqual(blockPlanCacheKey({ ...job, nodeId: "container:api" }, JEV_MODEL), key);
  assert.notEqual(blockPlanCacheKey(job, "jev-9.9.9"), key);
  const stateBody = blockPlanState(job);
  assert.deepEqual(Object.keys(stateBody.node), ["kind", "name", "children", "dependencies", "dependents"]);
});

test("cheap guards (kill switch, planner ledger, per-IP window) run before any publication state is read", async () => {
  const { provider } = fakeProvider(() => answer("lead"));
  const off = fakeSource();
  assert.deepEqual((await createBlockPlanService({ config: { ...CONFIG, enabled: false }, provider, source: off.source, plannerLedger: spyLedger().ledger }).handle(body(), "ip")).body, { state: "unavailable", reason: "disabled" });
  // CLA-304: no planner ledger, no planning (the server always supplies a durable one).
  assert.deepEqual((await createBlockPlanService({ config: CONFIG, provider, source: off.source }).handle(body(), "ip")).body, { state: "unavailable", reason: "no-planner-ledger" });
  assert.deepEqual(off.counts, { current: 0, facts: 0 });
  const limited = fakeSource();
  const guarded = createBlockPlanService({ config: CONFIG, provider, source: limited.source, plannerLedger: spyLedger().ledger });
  for (let index = 0; index < JEV_PLANNER_REQUESTS_PER_IP; index += 1) await guarded.handle({ bad: true }, "1.2.3.4");
  assert.deepEqual((await guarded.handle(body(), "1.2.3.4")).body, { state: "unavailable", reason: "rate-limited" });
  assert.deepEqual(limited.counts, { current: 0, facts: 0 });
});

test("only the current publication and a real node with derivable blocks are accepted, before any spend", async () => {
  const { provider, calls } = fakeProvider(() => answer("lead"));
  const stale = createBlockPlanService({ config: CONFIG, provider, source: fakeSource({ versionId: "publication-2", artifactRevisionId: "artifact-2" }).source, plannerLedger: spyLedger().ledger });
  assert.equal((await stale.handle(body(), "ip")).status, 404);
  const none = createBlockPlanService({ config: CONFIG, provider, source: fakeSource(null).source, plannerLedger: spyLedger().ledger });
  assert.equal((await none.handle(body(), "ip")).status, 404);
  const { service: live } = service({ provider });
  assert.equal((await live.handle(body({ nodeId: "container:ghost" }), "ip")).status, 404);
  assert.equal((await live.handle(body({}, ["summary"]), "ip")).status, 400);
  assert.equal((await live.handle(body({ node: { kind: "softwareSystem" } }), "ip")).status, 400);
  assert.equal((await live.handle({ nope: true }, "ip")).status, 400);
  assert.equal(calls.length, 0);
});

test("the publication source reads operator state at most once per TTL and indexes each artifact once", () => {
  let stateReads = 0; let fileReads = 0; let current = { versionId: "publication-1", artifactRevisionId: "artifact-1" };
  const publications = { currentForSlug: (slug: string) => { stateReads += 1; return slug === "thiss__okie" ? current : undefined; } };
  const store = { readArtifactFile: (_artifact: string, file: string) => { fileReads += 1; return Buffer.from(JSON.stringify(file === "snapshot.json" ? SNAPSHOT : SIDECAR)); } };
  let clock = 0;
  const source = publicationBlockPlanSource(publications as never, store as never, { ttlMs: 1_000, now: () => clock });
  for (let index = 0; index < 5; index += 1) assert.deepEqual(source.current("thiss__okie"), current);
  assert.equal(stateReads, 1);
  for (const nodeId of ["container:web", "container:api", "system:okie", "container:web", "container:ghost"]) source.facts("artifact-1", nodeId);
  assert.equal(fileReads, 2); // snapshot + sidecar, once
  assert.equal(source.stats().indexBuilds, 1);
  assert.equal(source.facts("artifact-1", "container:web")!.name, "Web");
  clock = 2_000; current = { versionId: "publication-2", artifactRevisionId: "artifact-2" };
  assert.equal(source.current("thiss__okie")!.versionId, "publication-2");
  assert.equal(stateReads, 2);
  assert.equal(source.current("someone__else"), undefined);
});

test("a cached plan (memory, then the durable file loaded once) never calls Jev twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "okie-block-plans-"));
  try {
    const { provider, calls } = fakeProvider(index => answer(index === 0 ? "lead" : "early", 0.9));
    const replay = createBlockPlanReplayStore(dir);
    const { service: first } = service({ provider, replay });
    const planned = await first.handle(body(), "1.1.1.1");
    assert.equal(state(planned), "planned");
    assert.equal((planned.body as { replayed: boolean }).replayed, false);
    const again = await first.handle(body(), "1.1.1.1");
    assert.equal((again.body as { replayed: boolean }).replayed, true);
    // A smaller budget reuses the same answers (budget is not part of the key).
    const capped = await first.handle(body({ budget: { maxBlocks: 2 } }), "1.1.1.1");
    assert.deepEqual((capped.body as { order: string[] }).order, (planned.body as { order: string[] }).order.slice(0, 2));
    assert.equal(calls.length, 1);
    // A restarted process replays from the durable file without a provider call, reading it once.
    const { provider: other, calls: otherCalls } = fakeProvider(() => answer("omit", 1));
    const reopened = createBlockPlanReplayStore(dir);
    const { service: restarted } = service({ provider: other, replay: reopened });
    assert.deepEqual((await restarted.handle(body(), "2.2.2.2")).body, { ...(planned.body as object), replayed: true });
    assert.equal(otherCalls.length, 0);
    await restarted.handle(body({}, WEB_IDS.slice(0, 3)), "2.2.2.2");
    await restarted.handle(body({}, WEB_IDS.slice(0, 4)), "2.2.2.2");
    assert.equal(reopened.fileReads(), 1);
    assert.equal(otherCalls.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("concurrent identical requests share one Jev call", async () => {
  const { provider, calls } = fakeProvider(() => answer("early", 1), { delayMs: 20 });
  const { service: planner } = service({ provider });
  const [left, right] = await Promise.all([planner.handle(body(), "a"), planner.handle(body(), "b")]);
  assert.equal(state(left), "planned");
  assert.deepEqual(left.body, right.body);
  assert.equal(calls.length, 1);
});

test("probability rounding drift up to 0.02 is renormalised; larger drift is invalid", async () => {
  const drift = (sum: number) => fakeProvider(() => answer("lead"), { json: answers => ({ model: JEV_MODEL, answers: { ...answers, b2: { type: "choice", choice: "later", confidence: 0.42, probabilities: { lead: 0, early: 0.09, later: 0.56, omit: sum - 0.65 } } } }) });
  assert.equal(state(await service({ provider: drift(0.99).provider }).service.handle(body(), "ip")), "planned");
  assert.deepEqual((await service({ provider: drift(0.95).provider }).service.handle(body(), "ip")).body, { state: "unavailable", reason: "invalid-response" });
});

test("failures fall back, settle the planner ledger and log a counted, key-free line", async () => {
  const lines: string[] = [];
  const cases: Array<[string, ReturnType<typeof fakeProvider>]> = [
    ["invalid-response", fakeProvider(() => answer("lead"), { json: answers => ({ model: JEV_MODEL, answers: { ...answers, b0: { type: "choice", choice: "first", confidence: 1, probabilities: { first: 1 } } } }) })],
    ["invalid-response", fakeProvider(index => index === 2 ? undefined : answer("lead"))],
    ["invalid-response", fakeProvider(() => answer("lead"), { json: answers => ({ model: "jev-9.9.9", answers }) })],
    ["provider-failure", fakeProvider(() => answer("lead"), { failed: true })],
    ["timeout", fakeProvider(() => answer("lead"), { delayMs: 200 })],
  ];
  for (const [reason, fake] of cases) {
    const planner = spyLedger();
    const svc = createBlockPlanService({ config: { ...CONFIG, timeoutMs: 30 }, provider: fake.provider, source: fakeSource().source, plannerLedger: planner.ledger, log: line => lines.push(line) });
    assert.deepEqual((await svc.handle(body(), "ip")).body, { state: "unavailable", reason });
    assert.equal(planner.reserved(), 1, reason);
    assert.equal(planner.open.size, 0, `${reason}: planner ledger settled`);
    assert.equal(svc.fallbacks()[reason], 1);
  }
  assert.deepEqual(lines, ["block-plan fallback reason=invalid-response count=1", "block-plan fallback reason=invalid-response count=1", "block-plan fallback reason=invalid-response count=1", "block-plan fallback reason=provider-failure count=1", "block-plan fallback reason=timeout count=1"]);
  assert.ok(lines.every(line => !/JEV|key|container:/i.test(line)));
  const noProvider = createBlockPlanService({ config: CONFIG, source: fakeSource().source, plannerLedger: spyLedger().ledger, log: line => lines.push(line) });
  assert.deepEqual((await noProvider.handle(body(), "ip")).body, { state: "unavailable", reason: "no-provider" });
  assert.equal(lines.at(-1), "block-plan fallback reason=no-provider count=1");
});

test("the planner budget gates spend; a refused request reserves nothing", async () => {
  const planner = spyLedger({ maxRequests: 1, maxTokens: Number.MAX_SAFE_INTEGER, maxDollars: 1 });
  const { provider, calls } = fakeProvider(() => answer("early", 1));
  const svc = createBlockPlanService({ config: CONFIG, provider, source: fakeSource().source, plannerLedger: planner.ledger });
  assert.equal(state(await svc.handle(body(), "ip")), "planned");
  assert.equal(planner.ledger.snapshot().requests, 1);
  assert.equal(planner.ledger.snapshot().inputTokens, 900);
  assert.deepEqual((await svc.handle(body({}, WEB_IDS.slice(1)), "ip")).body, { state: "unavailable", reason: "planner-budget" });
  assert.equal(planner.open.size, 0);
  assert.equal(planner.ledger.snapshot().requests, 1);
  assert.equal(state(await svc.handle(body(), "ip")), "planned"); // cached plans still answer
  assert.equal(calls.length, 1);
});

test("CLA-304: the planner spends only its own durable ledger, never the operator global ledger, and a restart does not reset it", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-block-plan-ledger-"));
  try {
    const store = new OperatorStore(root);
    const global = createOperatorBudgetLedger({ maxRequests: 100, maxTokens: Number.MAX_SAFE_INTEGER, maxDollars: 100 }, { store, runId: "global-operator-enrichment" });
    const durable = () => createOperatorBudgetLedger({ maxRequests: 1, maxTokens: Number.MAX_SAFE_INTEGER, maxDollars: CONFIG.maxDollars }, { store, runId: "jev-block-planner" });
    const { provider, calls } = fakeProvider(() => answer("early", 1));
    const first = createBlockPlanService({ config: CONFIG, provider, source: fakeSource().source, plannerLedger: durable() });
    assert.equal(state(await first.handle(body(), "ip")), "planned");
    assert.equal(global.snapshot().requests, 0, "the operator global ledger is never reserved");
    assert.equal(store.snapshot().events.filter(event => event.runId === "global-operator-enrichment").length, 0);
    assert.equal(first.ledger()?.requests, 1);
    // A restarted process reads the same durable ledger: the cap still binds.
    const restarted = createBlockPlanService({ config: CONFIG, provider, source: fakeSource().source, plannerLedger: durable() });
    assert.equal(restarted.ledger()?.requests, 1);
    assert.deepEqual((await restarted.handle(body({}, WEB_IDS.slice(1)), "ip")).body, { state: "unavailable", reason: "planner-budget" });
    assert.equal(calls.length, 1);
    assert.equal(global.snapshot().requests, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLA-304: planner request windows are bounded and fail closed (a new key is refused, live windows are never evicted)", async () => {
  let clock = 0;
  const { service: svc } = service({ now: () => clock });
  for (let index = 0; index < JEV_PLANNER_WINDOW_KEYS; index += 1) assert.equal(svc.admit(`10.0.${index >> 8}.${index & 255}`), undefined);
  assert.deepEqual(svc.admit("192.0.2.1")?.body, { state: "unavailable", reason: "rate-limited" }, "a new key is refused while every window is live");
  // A known key keeps its own count (it was not reset by the flood).
  for (let count = 1; count < JEV_PLANNER_REQUESTS_PER_IP; count += 1) assert.equal(svc.admit("10.0.0.0"), undefined);
  assert.deepEqual(svc.admit("10.0.0.0")?.body, { state: "unavailable", reason: "rate-limited" });
  clock = JEV_PLANNER_IP_WINDOW_MS;
  assert.equal(svc.admit("192.0.2.1"), undefined, "expired windows are swept, then new keys are admitted");
  // A signed-in caller is also counted per account.
  const { service: accounts } = service();
  for (let count = 0; count < JEV_PLANNER_REQUESTS_PER_ACCOUNT; count += 1) assert.equal(accounts.admit(`198.51.100.${count % 200}`, "user-1"), undefined);
  assert.deepEqual(accounts.admit("203.0.113.9", "user-1")?.body, { state: "unavailable", reason: "rate-limited" });
});

test("a per-IP window limits Jev-bound requests (cache hits are free)", async () => {
  const { provider, calls } = fakeProvider(() => answer("early", 1));
  const { service: svc } = service({ provider, config: { ...CONFIG, perIp: 1 } });
  assert.equal(state(await svc.handle(body(), "9.9.9.9")), "planned");
  assert.equal(state(await svc.handle(body(), "9.9.9.9")), "planned");
  assert.deepEqual((await svc.handle(body({}, WEB_IDS.slice(1)), "9.9.9.9")).body, { state: "unavailable", reason: "rate-limited" });
  assert.equal(state(await svc.handle(body({}, WEB_IDS.slice(1)), "8.8.8.8")), "planned");
  assert.equal(calls.length, 2);
});

test("env config is off by default and parses caps", () => {
  assert.deepEqual(resolveBlockPlannerConfig({}), { enabled: false, maxRequests: 100, maxDollars: 0.3, timeoutMs: 10_000, perIp: 30 });
  assert.deepEqual(resolveBlockPlannerConfig({ OKIE_JEV_BLOCK_PLANNER: "on", OKIE_JEV_PLANNER_MAX_REQUESTS: "5", OKIE_JEV_PLANNER_MAX_DOLLARS: "0.02", OKIE_JEV_PLANNER_TIMEOUT_MS: "abc", OKIE_JEV_PLANNER_PER_IP: "-1" }), { enabled: true, maxRequests: 5, maxDollars: 0.02, timeoutMs: 10_000, perIp: 30 });
});

test("CLA-304 review: planner windows normalise IP keys and check the account (own map) before the IP", () => {
  const { service: svc } = service();
  // 5,000 addresses in one IPv6 /64 are ONE key: they cannot fill the bounded map with junk.
  let admitted = 0;
  for (let index = 0; index < 5_000; index += 1) if (!svc.admit(`2001:db8:0:1::${index.toString(16)}`)) admitted += 1;
  assert.equal(admitted, JEV_PLANNER_REQUESTS_PER_IP);
  assert.equal(svc.admit("::ffff:192.0.2.10"), undefined);
  for (let count = 1; count < JEV_PLANNER_REQUESTS_PER_IP; count += 1) svc.admit("192.0.2.10");
  assert.deepEqual(svc.admit("::ffff:192.0.2.10")?.body, { state: "unavailable", reason: "rate-limited" }, "IPv4-mapped shares the IPv4 window");
  // An account over its window is refused without spending the IP window.
  const { service: accounts } = service();
  for (let count = 0; count < JEV_PLANNER_REQUESTS_PER_ACCOUNT; count += 1) assert.equal(accounts.admit(`198.51.100.${count % 100}`, "heavy"), undefined);
  for (let count = 0; count < 50; count += 1) assert.deepEqual(accounts.admit("203.0.113.1", "heavy")?.body, { state: "unavailable", reason: "rate-limited" });
  for (let count = 0; count < JEV_PLANNER_REQUESTS_PER_IP; count += 1) assert.equal(accounts.admit("203.0.113.1", `light-${count}`), undefined, "the IP window was untouched by the refused account");
  // Behind the loopback proxy (one shared, effectively global IP window) one account alone cannot exhaust it.
  const { service: proxied } = service();
  for (let count = 0; count < JEV_PLANNER_REQUESTS_PER_IP; count += 1) proxied.admit("127.0.0.1", "greedy");
  assert.equal(proxied.admit("127.0.0.1", "someone-else"), undefined, "another account is still admitted");
  assert.ok(JEV_PLANNER_REQUESTS_PER_ACCOUNT * 2 <= JEV_PLANNER_REQUESTS_PER_IP);
});

test("POST /api/block-plan: off without a service, sign-in required, per-IP window before the body, typed plan, 16 KB body cap", async () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-block-plan-route-"));
  const base = {
    queue: createScanJobQueue(async () => {}), allowSubmit: createSubmitLimiter(),
    auth: createGithubAuthService({ bind: "127.0.0.1", env: { OKIE_GITHUB_TEST_DOUBLE: "1", OKIE_PUBLIC_ORIGIN: "http://localhost:4173" } }),
    scanRoot, llm: { baseUrl: "https://openrouter.ai/api/v1", modelId: "m", keySource: "none" as const }, enrich: "off" as const, bind: "127.0.0.1",
  };
  const { provider, calls } = fakeProvider(index => answer(index === 0 ? "lead" : "later", 1));
  const serve = async (handler: ReturnType<typeof createScanHttpHandler>, work: (post: (payload: string, signedIn?: boolean) => Promise<{ status: number; body: Record<string, unknown> }>) => Promise<void>) => {
    const server = createServer((req, res) => { void handler(req, res); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const login = await fetch(`${origin}${TEST_LOGIN_PATH}`, { redirect: "manual" });
      const cookie = login.headers.getSetCookie().map(header => header.split(";")[0]!).find(pair => pair.startsWith(`${SESSION_COOKIE}=`)) ?? "";
      await work(async (payload, signedIn = true) => {
        const response = await fetch(`${origin}/api/block-plan`, { method: "POST", headers: { "content-type": "application/json", ...(signedIn ? { cookie } : {}) }, body: payload });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      });
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  };
  try {
    await serve(createScanHttpHandler(base), async post => assert.deepEqual(await post(JSON.stringify(body())), { status: 200, body: { state: "unavailable", reason: "disabled" } }));
    const planner = service({ provider }).service;
    await serve(createScanHttpHandler({ ...base, blockPlans: planner }), async post => {
      const valid = JSON.stringify(body());
      // CLA-304: anonymous callers get the Ask-style sign-in answer and never reach the planner.
      const anonymous = await post(valid, false);
      assert.equal(anonymous.status, 401);
      assert.match(String(anonymous.body.error), /Sign in with GitHub/);
      assert.deepEqual(anonymous.body.auth, { required: true, loginPath: "/api/auth/github" });
      assert.equal(calls.length, 0);
      const planned = await post(valid);
      assert.equal(planned.status, 200);
      assert.equal(planned.body.state, "planned");
      assert.equal((planned.body.order as string[])[0], "enrichment:summary");
      assert.equal((await post("{not json")).status, 400);
      // The same valid body padded past 16 KB with whitespace is refused by the size cap alone.
      const padded = `${valid}${" ".repeat(16 * 1024)}`;
      assert.ok(JSON.parse(padded));
      assert.deepEqual(await post(padded), { status: 400, body: { error: "Expected a JSON block plan request." } });
    });
    // The per-IP window is decided before the body is read: once it is spent, even a malformed body is `rate-limited`, not 400.
    const limited = service({ provider }).service;
    for (let count = 0; count < JEV_PLANNER_REQUESTS_PER_IP; count += 1) limited.admit("127.0.0.1");
    await serve(createScanHttpHandler({ ...base, blockPlans: limited }), async post => {
      assert.deepEqual(await post("{not json"), { status: 200, body: { state: "unavailable", reason: "rate-limited" } });
    });
  } finally { rmSync(scanRoot, { recursive: true, force: true }); }
});

test("replay: recorded live Jev answers for 11 thiss/okie nodes plan deterministically offline", async () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/judgments/block-planner/nodes.json", import.meta.url), "utf8")) as EvaluationNodesFixture;
  const replay = JSON.parse(readFileSync(new URL("../../../fixtures/judgments/block-planner/replay.json", import.meta.url), "utf8")) as { model: string; answers: Record<string, unknown> };
  let requests = 0;
  const provider = createJevProvider({ JEV_API: "offline-replay" }, async (_url, init) => {
    requests += 1;
    const name = (JSON.parse(String(init?.body)) as { state: { node: { name: string } } }).state.node.name;
    return Response.json({ model: replay.model, answers: replay.answers[name] ?? {}, usage: { input_tokens: 1 } });
  })!;
  const rows = await runBlockPlanEvaluation({ fixture, provider });
  assert.equal(rows.length, 11);
  assert.equal(requests, 11);
  // The live run's cap refused the 11th node, so replay has no answer for it: it falls back to the default.
  const unrecorded = rows.filter(row => !row.jevOrder);
  assert.deepEqual(unrecorded.map(row => [row.name, row.unavailable]), [["Build & fixture tooling", "invalid-response"]]);
  for (const row of rows.filter(row => row.jevOrder)) {
    assert.equal(row.jevOrder![0], "enrichment:summary");
    assert.ok(row.jevOrder!.every(id => row.defaultOrder.includes(id)));
    assert.equal(new Set(row.jevOrder).size, row.jevOrder!.length);
    assert.deepEqual([...row.jevOrder!, ...row.omitted!.map(item => item.id)].sort(), [...row.defaultOrder].sort());
  }
  assert.deepEqual(Object.fromEntries(rows.filter(row => row.jevOrder).map(row => [row.name, row.jevOrder])), EXPECTED_RUN_3);
  // The recorded run used the server-derived previews: named lists and full key points.
  const engine = fixture.nodes.find(node => node.name === "atlas-engine")!;
  assert.equal(engine.candidates.find(candidate => candidate.id === "relations:dependents")!.preview, "Direct dependents: 2 nodes — atlas-gpu (dependsOn); atlas-wasm (dependsOn)");
  assert.ok(engine.candidates.find(candidate => candidate.id === "enrichment:keyPoints")!.preview.length > 240);
});
/** Run 3 (block-order-v2, full key-points preview), recorded live 2026-09-29. "Build & fixture tooling" has no recorded answer: the $0.03 run cap admitted 10 reservations of $0.003. */
const EXPECTED_RUN_3: Record<string, string[]> = {
  "okie": ["enrichment:summary", "enrichment:diagram", "enrichment:keyPoints", "children", "enrichment:evidence"],
  "@okie/server": ["enrichment:summary", "enrichment:keyPoints", "relations:parent", "relations:dependents", "relations:dependencies", "children", "nodeRefs:related", "enrichment:evidence"],
  "@okie/web": ["enrichment:summary", "enrichment:diagram", "enrichment:keyPoints", "relations:parent", "children", "relations:dependencies", "nodeRefs:related", "enrichment:evidence"],
  "atlas-engine": ["enrichment:summary", "relations:parent", "enrichment:keyPoints", "relations:dependents", "nodeRefs:related", "relations:dependencies", "children", "enrichment:evidence"],
  "atlas-gpu": ["enrichment:summary", "relations:parent", "enrichment:keyPoints", "relations:dependents", "children", "relations:dependencies", "nodeRefs:related", "enrichment:evidence"],
  "atlas-protocol": ["enrichment:summary", "enrichment:diagram", "relations:parent", "enrichment:keyPoints", "children", "enrichment:evidence", "relations:dependents", "nodeRefs:related"],
  "atlas-wasm": ["enrichment:summary", "relations:parent", "relations:dependencies", "relations:dependents", "children", "enrichment:keyPoints", "nodeRefs:related", "enrichment:evidence"],
  "@okie/architecture": ["enrichment:summary", "enrichment:keyPoints", "enrichment:diagram", "relations:parent", "children", "relations:dependents", "enrichment:evidence", "nodeRefs:related"],
  "@okie/scan": ["enrichment:summary", "relations:dependents", "enrichment:diagram", "relations:parent", "relations:dependencies", "enrichment:keyPoints", "nodeRefs:related", "children", "enrichment:evidence"],
  "@okie/scene-compiler": ["enrichment:summary", "relations:dependents", "relations:parent", "enrichment:keyPoints", "relations:dependencies", "nodeRefs:related", "children", "enrichment:evidence"],
};
