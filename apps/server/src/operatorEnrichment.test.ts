import assert from "node:assert/strict";
import test from "node:test";
import { LlmGatewayError } from "./llmGateway.js";
import { LlmRateLimiter, rateLimitedGateway } from "./llmRateLimiter.js";
import { DIGEST_LINE_CHARS, OPERATOR_OUTPUT_SCHEMA_PROMPT, childPromptInput, normalizeInteractions, validateOperatorExplanation, SYMBOL_DIGEST_BUDGET, runOperatorEnrichment, symbolDigest, type OperatorEnrichmentAttempt, type OperatorEnrichmentGateway, type OperatorEnrichmentScope, type OperatorEnrichmentStore, type OperatorExplanation } from "./operatorEnrichment.js";

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
const scope = (scopeId: string, kind: OperatorEnrichmentScope["kind"], parentScopeId?: string): OperatorEnrichmentScope => ({ scopeId, ...(parentScopeId ? { parentScopeId } : {}), name: scopeId, kind, facts: {}, allowedEvidence: [{ entityId: scopeId }] });
type Prompt = { scope: { scopeId: string }; children: Array<{ scopeId: string; state: string; summary?: string; explanation?: unknown; evidence?: unknown; diagram?: unknown }> };
const prompt = (body: Record<string, unknown>): Prompt => JSON.parse(String((body.messages as Array<{ content: string }>)[1]!.content)) as Prompt;

function reply(scopeId: string, usage = 3): { json: unknown; usage: { totalTokens: number; costUsd: number } } {
  return { json: { choices: [{ message: { content: JSON.stringify({ summary: `${scopeId} summary`, evidence: [{ entityId: scopeId }] }) } }] }, usage: { totalTokens: usage, costUsd: 0.01 } };
}
const echo = (modelId = "m"): OperatorEnrichmentGateway => ({ modelId, async chatCompletions(body) { return reply(prompt(body).scope.scopeId); } });

test("nested children complete before parent and record model/usage without coordinator calls", async () => {
  const store = new MemoryStore(); const calls: string[] = []; let concurrent = 0; let maxConcurrent = 0;
  const result = await runOperatorEnrichment({ draftRevisionId: "d1", scopes, store, limits: { maxConcurrent: 2 }, gateway: { modelId: "configured/model", async chatCompletions(body) {
    const scopeId = prompt(body).scope.scopeId;
    calls.push(`start:${scopeId}`); concurrent += 1; maxConcurrent = Math.max(maxConcurrent, concurrent);
    if (scopeId === "area-a") await new Promise(resolve => setTimeout(resolve, 10));
    concurrent -= 1; calls.push(`end:${scopeId}`); return reply(scopeId);
  } } });
  assert.equal(result.modelId, "configured/model"); assert.ok(maxConcurrent <= 2); assert.equal(result.stopped, "complete");
  assert.equal(calls.filter(call => call.startsWith("start:")).length, 4, "one request per scope; no planning calls");
  assert.ok(calls.indexOf("end:leaf") < calls.indexOf("start:area-a"));
  assert.ok(calls.indexOf("end:area-a") < calls.indexOf("start:system"));
  assert.equal(result.attempts.every(attempt => attempt.state === "accepted" && attempt.usage !== undefined && attempt.role === "owner"), true);
});

test("fan-out: all leaves start before any parent, parents wait for settled children, and a container runs while an unrelated subtree is in flight", async () => {
  const tree = [scope("sys", "softwareSystem"), scope("c1", "container", "sys"), scope("c2", "container", "sys"), scope("k1", "component", "c1"), scope("k2", "component", "c1"), scope("k3", "component", "c2")];
  const events: string[] = []; let releaseK3!: () => void; const k3Gate = new Promise<void>(resolve => { releaseK3 = resolve; });
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: tree, store: new MemoryStore(), gateway: { modelId: "m", async chatCompletions(body) {
    const scopeId = prompt(body).scope.scopeId; events.push(`start:${scopeId}`);
    if (scopeId === "k3") await k3Gate;
    if (scopeId === "c1") releaseK3();
    events.push(`end:${scopeId}`); return reply(scopeId);
  } } });
  assert.equal(result.stopped, "complete");
  assert.deepEqual(events.filter(event => event.startsWith("start:")).slice(0, 3), ["start:k1", "start:k2", "start:k3"], "leaves are queued immediately in scopeId order, before any parent");
  const at = (event: string) => events.indexOf(event);
  assert.ok(at("start:c1") > at("end:k1") && at("start:c1") > at("end:k2"));
  assert.ok(at("start:c1") < at("end:k3"), "c1 does not wait for the unrelated k3 subtree");
  assert.ok(at("start:c2") > at("end:k3"));
  assert.ok(at("start:sys") > at("end:c1") && at("start:sys") > at("end:c2"));
});

