import type { ArchitectureSnapshot } from "@okie/architecture";
import { CLAIM_CHECK_CONFIDENCE_THRESHOLD, deriveClaimState, runClaimChecks, type ClaimCheckRow } from "./claimChecks.js";
import { operatorClaimId, type OperatorEvidenceRef, type OperatorExplanationClaim } from "./operatorEnrichment.js";
import type { JudgmentProvider } from "./operatorJudgments.js";
import type { OperatorUsage } from "./operatorContracts.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore } from "./operatorStore.js";

/**
 * CLA-145 held-out evaluation harness, shared by the CI replay test and scripts/evaluate-claim-checks.mjs.
 * It drives the real pipeline (code checks, batching, the Jev seam, verdict derivation) over
 * fixtures/judgments/cla145/heldout.json. Labels and rationales never reach the provider.
 */
export interface HeldoutSource { repository: string; commit: string; path: string; startLine: number; endLine: number; text: string; }
export interface HeldoutCase { id: string; category: string; source: string; claim: string; expected: string; rationale: string; expectedReason?: string; mutation?: "cite-missing-entity" | "cite-outside-range" | "foreign-commit-capture" | "truncated-capture" | "no-capture"; }
export interface HeldoutFixture { sources: Record<string, HeldoutSource>; cases: HeldoutCase[]; codeChecks: HeldoutCase[]; }
export interface EvaluationRow { id: string; category: string; expected: string; predicted: string; source: "code" | "jev"; reason?: string; choice?: string; confidence?: number; probabilities?: Record<string, number>; }
export interface EvaluationRequest { latencyMs: number; usage: OperatorUsage; failed: boolean; questions: number; }

const EVAL_COMMIT_FALLBACK = "0".repeat(40);
const scopeFor = (window: string, chunk: number) => `component:${window}${chunk ? `-${chunk}` : ""}`;

/** Builds the pinned snapshot + explanation sidecar: one code entity per source window, claims grouped per window (≤8). */
export function evaluationArtifacts(fixture: HeldoutFixture) {
  const commit = Object.values(fixture.sources)[0]?.commit ?? EVAL_COMMIT_FALLBACK;
  const entities: ArchitectureSnapshot["entities"] = [{ id: "system:eval", name: "Evaluation", kind: "softwareSystem", sourceRefs: [] } as never];
  const excerptOf = (source: HeldoutSource, extra: Record<string, unknown> = {}) => { const lines = source.text.split("\n"); return { path: source.path, language: source.path.endsWith(".rs") ? "rust" : "typescript", startLine: source.startLine, endLine: source.startLine + lines.length - 1, sourceStartLine: source.startLine, sourceEndLine: source.endLine, highlightLine: source.startLine, frozenRevision: source.commit, lines, text: source.text, ...extra }; };
  for (const [window, source] of Object.entries(fixture.sources)) {
    entities.push({ id: `component:${window}`, name: window, kind: "component", parentId: "system:eval", sourceRefs: [{ path: source.path, commitSha: source.commit }] } as never);
    entities.push({ id: `code:${window}`, name: window, kind: "code", parentId: `component:${window}`, sourceRefs: [{ path: source.path, startLine: source.startLine, endLine: source.endLine, commitSha: source.commit }], sourceExcerpts: [excerptOf(source)] } as never);
  }
  const claims = new Map<string, OperatorExplanationClaim[]>(); const caseByClaim = new Map<string, HeldoutCase>();
  const add = (scopeId: string, row: HeldoutCase, evidence: OperatorEvidenceRef[]) => {
    const claim: OperatorExplanationClaim = { id: operatorClaimId("summary", row.claim, evidence), text: row.claim, origin: "summary", index: 0, evidence };
    const list = claims.get(scopeId) ?? []; list.push(claim); claims.set(scopeId, list); caseByClaim.set(`${scopeId}\0${claim.id}`, row);
  };
  const perWindow = new Map<string, number>();
  for (const row of fixture.cases) {
    const source = fixture.sources[row.source]!; const seen = perWindow.get(row.source) ?? 0; perWindow.set(row.source, seen + 1);
    add(scopeFor(row.source, Math.floor(seen / 8)), row, [{ entityId: `code:${row.source}`, path: source.path, startLine: source.startLine, endLine: source.endLine }]);
  }
  for (const row of fixture.codeChecks) {
    const source = fixture.sources[row.source]!; const id = `code:check-${row.id}`;
    const ref = { path: source.path, startLine: source.startLine, endLine: source.endLine };
    if (row.mutation === "cite-missing-entity") { add("component:code-checks", row, [{ entityId: `code:missing-${row.id}`, ...ref }]); continue; }
    if (row.mutation === "cite-outside-range") { add("component:code-checks", row, [{ entityId: `code:${row.source}`, path: source.path, startLine: 100, endLine: 130 }]); continue; }
    const truncatedEnd = source.endLine + 64;
    entities.push({ id, name: row.id, kind: "code", parentId: "system:eval", sourceRefs: [{ ...ref, ...(row.mutation === "truncated-capture" ? { endLine: truncatedEnd } : {}), commitSha: source.commit }],
      ...(row.mutation === "no-capture" ? {} : { sourceExcerpts: [excerptOf(source, row.mutation === "foreign-commit-capture" ? { frozenRevision: "f".repeat(40) } : row.mutation === "truncated-capture" ? { sourceEndLine: truncatedEnd } : {})] }) } as never);
    add("component:code-checks", row, [{ entityId: id, ...ref, ...(row.mutation === "truncated-capture" ? { endLine: truncatedEnd } : {}) }]);
  }
  const scopes = [{ scopeId: "system:eval", name: "Evaluation", kind: "softwareSystem", sourceRefs: [] }, ...[...claims.keys()].map(scopeId => ({ scopeId, parentScopeId: "system:eval", name: scopeId, kind: "component", sourceRefs: [], state: "accepted" }))];
  const explanations = [...claims].map(([scopeId, list]) => ({ scopeId, explanationVersionId: `eval-${scopeId}`, content: { format: "v3", summary: list.map(claim => claim.text).join(" "), keyPoints: [], evidence: list.flatMap(claim => claim.evidence), claims: list } }));
  return { commit, snapshot: { entities, relations: [] } as unknown as ArchitectureSnapshot, sidecar: { schemaVersion: 1, scopes, explanations }, caseByClaim };
}

