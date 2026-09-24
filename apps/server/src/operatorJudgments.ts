import { createHash } from "node:crypto";
import { APIError, TypeSafeClient, type ChoiceQuestion, type ChoiceResponse, type EntryType, type Fetch } from "@typesafe-ai/sdk";
import { redactGatewayText } from "./llmGateway.js";
import { createOperatorBudgetLedger } from "./operatorBudget.js";
import type { OperatorUsage } from "./operatorContracts.js";
import type { OperatorPublicationService } from "./operatorPublication.js";
import type { OperatorStore } from "./operatorStore.js";

export const JEV_MODEL = "jev-1.13.0";
const SCHEMA = "operator-choice/v1";
const SIDECAR = "operator-judgments.json";
// Reserve the documented 64k context ceiling, plus bounded typed output. No
// unsupported max_tokens parameter is sent to System One. Billing is input-only.
const REQUEST_TOKENS = 65_536 + 16_384;
const REQUEST_DOLLARS = 0.003; // rounded up from 65,536 × $0.042 / 1M (2026-09-19)
export interface JudgmentLimits { maxRequests: number; maxTokens: number; maxDollars: number; maxConcurrent: number; timeoutMs: number; }
const DEFAULT_LIMITS: JudgmentLimits = { maxRequests: 4, maxTokens: 300_000, maxDollars: 0.02, maxConcurrent: 2, timeoutMs: 10_000 };
export interface JudgmentRequest {
  runId: string;
  draftRevisionId: string;
  scopeId: string;
  /** Stable server-owned purpose; independent questions sharing evidence batch here. */
  batchId: string;
  questionVersion: string;
  questions: Record<string, ChoiceQuestion>;
  /** Fresh explicit inputs for dependent stages. Never inferred from prior calls. */
  inputs: EntryType;
}
export interface JudgmentArtifact {
  schemaVersion: typeof SCHEMA;
  scopeId: string;
  batchId: string;
  questionVersion: string;
  modelId: string;
  evidenceDigest: string;
  inputHash: string;
  attemptId: string;
  sourceDraftRevisionId: string;
  answers: Record<string, ChoiceResponse>;
}
export type JudgmentOutcome = { state: "accepted"; draftRevisionId: string; artifact: JudgmentArtifact; replayed: boolean }
  | { state: "unavailable" | "failed" | "cancelled" | "limit" | "conflict" };
export interface JudgmentProvider {
  readonly modelId: string;
  evaluate(request: { state: EntryType; questions: Record<string, ChoiceQuestion> }, signal: AbortSignal, timeoutMs?: number): Promise<{ json?: unknown; usage: OperatorUsage; failed?: boolean }>;
}
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(record(value)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function usageOf(json: unknown): OperatorUsage {
  const usage = record(record(json).usage);
  const result: OperatorUsage = {};
  if (Number.isSafeInteger(usage.input_tokens) && Number(usage.input_tokens) >= 0) result.inputTokens = Number(usage.input_tokens);
  if (Number.isSafeInteger(usage.output_tokens) && Number(usage.output_tokens) >= 0) result.outputTokens = Number(usage.output_tokens);
  // Current SDK reports tokens only. Never derive a *measured* price from them.
  if (typeof usage.cost_usd === "number" && Number.isFinite(usage.cost_usd) && usage.cost_usd >= 0) result.measuredCostUsd = usage.cost_usd;
  return result;
}

/** JEV_API is resolved only here; SDK env defaults cannot redirect or log payloads. */
export function createJevProvider(env: NodeJS.Dict<string> = process.env, transport?: Fetch): JudgmentProvider | undefined {
  const apiKey = env.JEV_API?.trim();
  if (!apiKey) return undefined;
  const client = new TypeSafeClient({ apiKey, baseURL: "https://api.typesafe.ai", defaultModel: JEV_MODEL, logLevel: "off", retry: { maxRetries: 0 }, ...(transport ? { fetch: transport } : {}) });
  return {
    modelId: JEV_MODEL,
    async evaluate(request, signal, timeoutMs = DEFAULT_LIMITS.timeoutMs) {
      try {
        if (canonical(redact(request.questions, [apiKey], false)) !== canonical(request.questions)) return { failed: true, usage: {} };
        const safe = { questions: request.questions, state: redact(request.state, [apiKey]) as EntryType };
        const json: unknown = await client.systemOne({ ...safe, model: JEV_MODEL }, { signal, timeout: timeoutMs, retry: { maxRetries: 0 } });
        return { json, usage: usageOf(json) };
      } catch (error) {
        // Never retain error message, response body, SDK instance, or cause.
        return { failed: true, usage: usageOf(error instanceof APIError ? error.body : undefined) };
      }
    },
  };
}

/** Redact structured state without corrupting JSON, and never forward secret fields. */
function redact(value: unknown, secrets: readonly string[], sensitiveFields = true): unknown {
  if (typeof value === "string") return secrets.reduce((text, secret) => redactGatewayText(text, secret), redactGatewayText(value));
  if (Array.isArray(value)) return value.map(item => redact(item, secrets, sensitiveFields));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [String(redact(key, secrets, false)), sensitiveFields && /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)$/i.test(key) ? "[redacted]" : redact(item, secrets, sensitiveFields)]));
  return value;
}