test("a failed child still settles: its parent runs and receives it as failed without an explanation", async () => {
  const tree = [scope("c", "container"), scope("ok", "component", "c"), scope("bad", "component", "c")];
  const store = new MemoryStore(); let parentChildren: Prompt["children"] = [];
  await runOperatorEnrichment({ draftRevisionId: "d", scopes: tree, store, gateway: { modelId: "m", async chatCompletions(body) {
    const message = prompt(body); if (message.scope.scopeId === "c") parentChildren = message.children;
    return message.scope.scopeId === "bad" ? { json: { choices: [{ message: { content: "{}" } }] } } : reply(message.scope.scopeId);
  } } });
  assert.deepEqual(parentChildren.map(child => ({ scopeId: child.scopeId, state: child.state, explained: child.summary !== undefined })), [{ scopeId: "bad", state: "failed", explained: false }, { scopeId: "ok", state: "accepted", explained: true }]);
  assert.equal(store.current.has("c"), true);
});

test("failed retry preserves accepted sibling/current explanation and makes ancestors stale", async () => {
  const store = new MemoryStore(); store.current.set("area-a", { summary: "old", evidence: [{ entityId: "area-a" }] }); store.current.set("system", { summary: "old system", evidence: [{ entityId: "system" }] });
  const result = await runOperatorEnrichment({ draftRevisionId: "d1", scopes, store, retryScopeId: "area-a", gateway: { modelId: "m", async chatCompletions() { return { json: { choices: [{ message: { content: "not json" } }] }, usage: { totalTokens: 9 } }; } } });
  assert.deepEqual(result.staleScopes, ["system"]); assert.deepEqual(store.stale, ["system"]);
  assert.equal((await store.getAcceptedExplanation("area-a"))?.summary, "old");
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0]?.state, "failed"); assert.equal(result.attempts[0]?.usage?.totalTokens, 9);
});

test("only ancestors with an accepted explanation go stale; a not-run ancestor stays not run", async () => {
  const store = new MemoryStore(); store.current.set("area-a", { summary: "old", evidence: [{ entityId: "area-a" }] });
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes, store, retryScopeId: "leaf", gateway: echo() });
  assert.deepEqual(result.staleScopes, ["area-a"]); assert.deepEqual(store.stale, ["area-a"]);
});

test("run limit keeps finished work, records no attempt rows for skipped scopes, and never runs an incomplete parent", async () => {
  const large = Array.from({ length: 300 }, (_, index) => scope(`n${String(index).padStart(3, "0")}`, "component"));
  const store = new MemoryStore();
  const limited = await runOperatorEnrichment({ draftRevisionId: "d", scopes: large, store, limits: { maxScopes: 2 }, gateway: echo() });
  assert.equal(limited.stopped, "limit"); assert.equal(limited.attempts.length, 2, "budget-skipped scopes have no attempt rows");
  assert.deepEqual([...store.current.keys()].sort(), ["n000", "n001"]);

  const bodies: Record<string, unknown>[] = []; const treeStore = new MemoryStore();
  const tree = await runOperatorEnrichment({ draftRevisionId: "d", scopes, store: treeStore, limits: { maxScopes: 1 }, gateway: { modelId: "openrouter/model", async chatCompletions(body) { bodies.push(body); return reply(prompt(body).scope.scopeId); } } });
  assert.equal(bodies[0]?.model, "openrouter/model"); assert.equal(bodies[0]?.max_tokens, 4096); assert.equal(tree.stopped, "limit");
  assert.deepEqual(tree.attempts.map(attempt => attempt.scopeId), ["area-b"]);
  assert.equal(treeStore.attempts.size, 1, "system is not run while area-a was never run");

  const unavailableStore = new MemoryStore();
  const unavailable = await runOperatorEnrichment({ draftRevisionId: "d", scopes, store: unavailableStore, retryScopeId: "leaf" });
  assert.equal(unavailable.stopped, "unavailable"); assert.equal(unavailable.attempts.length, 0, "no gateway: scopes stay not run, no failed rows");
  assert.equal(unavailableStore.attempts.size, 0); assert.deepEqual(unavailableStore.stale, []);
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scopes[0]!], store: new MemoryStore(), gateway: { modelId: "m", async chatCompletions() { return reply("unknown"); } } });
  assert.equal(result.attempts[0]?.state, "failed");
});

