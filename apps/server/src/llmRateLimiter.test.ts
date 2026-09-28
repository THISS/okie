import assert from "node:assert/strict";
import test from "node:test";
import { LlmGatewayError } from "./llmGateway.js";
import { LlmRateLimiter, rateLimitedGateway, sharedLlmRateLimiter } from "./llmRateLimiter.js";

const rateLimited = () => new LlmGatewayError("llm gateway 429: busy", { kind: "rate_limit", status: 429 });
function fakeClock() { const state = { now: 0, sleeps: [] as number[] }; return { state, sleep: async (ms: number) => { state.sleeps.push(ms); state.now += ms; }, now: () => state.now }; }

test("429 pauses the provider, backs off exponentially, then succeeds", async () => {
  const clock = fakeClock(); let calls = 0;
  const limiter = new LlmRateLimiter({ maxConcurrent: 2, retries: 4, backoffMs: 1000, sleep: clock.sleep, now: clock.now });
  const gateway = rateLimitedGateway({ modelId: "m", async chatCompletions() { calls += 1; if (calls < 3) throw rateLimited(); return { json: { ok: true } }; } }, limiter);
  assert.deepEqual((await gateway.chatCompletions({})).json, { ok: true });
  assert.equal(calls, 3); assert.deepEqual(clock.state.sleeps, [1000, 2000]);
  assert.equal(limiter.active, 0);
});

test("a 429 on one request pauses other requests to the same provider", async () => {
  const clock = fakeClock(); const starts: number[] = []; let first = true;
  const limiter = new LlmRateLimiter({ maxConcurrent: 1, retries: 2, backoffMs: 500, sleep: clock.sleep, now: clock.now });
  const run = () => limiter.run(async () => { starts.push(clock.state.now); if (first) { first = false; throw rateLimited(); } return "ok"; });
  assert.deepEqual(await Promise.all([run(), run()]), ["ok", "ok"]);
  assert.deepEqual(starts, [0, 500, 500], "the queued request also waits out the provider pause");
});

test("exhausted retries surface the 429 and non-rate-limit errors are not retried", async () => {
  const clock = fakeClock(); let calls = 0;
  const limiter = new LlmRateLimiter({ maxConcurrent: 4, retries: 2, backoffMs: 10, sleep: clock.sleep, now: clock.now });
  await assert.rejects(limiter.run(async () => { calls += 1; throw rateLimited(); }), /llm gateway 429/);
  assert.equal(calls, 3); assert.deepEqual(clock.state.sleeps, [10, 20]);
  let serverCalls = 0;
  await assert.rejects(limiter.run(async () => { serverCalls += 1; throw new LlmGatewayError("llm gateway 500: down", { kind: "server", status: 500 }); }), /500/);
  assert.equal(serverCalls, 1); assert.equal(limiter.active, 0);
});

test("per-provider in-flight cap holds and shared limiters are keyed by provider", async () => {
  const limiter = new LlmRateLimiter({ maxConcurrent: 3, retries: 0, backoffMs: 1 }); let active = 0; let peak = 0;
  await Promise.all(Array.from({ length: 10 }, () => limiter.run(async () => { active += 1; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active -= 1; })));
  assert.equal(peak, 3);
  const config = { maxConcurrent: 2, retries: 1, backoffMs: 5 };
  assert.equal(sharedLlmRateLimiter("openrouter.ai", config), sharedLlmRateLimiter("openrouter.ai", config));
  assert.notEqual(sharedLlmRateLimiter("openrouter.ai", config), sharedLlmRateLimiter("api.example.test", config));
});