/** Runs the real claim-check pass once over every case. `provider` undefined = code checks only. */
export async function runClaimCheckEvaluation(options: { fixture: HeldoutFixture; root: string; provider?: JudgmentProvider; timeoutMs?: number; threshold?: number }): Promise<{ rows: EvaluationRow[]; requests: EvaluationRequest[]; checkRows: ClaimCheckRow[]; outcome: string }> {
  const { snapshot, sidecar, commit, caseByClaim } = evaluationArtifacts(options.fixture);
  const store = new OperatorStore(options.root); const publication = new OperatorPublicationService(store);
  const run = store.createRun({ idempotencyKey: `cla145-eval-${Date.now()}`, source: { repositoryId: "repo:thiss/okie", owner: "thiss", repo: "okie", slug: "thiss__okie" } }).run;
  const artifact = store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: commit, files: { "snapshot.json": JSON.stringify(snapshot), "operator-explanations.json": JSON.stringify(sidecar) } });
  const draft = publication.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
  store.updateRun(run.runId, { state: "awaiting_review" });
  const requests: EvaluationRequest[] = [];
  const provider = options.provider ? { modelId: options.provider.modelId, async evaluate(...args: Parameters<JudgmentProvider["evaluate"]>) {
    const started = performance.now(); const reply = await options.provider!.evaluate(...args);
    requests.push({ latencyMs: Math.round(performance.now() - started), usage: reply.usage, failed: Boolean(reply.failed), questions: Object.keys(args[0].questions).length });
    return reply;
  } } satisfies JudgmentProvider : undefined;
  // Evaluation caps: every window is one request; admission still runs through the real ledger.
  const outcome = await runClaimChecks({ store, publication, runId: run.runId, draftRevisionId: draft.draftRevisionId, ...(provider ? { provider } : {}), limits: { maxRequests: 64, maxTokens: 64 * 81_920, maxDollars: 0.25, maxConcurrent: 1, timeoutMs: options.timeoutMs ?? 30_000 }, enabled: true, ...(options.threshold !== undefined ? { threshold: options.threshold } : {}) });
  const checkRows = outcome.state === "accepted" ? outcome.rows : [];
  const rows = checkRows.map(row => {
    const source = caseByClaim.get(`${row.scopeId}\0${row.claimId}`)!;
    return { id: source.id, category: source.category, expected: source.expected, predicted: row.state, source: row.source, ...(row.reason ? { reason: row.reason } : {}), ...(row.judgment ? { choice: row.judgment.choice, confidence: row.judgment.confidence, probabilities: row.judgment.probabilities } : {}) };
  });
  return { rows, requests, checkRows, outcome: outcome.state };
}