test("admission refusal happens before the attempt row: refused scopes stay not run and in-flight work is stored", async () => {
  const leaves = Array.from({ length: 6 }, (_, index) => scope(`k${index}`, "component"));
  const store = new MemoryStore(); let admitted = 0; const settled: Array<number | undefined> = [];
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: leaves, store, limits: { maxConcurrent: 3 }, admitRequest: ({ scopeId, body }) => {
    assert.ok(![...store.attempts.values()].some(attempt => attempt.scopeId === scopeId), `no attempt row exists before ${scopeId} is admitted`); assert.equal(typeof body.max_tokens, "number");
    if (admitted >= 4) return false; admitted += 1; return { settle: usage => { settled.push(usage?.totalTokens); } };
  }, gateway: echo() });
  assert.equal(result.stopped, "limit");
  assert.equal(store.attempts.size, 4); assert.equal(store.current.size, 4);
  assert.deepEqual(settled, [3, 3, 3, 3], "each ticket settles once with reported usage");
  assert.ok([...store.attempts.values()].every(attempt => attempt.state === "accepted"));
});

test("a thrown scope halts dispatch, drains in-flight work, settles every ticket, then rejects", async () => {
  const leaves = Array.from({ length: 8 }, (_, index) => scope(`k${index}`, "component"));
  class Failing extends MemoryStore { override async createAttempt(attempt: OperatorEnrichmentAttempt): Promise<void> { if (attempt.scopeId === "k1") throw new Error("disk full"); await super.createAttempt(attempt); } }
  let reserved = 0; let settled = 0; const calls: string[] = [];
  await assert.rejects(runOperatorEnrichment({ draftRevisionId: "d", scopes: leaves, store: new Failing(), limits: { maxConcurrent: 2 }, admitRequest: () => { reserved += 1; return { settle() { settled += 1; } }; }, gateway: { modelId: "m", async chatCompletions(body) { const id = prompt(body).scope.scopeId; calls.push(id); await new Promise(resolve => setTimeout(resolve, 5)); return reply(id); } } }), /disk full/);
  const atReject = { reserved, settled, calls: calls.length };
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual({ reserved, settled, calls: calls.length }, atReject, "no provider calls or reservations after the run rejects");
  assert.equal(settled, reserved, "every admission ticket is settled, including the one whose row failed");
  assert.ok(!calls.includes("k1") && calls.length <= 2);
});

test("admission exceptions propagate instead of masquerading as a limit stop", async () => {
  await assert.rejects(runOperatorEnrichment({ draftRevisionId: "d", scopes: [scope("a", "component")], store: new MemoryStore(), admitRequest: () => { throw new Error("ledger unreadable"); }, gateway: echo() }), /ledger unreadable/);
});

test("ready parents dispatch before ready leaves, then by scopeId", async () => {
  const tree = [scope("c1", "container"), scope("a1", "component", "c1"), scope("z1", "component"), scope("z2", "component"), scope("z3", "component")];
  const starts: string[] = [];
  await runOperatorEnrichment({ draftRevisionId: "d", scopes: tree, store: new MemoryStore(), limits: { maxConcurrent: 1 }, gateway: { modelId: "m", async chatCompletions(body) { starts.push(prompt(body).scope.scopeId); return reply(prompt(body).scope.scopeId); } } });
  assert.deepEqual(starts, ["a1", "c1", "z1", "z2", "z3"], "c1 jumps ahead of queued leaves once a1 settles");
});

