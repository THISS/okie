import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GithubAuthService, GithubSession } from "./githubOAuth.js";
import { scanRepository } from "@okie/scan";
import { answerAskQuestion } from "./ask.js";
import { createScanJobQueue, toPublicJob, type ScanJob } from "./jobs.js";
import { classifyLlmGatewayFailure, LlmGatewayClient, LlmGatewayError, llmGatewayErrorFromHttp, normalizeGatewayErrorText, redactGatewayErrorText, summarizeGatewayErrorBody } from "./llmGateway.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { createOperatorRunner } from "./operatorRunner.js";
import { OperatorStore } from "./operatorStore.js";
import { createScanHttpHandler } from "./scanServer.js";

/**
 * CLA-261: an OpenRouter 400 body carries the account's `user_id`. Recorded shape,
 * FABRICATED identifiers — none of these is a real account, org, email, or key.
 */
const FAKE_USER_ID = "user_2fAbCdEfGhIjKlMnOpQrStUv";
const FAKE_ORG = "org_fake123";
const FAKE_EMAIL = "okie.fake.operator@example.invalid";
const FAKE_OR_KEY = "sk-or-v1-0000fakefakefakefakefakefake0000";
const IDENTIFIERS = [FAKE_USER_ID, FAKE_ORG, FAKE_EMAIL, FAKE_OR_KEY, "metadata", "provider_name"];
const OPENROUTER_400 = JSON.stringify({
  error: {
    message: "fake/model is not a valid model ID",
    code: 400,
    metadata: { provider_name: "FakeProvider", raw: `{"organization":"${FAKE_ORG}","email":"${FAKE_EMAIL}","key":"${FAKE_OR_KEY}"}` },
  },
  user_id: FAKE_USER_ID,
});
const NORMALIZED = "llm gateway 400: fake/model is not a valid model ID";

/** `strict`: the body's `user_id` field itself must be gone (normalized errors drop it; legacy free text keeps `user_id=[redacted]`). */
function assertNoIdentifier(text: string, where: string, strict = true): void {
  for (const value of strict ? [...IDENTIFIERS, "user_id"] : IDENTIFIERS) assert.equal(text.includes(value), false, `${value} leaked into ${where}: ${text.slice(0, 400)}`);
}

function openRouter400Client(): LlmGatewayClient {
  return new LlmGatewayClient(
    { baseUrl: "https://openrouter.test/api/v1", modelId: "fake/model", apiKey: FAKE_OR_KEY, keySource: "gateway" },
    { fetch: (async () => new Response(OPENROUTER_400, { status: 400, headers: { "content-type": "application/json" } })) as typeof fetch },
  );
}

test("CLA-261: a recorded OpenRouter 400 body normalizes to status + short message with no identifiers", async () => {
  const error = await openRouter400Client().chatCompletions({ messages: [] }).then(() => undefined, (cause: unknown) => cause);
  assert.ok(error instanceof LlmGatewayError);
  assert.equal(error.message, NORMALIZED);
  assert.equal(error.status, 400);
  assert.equal(error.kind, "http");
  assert.equal(classifyLlmGatewayFailure(error), "http");
  assert.equal(classifyLlmGatewayFailure(new Error(error.message)), "http", "the llm gateway NNN prefix still classifies");
  assertNoIdentifier(`${error.message} ${JSON.stringify(error)} ${String(error.stack)}`, "thrown error");

  // Provider code (when it differs from the status) and message only; metadata / other fields never.
  const coded = llmGatewayErrorFromHttp(429, JSON.stringify({ error: { message: `Rate limited for ${FAKE_EMAIL}`, code: "rate_limit_exceeded", metadata: { headers: { "X-RateLimit-Limit": "20" } } }, user_id: FAKE_USER_ID }));
  assert.equal(coded.message, "llm gateway 429 (rate_limit_exceeded): Rate limited for [redacted-email]");
  assert.equal(coded.providerCode, "rate_limit_exceeded");
  assert.equal(coded.kind, "rate_limit");
  assert.equal(llmGatewayErrorFromHttp(502, "<html><body>Bad gateway for user_id=" + FAKE_USER_ID + "</body></html>").message, "llm gateway 502: non-JSON response");
  const long = summarizeGatewayErrorBody(JSON.stringify({ error: { message: "x".repeat(1000) } }));
  assert.ok(long.message.length <= 200);
  assert.equal(llmGatewayErrorFromHttp(400, `plain text user_id=${FAKE_USER_ID}`).message, "llm gateway 400: plain text user_id=[redacted]");
  // Provider codes: numeric or a lowercase word only; an id-shaped "code" is dropped, never echoed.
  assert.equal(llmGatewayErrorFromHttp(400, JSON.stringify({ error: { message: "bad", code: FAKE_USER_ID } })).message, "llm gateway 400: bad");
  assert.equal(llmGatewayErrorFromHttp(400, JSON.stringify({ error: { message: "bad", code: "Org-AbCdEf1234567890" } })).providerCode, undefined);
  assert.equal(llmGatewayErrorFromHttp(400, JSON.stringify({ error: { message: "bad", type: "invalid_request_error" } })).message, "llm gateway 400 (invalid_request_error): bad");
  // A truncated legacy body never takes its code (or message) from inside metadata.
  const truncated = `{"error":{"message":"bad model","metadata":{"code":"leaky_code","message":"${FAKE_EMAIL}"`;
  assert.deepEqual(summarizeGatewayErrorBody(truncated), { message: "bad model" });
});

