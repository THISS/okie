import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ArchitectureSnapshot } from "@okie/architecture";
import { choice } from "@typesafe-ai/sdk";
import { checkClaimEvidence, droppedMappings, CLAIM_CHECK_CONFIDENCE_THRESHOLD, CLAIM_CHECK_FILE, CLAIM_CHECK_LABEL, claimBatchState, deriveClaimState, isClaimCheckAttempt, packClaimBatches, readClaimCheckView, runClaimChecks, storedClaims, type ClaimCheckDocument, type ClaimExcerpt, type PendingClaim } from "./claimChecks.js";
import { childPromptInput, explanationRowForJudgment, isSummarySentenceSpan, OPERATOR_OUTPUT_SCHEMA_PROMPT, operatorClaimId, validateOperatorExplanation, type OperatorEvidenceRef } from "./operatorEnrichment.js";
import { createOperatorRunner } from "./operatorRunner.js";
import { createOperatorBudgetLedger } from "./operatorBudget.js";
import { createJevProvider, evaluateJudgmentBatch, type JudgmentProvider } from "./operatorJudgments.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore } from "./operatorStore.js";
import { handleOperatorApi, parseClaimCheckSelection } from "./operatorApi.js";
import { avgCost, OperatorWorkflow, progressOf, readArtifactScopes, runBudget } from "./operatorWorkflow.js";
import { resolveClaimCheckConfig } from "./llmGateway.js";
import type { GithubAuthService, GithubSession } from "./githubOAuth.js";

const COMMIT = "c".repeat(40);
const lines = (start: number, count: number, prefix = "line") => Array.from({ length: count }, (_, index) => `${prefix} ${start + index}`);
function excerpt(path: string, start: number, captured: string[], sourceEnd?: number) {
  return { path, language: "typescript" as const, startLine: start, endLine: start + captured.length - 1, sourceStartLine: start, sourceEndLine: sourceEnd ?? start + captured.length - 1, highlightLine: start, frozenRevision: COMMIT, lines: captured, text: captured.join("\n") };
}
/** A system → component → code tree: one complete capture, one truncated capture, one uncaptured symbol. */
function snapshot(): ArchitectureSnapshot {
  return { entities: [
    { id: "system:s", name: "S", kind: "softwareSystem", sourceRefs: [] },
    { id: "component:c", name: "C", kind: "component", parentId: "system:s", sourceRefs: [{ path: "src/a.ts", commitSha: COMMIT }] },
    { id: "code:a", name: "a", kind: "code", parentId: "component:c", sourceRefs: [{ path: "src/a.ts", startLine: 10, endLine: 14, commitSha: COMMIT }], sourceExcerpts: [excerpt("src/a.ts", 10, ["export function save(row) {", "  if (!row.id) throw new Error(\"id required\");", "  writeFileSync(path, JSON.stringify(row));", "  return row;", "}"])] },
    { id: "code:big", name: "big", kind: "code", parentId: "component:c", sourceRefs: [{ path: "src/a.ts", startLine: 20, endLine: 100, commitSha: COMMIT }], sourceExcerpts: [excerpt("src/a.ts", 20, lines(20, 48), 100)] },
    { id: "code:none", name: "none", kind: "code", parentId: "component:c", sourceRefs: [{ path: "src/b.ts", startLine: 1, endLine: 5, commitSha: COMMIT }] },
  ], relations: [] } as unknown as ArchitectureSnapshot;
}
const ALLOWED: OperatorEvidenceRef[] = [
  { entityId: "component:c", path: "src/a.ts" },
  { entityId: "code:a", path: "src/a.ts", startLine: 10, endLine: 14 },
  { entityId: "code:big", path: "src/a.ts", startLine: 20, endLine: 100 },
  { entityId: "code:none", path: "src/b.ts", startLine: 1, endLine: 5 },
];
const SUMMARY = "**Storage** keeps rows on disk. It rejects rows without an id.";
function reply(extra: Record<string, unknown> = {}) {
  // The taught form: claim evidence is ref objects copied from allowedEvidence.
  return { summary: SUMMARY, keyPoints: [{ text: "Start at `save()`; it writes each row as JSON.", evidence: [ALLOWED[1]] }, "The big helper is long.", { text: "Rows without an id are rejected.", evidence: [ALLOWED[1]] }], evidence: ALLOWED.slice(0, 4), summaryClaims: [{ text: "It rejects rows without an id.", evidence: [ALLOWED[1]] }], ...extra };
}

test("claim mapping: keyPoint objects and verbatim summary spans map to canonical evidence; prose is unchanged", () => {
  const explanation = validateOperatorExplanation(reply(), ALLOWED);
  assert.deepEqual(explanation.keyPoints, ["Start at `save()`; it writes each row as JSON.", "The big helper is long.", "Rows without an id are rejected."], "keyPoints are stored as plain strings");
  assert.equal(explanation.summary, SUMMARY);
  assert.equal(explanation.claims?.length, 3);
  const [summary, first, third] = explanation.claims!;
  assert.deepEqual(summary, { id: operatorClaimId("summary", "It rejects rows without an id.", [ALLOWED[1]!]), text: "It rejects rows without an id.", origin: "summary", index: 0, evidence: [ALLOWED[1]] });
  assert.equal(first!.origin, "keyPoint"); assert.equal(first!.index, 0); assert.equal(first!.text, explanation.keyPoints[0]);
  assert.equal(third!.index, 2, "a keyPoint claim indexes the stored keyPoints");
  assert.equal(explanation.claimsNote, undefined);
  assert.deepEqual(storedClaims(explanation).claims, explanation.claims, "stored claims re-validate against the stored prose");
});

test("claim mapping is lenient: invalid mappings drop with a note and never reject or alter the explanation", () => {
  const bad = validateOperatorExplanation(reply({ summaryClaims: [{ text: "It never touches disk.", evidence: [1] }, { text: "It rejects rows without an id.", evidence: [9] }, { text: "**Storage** keeps rows on disk.", evidence: [0, 1, 2, 3] }], keyPoints: [{ text: "Start at `save()`.", evidence: [] }, "Plain point."] }), ALLOWED);
  assert.equal(bad.claims, undefined);
  assert.match(bad.claimsNote ?? "", /not whole verbatim sentence\(s\) of the summary/);
  assert.match(bad.claimsNote ?? "", /evidence index out of range/);
  assert.match(bad.claimsNote ?? "", /more than 3 evidence refs/);
  assert.deepEqual(bad.keyPoints, ["Start at `save()`.", "Plain point."]);
  const many = validateOperatorExplanation(reply({ summaryClaims: Array.from({ length: 12 }, () => ({ text: "It rejects rows without an id.", evidence: [1] })).map((row, index) => ({ ...row, evidence: [index % 2 ? 1 : 0] })) }), ALLOWED);
  assert.ok((many.claims?.length ?? 0) <= 8, "claims are capped");
  const legacy = validateOperatorExplanation({ summary: SUMMARY, keyPoints: ["a", "b"], evidence: [ALLOWED[1]] }, ALLOWED);
  assert.equal(legacy.claims, undefined, "plain strings carry no claim mapping");
  assert.equal(storedClaims(legacy).mapping, "none");
  assert.equal(storedClaims({ summary: "legacy v2", evidence: [] }).mapping, "none");
  // Parents never receive child claims; judgment rows leave them out so legacy hashes are unchanged.
  const explanation = validateOperatorExplanation(reply(), ALLOWED);
  assert.deepEqual(Object.keys(childPromptInput({ scopeId: "k", state: "accepted", explanation })!).sort(), ["keyPoints", "scopeId", "summary"]);
  assert.equal((explanationRowForJudgment({ scopeId: "k", content: explanation }) as { content: Record<string, unknown> }).content.claims, undefined);
  // A tampered stored claim (text no longer the keyPoint) is not evaluated.
  assert.equal(storedClaims({ ...explanation, claims: explanation.claims!.map(claim => ({ ...claim, text: `${claim.text}!` })) }).claims.length, 0);
});