test("v2 prompt carries the explicit output schema and a parent synthesis instruction", async () => {
  const bodies: Record<string, unknown>[] = [];
  await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scope("c", "container"), scope("k", "component", "c")], store: new MemoryStore(), gateway: { modelId: "m", async chatCompletions(body) { bodies.push(body); return reply(prompt(body).scope.scopeId); } } });
  const system = (body: Record<string, unknown>) => String((body.messages as Array<{ content: string }>)[0]!.content);
  assert.ok(system(bodies[0]!).startsWith(OPERATOR_OUTPUT_SCHEMA_PROMPT)); assert.match(system(bodies[0]!), /"interactions": string\[\] \(optional; each a short plain-text sentence, not an object\)/);
  assert.doesNotMatch(system(bodies[0]!), /synthesise/); assert.match(system(bodies[1]!), /synthesise how the children fit together/);
  assert.equal((JSON.parse(String((bodies[0]!.messages as Array<{ content: string }>)[1]!.content)) as { promptVersion: string }).promptVersion, "operator-enrichment/v2");
});

const codeScope = (scopeId: string, startLine: number, exported = false, lines = 6): OperatorEnrichmentScope => ({ scopeId, parentScopeId: "comp", name: scopeId, kind: "code", facts: { exposure: exported ? [{ kind: "moduleExport", evidence: {} }] : undefined, sourceExcerpts: [{ sourceStartLine: startLine, sourceEndLine: startLine + lines - 1, startLine, endLine: startLine + lines - 1, text: Array.from({ length: lines }, (_, index) => `line ${startLine + index} of ${scopeId}`).join("\n") }] }, allowedEvidence: [{ entityId: scopeId, path: "src/comp.ts", startLine, endLine: startLine + lines - 1 }] });

test("symbol digest is sorted by source line, bounded, and deterministic", () => {
  const symbols = [codeScope("zeta", 30, true), codeScope("alpha", 10), codeScope("mid", 20, true)];
  const digest = symbolDigest(symbols);
  assert.deepEqual(digest.symbols.map(symbol => symbol.name), ["alpha", "mid", "zeta"]);
  assert.deepEqual(digest.symbols[1], { name: "mid", exported: true, lines: "20-25", head: "line 20 of mid\nline 21 of mid\nline 22 of mid\nline 23 of mid" });
  assert.equal(digest.symbols[0]!.exported, false); assert.equal(digest.symbolCount, 3);
  assert.deepEqual(symbolDigest([...symbols].reverse()), digest, "input order does not change the digest");
  const many = Array.from({ length: 400 }, (_, index) => codeScope(`fn${String(index).padStart(3, "0")}`, index * 10 + 1));
  const bounded = symbolDigest(many);
  assert.equal(bounded.symbolCount, 400); assert.ok(bounded.symbols.length > 0 && bounded.symbols.length < 400);
  assert.ok(JSON.stringify(bounded.symbols).length <= SYMBOL_DIGEST_BUDGET);
  assert.equal(bounded.evidence.length, bounded.symbols.length);
});

