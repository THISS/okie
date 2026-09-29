import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { scanRepository } from "@okie/scan";
import { createOperatorBudgetLedger } from "./operatorBudget.js";
import {
  admitSpend,
  appendSpend,
  claimRates,
  classifyFailure,
  enrichScopeLabel,
  resolveGatewayPrice,
  scopeFailures,
  scoredLabels,
  type CrossRepoLabels,
  type CrossRepoRun,
  type ManifestRepo,
  computeMetrics,
  CROSS_REPO_EVAL_DIR,
  effectiveCapUsd,
  emptySpendLedger,
  enrichmentCoverage,
  kendallTau,
  loadLabels,
  loadManifest,
  loadRuns,
  mentionMatches,
  mustMentionAll,
  keptButDropped,
  omittedButRendered,
  orderAgreement,
  recallAtK,
  runCrossRepoEnrichment,
  sampleComponents,
  scoreRecordedAnswer,
  shuffledIds,
  spentUsd,
  TICKET_CAP_USD,
  topKAgreement,
  usefulOverviewNodes,
  type RecordedQuestion,
  type SpendLedger,
} from "./crossRepoEval.js";

/**
 * CLA-289 cross-repo eval. Offline only: the replay test recomputes every metric from the committed
 * labels + recorded runs (fixtures/cross-repo-eval) and asserts it equals metrics.json, so a label
 * edit, a re-recorded run or a metric change must regenerate metrics.json
 * (`node scripts/cross-repo-eval.mjs report`).
 *
 * What CI replay CAN catch: changes to the product Ask parser / citation completion (`parseAskCompletion`,
 * `citationsNamedInAnswer`, `saysNotInEvidence`) and to scoring/aggregation here, because recorded
 * completions are re-parsed and re-scored on every run.
 * What it CANNOT catch: retrieval or prompt drift. Ranked paths, packets, sections and completions are
 * recorded outputs; a change to `retrieveAskSections`, the Ask prompt or the scanner only shows up when
 * the harness re-records (`ask` offline marks answers stale when the request hash changes; `--live`
 * re-asks). It also cannot see enrichment/claim/block behaviour beyond the recorded rows.
 */

test("replay: metrics.json equals the metrics recomputed from committed labels + runs", () => {
  const manifest = loadManifest();
  const labels = loadLabels();
  const runs = loadRuns();
  const recorded = JSON.parse(readFileSync(join(CROSS_REPO_EVAL_DIR, "metrics.json"), "utf8")) as unknown;
  assert.deepEqual(JSON.parse(JSON.stringify(computeMetrics(manifest, labels, runs))), recorded);
});

test("recorded runs are pinned, compact and only hold what replay needs", () => {
  const manifest = loadManifest();
  for (const [slug, run] of loadRuns()) {
    const repo = manifest.repos.find(item => item.slug === slug);
    assert.ok(repo, `${slug} is in the manifest`);
    assert.equal(run.commitSha, repo!.commitSha, `${slug} was recorded at the pinned commit`);
    assert.ok(statSync(join(CROSS_REPO_EVAL_DIR, "runs", `${slug}.json`)).size <= 300 * 1024, `${slug} run stays under 300 KB`);
    for (const question of run.ask?.questions ?? []) {
      assert.ok(question.ranked.length <= 40 && question.ranked.every(index => index < run.ask!.paths.length), `${slug}/${question.id} ranks recorded paths`);
      if (question.answer) assert.match(question.answer.requestSha256, /^[0-9a-f]{64}$/);
    }
  }
});

test("spend ledger stays inside the $3 ticket cap", () => {
  const path = join(CROSS_REPO_EVAL_DIR, "spend.json");
  assert.ok(existsSync(path), "spend.json is committed with the recorded runs");
  const ledger = JSON.parse(readFileSync(path, "utf8")) as SpendLedger;
  assert.equal(ledger.capUsd, TICKET_CAP_USD);
  assert.ok(spentUsd(ledger) <= TICKET_CAP_USD);
});