test("CLA-261: provider error summaries do bounded work on huge bodies", () => {
  for (const body of [JSON.stringify({ error: { message: "a".repeat(100_000), code: 400 } }), `${"x".repeat(100_000)}@`, `{"error":{"message":"${"b".repeat(100_000)}`]) {
    const started = performance.now();
    const summary = summarizeGatewayErrorBody(body);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 200, `${elapsed.toFixed(0)}ms`);
    assert.ok(summary.message.length <= 200);
  }
  for (const text of [`llm gateway 400: ${"c".repeat(100_000)}`, "llm gateway 400 (".repeat(5882), "llm gateway 400: {".repeat(5882)]) {
    const started = performance.now();
    normalizeGatewayErrorText(text);
    assert.ok(performance.now() - started < 200, `${text.slice(0, 20)}…`);
  }
});

test("CLA-261: normalizing is idempotent, including provider messages that start with `{`", () => {
  const cases = [
    `llm gateway 400: ${OPENROUTER_400}`,
    `llm gateway 400: ${JSON.stringify({ error: { message: JSON.stringify({ error: { message: "inner" } }) }, user_id: FAKE_USER_ID })}`,
    `llm gateway 400: ${JSON.stringify({ error: { message: "{not json", code: "bad_request" } })}`,
    `llm gateway 400: {"error":{"message":"cut for ${FAKE_EMAIL.replace("@", "\\u0040")}","code":400,"metadata":{"raw":"trunc`,
    "llm gateway 400: {\"not\":\"a body\"}",
    `Retry of Leaf failed: llm gateway 400: ${OPENROUTER_400}`,
  ];
  for (const text of cases) {
    const once = normalizeGatewayErrorText(text);
    assert.equal(normalizeGatewayErrorText(once), once, once);
    assertNoIdentifier(once, "normalized text", false);
  }
  assert.equal(normalizeGatewayErrorText(cases[1]!), `llm gateway 400: provider message {"error":{"message":"inner"}}`);
  // JSON-escaped characters in a cut-off legacy body are decoded before the scrub (`\u0040` → `@`).
  assert.equal(normalizeGatewayErrorText(cases[3]!), "llm gateway 400: cut for [redacted-email]");
});

const OPERATOR_ENV_KEYS = ["OKIE_LLM_OPERATOR_MAX_REQUESTS", "OKIE_LLM_OPERATOR_MAX_TOKENS", "OKIE_LLM_OPERATOR_MAX_DOLLARS", "OKIE_LLM_GLOBAL_MAX_DOLLARS", "OKIE_LLM_ENRICH_DEPTH"] as const;
async function withOperatorEnv(values: Partial<Record<(typeof OPERATOR_ENV_KEYS)[number], string>>, work: () => Promise<void>): Promise<void> {
  const old = Object.fromEntries(OPERATOR_ENV_KEYS.map(key => [key, process.env[key]]));
  try { for (const key of OPERATOR_ENV_KEYS) { if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; } await work(); }
  finally { for (const key of OPERATOR_ENV_KEYS) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } }
}