test("a component prompt carries its code-symbol digest and accepts digest refs as evidence only", async () => {
  const component: OperatorEnrichmentScope = { scopeId: "comp", name: "comp", kind: "component", facts: { technology: ["ts"] }, allowedEvidence: [{ entityId: "comp", path: "src/comp.ts" }] };
  const many = Array.from({ length: 200 }, (_, index) => codeScope(`fn${String(index).padStart(3, "0")}`, index * 10 + 1));
  const run = async (evidence: unknown[]) => {
    const store = new MemoryStore(); let seen: { scope: { facts: { symbols: unknown[]; symbolCount: number }; allowedEvidence: unknown[] } } | undefined;
    const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [component, ...many], store, gateway: { modelId: "m", async chatCompletions(body) { seen = JSON.parse(String((body.messages as Array<{ content: string }>)[1]!.content)); return { json: { choices: [{ message: { content: JSON.stringify({ summary: "digest", evidence }) } }] } }; } } });
    return { result, seen: seen! };
  };
  const inside = { entityId: "fn000", path: "src/comp.ts", startLine: 1, endLine: 6 };
  const accepted = await run([inside]);
  assert.equal(accepted.result.attempts.length, 1); assert.equal(accepted.result.attempts[0]?.state, "accepted");
  assert.equal(accepted.seen.scope.facts.symbolCount, 200); assert.ok(accepted.seen.scope.facts.symbols.length < 200);
  assert.deepEqual(accepted.seen.scope.allowedEvidence.slice(0, 2), [{ entityId: "comp", path: "src/comp.ts" }, inside]);
  const outside = await run([{ entityId: "fn199", path: "src/comp.ts", startLine: 1991, endLine: 1996 }]);
  assert.equal(outside.result.attempts[0]?.state, "failed"); assert.match(outside.result.attempts[0]?.error ?? "", /unknown evidence reference/);
  const optedIn = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [component, codeScope("fn", 1)], store: new MemoryStore(), maxKind: "code", gateway: { modelId: "m", async chatCompletions(body) { const message = JSON.parse(String((body.messages as Array<{ content: string }>)[1]!.content)) as { scope: { scopeId: string; facts: Record<string, unknown> } }; if (message.scope.scopeId === "comp") assert.equal(message.scope.facts.symbols, undefined, "no digest when code children are in cap"); return reply(message.scope.scopeId); } } });
  assert.equal(optedIn.attempts.length, 2);
});

test("run-level concurrency cap holds at 3 and at the default 64", async () => {
  for (const [cap, count] of [[3, 10], [undefined, 80]] as const) {
    let active = 0; let peak = 0;
    const leaves = Array.from({ length: count }, (_, index) => scope(`k${String(index).padStart(2, "0")}`, "component"));
    await runOperatorEnrichment({ draftRevisionId: "d", scopes: leaves, store: new MemoryStore(), ...(cap ? { limits: { maxConcurrent: cap } } : {}), gateway: { modelId: "m", async chatCompletions(body) {
      active += 1; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active -= 1; return reply(prompt(body).scope.scopeId);
    } } });
    assert.equal(peak, cap ?? 64);
  }
});

test("depth cap: code scopes are not attempted by default and are when opted in", async () => {
  const tree = [scope("comp", "component"), scope("fn-a", "code", "comp"), scope("fn-b", "code", "comp")];
  const seen: Prompt[] = [];
  const gateway: OperatorEnrichmentGateway = { modelId: "m", async chatCompletions(body) { seen.push(prompt(body)); return reply(prompt(body).scope.scopeId); } };
  const byDefault = await runOperatorEnrichment({ draftRevisionId: "d", scopes: tree, store: new MemoryStore(), gateway });
  assert.deepEqual(byDefault.attempts.map(attempt => attempt.scopeId), ["comp"]);
  assert.deepEqual(seen[0]?.children, [], "below-cap children are not listed as not-run noise");
  seen.length = 0;
  const optedIn = await runOperatorEnrichment({ draftRevisionId: "d", scopes: tree, store: new MemoryStore(), gateway, maxKind: "code" });
  assert.deepEqual(optedIn.attempts.map(attempt => attempt.scopeId), ["fn-a", "fn-b", "comp"]);
  assert.deepEqual(seen.at(-1)?.children.map(child => child.state), ["accepted", "accepted"]);
  const huge = Array.from({ length: 4_048 }, (_, index) => scope(`code-${index}`, "code", index ? "code-0" : undefined));
  huge[0] = scope("code-0", "component");
  const bounded = await runOperatorEnrichment({ draftRevisionId: "d", scopes: huge, store: new MemoryStore(), gateway: echo() });
  assert.equal(bounded.attempts.length, 1, "a 4,048-scope input neither throws nor explains code symbols by default");
  await assert.rejects(runOperatorEnrichment({ draftRevisionId: "d", scopes: Array.from({ length: 8 }, (_, index) => scope(`s${index}`, "component", index ? `s${index - 1}` : undefined)), store: new MemoryStore(), gateway: echo() }), /depth limit/);
});