export function validateJudgmentAnswers(json: unknown, questions: Record<string, ChoiceQuestion>, modelId: string): Record<string, ChoiceResponse> {
  const response = record(json); const answers = record(response.answers);
  const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  const sameKeys = (a: object, b: object) => Object.keys(a).sort().join("\0") === Object.keys(b).sort().join("\0");
  if (response.model !== modelId || !sameKeys(answers, questions)) throw new Error("invalid judgment response");
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const answer = record(answers[id]); const probabilities = record(answer.probabilities);
    if (answer.type !== "choice" || typeof answer.choice !== "string" || !Object.hasOwn(question.criteria, answer.choice) || !probability(answer.confidence) || !sameKeys(probabilities, question.criteria) || !Object.values(probabilities).every(probability)) throw new Error("invalid judgment answer");
    const values = Object.values(probabilities) as number[];
    if (Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.0001 || Number(probabilities[answer.choice]) < Math.max(...values)) throw new Error("invalid judgment distribution");
    return [id, { type: "choice", choice: answer.choice, confidence: answer.confidence, probabilities: probabilities as Record<string, number> }];
  }));
}

/**
 * Explicit server-only operation, not an automatic scan pass. One call = one
 * durable attempt = one batched provider request. Retrying invokes this seam
 * again against the current draft; accepted siblings and publications are bytes.
 */