test("claim evidence: ref objects copied from allowedEvidence resolve canonically and must be in the reply's evidence; 0-based indices still work", () => {
  const decorated = { entityId: "code:a", path: "src/a.ts", startLine: 10, endLine: 14, note: "the save path" };
  const folded = { entityId: "code:big", path: "src/a.ts", startLine: null, endLine: null };
  const explanation = validateOperatorExplanation(reply({ keyPoints: [{ text: "Start at `save()`; it writes each row as JSON.", evidence: [decorated, 0] }, { text: "The big helper is long.", evidence: [folded] }], summaryClaims: [{ text: "It rejects rows without an id.", evidence: [1] }] }), ALLOWED);
  assert.equal(explanation.claimsNote, undefined);
  const [summary, first, second] = explanation.claims!;
  assert.deepEqual(summary!.evidence, [ALLOWED[1]], "a 0-based index into the reply's evidence (compatibility)");
  assert.deepEqual(first!.evidence, [ALLOWED[1], ALLOWED[0]], "decorations are dropped and the stored ref is the allowed copy");
  assert.deepEqual(second!.evidence, [ALLOWED[2]], "null lines are absent; the entity resolves to its one allowed ref");
  assert.deepEqual(storedClaims(explanation).claims, explanation.claims);
  // A ref allowed but not cited in the reply's evidence, and a ref that is not allowed at all, are dropped with a note.
  const narrow = validateOperatorExplanation(reply({ evidence: [ALLOWED[1]], keyPoints: [{ text: "Start at `save()`.", evidence: [ALLOWED[2]] }, { text: "Made up.", evidence: [{ entityId: "code:ghost", path: "ghost.ts" }] }, { text: "Numbers as strings.", evidence: ["0"] }], summaryClaims: [] }), ALLOWED);
  assert.equal(narrow.claims, undefined);
  assert.match(narrow.claimsNote ?? "", /keyPoints\[0\]: evidence ref is not in the reply's evidence/);
  assert.match(narrow.claimsNote ?? "", /keyPoints\[1\]: evidence ref is not in allowedEvidence/);
  assert.match(narrow.claimsNote ?? "", /keyPoints\[2\]: evidence entries must be refs from allowedEvidence/);
  assert.match(OPERATOR_OUTPUT_SCHEMA_PROMPT, /"evidence": EvidenceRef\[\]/); assert.match(OPERATOR_OUTPUT_SCHEMA_PROMPT, /never numbers/); assert.match(OPERATOR_OUTPUT_SCHEMA_PROMPT, /Claim mapping example/);
});

test("summary claims are whole sentences: a negation-dropping fragment and a bare pronoun are rejected on write and on read", () => {
  const summary = "The store never writes rows to disk. It keeps rows in memory! Ids are checked";
  assert.equal(isSummarySentenceSpan(summary, "The store never writes rows to disk."), true);
  assert.equal(isSummarySentenceSpan(summary, "It keeps rows in memory!"), true, "a sentence after [.!?] + space");
  assert.equal(isSummarySentenceSpan(summary, "The store never writes rows to disk. It keeps rows in memory!"), true, "several whole sentences");
  assert.equal(isSummarySentenceSpan(summary, "Ids are checked"), true, "runs to the end of the summary");
  assert.equal(isSummarySentenceSpan(summary, "writes rows to disk."), false, "the fragment would drop the negation");
  assert.equal(isSummarySentenceSpan(summary, "The store never writes rows"), false, "must end at a sentence end");
  assert.equal(isSummarySentenceSpan(summary, "It"), false, "too short to assert anything");
  assert.equal(isSummarySentenceSpan("Uses v1.2 now. Done here ok.", "Uses v1."), false, "a period inside a token is not a sentence end");
  const negation = "The store never writes rows to disk. It rejects rows without an id.";
  const written = validateOperatorExplanation(reply({ summary: negation, summaryClaims: [{ text: "writes rows to disk.", evidence: [1] }, { text: "It", evidence: [1] }, { text: "It rejects rows without an id.", evidence: [1] }] }), ALLOWED);
  assert.deepEqual(written.claims?.filter(claim => claim.origin === "summary").map(claim => claim.text), ["It rejects rows without an id."]);
  assert.equal((written.claimsNote?.match(/not whole verbatim sentence/g) ?? []).length, 2);
  // Stored content tampered with a fragment claim (valid id) is not evaluated on read.
  const fragment = { id: operatorClaimId("summary", "writes rows to disk.", [ALLOWED[1]!]), text: "writes rows to disk.", origin: "summary" as const, index: 0, evidence: [ALLOWED[1]!] };
  const stored = storedClaims({ ...written, claims: [fragment] });
  assert.equal(stored.mapping, "none"); assert.equal(stored.invalid, 1);
});

test("code checks: each failure kind and gap is decided by code before any model", () => {
  const snap = snapshot();
  const kind = (ref: OperatorEvidenceRef, commit: string | null = COMMIT, s = snap) => { const result = checkClaimEvidence(s, commit, { evidence: [ref] }); return result.kind === "ok" ? "ok" : result.reason; };
  assert.equal(kind({ entityId: "code:a", path: "src/a.ts", startLine: 10, endLine: 14 }), "ok");
  assert.equal(kind({ entityId: "code:a", path: "src/a.ts", startLine: 11, endLine: 12 }), "ok", "a sub-range of a captured excerpt is covered");
  assert.equal(kind({ entityId: "code:gone", path: "src/a.ts" }), "unknown-entity");
  assert.equal(kind({ entityId: "code:a", path: "src/other.ts" }), "unknown-ref");
  assert.equal(kind({ entityId: "code:a", path: "src/a.ts", startLine: 9, endLine: 14 }), "out-of-bounds");
  assert.equal(kind({ entityId: "code:a", path: "src/a.ts", startLine: 10, endLine: 14 }, "d".repeat(40)), "identity-mismatch");
  assert.equal(kind({ entityId: "code:a", path: "src/a.ts", startLine: 10, endLine: 14 }, null), "identity-mismatch");
  const corrupt = structuredClone(snap) as unknown as { entities: Array<{ id: string; sourceExcerpts?: Array<{ text: string }> }> };
  corrupt.entities.find(entity => entity.id === "code:a")!.sourceExcerpts![0]!.text = "tampered";
  assert.equal(kind({ entityId: "code:a", path: "src/a.ts", startLine: 10, endLine: 14 }, COMMIT, corrupt as unknown as ArchitectureSnapshot), "corrupt-excerpt");
  const stale = structuredClone(snap) as unknown as { entities: Array<{ id: string; sourceExcerpts?: Array<{ frozenRevision: string }> }> };
  stale.entities.find(entity => entity.id === "code:a")!.sourceExcerpts![0]!.frozenRevision = "e".repeat(40);
  assert.equal(kind({ entityId: "code:a", path: "src/a.ts", startLine: 10, endLine: 14 }, COMMIT, stale as unknown as ArchitectureSnapshot), "identity-mismatch", "publication identity: the capture must be from the artifact commit");
  assert.equal(kind({ entityId: "code:big", path: "src/a.ts", startLine: 20, endLine: 100 }), "truncated-capture", "the scanner clamped this capture: insufficient, not false");
  assert.equal(kind({ entityId: "code:big", path: "src/a.ts", startLine: 21, endLine: 30 }), "ok", "cited lines inside the captured window are covered");
  assert.equal(kind({ entityId: "code:none", path: "src/b.ts", startLine: 1, endLine: 5 }), "missing-capture");
  assert.equal(kind({ entityId: "component:c", path: "src/a.ts" }), "missing-capture", "a whole-file citation is never covered by a symbol's partial excerpt");
  // Mixed claim: any failure fails the claim; otherwise any gap makes it insufficient context.
  assert.equal(checkClaimEvidence(snap, COMMIT, { evidence: [{ entityId: "code:a", path: "src/a.ts", startLine: 10, endLine: 14 }, { entityId: "code:gone", path: "x" }] }).kind, "failed-check");
  assert.equal(checkClaimEvidence(snap, COMMIT, { evidence: [{ entityId: "code:a", path: "src/a.ts", startLine: 10, endLine: 14 }, { entityId: "code:none", path: "src/b.ts", startLine: 1, endLine: 5 }] }).kind, "insufficient-context");
  const ok = checkClaimEvidence(snap, COMMIT, { evidence: [{ entityId: "code:a", path: "src/a.ts", startLine: 10, endLine: 14 }, { entityId: "code:a", path: "src/a.ts", startLine: 11, endLine: 11 }] });
  assert.equal(ok.kind === "ok" && ok.excerpts.length, 1, "shared excerpts are deduplicated");
});

test("batching: at most 8 claims and 24 KB per request, shared excerpts deduplicated, oversized evidence never cut", () => {
  const big = (id: number): ClaimExcerpt => ({ id: `x${id}`, path: `f${id}.ts`, startLine: 1, endLine: 1, text: "y".repeat(7000), digest: String(id) });
  const small: ClaimExcerpt = { id: "xs", path: "s.ts", startLine: 1, endLine: 1, text: "const a = 1;", digest: "s" };
  const claims = (count: number, excerpts: ClaimExcerpt[]): PendingClaim[] => Array.from({ length: count }, (_, index) => ({ key: `k${index}`, text: `claim ${index}`, excerpts }));
  const eleven = packClaimBatches(COMMIT, claims(11, [small]));
  assert.deepEqual(eleven.batches.map(batch => batch.claims.length), [8, 3]);
  assert.equal(eleven.batches[0]!.body.state.excerpts.length, 1, "one shared excerpt for eight claims");
  const heavy = packClaimBatches(COMMIT, [0, 1, 2, 3, 4].map(index => ({ key: `h${index}`, text: `heavy ${index}`, excerpts: [big(index)] })));
  assert.ok(heavy.batches.length >= 2 && heavy.batches.every(batch => batch.bytes <= 24_000), "split below the 24 KB body limit");
  assert.ok(heavy.batches.flatMap(batch => batch.body.state.excerpts).every(item => item.text.length === 7000), "excerpts are never truncated");
  const oversized = packClaimBatches(COMMIT, [{ key: "o", text: "too big", excerpts: [big(1), big(2), big(3), big(4)] }]);
  assert.equal(oversized.batches.length, 0); assert.equal(oversized.oversized.length, 1);
  const state = JSON.stringify(claimBatchState(COMMIT, [small]));
  assert.doesNotMatch(state, /summary|keyPoints|explanation|digest/, "state holds only id, path, lines, text and commit");
});

test("verdict derivation keeps uncertainty distinct from the three outcomes", () => {
  assert.equal(deriveClaimState({ choice: "supports", confidence: 0.9 }), "supported");
  assert.equal(CLAIM_CHECK_CONFIDENCE_THRESHOLD, 0.7, "provisional threshold from the CLA-145 live evaluation");
  assert.equal(deriveClaimState({ choice: "contradicts", confidence: 0.7 }), "contradicted");
  assert.equal(deriveClaimState({ choice: "contradicts", confidence: 0.69 }), "uncertain");
  assert.equal(deriveClaimState({ choice: "insufficient", confidence: 0.7 }), "insufficient");
  assert.equal(deriveClaimState({ choice: "supports", confidence: 0.49 }), "uncertain");
  assert.equal(deriveClaimState({ choice: "supports", confidence: 0.7 }, 0.8), "uncertain");
  assert.equal(deriveClaimState({ choice: "supports", confidence: Number.NaN }), "uncertain");
});

// ---- pass-level fixtures ----
const LIMITS = { maxRequests: 10, maxTokens: 10_000_000, maxDollars: 1, maxConcurrent: 1, timeoutMs: 1000 };
type Answer = { choice: string; confidence: number };
function fakeProvider(answer: (claim: string) => Answer | "fail" = () => ({ choice: "supports", confidence: 0.9 }), bodies: Array<{ state: unknown; questions: Record<string, { instructions?: unknown }> }> = []): JudgmentProvider & { calls: number } {
  const provider = { modelId: "jev-1.13.0", calls: 0, async evaluate(request: { state: unknown; questions: Record<string, unknown> }) {
    provider.calls += 1; bodies.push(request as never);
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      const claim = /Claim: (".*")$/.exec(String((question as { instructions: { question: string } }).instructions.question))![1]!;
      const picked = answer(JSON.parse(claim) as string);
      if (picked === "fail") return { failed: true, usage: {} };
      // Reported confidence is a separate axis; the chosen label still carries the peak probability.
      const top = Math.max(picked.confidence, 0.5); const rest = (1 - top) / 2;
      const probabilities = { supports: rest, contradicts: rest, insufficient: rest, [picked.choice]: top };
      answers[id] = { type: "choice", choice: picked.choice, confidence: picked.confidence, probabilities };
    }
    return { json: { model: "jev-1.13.0", answers }, usage: { inputTokens: 100, outputTokens: 10 } };
  } };
  return provider;
}
function setup(t: { after(fn: () => void): void }, options: { snapshot?: ArchitectureSnapshot; explanations?: Record<string, unknown>; stale?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "okie-claim-checks-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new OperatorStore(root); const publication = new OperatorPublicationService(store);
  const run = store.createRun({ idempotencyKey: "claims", source: { repositoryId: "repo:o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
  const component = validateOperatorExplanation(reply(), ALLOWED);
  const system = validateOperatorExplanation({ summary: "The system stores rows.", keyPoints: [{ text: "Saving happens in `save()`.", evidence: [0] }, "Two."], evidence: [{ entityId: "code:a", path: "src/a.ts", startLine: 10, endLine: 14 }] }, [{ entityId: "code:a", path: "src/a.ts", startLine: 10, endLine: 14 }]);
  const explanations = options.explanations ?? { "component:c": component, "system:s": system };
  const sidecar = { schemaVersion: 1, scopes: [
    { scopeId: "system:s", name: "S", kind: "softwareSystem", sourceRefs: [], state: "accepted", ...(options.stale?.includes("system:s") ? { stale: true } : {}) },
    { scopeId: "component:c", parentScopeId: "system:s", name: "C", kind: "component", sourceRefs: [{ path: "src/a.ts" }], state: "accepted", ...(options.stale?.includes("component:c") ? { stale: true } : {}) },
    { scopeId: "code:a", parentScopeId: "component:c", name: "a", kind: "code", sourceRefs: [{ path: "src/a.ts", startLine: 10, endLine: 14 }], state: "below cap" },
  ], explanations: Object.entries(explanations).map(([scopeId, content]) => ({ scopeId, explanationVersionId: `v-${scopeId}`, content })) };
  const artifact = store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: COMMIT, files: { "snapshot.json": JSON.stringify(options.snapshot ?? snapshot()), "operator-explanations.json": JSON.stringify(sidecar) } });
  const draft = publication.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId, coverage: { total: 3, accepted: 2, failed: 0, notRun: 0, stale: 0, belowCap: 1 } });
  store.updateRun(run.runId, { state: "awaiting_review" });
  const current = () => store.snapshot().runs.find(row => row.runId === run.runId)!.draftRevisionId!;
  const view = (id = current()) => { const draftRow = store.snapshot().drafts.find(row => row.draftRevisionId === id)!; return readClaimCheckView(store, store.snapshot().artifacts.find(row => row.artifactRevisionId === draftRow.artifactRevisionId), true); };
  return { store, publication, run, draft, current, view, component, system };
}

