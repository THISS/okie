import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GithubAuthService, GithubSession } from "./githubOAuth.js";
import type { IncrementalStartResult } from "./operatorIncremental.js";
import { bearerMatches, createDeliveryLru, createIncrementalAutomation, createIncrementalScheduler, CRON_MAX_BODY_BYTES, resolveIncrementalTriggerConfig, verifyGithubSignature, WEBHOOK_MAX_BODY_BYTES, type IncrementalTimer, type IncrementalTriggerConfig } from "./operatorIncrementalTriggers.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore } from "./operatorStore.js";
import type { OperatorWorkflowJob } from "./operatorWorkflow.js";
import { createScanHttpHandler } from "./scanServer.js";

const SECRET = "webhook-secret-for-tests";
const TOKEN = "cron-token-for-tests";
const BASE = "a".repeat(40); const HEAD = "b".repeat(40); const LATER = "c".repeat(40);

function auth(): GithubAuthService {
  const session = (request: { headers: Record<string, string | string[] | undefined> }): GithubSession | undefined => request.headers["x-test-user"] === "operator" ? { id: "session", login: "operator", userId: "42", source: "test-double", token: "test-token", createdAt: 0 } : undefined;
  return { config: { publicOrigin: "http://fixture.test" }, sessionFromRequest: session as GithubAuthService["sessionFromRequest"], publicView: () => ({ signedIn: false }), handle: async () => false } as unknown as GithubAuthService;
}
/** A manual timer: `flush()` fires every armed, uncleared callback once. */
function manualTimer(): IncrementalTimer & { armed(): number; flush(): Promise<void>; delays: number[] } {
  let next = 0; const live = new Map<number, () => void>(); const delays: number[] = [];
  return {
    delays,
    set(callback, ms) { next += 1; live.set(next, callback); delays.push(ms); return next; },
    clear(handle) { live.delete(handle as number); },
    armed() { return live.size; },
    async flush() { const due = [...live.values()]; live.clear(); due.forEach(callback => callback()); await new Promise(resolve => setImmediate(resolve)); },
  };
}

