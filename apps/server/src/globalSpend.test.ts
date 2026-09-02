import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  clampEnrichmentBudget,
  createGlobalEnrichmentSpend,
  GLOBAL_ENRICHMENT_BUDGET_SKIP_NOTE,
  resolveGlobalEnrichmentCap,
} from "./globalSpend.js";
import { healthzBody } from "./localDefaults.js";
import {
  DEFAULT_MAX_ENRICHMENT_DOLLARS,
  DEFAULT_MAX_ENRICHMENT_SCOPES,
  DEFAULT_MAX_ENRICHMENT_TOKENS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type EnrichmentBudget,
} from "./llmGateway.js";

const FAKE_GATEWAY_KEY = "okie-test-llm-key-cla38-fake";
const srcDir = fileURLToPath(new URL(".", import.meta.url));

const scanBudget = (): EnrichmentBudget => ({
  requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  maxScopes: DEFAULT_MAX_ENRICHMENT_SCOPES,
  maxTokens: DEFAULT_MAX_ENRICHMENT_TOKENS,
  maxDollars: DEFAULT_MAX_ENRICHMENT_DOLLARS,
});

test("resolveGlobalEnrichmentCap is unset by default and reads tokens and/or dollars", () => {
  assert.deepEqual(resolveGlobalEnrichmentCap({}), {});
  assert.deepEqual(resolveGlobalEnrichmentCap({
    OKIE_LLM_GLOBAL_MAX_TOKENS: "5000",
    OKIE_LLM_GLOBAL_MAX_DOLLARS: "2.5",
  }), { maxTokens: 5000, maxDollars: 2.5 });
  assert.deepEqual(resolveGlobalEnrichmentCap({ OKIE_LLM_GLOBAL_MAX_TOKENS: "0" }), { maxTokens: 0 });
  assert.deepEqual(resolveGlobalEnrichmentCap({
    OKIE_LLM_GLOBAL_MAX_TOKENS: "nope",
    OKIE_LLM_GLOBAL_MAX_DOLLARS: "-1",
    OKIE_LLM_GLOBAL_MAX_SCOPES: "99",
  }), {});
});

test("ledger is a process-wide ceiling: under cap allows, at cap is exhausted across callers", () => {
  const spend = createGlobalEnrichmentSpend({ maxTokens: 100, maxDollars: 1 });
  assert.equal(spend.isExhausted(), false);
  spend.record({ totalTokens: 40 });
  spend.record({ totalTokens: 60, costUsd: 0.25 });
  assert.equal(spend.isExhausted(), true);
  assert.deepEqual(spend.snapshot(), { tokens: 100, dollars: 0.25 });
  assert.deepEqual(spend.remaining(), { tokens: 0, dollars: 0.75 });

  const dollarOnly = createGlobalEnrichmentSpend({ maxDollars: 0.5 });
  dollarOnly.record({ totalTokens: 9_000 });
  assert.equal(dollarOnly.isExhausted(), false, "dollar cap waits for reported cost");
  dollarOnly.record({ costUsd: 0.5 });
  assert.equal(dollarOnly.isExhausted(), true);
});

test("zero cap is already exhausted so enrichment can skip without a gateway call", () => {
  const tokens = createGlobalEnrichmentSpend({ maxTokens: 0 });
  const dollars = createGlobalEnrichmentSpend({ maxDollars: 0 });
  assert.equal(tokens.isExhausted(), true);
  assert.equal(dollars.isExhausted(), true);
});

test("clampEnrichmentBudget tightens the per-scan CLA-22 budget to remaining global headroom", () => {
  const spend = createGlobalEnrichmentSpend({ maxTokens: 50, maxDollars: 0.2 });
  spend.record({ totalTokens: 10, costUsd: 0.05 });
  const clamped = clampEnrichmentBudget(scanBudget(), spend);
  assert.equal(clamped.maxTokens, 40);
  assert.equal(clamped.maxDollars, 0.15);
  assert.equal(clamped.maxScopes, DEFAULT_MAX_ENRICHMENT_SCOPES);
  assert.deepEqual(clampEnrichmentBudget(scanBudget()), scanBudget());
});

test("skip note and healthz never carry keys, spend totals, or gateway URLs", () => {
  const note = GLOBAL_ENRICHMENT_BUDGET_SKIP_NOTE;
  const body = JSON.stringify(healthzBody({ enrich: "auto", bind: "127.0.0.1" }));
  assert.equal(note, "global enrichment budget reached");
  assert.doesNotMatch(note, /api[_-]?key|openrouter|https?:\/\//i);
  assert.doesNotMatch(note, new RegExp(FAKE_GATEWAY_KEY));
  assert.doesNotMatch(body, new RegExp(FAKE_GATEWAY_KEY));
  assert.doesNotMatch(body, /GLOBAL_MAX|maxTokens|dollars|spend/i);
  assert.deepEqual(Object.keys(JSON.parse(body) as object).sort(), [
    "bind",
    "enrich",
    "ok",
    "public",
    "service",
  ]);

  const main = readFileSync(join(srcDir, "../src/main.ts"), "utf8");
  const server = readFileSync(join(srcDir, "../src/scanServer.ts"), "utf8");
  assert.match(main, /createSubmitLimiter\(\)/);
  assert.match(main, /createGlobalEnrichmentSpend/);
  assert.match(server, /healthzBody\(\{\s*enrich,\s*bind\s*\}\)/);
  assert.doesNotMatch(server, /healthzBody\([^)]*spend/);
  assert.doesNotMatch(server, /healthzBody\([^)]*apiKey/);
  assert.doesNotMatch(main, /healthzBody\([^)]*apiKey/);
});