test("one pass over N scopes: code failures never reach Jev, the state holds no prose, and ONE revision is installed", async t => {
  const ctx = setup(t);
  const bodies: Array<{ state: unknown; questions: Record<string, { instructions?: unknown }> }> = [];
  const provider = fakeProvider(claim => claim.startsWith("Rows without") ? { choice: "contradicts", confidence: 0.8 } : claim.includes("JSON") ? { choice: "supports", confidence: 0.3 } : { choice: "supports", confidence: 0.95 }, bodies);
  const drafts = ctx.store.snapshot().drafts.length;
  const outcome = await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.draft.draftRevisionId, provider, limits: LIMITS, enabled: true });
  assert.equal(outcome.state, "accepted");
  assert.equal(ctx.store.snapshot().drafts.length, drafts + 1, "one new draft revision for the whole pass");
  assert.equal(provider.calls, 2, "one request per scope with claims");
  for (const body of bodies) {
    const state = JSON.stringify(body.state);
    assert.doesNotMatch(state, /Storage|keeps rows on disk|The system stores rows/, "no explanation prose or summaries in state");
    assert.match(state, /writeFileSync/, "actual captured source is sent");
  }
  const newDraft = ctx.store.snapshot().drafts.at(-1)!;
  assert.deepEqual(newDraft.coverage, ctx.draft.coverage, "coverage is copied unchanged");
  const document = JSON.parse(ctx.store.readArtifactFile(newDraft.artifactRevisionId, CLAIM_CHECK_FILE)!.toString()) as ClaimCheckDocument;
  assert.equal(document.label, CLAIM_CHECK_LABEL);
  const judged = document.rows.find(row => row.source === "jev")!;
  assert.equal(judged.judgment?.kind, "model-judgment");
  assert.ok(judged.judgment?.attemptId && judged.judgment.inputHash && judged.judgment.claimInputHash);
  assert.ok(judged.evidence.every(item => item.excerptDigest), "evidence provenance records excerpt digests");
  const view = ctx.view();
  const states = Object.fromEntries(view.scopes["component:c"]!.rows.map(row => [row.text, row.state]));
  assert.equal(states["It rejects rows without an id."], "supported");
  assert.equal(states["Rows without an id are rejected."], "contradicted");
  assert.equal(states["Start at `save()`; it writes each row as JSON."], "uncertain");
  assert.equal(view.scopes["system:s"]!.rows[0]!.state, "supported");
  assert.equal(ctx.store.snapshot().runs[0]!.state, "awaiting_review");
  assert.ok(ctx.store.snapshot().attempts.filter(row => row.scopeId.startsWith("claim-check:")).every(row => row.state === "accepted"));
});

