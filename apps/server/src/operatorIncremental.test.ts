import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveGithubCommit, scanRepository, type GithubClient } from "@okie/scan";
import { coverageFor } from "./operatorContracts.js";
import type { OperatorEnrichmentGateway } from "./operatorEnrichment.js";
import type { ArchitectureSnapshot } from "@okie/architecture";
import { autoPublishGate, carriedPassAllowed, incrementalRunError, reuseHashCheck, startIncrementalRun, type IncrementalStartContext, type OperatorSidecar } from "./operatorIncremental.js";
import { operatorScopesFromSnapshot } from "./operatorFacts.js";
import type { OperatorWorkflowJob } from "./operatorWorkflow.js";
import { unfinishedScopes, type IncrementalChangelog } from "./incrementalChangelog.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { assertPublicRepository, createOperatorRunner } from "./operatorRunner.js";
import { OperatorStore } from "./operatorStore.js";
import { OperatorWorkflow } from "./operatorWorkflow.js";

const access = { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } as const;
const publicClient = () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }) as never;
const UTIL = "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function mul(a: number, b: number): number {\n  return a * b;\n}\n";
const MAIN = "import { add } from \"./util.js\";\n\nexport function run(): number {\n  return add(1, 2);\n}\n";
const LOG = "import { mul } from \"./util.js\";\n\nexport function log(): void {\n  console.log(mul(2, 3));\n}\n";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "okie-incremental-run-"));
  const repo = join(root, "repo"); mkdirSync(join(repo, "src"), { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=test", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  const write = (path: string, text: string) => writeFileSync(join(repo, path), text);
  const commit = (message: string) => { git("add", "-A"); git("commit", "-q", "-m", message); return git("rev-parse", "HEAD"); };
  write("package.json", "{\"name\":\"demo-lib\",\"version\":\"1.0.0\",\"type\":\"module\"}\n"); write("README.md", "demo\n");
  write("src/util.ts", UTIL); write("src/main.ts", MAIN); write("src/log.ts", LOG);
  const first = commit("A");
  const store = new OperatorStore(join(root, "scan")); const publications = new OperatorPublicationService(store);
  const calls: string[] = [];
  /** Scopes whose replies are invalid (the attempt fails validation). */
  const failing = new Set<string>();
  const gateway: OperatorEnrichmentGateway = { modelId: "fake/model", async chatCompletions(body) {
    const message = JSON.parse(String((body.messages as Array<{ content: string }>)[1]!.content)) as { scope: { scopeId: string; allowedEvidence: unknown[] } };
    calls.push(message.scope.scopeId);
    if (failing.has(message.scope.scopeId)) return { json: { choices: [{ message: { content: "{}" } }] }, usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5, costUsd: 0.001 } };
    return { json: { choices: [{ message: { content: JSON.stringify({ keyPoints: ["Start at the entry point.", "Watch the cache."], summary: `Summary ${message.scope.scopeId} ${calls.length}`, evidence: message.scope.allowedEvidence.slice(0, 1) }) } }] }, usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5, costUsd: 0.001 } };
  } };
  const scans: Array<{ ref?: string; rustIndexCacheDir?: string }> = [];
  const runner = createOperatorRunner({
    store, publication: publications, gateway, githubClient: publicClient, transportRetryDelayMs: 0,
    resolveCommit: async source => git("rev-parse", source.ref ?? "HEAD"),
    scan: async (source, options) => { scans.push({ ...(source.ref ? { ref: source.ref } : {}), ...(options.rustIndexCacheDir ? { rustIndexCacheDir: options.rustIndexCacheDir } : {}) }); const artifacts = scanRepository(repo, { revision: source.ref ?? "HEAD", systemName: "Demo", repositorySlug: "demo" }); return { commitSha: artifacts.snapshot.commitSha, artifacts }; },
  });
  const context: IncrementalStartContext = { store, publications, enqueue: job => runner.enqueue(job) };
  const sidecar = (draftRevisionId: string) => { const draft = store.snapshot().drafts.find(value => value.draftRevisionId === draftRevisionId)!; return JSON.parse(store.readArtifactFile(draft.artifactRevisionId, "operator-explanations.json")!.toString()) as OperatorSidecar; };
  return { root, repo, write, commit, first, store, publications, runner, context, calls, sidecar, git, scans, failing };
}

/** Full run at HEAD, then publish it: the baseline of every incremental test. */
async function baseline(f: ReturnType<typeof fixture>) {
  const run = f.store.createRun({ idempotencyKey: "full", source: { repositoryId: "repo:acme/demo", owner: "acme", repo: "demo", slug: "acme__demo" } }).run;
  await f.runner.enqueue({ kind: "run", runId: run.runId, githubAccess: access });
  const full = f.store.snapshot().runs.find(value => value.runId === run.runId)!;
  assert.equal(full.state, "awaiting_review");
  const published = f.publications.publishDraft({ repositoryId: "repo:acme/demo", draftRevisionId: full.draftRevisionId!, coverage: coverageFor(f.sidecar(full.draftRevisionId!).scopes) });
  assert.ok(published.ok);
  return { run: full, versionId: published.publication.versionId };
}