test("recall@k counts expected files among the first k ranked paths", () => {
  const ranked = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"];
  assert.equal(recallAtK(["a.ts", "f.ts"], ranked, 5), 0.5);
  assert.equal(recallAtK(["a.ts", "f.ts"], ranked, 10), 1);
  assert.equal(recallAtK(["a.ts", "z.ts"], ranked), 0.5);
  assert.equal(recallAtK([], ranked, 1), 1);
  assert.equal(recallAtK(["a.ts"], [], 5), 0);
});

test("mustMention: case-insensitive substrings, `a|b` alternatives, every term required", () => {
  const answer = "The server action reads the cartId cookie and calls cartLinesAdd.";
  assert.ok(mentionMatches(answer, "CARTID COOKIE"));
  assert.ok(mentionMatches(answer, "addToCart|cartLinesAdd"));
  assert.ok(!mentionMatches(answer, "addToCart|lineItems"));
  assert.ok(!mentionMatches(answer, " | "));
  assert.ok(mustMentionAll(answer, ["cartid", "addToCart|cartLinesAdd"]));
  assert.ok(!mustMentionAll(answer, ["cartid", "revalidateTag"]));
  assert.ok(mustMentionAll(answer, []));
});

test("mustMention: short (<= 3 chars) and letter-less alternatives must stand alone; longer ones stay substrings", () => {
  const answer = "The search walker reads shared state, retries 10 times, then calls migrated handlers via Arc<Mutex>.";
  // Short alternatives no longer match inside longer words / numbers.
  assert.ok(!mentionMatches("It uses a search index.", "Arc"), "Arc is not inside search");
  assert.ok(mentionMatches(answer, "Arc"), "Arc stands alone before <");
  assert.ok(!mentionMatches("The shared cache", "sha"), "sha is not inside shared");
  assert.ok(mentionMatches("It hashes with SHA-256.", "sha"));
  assert.ok(!mentionMatches(answer, "0"), "0 is not inside 10");
  assert.ok(mentionMatches("returns 0 on success", "0"));
  // Letter-less alternatives need a standalone occurrence too, however long.
  assert.ok(!mentionMatches("a, b", ","), "a comma glued to a word is not a mention");
  assert.ok(mentionMatches("limit is 1024 bytes", "1024"));
  assert.ok(!mentionMatches("limit is 10240 bytes", "1024"));
  // Longer alternatives with letters keep plain substring matching.
  assert.ok(mentionMatches(answer, "migrate"), "migrate matches migrated");
  // Terms are literal text, never patterns (a label like "2 ?MB" only matches that exact text).
  assert.ok(!mentionMatches("about 2 MB", "2 ?MB"));
  assert.ok(mentionMatches("about 2 ?MB", "2 ?MB"));
  assert.ok(mentionMatches(answer, "sha|Arc"), "any alternative may match");
});

test("Kendall tau, top-k and order agreement over the shared candidates", () => {
  assert.equal(kendallTau(["a", "b", "c", "d"], ["a", "b", "c", "d"]), 1);
  assert.equal(kendallTau(["a", "b", "c", "d"], ["d", "c", "b", "a"]), -1);
  assert.equal(kendallTau(["a", "b", "c"], ["b", "a", "c"]), 1 / 3);
  assert.equal(kendallTau(["a"], ["a"]), null);
  assert.equal(kendallTau(["a", "b"], ["a", "c"]), null);
  assert.equal(topKAgreement(["a", "b", "c", "d"], ["c", "a", "b", "d"], 1), 0);
  assert.equal(topKAgreement(["a", "b", "c", "d"], ["c", "a", "b", "d"], 3), 1);
  assert.equal(topKAgreement(["a", "b", "c", "d"], ["d", "a", "b", "c"], 3), 2 / 3);
  // Hand order omits "x"; the default order has an extra "y": both are restricted to {a, b, c}.
  assert.deepEqual(orderAgreement(["c", "a", "b"], ["a", "y", "b", "c"]), { shared: 3, tau: -1 / 3, top1: 0, top3: 1, top1Unrestricted: 0 });
  // Restricted top1 agrees ("a" is the first shared id in both), but the real first block is "y".
  assert.deepEqual(orderAgreement(["a", "b"], ["y", "a", "b"]), { shared: 2, tau: 1, top1: 1, top3: 1, top1Unrestricted: 0 });
  assert.deepEqual(orderAgreement(["x"], ["y"]), { shared: 0, tau: null, top1: null, top3: null, top1Unrestricted: 0 });
  assert.equal(orderAgreement([], ["y"]), null);
  // Rendered blocks the labeler left out (the hand order drops them).
  assert.equal(omittedButRendered(["a", "b"], ["y", "a", "z", "b"]), 2);
  assert.equal(omittedButRendered(["a", "b", "c"], ["a"]), 0, "hand-only blocks are not counted");
  // Hand-kept candidates the order leaves out; hand ids that were never candidates do not count.
  assert.equal(keptButDropped(["a", "b", "c", "x"], ["a"], ["a", "b", "c", "y"]), 2);
});