test("code-failed and uncaptured claims are recorded without any provider call", async t => {
  const explanation = validateOperatorExplanation({ summary: "Big helper. Missing helper.", keyPoints: [{ text: "The big helper does everything.", evidence: [0] }, { text: "The missing helper exists.", evidence: [1] }], evidence: [ALLOWED[2], ALLOWED[3]] }, ALLOWED);
  const ctx = setup(t, { explanations: { "component:c": explanation } });
  const provider = fakeProvider();
  const outcome = await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.draft.draftRevisionId, provider, limits: LIMITS, enabled: true });
  assert.equal(outcome.state, "accepted"); assert.equal(provider.calls, 0);
  const rows = ctx.view().scopes["component:c"]!.rows;
  assert.deepEqual(rows.map(row => [row.state, row.source]), [["insufficient-context", "code"], ["insufficient-context", "code"]]);
  assert.match(rows[0]!.reason ?? "", /truncated.*not a falsehood/);
});

test("identical inputs replay from stored rows without a provider call or a new revision; re-checking replaces a scope's rows", async t => {
  const ctx = setup(t);
  const provider = fakeProvider();
  await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.draft.draftRevisionId, provider, limits: LIMITS, enabled: true });
  const calls = provider.calls; const drafts = ctx.store.snapshot().drafts.length;
  const again = await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.current(), provider, limits: LIMITS, enabled: true });
  assert.equal(again.state === "accepted" && again.replayed, 4);
  assert.equal(provider.calls, calls, "no provider call on replay");
  assert.equal(ctx.store.snapshot().drafts.length, drafts, "nothing changed, nothing installed");
  const scoped = await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.current(), scopeIds: ["system:s"], provider: { ...fakeProvider(), modelId: "jev-1.14.0" }, limits: LIMITS, enabled: true });
  assert.equal(scoped.state === "accepted" && scoped.installed, true, "a different pinned model re-asks");
  const document = JSON.parse(ctx.store.readArtifactFile(ctx.store.snapshot().artifacts.at(-1)!.artifactRevisionId, CLAIM_CHECK_FILE)!.toString()) as ClaimCheckDocument;
  assert.equal(document.rows.filter(row => row.scopeId === "system:s").length, 1, "the scope's rows are replaced, not appended");
  assert.equal(document.rows.filter(row => row.scopeId === "component:c").length, 3, "other scopes keep their rows");
});

test("disabled flag, missing provider and budget refusals are unavailable, never verdicts", async t => {
  const ctx = setup(t);
  assert.deepEqual(await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.draft.draftRevisionId, provider: fakeProvider(), limits: LIMITS, enabled: false }), { state: "disabled" });
  assert.equal(resolveClaimCheckConfig({}).enabled, false, "off by default");
  assert.equal(resolveClaimCheckConfig({ OKIE_JEV_CLAIM_CHECKS: "on" }).enabled, true);
  assert.deepEqual({ ...resolveClaimCheckConfig({ OKIE_JEV_MAX_REQUESTS: "3", OKIE_JEV_MAX_DOLLARS: "x" }), enabled: undefined }, { enabled: undefined, maxRequests: 3, maxTokens: 32 * 81_920, maxDollars: 0.1, timeoutMs: 20_000 });
  const disabledView = readClaimCheckView(ctx.store, ctx.store.snapshot().artifacts[0], false);
  assert.equal(disabledView.enabled, false); assert.match(disabledView.disabledReason ?? "", /OKIE_JEV_CLAIM_CHECKS/);
  const none = await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.draft.draftRevisionId, limits: LIMITS, enabled: true });
  assert.equal(none.state === "accepted" && none.stopped, "unavailable");
  assert.ok(ctx.view().scopes["component:c"]!.rows.every(row => row.state === "unavailable" && /No Jev provider/.test(row.reason ?? "")));
  const provider = fakeProvider();
  const exhausted = await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.current(), provider, limits: { ...LIMITS, maxRequests: 0 }, enabled: true });
  assert.equal(exhausted.state === "accepted" && exhausted.ledger, "run"); assert.equal(provider.calls, 0);
  assert.ok(ctx.view().scopes["system:s"]!.rows.every(row => row.state === "unavailable" && /claim-check budget/.test(row.reason ?? "")));
  const global = createOperatorBudgetLedger({ maxRequests: 0, maxTokens: 1, maxDollars: 1 }, { store: ctx.store, runId: "global-operator-enrichment" });
  const refused = await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.current(), provider, limits: LIMITS, globalLedger: global, enabled: true });
  assert.equal(refused.state === "accepted" && refused.ledger, "global"); assert.equal(provider.calls, 0);
  assert.equal(ctx.store.snapshot().events.filter(event => event.type === "budget.reserved" && event.detail?.kind === "claim-check").length, 0, "a global refusal reserves nothing on the run ledger");
  const failing = await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.current(), provider: fakeProvider(() => "fail"), limits: LIMITS, enabled: true });
  assert.equal(failing.state === "accepted" && failing.stopped, "failed");
  assert.ok(ctx.view().scopes["system:s"]!.rows.every(row => row.state === "unavailable" && /request failed/.test(row.reason ?? "")));
  assert.equal(ctx.store.snapshot().events.filter(event => event.type === "budget.reserved" && event.detail?.kind === "claim-check").length, 2, "each admitted request reserved on the run ledger");
});