test("CLA-261: the operator runner stores, serves, and never exposes the provider body", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-cla261-"));
  try {
    await withOperatorEnv({ OKIE_LLM_OPERATOR_MAX_REQUESTS: "3" }, async () => {
      const store = new OperatorStore(root);
      const run = store.createRun({ idempotencyKey: "cla261", source: { repositoryId: "repo:acme/app", owner: "acme", repo: "app", slug: "acme__app" } }).run;
      const artifacts = scanRepository(process.cwd(), { systemName: "Okie", repositorySlug: "okie" });
      // The real runner and its real store adapter; only the gateway's fetch is stubbed with the recorded 400.
      await createOperatorRunner({ store, publication: new OperatorPublicationService(store), githubClient: () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }) as never, scan: async () => ({ commitSha: "a".repeat(40), artifacts }), gateway: openRouter400Client() })
        .enqueue({ kind: "run", runId: run.runId, githubAccess: { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } });
      const failed = store.snapshot().attempts.filter(attempt => attempt.state === "failed");
      assert.ok(failed.length > 0, "the recorded 400 fails the attempts it reaches");
      assert.ok(failed.every(attempt => attempt.error === NORMALIZED), JSON.stringify(failed.map(attempt => attempt.error)));
      // A raw pre-CLA-261 message reaching the store directly is normalized there too (defense in depth).
      store.updateRun(run.runId, { state: "awaiting_review", error: `Retry of Leaf failed: llm gateway 400: ${OPENROUTER_400}` });
      store.appendEvent({ runId: run.runId, type: "enrichment.retry_failed", detail: { reason: `llm gateway 400: ${OPENROUTER_400}`, scopeId: "component:email:sender" } });
      assert.equal(store.snapshot().runs[0]?.error, `Retry of Leaf failed: ${NORMALIZED}`);
      assert.deepEqual(store.snapshot().events.at(-1)?.detail, { reason: NORMALIZED, scopeId: "component:email:sender" }, "event ids are not mangled by the key rule");
      assertNoIdentifier(readFileSync(join(root, "operator-v1", "state.json"), "utf8"), "state.json on disk");

      const session = { id: "session", login: "operator", userId: "42", source: "test-double", token: "test-token", createdAt: 0 } as GithubSession;
      const auth = { config: { publicOrigin: "http://fixture.test" }, sessionFromRequest: (request: { headers: Record<string, unknown> }) => request.headers["x-test-user"] === "operator" ? session : undefined, publicView: () => ({ signedIn: false }), handle: async () => false } as unknown as GithubAuthService;
      const handler = createScanHttpHandler({ queue: {} as never, allowSubmit: () => true, auth, scanRoot: root, llm: { baseUrl: "", modelId: "fake", keySource: "none" }, enrich: "off", bind: "127.0.0.1", operator: { auth, allowedGithubIds: new Set(["42"]), publicOrigin: "http://fixture.test", store, publications: new OperatorPublicationService(store), enqueue() {} } });
      const server = createServer((request, response) => { void handler(request, response); });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address(); if (!address || typeof address === "string") throw new Error("missing test address");
        const origin = `http://127.0.0.1:${address.port}`; const headers = { "x-test-user": "operator" };
        const runDetail = await fetch(`${origin}/api/operator/runs/${run.runId}`, { headers });
        assert.equal(runDetail.status, 200);
        const runBody = await runDetail.text();
        assertNoIdentifier(runBody, "operator run detail API");
        const parsed = JSON.parse(runBody) as { run: { error?: string; draftRevisionId?: string }; attempts: Array<{ state: string; error?: string }> };
        assert.equal(parsed.attempts.find(attempt => attempt.state === "failed")?.error, NORMALIZED, "the UI's latest-attempts panel receives only the normalized message");
        assert.equal(parsed.run.error, `Retry of Leaf failed: ${NORMALIZED}`);
        // Scope detail: the draft whose scopes carry the failed attempts.
        const draftIds = [...new Set(store.snapshot().attempts.map(attempt => attempt.draftRevisionId))];
        let scopeErrors = 0;
        for (const draftId of draftIds) {
          const draft = await fetch(`${origin}/api/operator/drafts/${draftId}`, { headers });
          assert.equal(draft.status, 200);
          const draftBody = await draft.text();
          // The draft carries the scanned atlas (source text may say "metadata"), so check the fabricated values themselves.
          for (const value of [FAKE_USER_ID, FAKE_ORG, FAKE_EMAIL, FAKE_OR_KEY]) assert.equal(draftBody.includes(value), false, `${value} leaked into operator draft detail API`);
          scopeErrors += (JSON.parse(draftBody) as { scopes: Array<{ attempts?: Array<{ error?: string }> }> }).scopes.flatMap(scope => scope.attempts ?? []).filter(attempt => attempt.error === NORMALIZED).length;
        }
        assert.ok(scopeErrors > 0, "scope detail carries the normalized attempt error");
        assertNoIdentifier(await (await fetch(`${origin}/api/operator/runs`, { headers })).text(), "operator run list API");
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLA-261: Ask returns only the normalized error for a recorded OpenRouter 400", async () => {
  const config = { baseUrl: "https://openrouter.test/api/v1", modelId: "fake/model", apiKey: FAKE_OR_KEY, keySource: "gateway" as const };
  const result = await answerAskQuestion(config, { question: "What is this?", packets: [{ id: "container:web-app", name: "Web app", kind: "container", summary: "Shell." }] }, { gateway: openRouter400Client() });
  assert.deepEqual(result, { connected: true, error: NORMALIZED });
  assertNoIdentifier(JSON.stringify(result), "Ask response");
});