export async function runOperatorJudgments(options: { store: OperatorStore; publication: OperatorPublicationService; request: JudgmentRequest; provider?: JudgmentProvider; limits?: Partial<JudgmentLimits>; signal?: AbortSignal; secrets?: readonly string[] }): Promise<JudgmentOutcome> {
  const { store, publication, provider } = options;
  const request = structuredClone(options.request);
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) if (!Number.isFinite(value) || value < 0 || (key !== "maxDollars" && !Number.isSafeInteger(value))) throw new Error("invalid judgment limits");
  if (limits.timeoutMs === 0) throw new Error("invalid judgment deadline");
  const cancelled = () => Boolean(options.signal?.aborted || store.isCancelled(request.runId));
  if (cancelled()) return { state: "cancelled" };
  const snapshot = store.snapshot();
  const run = snapshot.runs.find(row => row.runId === request.runId);
  const draft = snapshot.drafts.find(row => row.draftRevisionId === request.draftRevisionId && row.runId === request.runId);
  if (!draft || run?.draftRevisionId !== draft.draftRevisionId) return { state: "conflict" };
  // Completed publications may be explicitly reopened by judge; active scans,
  // failed and interrupted runs require their existing recovery/retry owner.
  const admissible = (state: string) => state === "awaiting_review" || state === "complete";
  if (!admissible(run.state)) return { state: "conflict" };
  const dataFailure = (): JudgmentOutcome => {
    store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: `judgment:${digest([request.scopeId, request.batchId])}`, kind: "judgment", state: "failed", usage: {}, error: "judgment invalid data" });
    return { state: "failed" };
  };
  try {
  const artifact = snapshot.artifacts.find(row => row.artifactRevisionId === draft.artifactRevisionId)!;
  const read = (file: string): unknown => { const bytes = store.readArtifactFile(artifact.artifactRevisionId, file); return bytes ? JSON.parse(bytes.toString()) : {}; };
  const observed = record(read("snapshot.json"));
  const entity = (Array.isArray(observed.entities) ? observed.entities : []).find(value => record(value).id === request.scopeId);
  if (!entity) throw new Error("unknown judgment scope");
  const explanations = record(read("operator-explanations.json"));
  const explanation = (Array.isArray(explanations.explanations) ? explanations.explanations : []).find(value => record(value).scopeId === request.scopeId) ?? null;
  const scope = (Array.isArray(explanations.scopes) ? explanations.scopes : []).find(value => record(value).scopeId === request.scopeId) ?? null;
  const evidence = { sourceCommitSha: artifact.sourceCommitSha ?? null, entity, scope, explanation, relations: (Array.isArray(observed.relations) ? observed.relations : []).filter(value => record(value).from === request.scopeId || record(value).to === request.scopeId) };
  const secrets = [...(options.secrets ?? []), ...[process.env.JEV_API, process.env.OKIE_LLM_API_KEY, process.env.OPENROUTER_API_KEY, process.env.OPENAI_API_KEY, process.env.GITHUB_TOKEN].filter((value): value is string => Boolean(value))];
  const safeId = (id: string) => /^[A-Za-z][A-Za-z0-9_.:-]{0,120}$/.test(id) && redact(id, secrets) === id && !["__proto__", "constructor", "prototype"].includes(id);
  if (![request.batchId, request.questionVersion, request.scopeId].every(safeId)) throw new Error("invalid judgment identity");
  if (!Object.keys(request.questions).length || Object.keys(request.questions).length > 8) throw new Error("judgment batch limit");
  for (const [id, question] of Object.entries(request.questions)) {
    if (!safeId(id) || question.type !== "choice" || !question.instructions || Object.keys(question.criteria).length < 2 || Object.keys(question.criteria).length > 8 || !Object.keys(question.criteria).every(safeId)) throw new Error("invalid judgment question");
  }
  // Snapshot caller-owned inputs before yielding so mutation cannot change a request/hash.
  // Trusted schemas are immutable. Secret-bearing schemas fail closed instead
  // of silently changing the meaning of a question or banning domain vocabulary.
  if (canonical(redact(request.questions, secrets, false)) !== canonical(request.questions)) return dataFailure();
  const body = JSON.parse(JSON.stringify({ state: redact({ evidence, inputs: request.inputs }, secrets), questions: request.questions })) as { state: EntryType; questions: Record<string, ChoiceQuestion> };
  if (Buffer.byteLength(JSON.stringify(body)) > 24_000) throw new Error("judgment state limit");
  const modelId = provider?.modelId ?? JEV_MODEL;
  if (!/^jev-\d+\.\d+\.\d+$/.test(modelId) || !safeId(modelId)) throw new Error("judgment requires pinned model");
  const evidenceDigest = digest(evidence);
  const inputHash = digest({ schema: SCHEMA, modelId, questionVersion: request.questionVersion, evidenceDigest, body });
  const previous = record(read(SIDECAR));
  const rows = (Array.isArray(previous.judgments) ? previous.judgments : []) as JudgmentArtifact[];
  const cached = rows.find(row => row.scopeId === request.scopeId && row.batchId === request.batchId && row.inputHash === inputHash && row.schemaVersion === SCHEMA);
  if (cached) {
    validateJudgmentAnswers({ model: cached.modelId, answers: cached.answers }, body.questions, modelId);
    return { state: "accepted", draftRevisionId: draft.draftRevisionId, artifact: cached, replayed: true };
  }
  const attempt = store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: `judgment:${digest([request.scopeId, request.batchId])}`, kind: "judgment", state: "running", provider: "typesafe", modelId, inputHash });
  const finish = (state: Exclude<JudgmentOutcome["state"], "accepted">, usage: OperatorUsage = {}): JudgmentOutcome => {
    store.updateAttempt(attempt.attemptId, { state: state === "cancelled" ? "cancelled" : "failed", usage, error: `judgment ${state}` });
    return { state };
  };
  if (!provider) return finish("unavailable");
  const ledger = createOperatorBudgetLedger(limits, { store, runId: run.runId, kind: "judgment" });
  const reservation = ledger.reserve(REQUEST_TOKENS, REQUEST_DOLLARS, attempt.attemptId);
  if (!reservation) return finish("limit");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(cancel, limits.timeoutMs);
  const poll = setInterval(() => { if (cancelled()) cancel(); }, 50);
  let usage: OperatorUsage = {};
  try {
    // Subscribe before entering a provider, which may abort synchronously.
    const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("judgment aborted")), { once: true }));
    const reply = await Promise.race([
      Promise.resolve().then(() => {
        if (cancelled() || controller.signal.aborted) throw new Error("judgment aborted");
        return provider.evaluate(body, controller.signal, limits.timeoutMs);
      }),
      aborted,
    ]);
    usage = reply.usage;
    if (cancelled()) return finish("cancelled", usage);
    if (controller.signal.aborted || reply.failed) return finish("failed", usage);
    const answers = validateJudgmentAnswers(reply.json, body.questions, modelId);
    const accepted: JudgmentArtifact = { schemaVersion: SCHEMA, scopeId: request.scopeId, batchId: request.batchId, questionVersion: request.questionVersion, modelId, evidenceDigest, inputHash, attemptId: attempt.attemptId, sourceDraftRevisionId: draft.draftRevisionId, answers };
    return store.withExclusiveLock(() => {
      if (cancelled()) return finish("cancelled", usage);
      const current = store.snapshot().runs.find(row => row.runId === run.runId);
      if (current?.draftRevisionId !== draft.draftRevisionId || !admissible(current.state)) return finish("conflict", usage);
      const files = Object.fromEntries(artifact.files.map(file => [file, store.readArtifactFile(artifact.artifactRevisionId, file)!]));
      const next = store.writeArtifactRevision({ repositoryId: draft.repositoryId, ...(artifact.sourceCommitSha ? { sourceCommitSha: artifact.sourceCommitSha } : {}), files: { ...files, [SIDECAR]: JSON.stringify({ schemaVersion: SCHEMA, judgments: [...rows.filter(row => row.scopeId !== request.scopeId || row.batchId !== request.batchId), accepted] }) } });
      const nextDraft = publication.createDraftRevision({ runId: run.runId, artifactRevisionId: next.artifactRevisionId, coverage: draft.coverage });
      store.updateAttempt(attempt.attemptId, { state: "accepted", usage, validation: { accepted: true, validator: SCHEMA, evidenceHash: evidenceDigest } });
      store.updateRun(run.runId, { state: "awaiting_review" });
      return { state: "accepted", draftRevisionId: nextDraft.draftRevisionId, artifact: accepted, replayed: false };
    });
  } catch {
    return finish(cancelled() ? "cancelled" : "failed", usage);
  } finally {
    clearTimeout(timeout); clearInterval(poll); options.signal?.removeEventListener("abort", cancel);
    ledger.settle(reservation, usage);
  }
  } catch {
    return dataFailure();
  }
}