test("staleness: changed evidence, changed explanation and a stale ancestor all read stale; vanished claims are never shown", async t => {
  const ctx = setup(t);
  await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.draft.draftRevisionId, provider: fakeProvider(), limits: LIMITS, enabled: true });
  const installed = ctx.store.snapshot().artifacts.at(-1)!;
  const files = Object.fromEntries(installed.files.map(file => [file, ctx.store.readArtifactFile(installed.artifactRevisionId, file)!.toString()]));
  const revise = (patch: (files: Record<string, string>) => void) => { const copy = { ...files }; patch(copy); const artifact = ctx.store.writeArtifactRevision({ repositoryId: ctx.run.source.repositoryId, sourceCommitSha: COMMIT, files: copy }); return readClaimCheckView(ctx.store, artifact, true); };
  assert.ok(Object.values(ctx.view().scopes).flatMap(scope => scope.rows).every(row => row.state === "supported"));
  // The captured bytes changed (same range, new text): the evidence digest no longer matches.
  const evidence = revise(copy => { const snap = snapshot() as unknown as { entities: Array<{ id: string; sourceExcerpts?: Array<{ lines: string[]; text: string }> }> }; const target = snap.entities.find(entity => entity.id === "code:a")!.sourceExcerpts![0]!; target.lines = target.lines.map(line => line.replace("row", "item")); target.text = target.lines.join("\n"); copy["snapshot.json"] = JSON.stringify(snap); });
  assert.ok(evidence.scopes["component:c"]!.rows.every(row => row.state === "stale" && /evidence changed/.test(row.reason ?? "")));
  // A child retry marked the parent stale in operator-explanations.json: its checks cannot look fresh.
  const ancestor = revise(copy => { const sidecar = JSON.parse(copy["operator-explanations.json"]!); sidecar.scopes[0].stale = true; copy["operator-explanations.json"] = JSON.stringify(sidecar); });
  assert.equal(ancestor.scopes["system:s"]!.rows[0]!.state, "stale"); assert.equal(ancestor.scopes["system:s"]!.counts.stale, 1);
  assert.equal(ancestor.scopes["component:c"]!.rows[0]!.state, "supported", "the unchanged child stays fresh");
  // New explanation content: previous claims vanish, the kept key point's check is stale (explanation digest).
  const changed = revise(copy => { const sidecar = JSON.parse(copy["operator-explanations.json"]!); const row = sidecar.explanations.find((item: { scopeId: string }) => item.scopeId === "system:s"); row.content = validateOperatorExplanation({ summary: "The system stores rows durably.", keyPoints: [{ text: "Saving happens in `save()`.", evidence: [0] }, "Three."], evidence: [{ entityId: "code:a", path: "src/a.ts", startLine: 10, endLine: 14 }] }, [{ entityId: "code:a", path: "src/a.ts", startLine: 10, endLine: 14 }]); copy["operator-explanations.json"] = JSON.stringify(sidecar); });
  assert.deepEqual(changed.scopes["system:s"]!.rows.map(row => row.state), ["stale"]);
  const legacy = revise(copy => { const sidecar = JSON.parse(copy["operator-explanations.json"]!); sidecar.explanations[0].content = { summary: "legacy", evidence: [] }; copy["operator-explanations.json"] = JSON.stringify(sidecar); });
  assert.equal(legacy.scopes["component:c"]?.mapping ?? legacy.scopes["system:s"]?.mapping, "none");
  assert.match(Object.values(legacy.scopes).find(scope => scope.mapping === "none")!.note ?? "", /no claim mapping/);
});

test("the pass refuses stale or active owners and never overwrites a newer draft", async t => {
  const ctx = setup(t);
  ctx.store.updateRun(ctx.run.runId, { state: "running" });
  assert.equal((await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.draft.draftRevisionId, provider: fakeProvider(), limits: LIMITS, enabled: true })).state, "conflict");
  ctx.store.updateRun(ctx.run.runId, { state: "awaiting_review" });
  const provider = fakeProvider();
  provider.evaluate = (async function (this: unknown, ...args: Parameters<JudgmentProvider["evaluate"]>) {
    ctx.publication.createDraftRevision({ runId: ctx.run.runId, artifactRevisionId: ctx.store.snapshot().artifacts[0]!.artifactRevisionId });
    return fakeProvider().evaluate(...args);
  }) as JudgmentProvider["evaluate"];
  const raced = await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.draft.draftRevisionId, provider, limits: LIMITS, enabled: true });
  assert.equal(raced.state, "conflict");
  assert.ok(!ctx.store.snapshot().artifacts.some(artifact => artifact.files.includes(CLAIM_CHECK_FILE)), "a lost CAS writes nothing");
});

function auth(): GithubAuthService {
  const session = (request: { headers: Record<string, string | undefined> }): GithubSession | undefined => request.headers["x-test-user"] === "operator" ? { id: "session", login: "operator", userId: "42", source: "test-double", token: "t", createdAt: 0 } as GithubSession : undefined;
  return { config: { publicOrigin: "http://fixture.test" }, sessionFromRequest: session as GithubAuthService["sessionFromRequest"] } as unknown as GithubAuthService;
}

test("API: mutation auth before lookup, disabled state, validation, stale-draft and active-run guards; detail carries the bounded view", async t => {
  const ctx = setup(t);
  const jobs: unknown[] = [];
  const options = { auth: auth(), allowedGithubIds: new Set(["42"]), publicOrigin: "http://fixture.test", store: ctx.store, publications: ctx.publication, enqueue: (job: unknown) => { jobs.push(job); } };
  const post = (path: string, body: unknown, headers: Record<string, string> = { "x-test-user": "operator", origin: "http://fixture.test" }) => handleOperatorApi(options, { method: "POST", headers } as never, path, body);
  const path = `/api/operator/drafts/${ctx.draft.draftRevisionId}/claim-checks`;
  const previous = process.env.OKIE_JEV_CLAIM_CHECKS;
  t.after(() => { if (previous === undefined) delete process.env.OKIE_JEV_CLAIM_CHECKS; else process.env.OKIE_JEV_CLAIM_CHECKS = previous; });
  assert.equal((await post("/api/operator/drafts/unknown/claim-checks", {}, {}))!.status, 401, "auth before any lookup");
  assert.equal((await post(path, {}, { "x-test-user": "operator", origin: "http://evil.test" }))!.status, 403);
  delete process.env.OKIE_JEV_CLAIM_CHECKS;
  const disabled = await post(path, {});
  assert.equal(disabled!.status, 422); assert.equal((disabled!.body as { code: string }).code, "claim_checks_disabled");
  const detail = new OperatorWorkflow({ store: ctx.store, publications: ctx.publication, enqueue: () => undefined }).draftDetail(ctx.draft.draftRevisionId)!;
  assert.equal(detail.claimChecks.enabled, false);
  assert.equal(detail.scopes.find(scope => scope.scopeId === "component:c")!.claimChecks!.counts["not-evaluated"], 3);
  process.env.OKIE_JEV_CLAIM_CHECKS = "on";
  assert.equal((await post(path, { scopeIds: ["nope"] }))!.status, 422);
  assert.equal((await post(path, { scopeIds: ["code:a"] }))!.status, 422, "a scope without claims is refused");
  const accepted = await post(path, {});
  assert.equal(accepted!.status, 202);
  assert.deepEqual((jobs[0] as { kind: string; scopeIds: string[] }).scopeIds.sort(), ["component:c", "system:s"]);
  assert.equal((jobs[0] as { kind: string }).kind, "claim-checks");
  ctx.store.updateRun(ctx.run.runId, { state: "running" });
  assert.equal(((await post(path, {}))!.body as { code: string }).code, "run_active");
  ctx.store.updateRun(ctx.run.runId, { state: "awaiting_review" });
  ctx.publication.createDraftRevision({ runId: ctx.run.runId, artifactRevisionId: ctx.store.snapshot().artifacts[0]!.artifactRevisionId });
  const superseded = await post(path, {});
  assert.equal(superseded!.status, 409); assert.equal((superseded!.body as { code: string }).code, "draft_superseded");
});