test("CLA-261: public scan job error and enrichment note carry no provider identifiers", async () => {
  const thrown = await openRouter400Client().chatCompletions({ messages: [] }).then(() => undefined, (cause: unknown) => cause as Error);
  const queue = createScanJobQueue(async () => { throw new Error(`all 1 enrichment scope(s) failed — first error: ${thrown!.message}`); });
  queue.submit({ owner: "o", repo: "r", slug: "o__r" });
  await queue.idle();
  const job = queue.list()[0]!;
  assert.equal(job.error, `all 1 enrichment scope(s) failed — first error: ${NORMALIZED}`);
  // Legacy/raw text reaching the public job view (the scanServer redactor) is scrubbed too.
  const raw: ScanJob = { ...job, stage: "complete", enrichment: { state: "failed", note: `llm gateway 400: ${OPENROUTER_400}` }, error: `boom ${OPENROUTER_400}` };
  const publicJob = JSON.stringify(toPublicJob(raw, text => redactGatewayErrorText(text, FAKE_OR_KEY)));
  for (const value of [FAKE_USER_ID, FAKE_ORG, FAKE_EMAIL, FAKE_OR_KEY]) assert.equal(publicJob.includes(value), false, `${value} leaked into public job: ${publicJob}`);
});

test("CLA-261 migration: an existing store's leaked provider bodies are scrubbed on read and on disk at open", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-cla261-migrate-"));
  try {
    const dir = join(root, "operator-v1"); mkdirSync(join(dir, "artifacts"), { recursive: true });
    const leaked = `llm gateway 400: ${OPENROUTER_400}`;
    // Pre-CLA-261 rows were capped at 800 characters, which can cut the JSON mid-body.
    const truncated = `llm gateway 400: ${JSON.stringify({ error: { message: "fake/model is not a valid model ID", code: 400 }, user_id: FAKE_USER_ID, pad: "p".repeat(900) })}`.slice(0, 800);
    const at = 1;
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      runs: [{ runId: "run-1", idempotencyKey: "k", source: { repositoryId: "repo:acme/app", owner: "acme", repo: "app", slug: "acme__app" }, state: "awaiting_review", createdAt: at, updatedAt: at, error: `Retry of Leaf failed: ${leaked}` }],
      drafts: [{ draftRevisionId: "draft-1", runId: "run-1", repositoryId: "repo:acme/app", revision: 1, state: "open", artifactRevisionId: "artifact-1", coverage: { total: 0, accepted: 0, failed: 0, notRun: 0, stale: 0 }, createdAt: at }],
      attempts: [
        { attemptId: "attempt-1", draftRevisionId: "draft-1", scopeId: "leaf", kind: "enrichment", state: "failed", createdAt: at, updatedAt: at, error: leaked },
        { attemptId: "attempt-2", draftRevisionId: "draft-1", scopeId: "leaf", kind: "retry", state: "failed", createdAt: at, updatedAt: at, error: truncated },
        { attemptId: "attempt-3", draftRevisionId: "draft-1", scopeId: "leaf", kind: "retry", state: "failed", createdAt: at, updatedAt: at, error: `request failed for user_id=${FAKE_USER_ID} org_id=${FAKE_ORG}` },
      ],
      explanations: [], artifacts: [], publications: [],
      events: [{ eventId: "event-1", runId: "run-1", at, type: "enrichment.retry_failed", detail: { reason: leaked, scopeId: "leaf" } }],
    }));
    const store = new OperatorStore(root);
    const snapshot = store.snapshot();
    assertNoIdentifier(JSON.stringify(snapshot), "store reads", false);
    assert.equal(snapshot.attempts[0]?.error, NORMALIZED);
    assert.equal(snapshot.attempts[1]?.error, NORMALIZED, "a truncated legacy body still yields the normalized message");
    assert.equal(snapshot.attempts[2]?.error, "request failed for user_id=[redacted] org_id=[redacted]");
    assert.equal(snapshot.runs[0]?.error, `Retry of Leaf failed: ${NORMALIZED}`);
    assert.equal(snapshot.events[0]?.detail?.scopeId, "leaf");
    // Opening the store rewrote the file: the identifiers are gone from disk, not just from reads.
    const onDisk = readFileSync(join(dir, "state.json"), "utf8");
    assertNoIdentifier(onDisk, "migrated state.json", false);
    // Idempotent: normalizing a normalized value is a no-op, and reopening changes nothing.
    assert.equal(normalizeGatewayErrorText(NORMALIZED), NORMALIZED);
    new OperatorStore(root);
    assert.equal(readFileSync(join(dir, "state.json"), "utf8"), onDisk);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