test("incremental run: an internal change re-enriches only its component and ancestors, carries the rest byte-for-byte, and marks its consumers stale", async () => {
  const f = fixture();
  try {
    const base = await baseline(f); const fullCalls = f.calls.length;
    assert.ok(fullCalls >= 5, "the full run enriched every in-cap scope");
    // A full SHA equal to the baseline is up to date without any run; the default branch is resolved by the runner,
    // which ends an up-to-date run complete with no draft.
    assert.deepEqual(await startIncrementalRun(f.context, { repositoryId: "repo:acme/demo", ref: f.first, trigger: "operator", githubAccess: access }), { status: "up_to_date", commitSha: f.first, baselineCommitSha: f.first });
    assert.equal(f.store.snapshot().runs.length, 1);
    const noop = await startIncrementalRun(f.context, { repositoryId: "repo:acme/demo", trigger: "operator", githubAccess: access });
    assert.equal(noop.status, "started");
    const noopRun = f.store.snapshot().runs.find(value => value.runId === (noop as { runId: string }).runId)!;
    assert.deepEqual([noopRun.state, noopRun.incremental?.upToDate?.commitSha, noopRun.draftRevisionId], ["complete", f.first, undefined]);

    f.write("src/util.ts", UTIL.replace("return a + b;", "return b + a;"));
    const second = f.commit("B");
    f.calls.length = 0;
    const started = await startIncrementalRun(f.context, { repositoryId: "repo:ACME/demo", trigger: "operator", githubAccess: access });
    assert.equal(started.status, "started");
    const run = f.store.snapshot().runs.find(value => value.runId === (started as { runId: string }).runId)!;
    assert.equal(run.kind, "incremental"); assert.equal(run.state, "awaiting_review"); assert.equal(run.source.commitSha, second);
    assert.deepEqual(run.incremental?.baseline, { runId: base.run.runId, draftRevisionId: base.run.draftRevisionId, artifactRevisionId: f.store.snapshot().drafts.find(draft => draft.draftRevisionId === base.run.draftRevisionId)!.artifactRevisionId, publicationVersionId: base.versionId, commitSha: f.first });
    assert.deepEqual(f.calls.sort(), ["component:src-util-ts", "container:demo-lib", "system:demo"], "only the dirty set was requested");

    const before = f.sidecar(base.run.draftRevisionId!); const after = f.sidecar(run.draftRevisionId!);
    const row = (sidecar: OperatorSidecar, scopeId: string) => JSON.stringify(sidecar.explanations.find(value => value.scopeId === scopeId));
    for (const scopeId of ["component:src-main-ts", "component:src-log-ts"]) assert.equal(row(after, scopeId), row(before, scopeId), `${scopeId} carried over byte-for-byte (version id and input hash included)`);
    for (const scopeId of ["component:src-util-ts", "container:demo-lib", "system:demo"]) assert.notEqual(row(after, scopeId), row(before, scopeId));
    const scope = (scopeId: string) => after.scopes.find(value => value.scopeId === scopeId)!;
    // main.ts calls add; log.ts imports util.ts (add's module): both are claim re-checks, not re-enriched.
    for (const scopeId of ["component:src-main-ts", "component:src-log-ts"]) { assert.equal(scope(scopeId).stale, true, scopeId); assert.equal(scope(scopeId).staleReason, "dependency-internal"); }
    for (const scopeId of ["component:src-util-ts", "container:demo-lib", "system:demo"]) assert.ok(!scope(scopeId).stale, `${scopeId} was re-summarised and is fresh (a claim re-check child does not hold it stale)`);

    const detail = new OperatorWorkflow({ store: f.store, publications: f.publications, enqueue() {} }).draftDetail(run.draftRevisionId!)!;
    const changelog = detail.changelog!;
    assert.equal(changelog.fromCommit, f.first); assert.equal(changelog.toCommit, second);
    assert.deepEqual(changelog.entities.changed.items, [{ id: "code:src-util-ts:add", kind: "code", name: "add", change: "internal" }]);
    assert.deepEqual(changelog.counts, { entitiesAdded: 0, entitiesRemoved: 0, entitiesChanged: 1, surfaceChanges: 0, internalChanges: 1, entitiesMoved: 0, relationsAdded: 0, relationsRemoved: 0, removedExports: 0, dirty: 3, carried: 0, stale: 2, unfinished: 0, reused: 0, removedScopes: 0 });
    assert.deepEqual(changelog.stale.items, [{ scopeId: "component:src-log-ts", reason: "dependency-internal" }, { scopeId: "component:src-main-ts", reason: "dependency-internal" }]);
    assert.deepEqual(changelog.hashCheck, { checked: 0, mismatches: 0, unknown: 0 }, "nothing is reused as-is here (see the code-cap test for the hash check)");
    assert.equal(changelog.outcome.state, "settled");
    assert.deepEqual(changelog.outcome.resummarised.items.map(item => item.id).sort(), ["component:src-util-ts", "container:demo-lib", "system:demo"]);
    assert.deepEqual(changelog.outcome.resummarisedByKind, { component: 1, container: 1, softwareSystem: 1 });
    assert.equal(changelog.summary, "1 changed; container demo-lib re-summarised; 1 component re-summarised; system re-summarised; 2 stale; 0 reused");
    assert.equal(detail.incremental?.trigger, "operator");
    assert.equal(detail.incremental?.targetCommitSha, second, "the resolved target is on the run as soon as it is known");
    assert.equal(detail.draft.coverage.stale, 2);
    const events = f.store.snapshot().events.filter(event => event.runId === run.runId).map(event => event.type);
    assert.ok(events.includes("incremental.diff") && events.includes("incremental.finished") && events.includes("enrichment.finished"));
    // The reused scope's evidence is still honest: reused hash unchanged; the stale consumer can be refreshed as usual.
    assert.equal(f.publications.currentPublication("repo:acme/demo")?.versionId, base.versionId, "no auto-publish unless asked");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("incremental run: a moved-only line shift marks the owning scope stale with no requests; an active run refuses a second start", async () => {
  const f = fixture();
  try {
    await baseline(f);
    f.write("src/log.ts", `// logging helpers\n${LOG}`);
    f.commit("B");
    f.calls.length = 0;
    const started = await startIncrementalRun(f.context, { repositoryId: "repo:acme/demo", trigger: "operator", githubAccess: access });
    assert.equal(started.status, "started");
    const run = f.store.snapshot().runs.find(value => value.runId === (started as { runId: string }).runId)!;
    assert.deepEqual(f.calls, [], "nothing to re-enrich: the pass never runs");
    assert.equal(run.state, "awaiting_review");
    const after = f.sidecar(run.draftRevisionId!);
    assert.equal(after.scopes.find(scope => scope.scopeId === "component:src-log-ts")?.stale, true, "evidence line refs moved: stale for refresh, never silently rebased");
    const detail = new OperatorWorkflow({ store: f.store, publications: f.publications, enqueue() {} }).draftDetail(run.draftRevisionId!)!;
    assert.equal(detail.changelog?.counts.entitiesMoved, 1); assert.deepEqual(detail.changelog?.stale.items, [{ scopeId: "component:src-log-ts", reason: "moved" }]);

    const busy = f.store.createRun({ idempotencyKey: "busy", source: { repositoryId: "repo:acme/demo", owner: "acme", repo: "demo", slug: "acme__demo" } }).run;
    assert.equal(busy.state, "queued");
    assert.deepEqual(await startIncrementalRun(f.context, { repositoryId: "repo:acme/demo", trigger: "operator", githubAccess: access }), { status: "active", runId: busy.runId });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("incremental run: auto-publish only when fully accepted, through the publication service", async () => {
  const f = fixture();
  try {
    await baseline(f);
    // Nobody consumes log(): an internal change there leaves no stale consumer, so the draft ends fully accepted.
    f.write("src/log.ts", LOG.replace("console.log(mul(2, 3));", "console.info(mul(2, 3));"));
    f.commit("B");
    const started = await startIncrementalRun(f.context, { repositoryId: "repo:acme/demo", trigger: "cron", githubAccess: { kind: "unauthenticated" }, autoPublish: true });
    const run = f.store.snapshot().runs.find(value => value.runId === (started as { runId: string }).runId)!;
    assert.equal(f.publications.currentPublication("repo:acme/demo")?.draftRevisionId, run.draftRevisionId, "published automatically");
    const event = f.store.snapshot().events.find(value => value.runId === run.runId && value.type === "incremental.auto_publish");
    assert.equal(event?.detail?.published, true);

    // The next change leaves a stale consumer: the gate refuses and records why.
    f.write("src/util.ts", UTIL.replace("return a * b;", "return b * a;"));
    f.commit("C");
    const second = await startIncrementalRun(f.context, { repositoryId: "repo:acme/demo", trigger: "cron", githubAccess: { kind: "unauthenticated" }, autoPublish: true });
    const next = f.store.snapshot().runs.find(value => value.runId === (second as { runId: string }).runId)!;
    assert.equal(next.incremental?.baseline.draftRevisionId, run.draftRevisionId, "the baseline is the new current publication");
    assert.notEqual(f.publications.currentPublication("repo:acme/demo")?.draftRevisionId, next.draftRevisionId);
    const refused = f.store.snapshot().events.find(value => value.runId === next.runId && value.type === "incremental.auto_publish");
    assert.deepEqual([refused?.detail?.published, refused?.detail?.reason], [false, "coverage_incomplete"]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("auto-publish gate: zero failed, not run and stale, and every in-scope scope accepted", () => {
  assert.equal(autoPublishGate({ total: 5, accepted: 4, failed: 0, notRun: 0, stale: 0, belowCap: 1 }), true);
  assert.equal(autoPublishGate({ total: 5, accepted: 4, failed: 0, notRun: 0, stale: 1, belowCap: 1 }), false);
  assert.equal(autoPublishGate({ total: 5, accepted: 3, failed: 1, notRun: 0, stale: 0, belowCap: 1 }), false);
  assert.equal(autoPublishGate({ total: 5, accepted: 3, failed: 0, notRun: 1, stale: 0, belowCap: 1 }), false);
});

test("incremental run at the code cap: a rename drops the old scopes and re-enriches the re-pointed callers", async () => {
  const previous = process.env.OKIE_LLM_ENRICH_DEPTH; process.env.OKIE_LLM_ENRICH_DEPTH = "code";
  const f = fixture();
  try {
    await baseline(f);
    f.git("mv", "src/util.ts", "src/math.ts");
    f.write("src/main.ts", MAIN.replace("./util.js", "./math.js")); f.write("src/log.ts", LOG.replace("./util.js", "./math.js"));
    f.commit("rename");
    f.calls.length = 0;
    const started = await startIncrementalRun(f.context, { repositoryId: "repo:acme/demo", trigger: "script", githubAccess: access });
    const run = f.store.snapshot().runs.find(value => value.runId === (started as { runId: string }).runId)!;
    const after = f.sidecar(run.draftRevisionId!);
    assert.ok(!after.scopes.some(scope => scope.scopeId.includes("src-util-ts")), "removed scopes are gone");
    assert.ok(!after.explanations.some(row => row.scopeId.includes("src-util-ts")));
    const changelog = new OperatorWorkflow({ store: f.store, publications: f.publications, enqueue() {} }).draftDetail(run.draftRevisionId!)!.changelog!;
    assert.deepEqual(changelog.entities.removed.items.map(item => item.id), ["code:src-util-ts:add", "code:src-util-ts:mul", "component:src-util-ts"]);
    assert.deepEqual(changelog.entities.added.items.map(item => item.id), ["code:src-math-ts:add", "code:src-math-ts:mul", "component:src-math-ts"]);
    assert.equal(changelog.hashCheck.mismatches, 0);
    // The callers' symbol text is unchanged, but their call edges were re-pointed (and the export they consumed was
    // removed), so every in-cap scope is re-enriched exactly once; nothing is stale or reused.
    const ALL = ["code:src-log-ts:log", "code:src-main-ts:run", "code:src-math-ts:add", "code:src-math-ts:mul", "component:src-log-ts", "component:src-main-ts", "component:src-math-ts", "container:demo-lib", "system:demo"];
    assert.deepEqual([...f.calls].sort(), ALL);
    assert.deepEqual(changelog.dirty.items.map(item => item.id), ALL);
    assert.deepEqual(changelog.stale.items, []);
    assert.deepEqual(changelog.counts, { entitiesAdded: 3, entitiesRemoved: 3, entitiesChanged: 0, surfaceChanges: 0, internalChanges: 0, entitiesMoved: 0, relationsAdded: 4, relationsRemoved: 4, removedExports: 2, dirty: 9, carried: 0, stale: 0, unfinished: 0, reused: 0, removedScopes: 3 });
    assert.deepEqual(changelog.hashCheck, { checked: 0, mismatches: 0, unknown: 0 });
  } finally { if (previous === undefined) delete process.env.OKIE_LLM_ENRICH_DEPTH; else process.env.OKIE_LLM_ENRICH_DEPTH = previous; rmSync(f.root, { recursive: true, force: true }); }
});

test("incremental run at the code cap: every reused explanation's recomputed input hash equals its stored hash", async () => {
  const previous = process.env.OKIE_LLM_ENRICH_DEPTH; process.env.OKIE_LLM_ENRICH_DEPTH = "code";
  const f = fixture();
  try {
    await baseline(f);
    f.write("src/util.ts", UTIL.replace("return a * b;", "return b * a;"));
    f.commit("B");
    f.calls.length = 0;
    const started = await startIncrementalRun(f.context, { repositoryId: "repo:acme/demo", trigger: "script", githubAccess: access });
    const run = f.store.snapshot().runs.find(value => value.runId === (started as { runId: string }).runId)!;
    assert.deepEqual(f.calls.sort(), ["code:src-util-ts:mul", "component:src-util-ts", "container:demo-lib", "system:demo"]);
    const changelog = new OperatorWorkflow({ store: f.store, publications: f.publications, enqueue() {} }).draftDetail(run.draftRevisionId!)!.changelog!;
    // log() calls mul; log.ts and main.ts import mul's module util.ts: all three are claim re-checks.
    assert.deepEqual(changelog.stale.items, [{ scopeId: "code:src-log-ts:log", reason: "dependency-internal" }, { scopeId: "component:src-log-ts", reason: "dependency-internal" }, { scopeId: "component:src-main-ts", reason: "dependency-internal" }]);
    assert.equal(changelog.counts.reused, 2, "add and run");
    assert.deepEqual(changelog.hashCheck, { checked: 2, mismatches: 0, unknown: 0 });
  } finally { if (previous === undefined) delete process.env.OKIE_LLM_ENRICH_DEPTH; else process.env.OKIE_LLM_ENRICH_DEPTH = previous; rmSync(f.root, { recursive: true, force: true }); }
});

test("incremental baseline chain: two starts at one HEAD give one run and one paid pass; A→B→C reuses B's re-enrichment", async () => {
  const f = fixture();
  try {
    const base = await baseline(f);
    // B: util.ts changes internally. Not published (it has stale consumers).
    f.write("src/util.ts", UTIL.replace("return a + b;", "return b + a;"));
    const commitB = f.commit("B");
    f.calls.length = 0;
    const first = await startIncrementalRun(f.context, { repositoryId: "repo:acme/demo", trigger: "operator", githubAccess: access });
    assert.equal(first.status, "started");
    const paid = f.calls.length;
    assert.deepEqual([...f.calls].sort(), ["component:src-util-ts", "container:demo-lib", "system:demo"]);
    const again = await startIncrementalRun(f.context, { repositoryId: "repo:acme/demo", trigger: "cron", githubAccess: { kind: "unauthenticated" } });
    assert.equal(again.status, "started");
    const againRun = f.store.snapshot().runs.find(run => run.runId === (again as { runId: string }).runId)!;
    assert.deepEqual([againRun.state, againRun.incremental?.upToDate?.commitSha, againRun.draftRevisionId], ["complete", commitB, undefined], "the chain's newest draft is already at HEAD: the runner records up to date");
    assert.equal(f.calls.length, paid, "one paid pass");
    assert.equal(f.scans.length, 2, "the full run's scan plus B's; the second start never scans");
    const runB = f.store.snapshot().runs.find(run => run.runId === (first as { runId: string }).runId)!;

    // C: log.ts changes internally. C diffs against B's draft (same publication underneath), not the publication.
    f.write("src/log.ts", LOG.replace("console.log(mul(2, 3));", "console.info(mul(2, 3));"));
    const commitC = f.commit("C");
    f.calls.length = 0;
    const third = await startIncrementalRun(f.context, { repositoryId: "repo:acme/demo", trigger: "operator", githubAccess: access });
    const runC = f.store.snapshot().runs.find(run => run.runId === (third as { runId: string }).runId)!;
    const draftB = f.store.snapshot().drafts.find(draft => draft.draftRevisionId === runB.draftRevisionId)!;
    assert.deepEqual(runC.incremental?.baseline, { runId: runB.runId, draftRevisionId: runB.draftRevisionId, artifactRevisionId: draftB.artifactRevisionId, publicationVersionId: base.versionId, commitSha: commitB });
    assert.deepEqual([...f.calls].sort(), ["component:src-log-ts", "container:demo-lib", "system:demo"], "util.ts is not paid for again");
    const b = f.sidecar(runB.draftRevisionId!); const c = f.sidecar(runC.draftRevisionId!);
    const row = (sidecar: OperatorSidecar, scopeId: string) => sidecar.explanations.find(value => value.scopeId === scopeId);
    assert.deepEqual(row(c, "component:src-util-ts"), row(b, "component:src-util-ts"), "B's re-enrichment of util.ts is reused byte-for-byte");
    assert.notDeepEqual(row(c, "component:src-util-ts"), row(f.sidecar(base.run.draftRevisionId!), "component:src-util-ts"));
    assert.equal(runC.source.commitSha, commitC);
    // Parents the pass re-reduced were reduced with their freshly re-enriched children as accepted (not stale): their
    // stored input hash equals a recompute over the draft they were installed in.
    const snapshotB = JSON.parse(f.store.readArtifactFile(draftB.artifactRevisionId, "snapshot.json")!.toString()) as ArchitectureSnapshot;
    const storedHashes = new Map(f.store.snapshot().explanations.map(value => [value.explanationVersionId, value.inputHash]));
    const finalB = f.store.snapshot().drafts.find(draft => draft.draftRevisionId === runB.draftRevisionId)!;
    assert.deepEqual(reuseHashCheck({ scopes: operatorScopesFromSnapshot(snapshotB), cap: "component", baseline: f.sidecar(finalB.draftRevisionId), reused: ["container:demo-lib", "system:demo", "component:src-util-ts"], modelId: "fake/model", leafReasoning: "provider-default", storedHash: value => value.inputHash ?? storedHashes.get(value.explanationVersionId!) }), { checked: 3, mismatches: 0, unknown: 0 });
    // The cumulative view is what publishing C would ship: publication → C, with B as the one unpublished step between.
    const changelogC = new OperatorWorkflow({ store: f.store, publications: f.publications, enqueue() {} }).draftDetail(runC.draftRevisionId!)!.changelog!;
    const ids = <T extends { id?: string; scopeId?: string }>(list: { items: T[] }) => list.items.map(item => item.id ?? item.scopeId);
    assert.deepEqual([changelogC.publication?.commitSha, changelogC.publication?.versionId], [f.first, base.versionId]);
    assert.deepEqual(changelogC.chain, [{ runId: runB.runId, draftRevisionId: runB.draftRevisionId, toCommit: commitB }]);
    assert.deepEqual(ids(changelogC.entities.changed), ["code:src-log-ts:log"], "this update only");
    assert.deepEqual([changelogC.cumulative?.fromCommit, changelogC.cumulative?.toCommit], [f.first, commitC]);
    assert.deepEqual(ids(changelogC.cumulative!.entities.changed), ["code:src-log-ts:log", "code:src-util-ts:add"], "cumulative: B's change is shipped too");
    assert.deepEqual(ids(changelogC.cumulative!.dirty), ["component:src-log-ts", "component:src-util-ts", "container:demo-lib", "system:demo"]);
    assert.deepEqual(ids(changelogC.dirty), ["component:src-log-ts", "container:demo-lib", "system:demo"], "dirty is commit-caused only");
    assert.deepEqual(changelogC.carried, { total: 0, items: [] });
    assert.deepEqual(changelogC.stale.items, [{ scopeId: "component:src-main-ts", reason: "dependency-internal" }], "B's stale overlay is inherited and listed");
    assert.equal(changelogC.counts.stale, 1);
    assert.deepEqual(ids(changelogC.reuse!.sincePublication), ["component:src-util-ts"], "re-enriched by B, unreviewed");
    assert.deepEqual(ids(changelogC.reuse!.fromPublication), [], "main.ts is stale: listed as stale, never as reused from publication");
    assert.deepEqual([changelogC.chainLength, changelogC.chainPartial], [1, undefined]);
    assert.equal(changelogC.cumulativeSummary, `since published ${f.first.slice(0, 7)} (2 updates): 2 changed; 4 re-summarised since publication (unreviewed); 1 stale; 0 reused from publication`);
    // main.ts stays a claim re-check across the chain (B's stale overlay is carried, not silently cleared).
    assert.equal(c.scopes.find(scope => scope.scopeId === "component:src-main-ts")?.staleReason, "dependency-internal");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

/** One incremental step at a new commit: returns its run, its changelog and the scopes it requested. */
async function step(f: ReturnType<typeof fixture>, path: string, text: string, message: string) {
  f.write(path, text); const commitSha = f.commit(message);
  f.calls.length = 0;
  const started = await startIncrementalRun(f.context, { repositoryId: "repo:acme/demo", trigger: "operator", githubAccess: access });
  assert.equal(started.status, "started", message);
  const run = f.store.snapshot().runs.find(value => value.runId === (started as { runId: string }).runId)!;
  const changelog = new OperatorWorkflow({ store: f.store, publications: f.publications, enqueue() {} }).draftDetail(run.draftRevisionId!)!.changelog!;
  return { run, changelog, calls: [...f.calls].sort(), commitSha };
}
const LOG_V = (n: number) => LOG.replace("console.log(mul(2, 3));", `console.log(mul(2, ${n}));`);
const UTIL_ID = "component:src-util-ts";

test("incremental chain: a gap in the publication is never re-seeded automatically", async () => {
  const f = fixture();
  try {
    // The published draft has util.ts failed (published with the gap acknowledged).
    f.failing.add(UTIL_ID);
    const run = f.store.createRun({ idempotencyKey: "full", source: { repositoryId: "repo:acme/demo", owner: "acme", repo: "demo", slug: "acme__demo" } }).run;
    await f.runner.enqueue({ kind: "run", runId: run.runId, githubAccess: access });
    const full = f.store.snapshot().runs.find(value => value.runId === run.runId)!;
    assert.equal(f.sidecar(full.draftRevisionId!).scopes.find(scope => scope.scopeId === UTIL_ID)?.state, "failed");
    assert.ok(f.publications.publishDraft({ repositoryId: "repo:acme/demo", draftRevisionId: full.draftRevisionId!, acknowledgeCoverage: true, coverage: coverageFor(f.sidecar(full.draftRevisionId!).scopes) }).ok);
    f.failing.clear();
    const first = await step(f, "src/log.ts", LOG_V(4), "B");
    assert.ok(!first.calls.includes(UTIL_ID), "the publication's failed scope stays as it is (the operator retries it)");
    assert.deepEqual(first.changelog.carried, { total: 0, items: [] });
    const second = await step(f, "src/log.ts", LOG_V(5), "C");
    assert.ok(!second.calls.includes(UTIL_ID), "nor on later chain steps");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("incremental chain: a chain step's leftovers are carried once more; two consecutive failures stop re-seeding", async () => {
  const f = fixture();
  try {
    await baseline(f);
    f.failing.add(UTIL_ID);
    // B: util.ts changes and its re-enrichment fails.
    const b = await step(f, "src/util.ts", UTIL.replace("return a + b;", "return b + a;"), "B");
    assert.ok(b.calls.includes(UTIL_ID));
    assert.ok([...b.changelog.outcome.failed.items, ...b.changelog.outcome.keptStale.items].some(item => item.id === UTIL_ID), "B leaves util.ts unfinished");
    // C: an unrelated commit. util.ts is carried (listed apart from the commit's dirty set) and fails again.
    const c = await step(f, "src/log.ts", LOG_V(4), "C");
    assert.ok(c.calls.includes(UTIL_ID), "carried from B");
    assert.deepEqual(c.changelog.carried.items.map(item => item.id), [UTIL_ID]);
    assert.ok(!c.changelog.dirty.items.some(item => item.id === UTIL_ID), "dirty is commit-caused only");
    assert.equal(c.changelog.counts.carried, 1);
    // D: util.ts failed in two consecutive chain steps (B, C): no longer re-seeded.
    const d = await step(f, "src/log.ts", LOG_V(5), "D");
    assert.ok(!d.calls.includes(UTIL_ID), "dropped after two consecutive failures");
    assert.deepEqual(d.changelog.carried, { total: 0, items: [] });
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("incremental chain: a failed scope and the ancestors it holds stale are dropped after two failing steps; later steps make zero calls", async () => {
  const f = fixture();
  try {
    await baseline(f);
    f.failing.add(UTIL_ID);
    const b = await step(f, "src/util.ts", UTIL.replace("return a + b;", "return b + a;"), "B");
    assert.deepEqual(b.calls, [UTIL_ID], "util.ts fails; its ancestors wait for it");
    const held = ["container:demo-lib", "system:demo"];
    const c = await step(f, "README.md", "# demo\nC\n", "C");
    assert.deepEqual(c.changelog.dirty.total, 0, "README-only");
    assert.deepEqual(c.calls, [UTIL_ID, ...held].sort(), "carried once: util.ts fails again; the ancestors are re-reduced but held stale by it");
    // D: util.ts and the ancestors it holds stale were attempted and left unfinished by B and C: dropped, no calls.
    const d = await step(f, "README.md", "# demo\nD\n", "D");
    assert.deepEqual(d.calls, [], "the drop happens: zero calls");
    assert.deepEqual(d.changelog.carried, { total: 0, items: [] });
    const e = await step(f, "README.md", "# demo\nE\n", "E");
    assert.deepEqual(e.calls, [], "and stays dropped: zero calls");
    // The dropped scopes stay visible: unfinished with a reason, counted stale, never "reused from publication".
    const unfinished = new Map(e.changelog.unfinished.items.map(item => [item.id, item.reason]));
    for (const scopeId of [UTIL_ID, ...held]) assert.equal(unfinished.get(scopeId), "dropped", scopeId);
    assert.equal(e.changelog.counts.unfinished, e.changelog.unfinished.total);
    assert.equal(e.changelog.counts.stale, e.changelog.stale.total + e.changelog.unfinished.total);
    assert.equal(e.changelog.cumulative!.counts.stale, e.changelog.counts.stale, "both views count them");
    for (const scopeId of [UTIL_ID, ...held]) assert.ok(!e.changelog.reuse!.fromPublication.items.some(item => item.id === scopeId), `${scopeId} is not reused from publication`);
    assert.match(e.changelog.summary, /stale \(\d+ unfinished\)/);
    assert.match(e.changelog.cumulativeSummary!, /\(4 updates\).*stale \(\d+ unfinished\)/);
    const detail = new OperatorWorkflow({ store: f.store, publications: f.publications, enqueue() {} }).draftDetail(e.run.draftRevisionId!)!;
    assert.equal(detail.scopes.find(scope => scope.scopeId === "system:demo")?.staleReason, "dropped", "the scope list and detail show why");
    // A commit that touches util.ts again re-seeds it (commit-caused), whatever was dropped.
    f.failing.clear();
    const g = await step(f, "src/util.ts", UTIL, "G");
    assert.ok(g.calls.includes(UTIL_ID));
    assert.equal(g.changelog.unfinished.total, 0, "finished");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("incremental run: the carried pass keeps the commit pass's run error alongside its own", async () => {
  const f = fixture();
  try {
    await baseline(f);
    f.failing.add(UTIL_ID);
    await step(f, "src/util.ts", UTIL.replace("return a + b;", "return b + a;"), "B");
    // C: the commit's own seed (log.ts) fails in the first pass, then carried util.ts fails in the second.
    f.failing.add("component:src-log-ts");
    const c = await step(f, "src/log.ts", LOG_V(4), "C");
    assert.ok(c.calls.includes("component:src-log-ts") && c.calls.includes(UTIL_ID), "both passes ran");
    const error = f.store.snapshot().runs.find(run => run.runId === c.run.runId)!.error ?? "";
    const kept = c.changelog.outcome.keptStale.items.map(item => item.id);
    assert.ok(kept.includes("component:src-log-ts") && kept.includes(UTIL_ID), "both passes' failures are in the outcome");
    // The run error covers both passes, in the changelog outcome's numbers (the same the chips show).
    assert.equal(error, `Update finished with failures: ${c.changelog.outcome.resummarised.total} re-summarised, ${c.changelog.outcome.keptStale.total} kept stale (changed; not re-enriched).`);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("carried pass gate: only after a complete commit pass, or when the commit has no seeds", () => {
  assert.equal(carriedPassAllowed(0, undefined), true, "no commit pass: carried scopes are the whole pass");
  assert.equal(carriedPassAllowed(3, "complete"), true);
  for (const stop of ["limit", "cancelled", "unavailable", undefined]) assert.equal(carriedPassAllowed(3, stop), false, String(stop));
});

test("incremental run: scopes a budget stop leaves stale are unfinished with reason pending; the carried pass runs only after a complete first pass", async () => {
  const previous = process.env.OKIE_LLM_OPERATOR_MAX_REQUESTS;
  const f = fixture();
  try {
    await baseline(f);
    f.failing.add(UTIL_ID);
    await step(f, "src/util.ts", UTIL.replace("return a + b;", "return b + a;"), "B");
    f.failing.clear();
    // C: the commit pass stops at the budget (2 of its 3 seeds): the carried pass must not start at all.
    process.env.OKIE_LLM_OPERATOR_MAX_REQUESTS = "2";
    const c = await step(f, "src/log.ts", LOG_V(4), "C");
    assert.equal(c.calls.length, 2);
    assert.ok(!c.calls.includes(UTIL_ID), "no carried pass after an incomplete first pass");
    assert.deepEqual(c.changelog.carried.items.map(item => item.id), [UTIL_ID]);
    const pending = c.changelog.unfinished.items.filter(item => item.reason === "pending").map(item => item.id);
    assert.ok(pending.includes(UTIL_ID) && pending.includes("system:demo"), `pending: ${pending.join(", ")}`);
    const detail = new OperatorWorkflow({ store: f.store, publications: f.publications, enqueue() {} }).draftDetail(c.run.draftRevisionId!)!;
    assert.equal(detail.scopes.find(scope => scope.scopeId === "system:demo")?.staleReason, "pending");
    const { outcome } = c.changelog;
    assert.equal(f.store.snapshot().runs.find(run => run.runId === c.run.runId)!.error, `Update stopped at the run budget (OKIE_LLM_OPERATOR_*): ${outcome.resummarised.total} re-summarised${outcome.notRun.total ? `, ${outcome.notRun.total} not run` : ""}, ${outcome.keptStale.total} kept stale (changed; not re-enriched).`, "the run error uses the changelog's numbers");
  } finally { if (previous === undefined) delete process.env.OKIE_LLM_OPERATOR_MAX_REQUESTS; else process.env.OKIE_LLM_OPERATOR_MAX_REQUESTS = previous; rmSync(f.root, { recursive: true, force: true }); }
});

test("incremental chain: a leftover that succeeds when carried is finished; commit seeds are admitted before carried ones", async () => {
  const previous = process.env.OKIE_LLM_OPERATOR_MAX_REQUESTS;
  const f = fixture();
  try {
    await baseline(f);
    f.failing.add(UTIL_ID);
    await step(f, "src/util.ts", UTIL.replace("return a + b;", "return b + a;"), "B");
    f.failing.clear();
    // C's own commit seeds (log.ts, then its container and system) use the whole budget: the carried pass is refused.
    process.env.OKIE_LLM_OPERATOR_MAX_REQUESTS = "3";
    const c = await step(f, "src/log.ts", LOG_V(4), "C");
    assert.deepEqual(c.calls, ["component:src-log-ts", "container:demo-lib", "system:demo"], "the commit's seeds first");
    assert.deepEqual(c.changelog.carried.items.map(item => item.id), [UTIL_ID]);
    delete process.env.OKIE_LLM_OPERATOR_MAX_REQUESTS;
    // D: util.ts was carried by C but never attempted (budget), so it is carried again and now succeeds.
    const d = await step(f, "src/log.ts", LOG_V(5), "D");
    assert.ok(d.calls.includes(UTIL_ID));
    assert.ok(d.changelog.outcome.resummarised.items.some(item => item.id === UTIL_ID));
    const e = await step(f, "src/log.ts", LOG_V(6), "E");
    assert.ok(!e.calls.includes(UTIL_ID), "finished: nothing left to carry");
  } finally { if (previous === undefined) delete process.env.OKIE_LLM_OPERATOR_MAX_REQUESTS; else process.env.OKIE_LLM_OPERATOR_MAX_REQUESTS = previous; rmSync(f.root, { recursive: true, force: true }); }
});

test("incremental run: an explained below-cap scope whose source changed is marked stale, never carried as fresh", async () => {
  const f = fixture();
  try {
    const base = await baseline(f);
    // Opt in to explaining one below-cap symbol on the published draft, then publish that revision.
    await f.runner.enqueue({ kind: "retry", runId: base.run.runId, draftRevisionId: base.run.draftRevisionId!, scopeIds: ["code:src-log-ts:log"], batch: true, githubAccess: access });
    const withSymbol = f.store.snapshot().runs.find(run => run.runId === base.run.runId)!.draftRevisionId!;
    assert.ok(f.sidecar(withSymbol).explanations.some(row => row.scopeId === "code:src-log-ts:log"), "the below-cap symbol has an explanation");
    const republished = f.publications.publishDraft({ repositoryId: "repo:acme/demo", draftRevisionId: withSymbol, expectedCurrentVersionId: base.versionId, coverage: coverageFor(f.sidecar(withSymbol).scopes) });
    assert.ok(republished.ok);
    f.write("src/log.ts", LOG.replace("console.log(mul(2, 3));", "console.info(mul(2, 3));"));
    f.commit("B");
    f.calls.length = 0;
    const started = await startIncrementalRun(f.context, { repositoryId: "repo:acme/demo", trigger: "operator", githubAccess: access, autoPublish: true });
    const run = f.store.snapshot().runs.find(value => value.runId === (started as { runId: string }).runId)!;
    assert.ok(!f.calls.includes("code:src-log-ts:log"), "below the cap: never re-enriched by the pass");
    const after = f.sidecar(run.draftRevisionId!);
    const symbol = after.scopes.find(scope => scope.scopeId === "code:src-log-ts:log")!;
    assert.deepEqual([symbol.stale, symbol.staleReason], [true, "changed"]);
    assert.ok(after.explanations.some(row => row.scopeId === "code:src-log-ts:log"), "its text is kept for review, marked stale");
    assert.ok(!after.scopes.find(scope => scope.scopeId === "component:src-log-ts")!.stale, "the re-summarised parent is fresh");
    const refused = f.store.snapshot().events.find(value => value.runId === run.runId && value.type === "incremental.auto_publish");
    assert.deepEqual([refused?.detail?.published, refused?.detail?.reason], [false, "coverage_incomplete"], "a stale below-cap explanation blocks auto-publish");
    const dto = new OperatorWorkflow({ store: f.store, publications: f.publications, enqueue() {} }).draftDetail(run.draftRevisionId!)!.scopes.find(scope => scope.scopeId === "code:src-log-ts:log")!;
    assert.equal(dto.staleReason, "changed");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("cancel while queued: neither an incremental nor a full run is marked running, scanned or charged", async () => {
  const f = fixture();
  try {
    await baseline(f);
    f.write("src/util.ts", UTIL.replace("return a + b;", "return b + a;"));
    f.commit("B");
    const deferred: OperatorWorkflowJob[] = [];
    const started = await startIncrementalRun({ ...f.context, enqueue: job => { deferred.push(job); } }, { repositoryId: "repo:acme/demo", trigger: "operator", githubAccess: access });
    const runId = (started as { runId: string }).runId;
    f.store.updateRun(runId, { state: "cancelled" });
    const scans = f.scans.length; const calls = f.calls.length;
    await f.runner.enqueue(deferred[0]!);
    const states = f.store.snapshot().events.filter(event => event.runId === runId && event.type === "run.state").map(event => event.detail?.state);
    assert.deepEqual(states, ["cancelled"], "never marked running");
    assert.equal(f.store.snapshot().runs.find(run => run.runId === runId)!.state, "cancelled");
    assert.deepEqual([f.scans.length, f.calls.length], [scans, calls]);
    const full = f.store.createRun({ idempotencyKey: "full-2", source: { repositoryId: "repo:acme/demo", owner: "acme", repo: "demo", slug: "acme__demo" } }).run;
    f.store.updateRun(full.runId, { state: "cancelled" });
    await f.runner.enqueue({ kind: "run", runId: full.runId, githubAccess: access });
    assert.equal(f.store.snapshot().runs.find(run => run.runId === full.runId)!.state, "cancelled");
    assert.deepEqual(f.store.snapshot().events.filter(event => event.runId === full.runId && event.type === "run.state").map(event => event.detail?.state), ["cancelled"]);
    assert.deepEqual([f.scans.length, f.calls.length], [scans, calls]);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("auto-publish after a manual publish is refused with stale_publication; up-to-date runs record upToDate; scans use the store's SCIP cache", async () => {
  const f = fixture();
  try {
    const base = await baseline(f);
    assert.deepEqual(f.scans[0], { rustIndexCacheDir: join(f.store.root, "cache", "rust-scip") }, "operator scans share the content-addressed SCIP cache");
    // A run that resolves to its baseline's commit (no resolver at start) records upToDate and ends complete.
    const noResolve = await startIncrementalRun({ store: f.store, publications: f.publications, enqueue: job => f.runner.enqueue(job) }, { repositoryId: "repo:acme/demo", trigger: "operator", githubAccess: access });
    const upToDate = f.store.snapshot().runs.find(run => run.runId === (noResolve as { runId: string }).runId)!;
    assert.deepEqual([upToDate.state, upToDate.draftRevisionId, upToDate.incremental?.upToDate, upToDate.incremental?.targetCommitSha], ["complete", undefined, { commitSha: f.first }, f.first]);
    f.write("src/log.ts", LOG.replace("console.log(mul(2, 3));", "console.info(mul(2, 3));"));
    f.commit("B");
    const deferred: OperatorWorkflowJob[] = [];
    const started = await startIncrementalRun({ ...f.context, enqueue: job => { deferred.push(job); } }, { repositoryId: "repo:acme/demo", trigger: "operator", githubAccess: access, autoPublish: true });
    const runId = (started as { runId: string }).runId;
    // An operator publishes by hand while the update is queued (here: a copy of the baseline draft as a new revision).
    const baseDraft = f.store.snapshot().drafts.find(draft => draft.draftRevisionId === base.run.draftRevisionId)!;
    const copy = f.store.writeArtifactRevision({ repositoryId: "repo:acme/demo", sourceCommitSha: f.first, files: Object.fromEntries(f.store.snapshot().artifacts.find(artifact => artifact.artifactRevisionId === baseDraft.artifactRevisionId)!.files.map(name => [name, f.store.readArtifactFile(baseDraft.artifactRevisionId, name)!.toString()])) });
    const manualDraft = f.publications.createDraftRevision({ runId: base.run.runId, artifactRevisionId: copy.artifactRevisionId, coverage: baseDraft.coverage });
    const manual = f.publications.publishDraft({ repositoryId: "repo:acme/demo", draftRevisionId: manualDraft.draftRevisionId, expectedCurrentVersionId: base.versionId, coverage: baseDraft.coverage });
    assert.ok(manual.ok); assert.notEqual(manual.publication.versionId, base.versionId);
    await f.runner.enqueue(deferred[0]!);
    const event = f.store.snapshot().events.find(value => value.runId === runId && value.type === "incremental.auto_publish");
    assert.deepEqual([event?.detail?.published, event?.detail?.reason], [false, "stale_publication"]);
    assert.equal(f.publications.currentPublication("repo:acme/demo")?.versionId, manual.publication.versionId, "the manual publication wins");
    assert.equal(f.store.snapshot().runs.find(run => run.runId === runId)!.state, "awaiting_review");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("incremental run error: budget, no gateway and failures are named; any other pass error is kept verbatim after the counts", () => {
  const list = (total: number) => ({ total, items: [] });
  const view = { outcome: { state: "settled", resummarised: list(2), resummarisedByKind: {}, keptStale: list(3), failed: list(0), notRun: list(4) } } as unknown as IncrementalChangelog;
  const counts = "2 re-summarised, 4 not run, 3 kept stale (changed; not re-enriched).";
  assert.equal(incrementalRunError("Updated 2 of 9 selected scopes: stopped at the run budget (OKIE_LLM_OPERATOR_*); 7 not run.", view), `Update stopped at the run budget (OKIE_LLM_OPERATOR_*): ${counts}`);
  assert.equal(incrementalRunError("Update of 9 scopes was not run: this run's enrichment budget is exhausted. Raise OKIE_LLM_OPERATOR_MAX_REQUESTS (or the matching budget limit) to retry.", view), `Update stopped at the run budget (OKIE_LLM_OPERATOR_*): ${counts}`);
  assert.equal(incrementalRunError("Update of 9 scopes was not run: no enrichment gateway is configured.", view), `Update was not run: no enrichment gateway is configured: ${counts}`);
  assert.equal(incrementalRunError("Update: 1 of 3 selected scopes failed; previous explanation was kept.", view), `Update finished with failures: ${counts}`);
  assert.equal(incrementalRunError("Update of 9 scopes failed: disk full", view), `Update finished with an error: ${counts} Update of 9 scopes failed: disk full`);
});

test("GitHub reads: a failed read reports its status (and rate limits); only a successful read of a private repo is \"not public\"; an unresolvable ref is named", async () => {
  const client = (result: Awaited<ReturnType<GithubClient["getJson"]>>): GithubClient => ({ getJson: async () => result, downloadTarball: async () => 0 });
  await assert.rejects(assertPublicRepository(client({ ok: false, status: 403, rateLimited: true, message: "GitHub API rate limit reached for anonymous access." }), "acme", "demo"), { message: "could not read the repository on GitHub: rate limited (status 403). Try again after the rate limit resets." });
  await assert.rejects(assertPublicRepository(client({ ok: false, status: 502, rateLimited: false, message: "GitHub API request failed (status 502)." }), "acme", "demo"), { message: "could not read the repository on GitHub (status 502)." });
  await assert.rejects(assertPublicRepository(client({ ok: false, status: 404, rateLimited: false, message: "x" }), "acme", "demo"), { message: "could not read the repository on GitHub (status 404: not found, or not public)." });
  await assert.rejects(assertPublicRepository(client({ ok: true, json: { private: true } }), "acme", "demo"), { message: "repository is not public" });
  await assertPublicRepository(client({ ok: true, json: { private: false } }), "acme", "demo");
  const unresolvable: GithubClient = { getJson: async path => path.includes("/commits/") ? { ok: false, status: 422, rateLimited: false, message: "GitHub API request failed (status 422)." } : { ok: true, json: { default_branch: "main" } }, downloadTarball: async () => 0 };
  await assert.rejects(resolveGithubCommit({ owner: "acme", repo: "demo", dirSlug: "acme__demo", ref: "nope" }, unresolvable), { message: "ref “nope” could not be resolved on GitHub for acme/demo (status 422)." });
});

test("up-to-date runs: only the newest no-op run of a repository is kept; runs with a draft are never removed", async () => {
  const f = fixture();
  try {
    await baseline(f);
    const noop = async () => { const started = await startIncrementalRun(f.context, { repositoryId: "repo:acme/demo", trigger: "cron", githubAccess: { kind: "unauthenticated" } }); assert.equal(started.status, "started"); return (started as { runId: string }).runId; };
    const first = await noop(); const second = await noop(); const third = await noop();
    const incremental = f.store.snapshot().runs.filter(run => run.kind === "incremental");
    assert.deepEqual(incremental.map(run => run.runId), [third], "each tick replaces the previous no-op run");
    assert.ok(!f.store.snapshot().events.some(event => event.runId === first || event.runId === second), "their events go with them");
    // A no-op-looking run that a draft refers to is kept.
    const referenced = f.store.createRun({ idempotencyKey: "ref", source: { repositoryId: "repo:acme/demo", owner: "acme", repo: "demo", slug: "acme__demo" }, incremental: { baseline: incremental[0]!.incremental!.baseline, trigger: "cron", upToDate: { commitSha: f.first } } }).run;
    const artifact = f.store.writeArtifactRevision({ repositoryId: "repo:acme/demo", sourceCommitSha: f.first, files: { "snapshot.json": "{}" } });
    f.publications.createDraftRevision({ runId: referenced.runId, artifactRevisionId: artifact.artifactRevisionId });
    f.store.updateRun(referenced.runId, { state: "complete", draftRevisionId: undefined as never });
    await noop();
    assert.ok(f.store.snapshot().runs.some(run => run.runId === referenced.runId), "a run with a draft revision is never pruned");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("unfinished reasons: pending only for scopes this update selected (the next update retries them); dropped; inherited otherwise", () => {
  const ref = (scopeId: string) => ({ scopeId, kind: "component", name: scopeId });
  const scope = (scopeId: string, extra: Record<string, unknown> = {}) => ({ scopeId, name: scopeId, kind: "component", state: "accepted", stale: true, ...extra });
  const stored = { dirty: [ref("dirty")], carried: [ref("carried")], dropped: [ref("dropped")] };
  const sidecar = { scopes: [scope("carried"), scope("dirty"), scope("dropped"), scope("fresh", { stale: false }), scope("old"), scope("overlay", { staleReason: "moved" })], explanations: [] };
  assert.deepEqual(unfinishedScopes(stored, sidecar).map(item => [item.id, item.reason]), [["carried", "pending"], ["dirty", "pending"], ["dropped", "dropped"], ["old", "inherited"]]);
});