const ACCESS = { kind: "github", source: "test-double", token: "t", login: "x", userId: "1" } as never;
test("runner: claim checks run through the workflow seam (running, then awaiting_review) and are cancellable", async t => {
  const ctx = setup(t);
  const previous = process.env.OKIE_JEV_CLAIM_CHECKS; process.env.OKIE_JEV_CLAIM_CHECKS = "on";
  t.after(() => { if (previous === undefined) delete process.env.OKIE_JEV_CLAIM_CHECKS; else process.env.OKIE_JEV_CLAIM_CHECKS = previous; });
  const seen: string[] = [];
  const provider = fakeProvider(); const evaluate = provider.evaluate.bind(provider);
  provider.evaluate = (async (...args: Parameters<JudgmentProvider["evaluate"]>) => { seen.push(ctx.store.snapshot().runs[0]!.state); return evaluate(...args); }) as JudgmentProvider["evaluate"];
  const runner = createOperatorRunner({ store: ctx.store, publication: ctx.publication, judgmentProvider: provider });
  await runner.enqueue({ kind: "claim-checks", runId: ctx.run.runId, draftRevisionId: ctx.draft.draftRevisionId, githubAccess: ACCESS });
  assert.deepEqual([...new Set(seen)], ["running"], "the pass is visible as running");
  const run = ctx.store.snapshot().runs[0]!;
  assert.equal(run.state, "awaiting_review"); assert.equal(run.error, undefined);
  assert.notEqual(run.draftRevisionId, ctx.draft.draftRevisionId, "the pass installed one new revision");
  assert.ok(ctx.store.snapshot().events.some(event => event.type === "claim_checks.finished" && event.detail?.installed === true));
  const types = ctx.store.snapshot().events.map(event => event.type);
  assert.ok(types.indexOf("claim_checks.started") > -1 && types.indexOf("claim_checks.started") < types.indexOf("claim_checks.finished"), "the pass announces itself (the UI shows Checking claims…)");
  // A stale base is a recorded conflict, not an overwrite.
  await runner.enqueue({ kind: "claim-checks", runId: ctx.run.runId, draftRevisionId: ctx.draft.draftRevisionId, githubAccess: ACCESS });
  assert.ok(ctx.store.snapshot().events.some(event => event.type === "draft.conflict"));
  // Cancellation mid-pass installs nothing and leaves the run cancelled.
  const drafts = ctx.store.snapshot().drafts.length;
  const cancelling = fakeProvider(); const inner = cancelling.evaluate.bind(cancelling);
  cancelling.evaluate = (async (...args: Parameters<JudgmentProvider["evaluate"]>) => { ctx.store.updateRun(ctx.run.runId, { state: "cancelled" }); return inner(...args); }) as JudgmentProvider["evaluate"];
  const other = createOperatorRunner({ store: ctx.store, publication: ctx.publication, judgmentProvider: { ...cancelling, modelId: "jev-1.14.0" } });
  await other.enqueue({ kind: "claim-checks", runId: ctx.run.runId, draftRevisionId: ctx.current(), githubAccess: ACCESS });
  assert.equal(ctx.store.snapshot().runs[0]!.state, "cancelled");
  assert.equal(ctx.store.snapshot().drafts.length, drafts);
});

test("runner: a retried child marks its ancestor stale, so the parent's claim checks read stale", async t => {
  const ctx = setup(t);
  await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.draft.draftRevisionId, provider: fakeProvider(), limits: LIMITS, enabled: true });
  assert.equal(ctx.view().scopes["system:s"]!.rows[0]!.state, "supported");
  const gateway = { modelId: "fake/model", async chatCompletions() { return { json: { choices: [{ message: { content: JSON.stringify(reply({ summary: "**Storage** keeps rows on disk. It rejects rows without an id. New sentence.", evidence: ALLOWED.slice(0, 2) })) } }] }, usage: { totalTokens: 2 } }; } };
  const runner = createOperatorRunner({ store: ctx.store, publication: ctx.publication, gateway, judgmentProvider: null });
  await runner.enqueue({ kind: "retry", runId: ctx.run.runId, draftRevisionId: ctx.current(), scopeIds: ["component:c"], githubAccess: ACCESS });
  const view = ctx.view();
  assert.equal(view.scopes["system:s"]!.rows[0]!.state, "stale", "an apparently fresh parent check would be a lie");
  assert.match(view.scopes["system:s"]!.rows[0]!.reason ?? "", /stale/);
  assert.ok(view.scopes["component:c"]!.rows.length > 0 && view.scopes["component:c"]!.rows.every(row => row.state === "stale"), "the changed child's own checks are not fresh either");
});

// ---- CLA-145 review fixes ----

test("oversized evidence: the pass records insufficient context and the view reads it as current, not stale", async t => {
  const snap = snapshot() as unknown as { entities: Array<{ id: string; sourceExcerpts?: Array<{ lines: string[]; text: string }> }> };
  const target = snap.entities.find(entity => entity.id === "code:a")!.sourceExcerpts![0]!;
  target.lines = target.lines.map((line, index) => `${line} // ${String(index).repeat(6000)}`); target.text = target.lines.join("\n");
  const ctx = setup(t, { snapshot: snap as unknown as ArchitectureSnapshot });
  const provider = fakeProvider();
  const outcome = await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.draft.draftRevisionId, provider, limits: LIMITS, enabled: true });
  assert.equal(outcome.state === "accepted" && outcome.installed, true); assert.equal(provider.calls, 0, "nothing is cut or sent");
  const rows = Object.values(ctx.view().scopes).flatMap(scope => scope.rows);
  assert.ok(rows.length > 0);
  assert.ok(rows.every(row => row.state === "insufficient-context" && row.source === "code" && /24 KB/.test(row.reason ?? "")), "fresh right after the pass");
  const again = await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.current(), provider, limits: LIMITS, enabled: true });
  assert.equal(again.state === "accepted" && again.installed, false, "a repeat pass changes nothing");
});