const percentile = (values: number[], p: number) => { if (!values.length) return null; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!; };
/** Jev bills input tokens only: $0.042 / 1M (2026-09-19 pricing used by the reservation). */
export const JEV_INPUT_USD_PER_TOKEN = 0.042 / 1_000_000;
const ATTENTION = new Set(["failed-check", "stale", "contradicted", "uncertain", "insufficient", "insufficient-context", "unavailable", "not-evaluated"]);
function tally(rows: readonly EvaluationRow[]) {
  const n = rows.length;
  const correct = rows.filter(row => row.predicted === row.expected).length;
  const unsupported = rows.filter(row => row.expected !== "supported");
  const supported = rows.filter(row => row.expected === "supported");
  const falseAcceptance = unsupported.filter(row => row.predicted === "supported").length;
  const falseAlarm = supported.filter(row => row.predicted !== "supported").length;
  return { n, correct, accuracy: n ? correct / n : null, falseAcceptance, falseAcceptanceRate: unsupported.length ? falseAcceptance / unsupported.length : null, falseAlarm, falseAlarmRate: supported.length ? falseAlarm / supported.length : null, reviewLoad: n ? rows.filter(row => ATTENTION.has(row.predicted)).length / n : null };
}
/**
 * Report: per category false acceptance (unsupported/contradicted claims judged supported) and false alarms
 * (supported claims flagged), review load, latency p50/p95, cost, and the same at several thresholds.
 */
export function scoreClaimCheckEvaluation(rows: readonly EvaluationRow[], requests: readonly EvaluationRequest[], thresholds: readonly number[] = [0.3, 0.5, 0.6, 0.7, 0.8, 0.9]) {
  const categories = [...new Set(rows.map(row => row.category))].sort();
  const judged = rows.filter(row => row.source === "jev" && row.choice !== undefined);
  const inputTokens = requests.reduce((sum, request) => sum + (request.usage.inputTokens ?? 0), 0);
  const measured = requests.filter(request => request.usage.measuredCostUsd !== undefined);
  return {
    overall: tally(rows),
    byCategory: Object.fromEntries(categories.map(category => [category, tally(rows.filter(row => row.category === category))])),
    codeChecksReachedJev: rows.filter(row => row.category === "code-check" && row.source === "jev").length,
    requests: requests.length, failedRequests: requests.filter(request => request.failed).length,
    latencyMs: { p50: percentile(requests.map(request => request.latencyMs), 0.5), p95: percentile(requests.map(request => request.latencyMs), 0.95) },
    usage: { inputTokens, outputTokens: requests.reduce((sum, request) => sum + (request.usage.outputTokens ?? 0), 0) },
    cost: measured.length ? { kind: "measured" as const, usd: measured.reduce((sum, request) => sum + request.usage.measuredCostUsd!, 0) } : { kind: "estimated" as const, usd: inputTokens * JEV_INPUT_USD_PER_TOKEN, reservedUsd: requests.length * 0.003 },
    thresholds: thresholds.map(threshold => {
      const rederived = rows.map(row => row.source === "jev" && row.choice !== undefined && row.confidence !== undefined ? { ...row, predicted: deriveClaimState({ choice: row.choice, confidence: row.confidence }, threshold) } : row);
      return { threshold, ...tally(rederived), uncertain: rederived.filter(row => row.predicted === "uncertain").length };
    }),
    currentThreshold: CLAIM_CHECK_CONFIDENCE_THRESHOLD,
    judgedClaims: judged.length,
  };
}