test("rate-limit retries below admission do not consume budget", async () => {
  let calls = 0; let admissions = 0; let clock = 0; const sleeps: number[] = [];
  const limiter = new LlmRateLimiter({ maxConcurrent: 4, retries: 3, backoffMs: 50, sleep: async ms => { sleeps.push(ms); clock += ms; }, now: () => clock });
  const raw: OperatorEnrichmentGateway = { modelId: "m", async chatCompletions(body) { calls += 1; if (calls <= 2) throw new LlmGatewayError("llm gateway 429: slow down", { kind: "rate_limit", status: 429 }); return reply(prompt(body).scope.scopeId); } };
  const store = new MemoryStore();
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scope("only", "component")], store, gateway: rateLimitedGateway(raw, limiter), admitRequest: () => { admissions += 1; return true; } });
  assert.equal(result.attempts[0]?.state, "accepted"); assert.equal(calls, 3); assert.equal(admissions, 1); assert.equal(store.attempts.size, 1); assert.deepEqual(sleeps, [50, 100]);
});

test("attempt IDs are UUIDs by default and invalid structured diagrams preserve prose", async () => {
  const store = new MemoryStore(); const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scopes[0]!], store, gateway: { modelId: "m", async chatCompletions() { return { json: { choices: [{ message: { content: JSON.stringify({ summary: "useful", evidence: [{ entityId: "system" }], diagram: { nodes: ["invented"], edges: [] } }) } }] } }; } } });
  assert.match(result.attempts[0]!.attemptId, /^[0-9a-f-]{36}$/); assert.equal((await store.getAcceptedExplanation("system"))?.summary, "useful"); assert.match((await store.getAcceptedExplanation("system"))?.diagramError ?? "", /rejected diagram/);
});

test("parent prompts carry child prose only: evidence and diagrams stay out of the upward reduction", () => {
  const explanation: OperatorExplanation = { summary: "does x", roleWithinParent: "r", interactions: ["calls y"], evidence: [{ entityId: "k", path: "k.ts", startLine: 1, endLine: 9 }], diagram: { nodes: ["k"], edges: [] } };
  assert.deepEqual(childPromptInput({ scopeId: "k", state: "accepted", explanation }), { scopeId: "k", state: "accepted", summary: "does x", roleWithinParent: "r", interactions: ["calls y"] });
  assert.deepEqual(childPromptInput({ scopeId: "k", state: "failed" }), { scopeId: "k", state: "failed" });
  assert.deepEqual(childPromptInput({ scopeId: "k", state: "accepted", explanation: { summary: "s", evidence: [], interactions: [] } }), { scopeId: "k", state: "accepted", summary: "s" });
});

test("MiMo's live output shapes validate: relation-object interactions become text, null optionals are absent, evidence keeps canonical fields", () => {
  const allowed = [{ entityId: "component:a", path: "a.ts" }];
  // Verbatim shapes captured from xiaomi/mimo-v2.6-pro replies in the CLA-254 live probe.
  const reply = { summary: " a.ts does x. ", roleWithinParent: null, diagram: null,
    interactions: [{ from: "component:a", to: "component:b", kind: "dependsOn" }, { relationId: "relation:a:c", direction: "outgoing", kind: "dependsOn", peerId: "component:c", peerName: "src/c.ts", note: "reads config" }, "  plain sentence  ", {}],
    evidence: [{ entityId: "component:a", path: "a.ts", note: "allowed path", quote: "x", confidence: "declared" }] };
  assert.deepEqual(validateOperatorExplanation(reply, allowed), { summary: "a.ts does x.", evidence: [{ entityId: "component:a", path: "a.ts" }], interactions: ["component:a dependsOn component:b", "dependsOn src/c.ts: reads config", "plain sentence"] });
  assert.equal(normalizeInteractions(null), undefined); assert.equal(normalizeInteractions([{}, " "]), undefined);
});

