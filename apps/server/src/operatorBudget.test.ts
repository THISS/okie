import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperatorBudgetLedger } from "./operatorBudget.js";
import { OperatorStore } from "./operatorStore.js";

test("concurrent requests reserve capacity before usage arrives and settle by identity", () => {
  const ledger = createOperatorBudgetLedger({ maxRequests: 4, maxTokens: 100, maxDollars: 1 });
  const first = ledger.reserve(60)!;
  const second = ledger.reserve(40)!;
  assert.equal(ledger.reserve(1), undefined);
  ledger.settle(second, { inputTokens: 4, outputTokens: 6, measuredCostUsd: 0 });
  assert.equal(ledger.snapshot().reservedTokens, 60);
  assert.ok(ledger.reserve(30));
  ledger.settle(first, { inputTokens: 20, outputTokens: 40, measuredCostUsd: 1 });
  assert.equal(ledger.reserve(0), undefined);
  ledger.settle(first, { inputTokens: 0, outputTokens: 0, measuredCostUsd: 0 });
  assert.equal(ledger.snapshot().measuredCostUsd, 1);
});

test("missing usage remains unknown and does not free reserved tokens", () => {
  const ledger = createOperatorBudgetLedger({ maxRequests: 4, maxTokens: 100, maxDollars: 1 });
  ledger.settle(ledger.reserve(100)!);
  assert.equal(ledger.reserve(1), undefined);
  assert.equal(ledger.snapshot().measuredCostUsd, undefined);
  assert.equal(ledger.snapshot().unknownCostRequests, 1);
});

test("optional concurrency and dollar reservations survive restart without inventing measured cost", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-budget-dollars-"));
  try {
    const store = new OperatorStore(root);
    const run = store.createRun({ idempotencyKey: "dollars", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
    const limits = { maxRequests: 10, maxTokens: 1000, maxDollars: 0.5, maxConcurrent: 1 };
    const ledger = createOperatorBudgetLedger(limits, { store, runId: run.runId });
    const first = ledger.reserve(50, 0.3)!;
    assert.equal(ledger.reserve(1, 0.1), undefined, "pending request occupies concurrent slot");
    ledger.settle(first, { inputTokens: 3, outputTokens: 2 });
    const restored = createOperatorBudgetLedger(limits, { store: new OperatorStore(root), runId: run.runId });
    assert.equal(restored.snapshot().reservedCostUsd, 0.3);
    assert.equal(restored.snapshot().measuredCostUsd, undefined);
    assert.equal(restored.reserve(1, 0.201), undefined, "unknown billing cannot free dollars");
    const second = restored.reserve(50, 0.2)!;
    assert.ok(second, "exact dollar boundary is allowed");
    restored.settle(second, { inputTokens: 3, outputTokens: 2, measuredCostUsd: 0.1 });
    assert.equal(ledger.snapshot().measuredCostUsd, 0.1);
    assert.ok(ledger.reserve(50, 0.09), "measured usage replaces only its own reservation");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("durable admission shares limits across ledger instances and restart", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-budget-"));
  try {
    const store = new OperatorStore(root);
    const run = store.createRun({ idempotencyKey: "budget", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
    const limits = { maxRequests: 2, maxTokens: 100, maxDollars: 1 };
    const a = createOperatorBudgetLedger(limits, { store, runId: run.runId });
    const b = createOperatorBudgetLedger(limits, { store, runId: run.runId });
    const id = a.reserve(70)!;
    assert.equal(b.reserve(31), undefined);
    b.settle(id, { inputTokens: 10, outputTokens: 20, estimatedCostUsd: 0.2 });
    const restored = createOperatorBudgetLedger(limits, { store: new OperatorStore(root), runId: run.runId });
    assert.equal(restored.snapshot().estimatedCostUsd, 0.2);
    assert.ok(restored.reserve(70));
    assert.equal(a.reserve(0), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