test("stale scopes are skipped: no Jev spend, no rows written; an only-stale selection is refused by the API", async t => {
  const ctx = setup(t, { stale: ["system:s"] });
  const provider = fakeProvider();
  const outcome = await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.draft.draftRevisionId, provider, limits: LIMITS, enabled: true });
  assert.equal(outcome.state, "accepted");
  assert.deepEqual(outcome.state === "accepted" && outcome.skipped, [{ scopeId: "system:s", reason: "Explanation is stale; refresh it, then re-check." }]);
  assert.equal(provider.calls, 1, "only the fresh scope is asked");
  const document = JSON.parse(ctx.store.readArtifactFile(ctx.store.snapshot().artifacts.at(-1)!.artifactRevisionId, CLAIM_CHECK_FILE)!.toString()) as ClaimCheckDocument;
  assert.equal(document.rows.some(row => row.scopeId === "system:s"), false, "no rows for the stale scope");
  const only = await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.current(), scopeIds: ["system:s"], provider, limits: LIMITS, enabled: true });
  assert.equal(only.state, "stale"); assert.equal(provider.calls, 1);
  // API: explicit only-stale selection → 422 claim_scopes_stale; mixed and default selections leave stale scopes out.
  const previous = process.env.OKIE_JEV_CLAIM_CHECKS; process.env.OKIE_JEV_CLAIM_CHECKS = "on";
  t.after(() => { if (previous === undefined) delete process.env.OKIE_JEV_CLAIM_CHECKS; else process.env.OKIE_JEV_CLAIM_CHECKS = previous; });
  const jobs: Array<{ scopeIds: string[] }> = [];
  const options = { auth: auth(), allowedGithubIds: new Set(["42"]), publicOrigin: "http://fixture.test", store: ctx.store, publications: ctx.publication, enqueue: (job: unknown) => { jobs.push(job as { scopeIds: string[] }); } };
  const post = (body: unknown) => handleOperatorApi(options, { method: "POST", headers: { "x-test-user": "operator", origin: "http://fixture.test" } } as never, `/api/operator/drafts/${ctx.current()}/claim-checks`, body);
  const refused = await post({ scopeIds: ["system:s"] });
  assert.equal(refused!.status, 422); assert.equal((refused!.body as { code: string }).code, "claim_scopes_stale"); assert.match((refused!.body as { error: string }).error, /refresh/);
  assert.equal((await post({ scopeIds: ["system:s", "component:c"] }))!.status, 202, "a mixed selection is accepted; the pass skips the stale member");
  assert.equal((await post({}))!.status, 202);
  assert.deepEqual(jobs.at(-1)!.scopeIds, ["component:c"], "the default selection leaves stale scopes out");
  assert.deepEqual(parseClaimCheckSelection({}, [{ scopeId: "a", stale: true, claimChecks: { mapping: "claims" } }]), { error: "Every selected scope's explanation is stale; refresh it, then re-check.", code: "claim_scopes_stale" });
  // Runner: an only-stale pass says so on its event.
  const runner = createOperatorRunner({ store: ctx.store, publication: ctx.publication, judgmentProvider: provider });
  await runner.enqueue({ kind: "claim-checks", runId: ctx.run.runId, draftRevisionId: ctx.current(), scopeIds: ["system:s"], githubAccess: ACCESS });
  const finished = ctx.store.snapshot().events.filter(event => event.type === "claim_checks.finished").at(-1)!;
  assert.equal(finished.detail?.stopped, "stale"); assert.match(String(finished.detail?.message), /stale; refresh it/);
  assert.equal(provider.calls, 1);
});

test("a claim-check pass never clears or overwrites run.error; its outcome message is on the claim_checks.finished event", async t => {
  const ctx = setup(t);
  ctx.store.updateRun(ctx.run.runId, { error: "Enrichment stopped: gateway unavailable." as never });
  const previous = process.env.OKIE_JEV_CLAIM_CHECKS;
  t.after(() => { if (previous === undefined) delete process.env.OKIE_JEV_CLAIM_CHECKS; else process.env.OKIE_JEV_CLAIM_CHECKS = previous; });
  const errorOf = () => JSON.stringify(ctx.store.snapshot().runs[0]!.error);
  const before = errorOf();
  assert.match(before, /gateway unavailable/);
  process.env.OKIE_JEV_CLAIM_CHECKS = "on";
  await createOperatorRunner({ store: ctx.store, publication: ctx.publication, judgmentProvider: fakeProvider() }).enqueue({ kind: "claim-checks", runId: ctx.run.runId, draftRevisionId: ctx.draft.draftRevisionId, githubAccess: ACCESS });
  assert.equal(errorOf(), before, "a clean pass leaves the enrichment error in place");
  delete process.env.OKIE_JEV_CLAIM_CHECKS;
  await createOperatorRunner({ store: ctx.store, publication: ctx.publication, judgmentProvider: null }).enqueue({ kind: "claim-checks", runId: ctx.run.runId, draftRevisionId: ctx.current(), scopeIds: ["system:s"], githubAccess: ACCESS });
  assert.equal(errorOf(), before, "a refused pass does not overwrite it either");
  assert.equal(ctx.store.snapshot().runs[0]!.state, "awaiting_review");
  const finished = ctx.store.snapshot().events.filter(event => event.type === "claim_checks.finished");
  assert.equal(finished.length, 2);
  assert.equal(finished[0]!.detail?.message, undefined, "a clean pass has nothing to report");
  assert.match(String(finished[1]!.detail?.message), /off on this server/);
});

test("global ledger: every global reservation is settled or released — run refusal, provider throw, malformed usage", async t => {
  const ctx = setup(t);
  const global = createOperatorBudgetLedger({ maxRequests: 100, maxTokens: 100_000_000, maxDollars: 100 }, { store: ctx.store, runId: "global-operator-enrichment" });
  const body = { state: { x: 1 }, questions: { q0: choice({ question: "Is it?", rules: "Answer." }, { supports: "yes", contradicts: "no", insufficient: "unknown" }) } } as never;
  const base = { store: ctx.store, runId: ctx.run.runId, draftRevisionId: ctx.draft.draftRevisionId, schema: "test/v1", questionVersion: "q1", evidenceDigest: "e", body, cancelled: () => false, ledgerKind: "claim-check" as const, globalLedger: global };
  const refused = await evaluateJudgmentBatch({ ...base, attemptScopeId: "claim-check:refused", provider: fakeProvider(), limits: { ...LIMITS, maxRequests: 0 } });
  assert.deepEqual([refused.state, refused.state === "limit" && refused.ledger], ["limit", "run"]);
  const throwing = { modelId: "jev-1.13.0", async evaluate(): Promise<never> { throw new Error("socket closed"); } } as JudgmentProvider;
  assert.equal((await evaluateJudgmentBatch({ ...base, attemptScopeId: "claim-check:throw", provider: throwing, limits: LIMITS })).state, "failed");
  const malformed = { modelId: "jev-1.13.0", async evaluate(request: { questions: Record<string, unknown> }) { return { json: { model: "jev-1.13.0", answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: "choice", choice: "supports", confidence: 0.9, probabilities: { supports: 0.9, contradicts: 0.05, insufficient: 0.05 } }])) }, usage: { inputTokens: -5, outputTokens: Number.NaN } }; } } as unknown as JudgmentProvider;
  assert.equal((await evaluateJudgmentBatch({ ...base, attemptScopeId: "claim-check:usage", provider: malformed, limits: LIMITS })).state, "answered", "malformed usage never throws out of settle");
  const events = ctx.store.snapshot().events.filter(event => event.runId === "global-operator-enrichment");
  const reserved = events.filter(event => event.type === "budget.reserved").map(event => event.detail!.requestId);
  const closed = new Set(events.filter(event => event.type === "budget.settled" || event.type === "budget.released").map(event => event.detail!.requestId));
  assert.equal(reserved.length, 3);
  assert.ok(reserved.every(id => closed.has(id)), "no global reservation is left open");
  assert.equal(events.filter(event => event.type === "budget.released").length, 1, "the run refusal released its global reservation");
  const run = ctx.store.snapshot().events.filter(event => event.runId === ctx.run.runId && event.detail?.kind === "claim-check");
  assert.equal(run.filter(event => event.type === "budget.reserved").length, run.filter(event => event.type === "budget.settled").length, "run reservations all settle");
});

test("claim mappings are operator-only: the public explanation read strips claims and claimsNote", async t => {
  const ctx = setup(t);
  const artifactId = ctx.store.snapshot().artifacts[0]!.artifactRevisionId;
  const stored = JSON.parse(ctx.store.readArtifactFile(artifactId, "operator-explanations.json")!.toString()) as { explanations: Array<{ content: { claims?: unknown } }> };
  assert.ok(stored.explanations.some(row => row.content.claims), "the fixture artifact carries claims");
  const publicScopes = readArtifactScopes(ctx.store, artifactId);
  assert.ok(publicScopes.some(scope => scope.explanation));
  for (const scope of publicScopes) { assert.equal(JSON.stringify(scope).includes("\"claims\""), false); assert.equal(JSON.stringify(scope).includes("claimsNote"), false); }
  const operator = new OperatorWorkflow({ store: ctx.store, publications: ctx.publication, enqueue: () => undefined }).draftDetail(ctx.draft.draftRevisionId)!;
  assert.ok(operator.scopes.some(scope => (scope.explanation as { claims?: unknown } | undefined)?.claims), "the operator draft detail keeps them");
});