test("tolerance stays narrow: wrong-typed optionals and missing or invented evidence still reject", () => {
  const allowed = [{ entityId: "component:a", path: "a.ts" }]; const base = { summary: "s", evidence: [{ entityId: "component:a", path: "a.ts" }] };
  assert.throws(() => validateOperatorExplanation({ ...base, interactions: "calls b" }, allowed), /interactions/);
  assert.throws(() => validateOperatorExplanation({ ...base, interactions: [3] }, allowed), /interactions/);
  assert.throws(() => validateOperatorExplanation({ ...base, roleWithinParent: 7 }, allowed), /roleWithinParent/);
  assert.throws(() => validateOperatorExplanation({ summary: "s" }, allowed), /evidence is required/);
  assert.throws(() => validateOperatorExplanation({ ...base, evidence: [{ entityId: "component:zzz", path: "z.ts" }] }, allowed), /unknown evidence reference/);
});

test("one oversized symbol cannot empty the digest: lines are capped and an entry over budget is skipped", () => {
  const minified: OperatorEnrichmentScope = { ...codeScope("min", 1), facts: { sourceExcerpts: [{ sourceStartLine: 1, sourceEndLine: 1, text: "x".repeat(7000) }] } };
  const small = Array.from({ length: 20 }, (_, index) => codeScope(`fn${String(index).padStart(2, "0")}`, 10 + index * 10));
  const digest = symbolDigest([minified, ...small]);
  assert.equal(digest.symbols.length, 21); assert.equal(digest.symbols[0]!.head!.length, DIGEST_LINE_CHARS + 1);
  const giant: OperatorEnrichmentScope = { ...codeScope("giant", 1), name: "g".repeat(SYMBOL_DIGEST_BUDGET) };
  const skipped = symbolDigest([giant, ...small]);
  assert.deepEqual(skipped.symbols.map(symbol => symbol.name), small.map(symbol => symbol.name)); assert.equal(skipped.symbolCount, 21);
  assert.ok(!skipped.evidence.some(ref => ref.entityId === "giant"), "a skipped symbol contributes no allowed evidence");
});

const timeout = () => new LlmGatewayError("llm gateway timeout after 5ms", { kind: "timeout" });
const emptyContent = { json: { choices: [{ message: { content: "" } }] }, usage: { totalTokens: 2, promptTokens: 2, completionTokens: 0 } };
function ticketCounter() { const state = { admitted: 0, settled: 0, settledUsage: [] as Array<number | undefined> }; return { state, admitRequest: () => { state.admitted += 1; return { settle: (usage?: { totalTokens: number }) => { state.settled += 1; state.settledUsage.push(usage?.totalTokens); } }; } }; }

test("retry-once: a timeout then success is accepted in one attempt with two admissions and two settles", async () => {
  const counter = ticketCounter(); let calls = 0; const store = new MemoryStore();
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scope("a", "component")], store, admitRequest: counter.admitRequest, gateway: { modelId: "m", async chatCompletions(body) { calls += 1; if (calls === 1) throw timeout(); return reply(prompt(body).scope.scopeId); } } });
  assert.equal(calls, 2); assert.equal(result.attempts.length, 1); assert.equal(result.attempts[0]?.state, "accepted"); assert.equal(store.attempts.size, 1);
  assert.deepEqual(counter.state, { admitted: 2, settled: 2, settledUsage: [undefined, 3] });
});

test("retry-once: empty content then success is accepted and usage is the sum of both calls", async () => {
  const counter = ticketCounter(); let calls = 0;
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scope("a", "component")], store: new MemoryStore(), admitRequest: counter.admitRequest, gateway: { modelId: "m", async chatCompletions(body) { calls += 1; return calls === 1 ? emptyContent : reply(prompt(body).scope.scopeId); } } });
  assert.equal(calls, 2); assert.equal(result.attempts[0]?.state, "accepted");
  assert.deepEqual(result.attempts[0]?.usage, { totalTokens: 5, promptTokens: 2, completionTokens: 0, costUsd: 0.01 });
  assert.deepEqual(counter.state, { admitted: 2, settled: 2, settledUsage: [2, 3] });
});

test("retry-once: two timeouts fail after exactly two requests", async () => {
  const counter = ticketCounter(); let calls = 0;
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scope("a", "component")], store: new MemoryStore(), admitRequest: counter.admitRequest, gateway: { modelId: "m", async chatCompletions() { calls += 1; throw timeout(); } } });
  assert.equal(calls, 2); assert.equal(result.attempts.length, 1); assert.equal(result.attempts[0]?.state, "failed"); assert.match(result.attempts[0]?.error ?? "", /timeout/);
  assert.equal(result.stopped, "complete"); assert.deepEqual([counter.state.admitted, counter.state.settled], [2, 2]);
});