test("spend cap: refuses a reservation that would cross the cap, and --max-dollars never exceeds $3", () => {
  let ledger = emptySpendLedger();
  assert.equal(effectiveCapUsd(), 3);
  assert.equal(effectiveCapUsd(0.5), 0.5);
  assert.throws(() => effectiveCapUsd(3.01), /exceeds the ticket cap/);
  assert.throws(() => effectiveCapUsd(0), /positive/);
  ledger = appendSpend(ledger, { at: "t", stage: "enrich", slug: "a", usd: 2.5, estimated: false, requests: 100 });
  assert.equal(admitSpend(ledger, 0.4).ok, true);
  const refused = admitSpend(ledger, 0.6);
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.reason : "", /exceeds the \$3 cap/);
  assert.equal(admitSpend(ledger, 0.1, 2.55).ok, false, "a lower --max-dollars is honoured");
  assert.throws(() => appendSpend(ledger, { at: "t", stage: "ask", usd: -1, estimated: false, requests: 1 }));
});

test("claim rates use the product verdict names; `unavailable` is outside the denominator", () => {
  const rates = claimRates([{ state: "supported" }, { state: "insufficient-context" }, { state: "insufficient" }, { state: "supported" }, { state: "unavailable" }]);
  assert.equal(rates.checked, 5);
  assert.equal(rates.judged, 4);
  assert.equal(rates.unavailableRate, 0.2);
  assert.equal(rates.insufficientContextRate, 0.25);
  assert.equal(rates.insufficientRate, 0.25);
  assert.equal(rates.notEnoughEvidenceRate, 0.5);
  assert.equal(rates.supportedRate, 0.5);
  assert.equal(claimRates([]).insufficientContextRate, null);
  assert.equal(claimRates([{ state: "unavailable" }]).supportedRate, null, "nothing judged: no rate");
  // Per-reason breakdowns; rows recorded before reasons were kept count as "unrecorded".
  const reasons = claimRates([{ state: "insufficient-context", reason: "missing-capture" }, { state: "insufficient-context", reason: "truncated-capture" }, { state: "insufficient-context", reason: "missing-capture" }, { state: "insufficient-context" }, { state: "unavailable", reason: "timeout" }]);
  assert.deepEqual(reasons.insufficientContextByReason, { "missing-capture": 2, "truncated-capture": 1, unrecorded: 1 });
  assert.deepEqual(reasons.unavailableByReason, { timeout: 1 });
  assert.deepEqual(reasons.failedCheckByReason, {});
});