/** A store whose acme/demo repository has one reviewable draft at BASE (the incremental baseline). */
function fixture(config: Partial<IncrementalTriggerConfig> = {}) {
  const root = mkdtempSync(join(tmpdir(), "okie-incremental-triggers-"));
  const store = new OperatorStore(root); const publications = new OperatorPublicationService(store);
  const run = store.createRun({ idempotencyKey: "full", source: { repositoryId: "repo:acme/demo", owner: "acme", repo: "demo", slug: "acme__demo" } }).run;
  const artifact = store.writeArtifactRevision({ repositoryId: "repo:acme/demo", sourceCommitSha: BASE, files: { "snapshot.json": "{}", "operator-explanations.json": "{\"scopes\":[],\"explanations\":[]}" } });
  publications.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
  store.updateRun(run.runId, { state: "awaiting_review" });
  const jobs: OperatorWorkflowJob[] = [];
  const timer = manualTimer();
  /** `failEnqueue` makes enqueueing throw; `onJob` sees each queued job (never awaited by the start). */
  const github = { failEnqueue: false, onJob: undefined as ((job: OperatorWorkflowJob) => void) | undefined };
  const enqueue = (job: OperatorWorkflowJob) => { if (github.failEnqueue) throw new Error("queue exploded: /internal/path"); jobs.push(job); github.onJob?.(job); };
  const automation = createIncrementalAutomation({ config: { debounceMs: 60_000, autoPublish: false, ...config }, store, publications, timer, enqueue });
  const handler = createScanHttpHandler({ queue: {} as never, allowSubmit: () => true, auth: auth(), scanRoot: root, llm: { baseUrl: "", modelId: "fake", keySource: "none" }, enrich: "off", bind: "127.0.0.1", operator: { auth: auth(), allowedGithubIds: new Set(["42"]), publicOrigin: "http://fixture.test", store, publications, enqueue, incremental: automation } });
  return { root, store, publications, run, jobs, timer, automation, handler, github };
}
async function serve(handler: ReturnType<typeof createScanHttpHandler>, work: (origin: string) => Promise<void>) {
  const server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test address");
  try { await work(`http://127.0.0.1:${address.port}`); } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const push = (overrides: Record<string, unknown> = {}) => JSON.stringify({ ref: "refs/heads/main", after: HEAD, repository: { full_name: "Acme/demo", default_branch: "main" }, ...overrides });
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const webhook = (origin: string, body: string, headers: Record<string, string> = {}) => fetch(`${origin}/api/operator/webhooks/github`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": sign(body), ...headers }, body });

test("config: every incremental trigger is off unless configured", () => {
  assert.deepEqual(resolveIncrementalTriggerConfig({}), { debounceMs: 60_000, autoPublish: false });
  assert.deepEqual(resolveIncrementalTriggerConfig({ OKIE_INCREMENTAL_CRON_TOKEN: " t ", OKIE_GITHUB_WEBHOOK_SECRET: "s", OKIE_INCREMENTAL_DEBOUNCE_MS: "5000", OKIE_INCREMENTAL_AUTO_PUBLISH: "1" }), { cronToken: "t", webhookSecret: "s", debounceMs: 5000, autoPublish: true });
});

test("signature and bearer checks are exact", () => {
  const body = Buffer.from(push());
  assert.equal(verifyGithubSignature(SECRET, body, sign(push())), true);
  assert.equal(verifyGithubSignature(SECRET, body, sign(push(), "other-secret")), false);
  assert.equal(verifyGithubSignature(SECRET, Buffer.from(`${push()} `), sign(push())), false, "any byte of the raw body counts");
  assert.equal(verifyGithubSignature(SECRET, body, sign(push()).replace("sha256=", "sha1=")), false);
  assert.equal(verifyGithubSignature(SECRET, body, undefined), false);
  assert.equal(bearerMatches(TOKEN, `Bearer ${TOKEN}`), true);
  assert.equal(bearerMatches(TOKEN, `Bearer ${TOKEN}x`), false); assert.equal(bearerMatches(TOKEN, TOKEN), false); assert.equal(bearerMatches(TOKEN, undefined), false);
});

test("webhook and cron routes answer 404 when their secret is not configured, without reading the body", async () => {
  const f = fixture();
  try { await serve(f.handler, async origin => {
    assert.equal((await webhook(origin, push())).status, 404);
    // A body that never ends: a server that read it before deciding would never answer.
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; if (pulled < 3) controller.enqueue(new TextEncoder().encode("{")); } });
    const response = await Promise.race([
      fetch(`${origin}/api/operator/webhooks/github`, { method: "POST", headers: { "content-type": "application/json", "x-github-event": "push", "x-hub-signature-256": sign("{") }, body: endless, duplex: "half" } as RequestInit),
      new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 3000).unref()),
    ]);
    assert.notEqual(response, "timeout", "answered before the body ended");
    assert.equal((response as Response).status, 404);
    assert.equal((await fetch(`${origin}/api/operator/cron/incremental`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
    assert.equal(f.jobs.length, 0);
  }); } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("webhook: bad signature is 401; non-push, non-default branch, unknown repository and deletions are ignored; a push is debounced", async () => {
  const f = fixture({ webhookSecret: SECRET });
  try { await serve(f.handler, async origin => {
    const bad = await webhook(origin, push(), { "x-hub-signature-256": sign(push(), "wrong") });
    assert.equal(bad.status, 401); assert.equal((await bad.json() as { code: string }).code, "signature_invalid");
    assert.equal((await webhook(origin, push(), { "x-hub-signature-256": "" })).status, 401);
    const ping = await webhook(origin, "{}", { "x-github-event": "ping", "x-hub-signature-256": sign("{}") });
    assert.deepEqual([ping.status, (await ping.json() as { ignored: string }).ignored], [200, "event"]);
    const branch = await webhook(origin, push({ ref: "refs/heads/feature" }));
    assert.deepEqual([branch.status, await branch.json()], [200, { ignored: "branch" }]);
    const unknown = await webhook(origin, push({ repository: { full_name: "acme/other", default_branch: "main" } }));
    assert.deepEqual(await unknown.json(), { ignored: "repository" });
    const deleted = await webhook(origin, push({ after: "0".repeat(40) }));
    assert.deepEqual(await deleted.json(), { ignored: "commit" });
    assert.equal(f.timer.armed(), 0);
    const accepted = await webhook(origin, push());
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { scheduled: true, repositoryId: "repo:acme/demo", pushedCommitSha: HEAD, debounceMs: 60_000 });
    assert.equal(f.jobs.length, 0, "nothing starts before the debounce window closes");
    await f.timer.flush();
    assert.equal(f.jobs.length, 1); assert.equal(f.jobs[0]!.kind, "incremental");
    const run = f.store.snapshot().runs.find(value => value.runId === f.jobs[0]!.runId)!;
    // The push is only a trigger: nothing is pinned, so the runner resolves default-branch HEAD when it starts.
    assert.deepEqual([run.kind, run.incremental?.trigger, run.incremental?.ref, run.incremental?.targetCommitSha, run.source.ref], ["incremental", "webhook", undefined, undefined, undefined]);
  }); } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("debounce: a burst coalesces into one start; a push during an active run queues exactly one follow-up", async () => {
  let starts = 0; let active = false;
  const timer = manualTimer();
  const scheduler = createIncrementalScheduler({ debounceMs: 1000, timer, async start(): Promise<IncrementalStartResult> { if (active) return { status: "active", runId: "run-1" }; starts += 1; active = true; return { status: "started", runId: "run-1", baselineCommitSha: BASE }; } });
  scheduler.schedule("repo:acme/demo"); scheduler.schedule("repo:acme/demo"); scheduler.schedule("repo:acme/demo");
  assert.equal(timer.armed(), 1, "each push re-arms the one per-repository timer");
  await timer.flush();
  assert.equal(starts, 1);
  assert.equal(scheduler.pending("repo:acme/demo"), false);
  // Two pushes land while that run is active: one follow-up, retried until the run ends.
  scheduler.schedule("repo:acme/demo"); scheduler.schedule("repo:acme/demo");
  await timer.flush();
  assert.equal(starts, 1, "still active: nothing started");
  assert.equal(scheduler.pending("repo:acme/demo"), true); assert.equal(timer.armed(), 1);
  active = false;
  await timer.flush();
  assert.equal(starts, 2);
  assert.equal(scheduler.pending("repo:acme/demo"), false); assert.equal(timer.armed(), 0);
  assert.ok(timer.delays.every(delay => delay === 1000));
  // Repositories debounce independently.
  scheduler.schedule("repo:acme/one"); scheduler.schedule("repo:acme/two");
  assert.equal(timer.armed(), 2);
});

test("delivery LRU: remembers the last N ids and refreshes on a hit", () => {
  const lru = createDeliveryLru(2);
  assert.equal(lru.seen("a"), false); assert.equal(lru.seen("b"), false); assert.equal(lru.seen("a"), true);
  assert.equal(lru.seen("c"), false, "evicts b (a was refreshed)"); assert.equal(lru.size, 2);
  assert.equal(lru.seen("a"), true); assert.equal(lru.seen("b"), false);
});

test("webhook: an out-of-order older push never regresses the draft; a redelivery is ignored", async () => {
  const f = fixture({ webhookSecret: SECRET });
  try { await serve(f.handler, async origin => {
    const newer = await webhook(origin, push({ after: LATER }), { "x-github-delivery": "delivery-1" });
    assert.equal(newer.status, 202);
    await f.timer.flush();
    assert.equal(f.jobs.length, 1);
    const first = f.store.snapshot().runs.find(value => value.runId === f.jobs[0]!.runId)!;
    assert.deepEqual([first.incremental?.targetCommitSha, first.incremental?.ref, first.source.ref], [undefined, undefined, undefined], "the pushed SHA is never pinned: the runner resolves default-branch HEAD");
    // The run finishes with a reviewable draft at LATER (what the runner would do).
    const artifact = f.store.writeArtifactRevision({ repositoryId: "repo:acme/demo", sourceCommitSha: LATER, files: { "snapshot.json": "{}", "operator-explanations.json": "{\"scopes\":[],\"explanations\":[]}" } });
    f.publications.createDraftRevision({ runId: first.runId, artifactRevisionId: artifact.artifactRevisionId });
    f.store.updateRun(first.runId, { state: "awaiting_review", source: { ...first.source, commitSha: LATER } });
    // GitHub redelivers the first push, then an older push (HEAD) arrives late.
    const redelivered = await webhook(origin, push({ after: LATER }), { "x-github-delivery": "delivery-1" });
    assert.deepEqual([redelivered.status, await redelivered.json()], [200, { ignored: "duplicate_delivery" }]);
    assert.equal(f.timer.armed(), 0, "a redelivery arms nothing");
    const older = await webhook(origin, push({ after: HEAD }), { "x-github-delivery": "delivery-0" });
    assert.equal(older.status, 202);
    await f.timer.flush();
    assert.equal(f.jobs.length, 2, "the late push only triggers a start at HEAD (the runner finds it up to date)");
    assert.ok(!f.store.snapshot().runs.some(run => run.incremental?.targetCommitSha === HEAD || run.incremental?.ref === HEAD || run.source.ref === HEAD), "nothing ever targets the older pushed SHA");
    f.store.updateRun(f.jobs[1]!.runId, { state: "complete" });
    // An unsigned request never poisons the delivery cache.
    assert.equal((await webhook(origin, push(), { "x-github-delivery": "delivery-2", "x-hub-signature-256": sign(push(), "wrong") })).status, 401);
    assert.equal((await webhook(origin, push({ after: "d".repeat(40) }), { "x-github-delivery": "delivery-2" })).status, 202);
  }); } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("automation routes: method and configuration are checked before the body is read; an oversized body is 413", async () => {
  const f = fixture({ cronToken: TOKEN });
  try { await serve(f.handler, async origin => {
    const huge = "x".repeat(CRON_MAX_BODY_BYTES + 1);
    // Unconfigured webhook: 404 without reading the (oversized) body.
    assert.equal((await webhook(origin, "y".repeat(64 * 1024))).status, 404);
    assert.equal((await fetch(`${origin}/api/operator/cron/incremental`, { method: "GET", headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
    assert.equal((await fetch(`${origin}/api/operator/cron/incremental`, { method: "POST", body: huge })).status, 401, "the token is checked before the body");
    const tooLarge = await fetch(`${origin}/api/operator/cron/incremental`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: huge });
    assert.deepEqual([tooLarge.status, await tooLarge.json()], [413, { error: "request body too large" }]);
    assert.equal(f.jobs.length, 0);
  }); } finally { rmSync(f.root, { recursive: true, force: true }); }
  const w = fixture({ webhookSecret: SECRET });
  try { await serve(w.handler, async origin => {
    const body = JSON.stringify({ padding: "z".repeat(WEBHOOK_MAX_BODY_BYTES) });
    const tooLarge = await webhook(origin, body);
    assert.equal(tooLarge.status, 413);
  }); } finally { rmSync(w.root, { recursive: true, force: true }); }
});

test("cron: bearer token required; starts an incremental run per published repository, skipping up-to-date ones", async () => {
  const f = fixture({ cronToken: TOKEN });
  try { await serve(f.handler, async origin => {
    const cron = (headers: Record<string, string>, body = "") => fetch(`${origin}/api/operator/cron/incremental`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    assert.equal((await cron({})).status, 401);
    assert.equal((await cron({ authorization: "Bearer nope" })).status, 401);
    const none = await cron({ authorization: `Bearer ${TOKEN}` });
    assert.deepEqual(await none.json(), { results: [] }, "no publication yet: nothing to update by default");
    const named = await cron({ authorization: `Bearer ${TOKEN}` }, JSON.stringify({ repositoryId: "repo:acme/demo", ref: BASE }));
    assert.deepEqual(await named.json(), { results: [{ repositoryId: "repo:acme/demo", status: "up_to_date", commitSha: BASE, baselineCommitSha: BASE }] });
    const started = await cron({ authorization: `Bearer ${TOKEN}` }, JSON.stringify({ repositoryId: "repo:acme/demo" }));
    const result = (await started.json() as { results: Array<{ status: string; runId: string; commitSha: string }> }).results[0]!;
    assert.deepEqual([result.status, result.commitSha], ["started", undefined], "no GitHub call in the request: the runner resolves HEAD");
    assert.equal(f.jobs.length, 1);
    assert.equal(f.store.snapshot().runs.find(run => run.runId === result.runId)!.incremental?.autoPublish, undefined);
    const again = await cron({ authorization: `Bearer ${TOKEN}` }, JSON.stringify({ repositoryId: "repo:acme/demo", autoPublish: true }));
    assert.equal((await again.json() as { results: Array<{ status: string }> }).results[0]!.status, "active");
  }); } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("cron: a per-repository failure returns a generic message; the detail stays in the server log", async () => {
  const f = fixture({ cronToken: TOKEN });
  const logged: unknown[][] = []; const original = console.error; console.error = (...args: unknown[]) => { logged.push(args); };
  try { await serve(f.handler, async origin => {
    const cron = (body: unknown) => fetch(`${origin}/api/operator/cron/incremental`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) });
    f.github.failEnqueue = true;
    const broken = await (await cron({ repositoryId: "repo:acme/demo" })).text();
    assert.deepEqual(JSON.parse(broken), { results: [{ repositoryId: "repo:acme/demo", status: "error", error: "could not start the incremental run" }] });
    assert.ok(!broken.includes("/internal/path"));
    assert.ok(logged.some(args => String(args[1]).includes("/internal/path")), "the detail is logged server-side");
  }); } finally { console.error = original; rmSync(f.root, { recursive: true, force: true }); }
});

test("cron: a body autoPublish is ignored; only OKIE_INCREMENTAL_AUTO_PUBLISH opts in", async () => {
  for (const serverAutoPublish of [false, true]) {
    const f = fixture({ cronToken: TOKEN, autoPublish: serverAutoPublish });
    try { await serve(f.handler, async origin => {
      const response = await fetch(`${origin}/api/operator/cron/incremental`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ repositoryId: "repo:acme/demo", autoPublish: !serverAutoPublish }) });
      const runId = (await response.json() as { results: Array<{ runId: string }> }).results[0]!.runId;
      assert.equal(f.store.snapshot().runs.find(run => run.runId === runId)!.incremental?.autoPublish, serverAutoPublish ? true : undefined);
    }); } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("operator route: session and CSRF guarded; 202 with the run id, 200 when up to date, 409 while active", async () => {
  const f = fixture();
  try { await serve(f.handler, async origin => {
    const url = `${origin}/api/operator/repositories/${encodeURIComponent("repo:acme/demo")}/incremental`;
    const headers = { "content-type": "application/json", origin: "http://fixture.test", "x-test-user": "operator" };
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers, "x-test-user": "nobody" }, body: "{}" })).status, 401);
    assert.equal((await fetch(url, { method: "POST", headers: { ...headers, origin: "http://evil.test" }, body: "{}" })).status, 403);
    assert.equal((await fetch(`${origin}/api/operator/repositories/acme%2Fother/incremental`, { method: "POST", headers, body: "{}" })).status, 404);
    assert.equal((await fetch(url, { method: "POST", headers, body: JSON.stringify({ ref: "../etc" }) })).status, 422);
    const upToDate = await fetch(url, { method: "POST", headers, body: JSON.stringify({ ref: BASE }) });
    assert.deepEqual([upToDate.status, await upToDate.json()], [200, { status: "up_to_date", commitSha: BASE, baselineCommitSha: BASE }]);
    const started = await fetch(`${origin}/api/operator/repositories/acme%2Fdemo/incremental`, { method: "POST", headers, body: "{}" });
    assert.equal(started.status, 202);
    const body = await started.json() as { status: string; runId: string; commitSha: string; baselineCommitSha: string };
    assert.deepEqual([body.status, body.commitSha, body.baselineCommitSha], ["started", undefined, BASE]);
    assert.equal(f.jobs.at(-1)!.runId, body.runId);
    assert.equal(f.jobs.at(-1)!.githubAccess.kind, "github", "the operator's session is used for GitHub reads");
    const busy = await fetch(url, { method: "POST", headers, body: "{}" });
    assert.equal(busy.status, 409); assert.deepEqual(await busy.json(), { status: "active", runId: body.runId, error: "operator action already running", code: "run_active" });
  }); } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("operator route: a start failure is a generic 500 and never leaves the run queued", async () => {
  const f = fixture();
  try { await serve(f.handler, async origin => {
    const url = `${origin}/api/operator/repositories/${encodeURIComponent("repo:acme/demo")}/incremental`;
    const headers = { "content-type": "application/json", origin: "http://fixture.test", "x-test-user": "operator" };
    f.github.failEnqueue = true;
    const broken = await fetch(url, { method: "POST", headers, body: "{}" });
    const text = await broken.text();
    assert.equal(broken.status, 500); assert.deepEqual(JSON.parse(text), { error: "could not start the incremental run" });
    assert.ok(!text.includes("/internal/path"), "internal error text is never returned");
    const orphan = f.store.snapshot().runs.filter(run => run.kind === "incremental");
    assert.equal(orphan.length, 1);
    assert.deepEqual([orphan[0]!.state, orphan[0]!.error], ["failed", "The incremental run could not be queued."], "a run whose job could not be queued never stays queued");
    // …so it does not block the next start.
    f.github.failEnqueue = false;
    assert.equal((await fetch(url, { method: "POST", headers, body: "{}" })).status, 202);
  }); } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("triggers answer immediately while a slow scan is still running: nothing in a request awaits GitHub or the scan", async () => {
  const f = fixture({ webhookSecret: SECRET, cronToken: TOKEN });
  // Each queued job starts a "scan" that takes 30 s (never awaited by the start).
  const scans: Array<Promise<void>> = []; const timers: NodeJS.Timeout[] = [];
  f.github.onJob = () => { scans.push(new Promise<void>(resolve => { timers.push(setTimeout(resolve, 30_000)); })); };
  try { await serve(f.handler, async origin => {
    const timed = async (request: Promise<Response>) => { const started = Date.now(); const response = await request; return { status: response.status, ms: Date.now() - started }; };
    const operator = await timed(fetch(`${origin}/api/operator/repositories/acme%2Fdemo/incremental`, { method: "POST", headers: { "content-type": "application/json", origin: "http://fixture.test", "x-test-user": "operator" }, body: "{}" }));
    assert.equal(operator.status, 202); assert.ok(operator.ms < 10_000, `operator route answered in ${operator.ms} ms`);
    assert.equal(scans.length, 1, "the scan is running");
    const push1 = await timed(webhook(origin, push(), { "x-github-delivery": "slow-1" }));
    assert.equal(push1.status, 202); assert.ok(push1.ms < 10_000, `webhook answered in ${push1.ms} ms while the scan runs`);
    const cron = await timed(fetch(`${origin}/api/operator/cron/incremental`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ repositoryId: "repo:acme/demo" }) }));
    assert.equal(cron.status, 200); assert.ok(cron.ms < 10_000, `cron answered in ${cron.ms} ms`);
    // The debounced start fires while the run is active: recorded, and a follow-up stays pending.
    await f.timer.flush();
    const fire = f.store.snapshot().events.filter(event => event.type === "incremental.webhook_fire");
    assert.deepEqual(fire.map(event => event.detail?.status), ["active"]);
    assert.equal(f.automation.scheduler.pending("repo:acme/demo"), true);
  }); } finally { timers.forEach(clearTimeout); rmSync(f.root, { recursive: true, force: true }); }
});

test("webhook: each debounced start is recorded on the repository's runs (started, up to date, failed)", async () => {
  const f = fixture({ webhookSecret: SECRET });
  const logged: unknown[][] = []; const original = console.error; console.error = (...args: unknown[]) => { logged.push(args); };
  try { await serve(f.handler, async origin => {
    assert.equal((await webhook(origin, push(), { "x-github-delivery": "trace-1" })).status, 202);
    await f.timer.flush();
    const started = f.store.snapshot().events.filter(event => event.type === "incremental.webhook_fire");
    assert.deepEqual(started.map(event => [event.runId, event.detail?.status]), [[f.jobs[0]!.runId, "started"]], "recorded on the new run");
    f.store.updateRun(f.jobs[0]!.runId, { state: "complete" });
    f.github.failEnqueue = true;
    assert.equal((await webhook(origin, push(), { "x-github-delivery": "trace-2" })).status, 202);
    await f.timer.flush();
    const failed = f.store.snapshot().events.filter(event => event.type === "incremental.webhook_fire").at(-1)!;
    assert.deepEqual(failed.detail, { status: "failed", reason: "could not start the incremental run" });
    assert.ok(!JSON.stringify(failed).includes("/internal/path"), "the detail stays in the server log");
    assert.ok(logged.some(args => String(args[1]).includes("/internal/path")));
  }); } finally { console.error = original; rmSync(f.root, { recursive: true, force: true }); }
});