test("retry-once never retries validation rejects, other HTTP errors, or 429s", async () => {
  for (const failure of [async () => ({ json: { choices: [{ message: { content: JSON.stringify({ summary: "x", evidence: [{ entityId: "invented" }] }) } }] } }), async () => { throw new LlmGatewayError("llm gateway 500: down", { kind: "server", status: 500 }); }, async () => { throw new LlmGatewayError("llm gateway 429: busy", { kind: "rate_limit", status: 429 }); }]) {
    let calls = 0; const counter = ticketCounter();
    const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scope("a", "component")], store: new MemoryStore(), admitRequest: counter.admitRequest, gateway: { modelId: "m", async chatCompletions() { calls += 1; return failure(); } } });
    assert.equal(calls, 1); assert.equal(result.attempts[0]?.state, "failed"); assert.deepEqual([counter.state.admitted, counter.state.settled], [1, 1]);
  }
});

test("retry-once: a refused retry fails the attempt with the original error and halts as a limit stop", async () => {
  let admitted = 0; let settled = 0; let calls = 0; const store = new MemoryStore();
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scope("a", "component"), scope("b", "component")], store, limits: { maxConcurrent: 1 }, admitRequest: () => { if (admitted >= 1) return false; admitted += 1; return { settle() { settled += 1; } }; }, gateway: { modelId: "m", async chatCompletions() { calls += 1; throw timeout(); } } });
  assert.equal(calls, 1); assert.equal(result.stopped, "limit"); assert.equal(settled, admitted);
  assert.deepEqual(result.attempts.map(attempt => [attempt.scopeId, attempt.state]), [["a", "failed"]]); assert.match(result.attempts[0]?.error ?? "", /timeout/);
});

test("retry-once: the run-level request cap counts the retry", async () => {
  let calls = 0;
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scope("a", "component"), scope("b", "component")], store: new MemoryStore(), limits: { maxConcurrent: 1, maxScopes: 2 }, gateway: { modelId: "m", async chatCompletions(body) { calls += 1; if (calls === 1) throw timeout(); return reply(prompt(body).scope.scopeId); } } });
  assert.equal(calls, 2); assert.equal(result.stopped, "limit");
  assert.deepEqual(result.attempts.map(attempt => [attempt.scopeId, attempt.state]), [["a", "accepted"]], "b is not run: a's retry used the second request");
});

test("leaf reasoning: off adds reasoning.enabled=false to leaf bodies only (a digest component is a leaf) and changes the input hash", async () => {
  const tree = [scope("c", "container"), scope("k", "component", "c"), { ...scope("fn", "code", "k"), allowedEvidence: [{ entityId: "fn", path: "fn.ts", startLine: 1, endLine: 2 }] }];
  const run = async (leafReasoning?: "provider-default" | "off") => {
    const bodies = new Map<string, Record<string, unknown>>();
    const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: tree, store: new MemoryStore(), ...(leafReasoning ? { leafReasoning } : {}), gateway: { modelId: "m", async chatCompletions(body) { bodies.set(prompt(body).scope.scopeId, body); return reply(prompt(body).scope.scopeId); } } });
    return { bodies, hashes: new Map(result.attempts.map(attempt => [attempt.scopeId, attempt.inputHash])) };
  };
  const off = await run("off"); const byDefault = await run(); const explicit = await run("provider-default");
  assert.deepEqual(off.bodies.get("k")?.reasoning, { enabled: false }, "component with a symbol digest is still a leaf");
  assert.equal("reasoning" in off.bodies.get("c")!, false, "parents never get the field");
  for (const bodies of [byDefault.bodies, explicit.bodies]) for (const body of bodies.values()) assert.equal("reasoning" in body, false);
  assert.notEqual(off.hashes.get("k"), byDefault.hashes.get("k")); assert.equal(explicit.hashes.get("k"), byDefault.hashes.get("k"));
});