test("labels with status \"rejected\" are never scored; draft and checked are", () => {
  assert.deepEqual(scoredLabels([{ id: "a", status: "draft" }, { id: "b", status: "rejected" }, { id: "c", status: "checked" }, { id: "d" }]).map(item => item.id), ["a", "c", "d"]);
  assert.deepEqual(scoredLabels(undefined), []);
  const repo: ManifestRepo = { slug: "o__r", repository: "o/r", url: "https://example.invalid/o/r", commitSha: "0".repeat(40) };
  const question = (id: string, status: string) => ({ id, family: id, status, question: `q ${id}`, selection: { level: "L1 system", selectedId: "system:r" }, expectedFiles: ["a.ts"], mustMention: [] });
  const labels: CrossRepoLabels = {
    schema: "s", repository: "o/r", commitSha: repo.commitSha,
    questions: [question("hit", "checked"), question("miss", "rejected"), question("half", "draft")],
    overviews: [{ nodeId: "system:r", status: "checked", order: ["summary", "children"] }, { nodeId: "container:r", status: "rejected", order: ["children", "summary"] }],
  };
  const recorded = (id: string, ranked: number[]): RecordedQuestion => ({ id, question: `q ${id}`, selectedId: "system:r", selectionFound: true, byteBudget: 1, bytes: 1, sectionCount: 1, ranked, packets: [], expectedIndexed: { "a.ts": true }, variants: {} });
  const run: CrossRepoRun = {
    schema: "cross-repo-eval-run/v1", slug: repo.slug, repository: repo.repository, commitSha: repo.commitSha,
    ask: { recordedAt: "t", corpus: "scan", entityCount: 1, systemNames: ["r"], paths: ["a.ts", "b.ts"], questions: [recorded("hit", [0]), recorded("miss", [1]), recorded("half", [1, 0])] },
    blocks: { corpus: "scan", nodes: [{ nodeId: "system:r", name: "r", kind: "softwareSystem", candidates: [], defaultOrder: ["summary", "children"] }, { nodeId: "container:r", name: "r", kind: "container", candidates: [], defaultOrder: ["summary", "children"] }] },
  };
  const metrics = computeMetrics({ schema: "m", repos: [repo] }, new Map([[repo.slug, labels]]), new Map([[repo.slug, run]])).repos[0]!;
  assert.deepEqual(metrics.perQuestion.map(row => row.id), ["hit", "half"], "the rejected question is not scored");
  assert.equal(metrics.retrieval!.recallFull, 1);
  assert.deepEqual(metrics.labels!.byStatus, { checked: 1, rejected: 1, draft: 1 });
  assert.deepEqual(metrics.labels!.overviewsByStatus, { checked: 1, rejected: 1 });
  assert.equal(metrics.blocks!.labeled, 1, "the rejected overview is not scored");
  assert.equal(metrics.blocks!.default.tau, 1);
});

test("enrichment failures keep the stored error and a coarse class; the scope label prints the K actually used", () => {
  assert.equal(classifyFailure("llm gateway timeout after 120000ms"), "timeout");
  assert.equal(classifyFailure("llm gateway 429: rate limited"), "rate-limit");
  assert.equal(classifyFailure("llm gateway 503: upstream"), "server");
  assert.equal(classifyFailure("llm gateway response content is not JSON"), "invalid-output");
  assert.equal(classifyFailure("malformed explanation: evidence is required"), "rejected-by-validator");
  assert.equal(classifyFailure("rejected explanation: 1 keyPoints (allowed 2-5)"), "rejected-by-validator");
  assert.equal(classifyFailure("rejected explanation: unknown evidence reference(s): code:x src/timeout-schema.ts:1-2"), "rejected-by-validator");
  assert.equal(classifyFailure("something else about a schema in src/parse.ts"), "other", "words inside paths never decide the class");
  const failures = scopeFailures([
    { scopeId: "component:a", state: "failed", error: "llm gateway response content is not JSON", updatedAt: 1 },
    { scopeId: "component:a", state: "accepted", updatedAt: 2 },
    { scopeId: "system:s", state: "failed", error: "malformed explanation: evidence is required", updatedAt: 3 },
  ], new Map([["system:s", "softwareSystem"]]));
  assert.deepEqual(failures, [{ scopeId: "system:s", kind: "softwareSystem", class: "rejected-by-validator", error: "malformed explanation: evidence is required" }], "only the latest attempt per scope counts");
  const sampled = { mode: "sampled" as const, k: 5, singleContainerK: 30, componentsSampled: 30, componentsFull: 116, containers: 1, droppedFiles: 86, sampledCommitSha: "x", parentsFromSample: true as const, overlaidOnFullScan: true as const };
  assert.equal(enrichScopeLabel(sampled), "sampled k=30 (30/116 components)");
  assert.equal(enrichScopeLabel({ ...sampled, containers: 11, componentsSampled: 55, componentsFull: 485 }), "sampled k=5 (55/485 components)");
  assert.equal(enrichScopeLabel({ mode: "full" }), "full");
});

