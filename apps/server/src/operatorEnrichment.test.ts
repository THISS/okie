import assert from "node:assert/strict";
import test from "node:test";
import { runOperatorEnrichment, validateDelegation, type OperatorEnrichmentAttempt, type OperatorEnrichmentScope, type OperatorEnrichmentStore, type OperatorExplanation } from "./operatorEnrichment.js";

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

const scopes: OperatorEnrichmentScope[] = [
  { scopeId: "system", name: "System", kind: "softwareSystem", facts: { observed: true }, allowedEvidence: [{ entityId: "system" }] },
  { scopeId: "area-a", parentScopeId: "system", name: "A", kind: "container", facts: { observed: true }, allowedEvidence: [{ entityId: "area-a" }] },
  { scopeId: "area-b", parentScopeId: "system", name: "B", kind: "container", facts: { observed: true }, allowedEvidence: [{ entityId: "area-b" }] },
  { scopeId: "leaf", parentScopeId: "area-a", name: "Leaf", kind: "component", facts: { observed: true }, allowedEvidence: [{ entityId: "leaf" }] },
];

function reply(scopeId: string, usage = 3): { json: unknown; usage: { totalTokens: number; costUsd: number } } {
  return { json: { choices: [{ message: { content: JSON.stringify({ summary: `${scopeId} summary`, evidence: [{ entityId: scopeId }] }) } }] }, usage: { totalTokens: usage, costUsd: 0.01 } };
}

test("nested children complete before parent, preserves out-of-order leaf completion, and records model/usage", async () => {
  const store = new MemoryStore(); const calls: string[] = []; let concurrent = 0; let maxConcurrent = 0;
  const result = await runOperatorEnrichment({ draftRevisionId: "d1", scopes, store, limits: { maxConcurrent: 2 }, gateway: { modelId: "configured/model", async chatCompletions(body) {
    const parsed = JSON.parse(String((body.messages as Array<{ content: string }>)[1]!.content)) as { scope?: { scopeId: string }; role?: string; directChildren?: string[] };
    if (parsed.role === "coordinator") return { json: { choices: [{ message: { content: JSON.stringify({ assignments: (parsed.directChildren ?? []).map(scopeId => ({ scopeId })) }) } }] }, usage: { totalTokens: 1, costUsd: 0.01 } };
    const scopeId = parsed.scope!.scopeId;
    calls.push(`start:${scopeId}`); concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent);
    if (scopeId === "area-a") await new Promise(resolve => setTimeout(resolve, 10));
    concurrent -= 1; calls.push(`end:${scopeId}`); return reply(scopeId);
  } } });
  assert.equal(result.modelId, "configured/model"); assert.ok(maxConcurrent <= 2);
  assert.ok(calls.indexOf("end:leaf") < calls.indexOf("start:area-a"));
  assert.ok(calls.indexOf("end:area-a") < calls.indexOf("start:system"));
  assert.equal(result.attempts.every(attempt => attempt.state === "accepted" && attempt.usage !== undefined), true);
});

test("failed retry preserves accepted sibling/current explanation and makes ancestors stale", async () => {
  const store = new MemoryStore(); store.current.set("area-a", { summary: "old", evidence: [{ entityId: "area-a" }] });
  const result = await runOperatorEnrichment({ draftRevisionId: "d1", scopes, store, retryScopeId: "area-a", gateway: { modelId: "m", async chatCompletions() { return { json: { choices: [{ message: { content: "not json" } }] }, usage: { totalTokens: 9 } }; } } });
  assert.deepEqual(result.staleScopes, ["system"]); assert.deepEqual(store.stale, ["system"]);
  assert.equal((await store.getAcceptedExplanation("area-a"))?.summary, "old");
  const owner = result.attempts.find(attempt => attempt.role === "owner");
  assert.equal(owner?.state, "failed"); assert.equal(owner?.usage?.totalTokens, 9);
});

test("rejects malformed evidence and invalid coordinator assignments while large inventories reduce by task cap", async () => {
  assert.throws(() => validateDelegation({ assignments: [{ scopeId: "other" }] }, "parent", ["child"]));
  const large = Array.from({ length: 300 }, (_, index) => ({ scopeId: `n${index}`, name: `n${index}`, kind: "code" as const, facts: {}, allowedEvidence: [{ entityId: `n${index}` }] }));
  const limited = await runOperatorEnrichment({ draftRevisionId: "d", scopes: large, store: new MemoryStore(), limits: { maxScopes: 2 }, gateway: { modelId: "m", async chatCompletions(body) { const scopeId = (JSON.parse(String((body.messages as Array<{ content: string }>)[1]!.content)) as { scope: { scopeId: string } }).scope.scopeId; return reply(scopeId); } } });
  assert.equal(limited.stopped, "limit"); assert.equal(limited.attempts.length > 2, true, "attempt records expose skipped scope gaps");
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scopes[0]!], store: new MemoryStore(), gateway: { modelId: "m", async chatCompletions() { return reply("unknown"); } } });
  assert.equal(result.attempts.find(attempt => attempt.role === "owner")?.state, "failed");
});

test("sends configured model/output cap, admits coordinator requests, and records unavailable gateway scopes", async () => {
  const bodies: Record<string, unknown>[] = []; const store = new MemoryStore();
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes, store, limits: { maxScopes: 1 }, gateway: { modelId: "openrouter/model", async chatCompletions(body) { bodies.push(body); return { json: { choices: [{ message: { content: JSON.stringify({ assignments: [] }) } }] }, usage: { totalTokens: 1 } }; } } });
  assert.equal(bodies[0]?.model, "openrouter/model"); assert.equal(bodies[0]?.max_tokens, 4096); assert.equal(result.stopped, "limit");
  const unavailable = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scopes[0]!], store: new MemoryStore() });
  assert.equal(unavailable.stopped, "unavailable"); assert.equal(unavailable.attempts[0]?.state, "failed");
});

test("attempt IDs are UUIDs by default and invalid structured diagrams preserve prose", async () => {
  const store = new MemoryStore(); const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scopes[0]!], store, gateway: { modelId: "m", async chatCompletions() { return { json: { choices: [{ message: { content: JSON.stringify({ summary: "useful", evidence: [{ entityId: "system" }], diagram: { nodes: ["invented"], edges: [] } }) } }] } }; } } });
  assert.match(result.attempts[0]!.attemptId, /^[0-9a-f-]{36}$/); assert.equal((await store.getAcceptedExplanation("system"))?.summary, "useful"); assert.match((await store.getAcceptedExplanation("system"))?.diagramError ?? "", /rejected diagram/);
});