test("ledger separation: claim checks never spend the enrichment run ledger or count as enrichment progress; judgments still do", async t => {
  const ctx = setup(t);
  await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.draft.draftRevisionId, provider: fakeProvider(), limits: LIMITS, enabled: true });
  const claimReservations = ctx.store.snapshot().events.filter(event => event.type === "budget.reserved" && event.detail?.kind === "claim-check").length;
  assert.equal(claimReservations, 2);
  const enrichment = () => createOperatorBudgetLedger({ maxRequests: 100, maxTokens: 100_000_000, maxDollars: 100 }, { store: ctx.store, runId: ctx.run.runId }).snapshot();
  assert.equal(enrichment().requests, 0, "the kindless enrichment ledger ignores claim-check events");
  assert.equal(runBudget(ctx.store, ctx.run.runId).requests, 0);
  assert.equal(createOperatorBudgetLedger(LIMITS, { store: ctx.store, runId: ctx.run.runId, kind: "claim-check" }).snapshot().requests, 2, "the OKIE_JEV_* ledger sees them");
  // CLA-144 judgment reservations keep counting against the enrichment ledger exactly as before.
  const judgment = createOperatorBudgetLedger(LIMITS, { store: ctx.store, runId: ctx.run.runId, kind: "judgment" });
  judgment.settle(judgment.reserve(1000, 0.001)!, { inputTokens: 10, outputTokens: 1 });
  assert.equal(enrichment().requests, 1);
  const attempts = ctx.store.snapshot().attempts;
  assert.ok(attempts.filter(isClaimCheckAttempt).length >= 2 && attempts.filter(isClaimCheckAttempt).every(attempt => attempt.state === "accepted"));
  assert.deepEqual(progressOf(attempts), { accepted: 0, failed: 0, inFlight: 0 }, "claim-check attempts are not enrichment progress");
  assert.deepEqual(avgCost(attempts), {}, "nor per-scope cost");
  const detail = new OperatorWorkflow({ store: ctx.store, publications: ctx.publication, enqueue: () => undefined }).runDetail(ctx.run.runId)!;
  assert.deepEqual(detail.progress, { accepted: 0, failed: 0, inFlight: 0 });
  // L4: claim-check attempts name the checked scope, and at most 20 are listed next to the latest 100 enrichment attempts.
  assert.ok(attempts.filter(isClaimCheckAttempt).every(attempt => /^claim-check:(component:c|system:s)#[0-9a-f]{16}$/.test(attempt.scopeId)));
  for (let index = 0; index < 25; index += 1) ctx.store.createAttempt({ draftRevisionId: ctx.current(), scopeId: `claim-check:component:c#${String(index).padStart(16, "0")}`, kind: "judgment", state: "accepted" });
  ctx.store.createAttempt({ draftRevisionId: ctx.current(), scopeId: "component:c", kind: "retry", state: "accepted" });
  const listed = new OperatorWorkflow({ store: ctx.store, publications: ctx.publication, enqueue: () => undefined }).runDetail(ctx.run.runId)!.attempts;
  assert.equal(listed.filter(isClaimCheckAttempt).length, 20); assert.equal(listed.filter(attempt => !isClaimCheckAttempt(attempt)).length, 1);
});

test("a stale container whose claims cite directory-level evidence reads stale, not context-not-captured; dropped mappings are surfaced", async t => {
  // Container-style claims: whole-path evidence with no lines can never be evaluated (insufficient context) by the live code check.
  const container = validateOperatorExplanation({ summary: "The area keeps rows on disk. It validates ids.", keyPoints: [{ text: "Rows live under `src/a.ts`.", evidence: [ALLOWED[0]] }, { text: "Ids are checked.", evidence: [7] }], summaryClaims: [{ text: "The area keeps rows on disk.", evidence: [ALLOWED[0]] }], evidence: [ALLOWED[0]] }, ALLOWED);
  assert.match(container.claimsNote ?? "", /index out of range/);
  const fresh = setup(t, { explanations: { "component:c": container } });
  const before = fresh.view().scopes["component:c"]!;
  assert.ok(before.rows.every(row => row.state === "insufficient-context"), "fresh: the live code check decides");
  assert.equal(before.stale, undefined);
  assert.deepEqual([before.dropped, before.droppedNote], [1, container.claimsNote]);
  const stale = setup(t, { explanations: { "component:c": container }, stale: ["component:c"] });
  const checks = stale.view().scopes["component:c"]!;
  assert.equal(checks.stale, true);
  assert.ok(checks.rows.length === 2 && checks.rows.every(row => row.state === "stale" && row.reason === "Explanation is stale; refresh it, then re-check."), "stale takes precedence over the code check");
  assert.equal(checks.counts.stale, 2); assert.equal(checks.counts["insufficient-context"], 0);
  // Every mapping dropped: a specific note instead of the generic "no claim mapping".
  const none = validateOperatorExplanation({ summary: "Area. Ids.", keyPoints: [{ text: "One.", evidence: [9] }, { text: "Two.", evidence: [8] }], evidence: [ALLOWED[0]] }, ALLOWED);
  const all = setup(t, { explanations: { "component:c": none } }).view().scopes["component:c"]!;
  assert.equal(all.mapping, "none"); assert.equal(all.dropped, 2); assert.match(all.note ?? "", /all 2 claim mappings were dropped/);
  assert.deepEqual(droppedMappings({ claimsNote: "dropped claim mapping: a; b; c; d (+3 more)" }), { count: 7, note: "dropped claim mapping: a; b; c; d (+3 more)" });
});

test("L3: a fast 401/403 from TypeSafe is a provider failure (not a timeout); a real timeout stops the rest of the pass", async t => {
  const ctx = setup(t);
  for (const status of [401, 403]) {
    const transport = async () => new Response(JSON.stringify({ error: { message: "invalid api key sk-should-not-leak" } }), { status, headers: { "content-type": "application/json" } });
    const provider = createJevProvider({ JEV_API: "invalid-key" }, transport as never)!;
    const started = Date.now();
    const outcome = await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.current(), provider, limits: { ...LIMITS, timeoutMs: 20_000 }, enabled: true });
    assert.ok(Date.now() - started < 5_000, "no wait for the deadline");
    assert.equal(outcome.state === "accepted" && outcome.stopped, "failed");
    const rows = Object.values(ctx.view().scopes).flatMap(scope => scope.rows);
    assert.ok(rows.every(row => row.state === "unavailable" && /request failed/.test(row.reason ?? "")), `${status} reads as a provider failure`);
    assert.ok(!JSON.stringify(ctx.store.snapshot()).includes("sk-should-not-leak"), "the error body is never stored");
  }
  let calls = 0;
  const hanging = { modelId: "jev-1.13.0", evaluate: (_request: unknown, signal: AbortSignal) => { calls += 1; return new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))); } } as unknown as JudgmentProvider;
  const timedOut = await runClaimChecks({ store: ctx.store, publication: ctx.publication, runId: ctx.run.runId, draftRevisionId: ctx.current(), provider: { ...hanging, modelId: "jev-1.14.0" }, limits: { ...LIMITS, timeoutMs: 50 }, enabled: true });
  assert.equal(calls, 1, "after one timeout the remaining batch is not sent");
  assert.equal(timedOut.state === "accepted" && timedOut.stopped, "failed");
  assert.ok(Object.values(ctx.view().scopes).flatMap(scope => scope.rows).every(row => row.state === "unavailable" && /timed out/.test(row.reason ?? "")));
});