test("live pricing: known model or an explicit --price-per-mtok, never a silent guess", () => {
  assert.equal(resolveGatewayPrice("xiaomi/mimo-v2.6-pro").input, 0.4 / 1_000_000);
  assert.throws(() => resolveGatewayPrice("someone/else"), /refusing --live: no known pricing for model someone\/else/);
  assert.deepEqual(resolveGatewayPrice("someone/else", { input: 3, output: 15 }), { input: 3 / 1_000_000, output: 15 / 1_000_000 });
  assert.throws(() => resolveGatewayPrice("x", { input: 0, output: 1 }), /two positive numbers/);
});

test("recorded answers replay through the product parser and citation completion", () => {
  const paths = ["lib/cart.ts", "app/page.tsx", "README.md"];
  const question: RecordedQuestion = {
    id: "q", question: "How is the cart updated?", selectedId: "system:x", selectionFound: true,
    byteBudget: 24_000, bytes: 100, sectionCount: 2, ranked: [0, 1], packets: [2], expectedIndexed: {}, variants: {},
    sections: [
      { id: "component:lib-cart-ts", kind: "component", p: 0, symbols: [{ id: "code:lib/cart.ts#addItem", name: "addItem" }] },
      { id: "component:app-page-tsx", kind: "component", p: 1 },
    ],
    answer: {
      modelId: "fake/model", requestSha256: "0".repeat(64), allowedIdsCount: 4, allowedIdsSha256: "0".repeat(64),
      allowedIdsInContent: ["component:app-page-tsx"], packetSources: {}, ms: 1,
      // Cites the page; names `addItem()` in prose, which citation completion maps to lib/cart.ts.
      content: JSON.stringify({ answer: "The page calls `addItem()` to update the cartId cookie.", citations: ["component:app-page-tsx", "component:not-allowed"] }),
    },
  };
  const scored = scoreRecordedAnswer(question, paths, ["lib/cart.ts"], ["cartid cookie", "addItem|addToCart"])!;
  assert.deepEqual(scored.cited, ["app/page.tsx", "lib/cart.ts"]);
  assert.equal(scored.citedRecall, 1);
  assert.equal(scored.citationPrecision, 0.5);
  assert.equal(scored.declined, false);
  assert.equal(scored.correct, true);
  const declined = scoreRecordedAnswer({ ...question, answer: { ...question.answer!, content: JSON.stringify({ answer: "The evidence does not contain the cart flow.", citations: [] }) } }, paths, ["lib/cart.ts"], ["cart"])!;
  assert.equal(declined.declined, true);
  assert.equal(declined.correct, false);
  assert.equal(declined.citationPrecision, null);
  assert.equal(declined.invalid, false);
  // A completion the product parser rejects (empty content; plain text is accepted as the answer) is invalid, not a decline.
  const invalid = scoreRecordedAnswer({ ...question, answer: { ...question.answer!, content: "" } }, paths, ["lib/cart.ts"], ["cart"])!;
  assert.equal(invalid.invalid, true);
  assert.equal(invalid.declined, false);
  assert.equal(invalid.correct, false);
});

test("labeler helpers: deterministic shuffle, system + largest containers", () => {
  const ids = ["summary", "children", "relations:parent", "nodeRefs:related", "enrichment:keyPoints"];
  assert.deepEqual(shuffledIds(ids, "seed"), shuffledIds([...ids].reverse(), "seed"));
  assert.deepEqual([...shuffledIds(ids, "seed")].sort(), [...ids].sort());
  const snapshot = { relations: [], entities: [
    { id: "system:s", kind: "softwareSystem" },
    { id: "container:a", kind: "container", parentId: "system:s" }, { id: "container:b", kind: "container", parentId: "system:s" },
    { id: "component:b1", kind: "component", parentId: "container:b" }, { id: "component:b2", kind: "component", parentId: "container:b" },
    { id: "component:a1", kind: "component", parentId: "container:a" },
  ] };
  assert.deepEqual(usefulOverviewNodes(snapshot, 5), ["system:s", "container:b", "container:a"]);
  assert.deepEqual(usefulOverviewNodes(snapshot, 2), ["system:s", "container:b"]);
});

test("sampling keeps the top-K components per container by relation degree, ties by id, deterministically", () => {
  const component = (id: string, parentId: string, path: string) => ({ id, kind: "component", parentId, sourceRefs: [{ path }] });
  const snapshot = {
    entities: [
      { id: "system:s", kind: "softwareSystem", sourceRefs: [{ path: "README.md" }] },
      { id: "container:a", kind: "container", parentId: "system:s", sourceRefs: [{ path: "a/package.json" }] },
      { id: "container:b", kind: "container", parentId: "system:s", sourceRefs: [{ path: "b/package.json" }] },
      component("component:a-hub", "container:a", "a/hub.ts"), component("component:a-x", "container:a", "a/x.ts"),
      component("component:a-y", "container:a", "a/y.ts"), component("component:a-z", "container:a", "a/z.ts"),
      component("component:b-1", "container:b", "b/one.ts"), component("component:b-2", "container:b", "b/two.ts"),
      // Shares its file with the container: never dropped.
      component("component:b-pkg", "container:b", "b/package.json"),
      { id: "code:a-z#f", kind: "code", parentId: "component:a-z", sourceRefs: [{ path: "a/z.ts", startLine: 1, endLine: 2 }] },
    ],
    relations: [
      { from: "component:a-x", to: "component:a-hub" }, { from: "component:a-y", to: "component:a-hub" }, { from: "component:a-z", to: "component:a-hub" },
      { from: "component:b-2", to: "external:npm" },
    ],
  };
  const sample = sampleComponents(snapshot, 2);
  // a: hub (3) first, then a-x/a-y/a-z tie at 1 -> a-x by id. b: b-2 (1), then b-1/b-pkg tie at 0 -> b-1.
  assert.deepEqual(sample.keep, ["component:a-hub", "component:a-x", "component:b-1", "component:b-2"]);
  assert.deepEqual(sample.dropPaths, ["a/y.ts", "a/z.ts"]);
  assert.deepEqual({ sampled: sample.componentsSampled, full: sample.componentsFull, containers: sample.containers, perContainer: sample.perContainer }, { sampled: 4, full: 7, containers: 2, perContainer: 2 });
  const shuffled = { ...snapshot, entities: [...snapshot.entities].reverse(), relations: [...snapshot.relations].reverse() };
  assert.deepEqual(sampleComponents(shuffled, 2), sample, "input order does not matter");
  // A single-container atlas uses singleContainerK.
  const single = { entities: snapshot.entities.filter(entity => entity.id !== "container:b" && !String(entity.parentId).startsWith("container:b")), relations: snapshot.relations };
  assert.equal(sampleComponents(single, 1, 3).perContainer, 3);
  assert.deepEqual(sampleComponents(single, 1, 3).keep, ["component:a-hub", "component:a-x", "component:a-y"]);
  assert.throws(() => sampleComponents(snapshot, 0), /positive integer/);
});

test("enrichment coverage: parents reduce only when every in-cap child settled", () => {
  const coverage = enrichmentCoverage({ scopes: [
    { scopeId: "s", kind: "softwareSystem", state: "not run" },
    { scopeId: "c", parentScopeId: "s", kind: "container", state: "not run" },
    { scopeId: "k1", parentScopeId: "c", kind: "component", state: "accepted" },
    { scopeId: "k2", parentScopeId: "c", kind: "component", state: "not run" },
    { scopeId: "x", parentScopeId: "k1", kind: "code", state: "below cap" },
  ] });
  assert.equal(coverage.systemExplained, false);
  assert.equal(coverage.containersExplained, 0);
  assert.deepEqual(coverage.byKind.component, { total: 2, accepted: 1, failed: 0, notRun: 1, belowCap: 0 });
  assert.equal(coverage.parentsWithUnsettledChildren, 0);
});

test("real operator runner under a request cap: leaves run, the cut subtree's parents never reduce (fake gateway)", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-cross-repo-eval-"));
  const saved = { ...process.env };
  try {
    const source = join(root, "src-repo");
    mkdirSync(join(source, "src/util"), { recursive: true });
    writeFileSync(join(source, "package.json"), JSON.stringify({ name: "tiny", version: "1.0.0" }));
    writeFileSync(join(source, "README.md"), "# Tiny\n\nAdds numbers and shouts them.\n");
    writeFileSync(join(source, "src/index.ts"), "import { add } from './math';\nimport { shout } from './util/text';\nexport function main(): string { return shout(String(add(1, 2))); }\n");
    writeFileSync(join(source, "src/math.ts"), "export function add(a: number, b: number): number { return a + b; }\n");
    writeFileSync(join(source, "src/util/text.ts"), "export function shout(value: string): string { return value.toUpperCase(); }\n");
    const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid", GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z" } });
    git("init", "-q"); git("add", "."); git("commit", "-q", "-m", "tiny");
    const artifacts = scanRepository(source, { systemName: "Tiny", repositorySlug: "tiny", analysisMode: "quick" });
    const inScope = artifacts.snapshot.entities.filter(entity => entity.kind !== "code").length;
    const leaves = artifacts.snapshot.entities.filter(entity => entity.kind === "component").length;
    assert.ok(leaves >= 2, "the tiny repo has several components");
    let calls = 0;
    const gateway = { modelId: "fake/model", async chatCompletions(body: Record<string, unknown>) {
      calls += 1;
      const message = JSON.parse(String((body.messages as Array<{ content: string }>)[1]!.content)) as { scope: { name: string; allowedEvidence: unknown[] } };
      const ref = message.scope.allowedEvidence[0];
      return { json: { choices: [{ message: { content: JSON.stringify({ summary: `${message.scope.name} does one thing.`, keyPoints: ["Read it first.", "It is small."], evidence: [ref] }) } }] }, usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.001 } };
    } };
    const caps = { maxRequests: leaves - 1, maxTokens: 1_000_000, maxDollars: 1, maxConcurrent: 1 };
    Object.assign(process.env, { OKIE_LLM_OPERATOR_MAX_REQUESTS: String(caps.maxRequests), OKIE_LLM_OPERATOR_MAX_DOLLARS: "1", OKIE_LLM_OPERATOR_MAX_TOKENS: "1000000", OKIE_LLM_MAX_CONCURRENT: "1", OKIE_LLM_ENRICH_DEPTH: "component" });
    const cut = await runCrossRepoEnrichment({ root: join(root, "store-cut"), source: { owner: "o", repo: "tiny", slug: "o__tiny" }, commitSha: artifacts.pin.commitSha, artifacts, mode: "fake", gateway, globalLedger: createOperatorBudgetLedger({ maxRequests: 1_000, maxTokens: 1_000_000, maxDollars: 1 }), caps, depth: "component" });
    assert.equal(calls, leaves - 1, "the cap admits exactly its request count");
    assert.equal(cut.record.stopped, "limit");
    assert.equal(cut.record.systemExplained, false, "the system never reduces once the cap cuts a leaf");
    assert.equal(cut.record.containersExplained, 0);
    assert.equal(cut.record.byKind.component!.accepted, leaves - 1);
    assert.equal(cut.record.parentsWithUnsettledChildren, 0);
    assert.ok(cut.sidecar && cut.snapshot, "the partial draft is still exported");

    calls = 0;
    process.env.OKIE_LLM_OPERATOR_MAX_REQUESTS = String(inScope);
    const full = await runCrossRepoEnrichment({ root: join(root, "store-full"), source: { owner: "o", repo: "tiny", slug: "o__tiny" }, commitSha: artifacts.pin.commitSha, artifacts, mode: "fake", gateway, caps: { ...caps, maxRequests: inScope }, depth: "component" });
    assert.equal(full.record.stopped, "complete");
    assert.equal(full.record.systemExplained, true);
    assert.equal(calls, inScope, "one request per in-scope scope");
    assert.equal(full.record.costUsd, Math.round(inScope * 0.001 * 1e6) / 1e6);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    rmSync(root, { recursive: true, force: true });
  }
});
