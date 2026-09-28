import { createHash, randomUUID } from "node:crypto";
import { scrubGithubTokens } from "@okie/scan";
import { parseChatCompletionDocument } from "./enrichment.js";
import { classifyLlmGatewayFailure, resolveLlmGatewayConfig, type GatewayUsage, type LlmChatCompletionResult } from "./llmGateway.js";

/**
 * CLA-134's runtime boundary.  This deliberately does not own draft storage or
 * publication: CLA-132 binds this small, durable seam to its store.
 */
export type OperatorExplanationState = "queued" | "running" | "accepted" | "failed" | "stale" | "cancelled";
/** A child passed to its parent's prompt; "not run" only appears for retries of partially enriched drafts. */
export type OperatorChildState = OperatorExplanationState | "not run";

export interface OperatorEvidenceRef { entityId?: string; path?: string; startLine?: number; endLine?: number; }
export interface OperatorExplanation {
  summary: string;
  roleWithinParent?: string;
  interactions?: string[];
  evidence: OperatorEvidenceRef[];
  /** Renderer turns these validated entity references into Mermaid later. */
  diagram?: { nodes: string[]; edges: Array<{ from: string; to: string; label?: string }> };
  diagramError?: string;
}

export interface OperatorEnrichmentScope {
  scopeId: string;
  parentScopeId?: string;
  name: string;
  kind: "softwareSystem" | "container" | "component" | "code";
  /** Scanner-created, token-scrubbed bounded facts. They are never overwritten. */
  facts: unknown;
  allowedEvidence: readonly OperatorEvidenceRef[];
}

export interface OperatorEnrichmentAttempt {
  attemptId: string;
  scopeId: string;
  role: "owner";
  state: OperatorExplanationState;
  modelId: string;
  createdAt: number;
  updatedAt: number;
  usage?: GatewayUsage;
  /** Hash of the deterministic facts + accepted-child inputs used for this attempt. */
  inputHash: string;
  error?: string;
}

export interface OperatorEnrichmentStore {
  createAttempt(attempt: OperatorEnrichmentAttempt): Promise<void>;
  updateAttempt(attemptId: string, patch: Partial<Pick<OperatorEnrichmentAttempt, "state" | "updatedAt" | "usage" | "error">>): Promise<void>;
  latestAttempt(scopeId: string): Promise<OperatorEnrichmentAttempt | undefined>;
  /**
   * Write an immutable explanation version, then update the draft's current pointer.
   * A frozen publication must retain its selected version id and never dereference
   * this mutable pointer.
   */
  putAcceptedExplanation(scopeId: string, explanation: OperatorExplanation, attemptId: string, inputHash: string): Promise<{ explanationVersionId: string }>;
  getAcceptedExplanation(scopeId: string): Promise<OperatorExplanation | undefined>;
  /** Must persist so a restart cannot silently treat a parent as fresh. */
  markStale(scopeIds: readonly string[]): Promise<void>;
}

export interface OperatorEnrichmentGateway {
  readonly modelId: string;
  chatCompletions(body: Record<string, unknown>): Promise<LlmChatCompletionResult>;
}

export interface OperatorEnrichmentLimits {
  maxDepth: number;
  maxConcurrent: number;
  /** Run-level request cap; admission beyond it stops the run with `stopped = "limit"`. */
  maxScopes: number;
  maxTokens: number;
  maxDollars: number;
}

export interface OperatorAdmission { settle(usage?: GatewayUsage): void | Promise<void>; }

export interface OperatorEnrichmentRunOptions {
  draftRevisionId: string;
  scopes: readonly OperatorEnrichmentScope[];
  store: OperatorEnrichmentStore;
  gateway?: OperatorEnrichmentGateway;
  limits?: Partial<OperatorEnrichmentLimits>;
  now?: () => number;
  nextAttemptId?: () => string;
  cancelled?: () => boolean | Promise<boolean>;
  /** Deepest scope kind attempted in a full run (default "component"; "code" opts symbols in). */
  maxKind?: "component" | "code";
  /**
   * Resolved by the caller (the runner knows the provider): "off" adds
   * `reasoning: { enabled: false }` to leaf requests only (no child inputs; a
   * component with a symbol digest is still a leaf). Parents never get it.
   */
  leafReasoning?: "provider-default" | "off";
  /** Bind to CLA-38's process-wide ledger. Called even for malformed replies. */
  onUsage?: (usage: GatewayUsage) => void | Promise<void>;
  /**
   * Atomic durable/global reservation, called before the attempt row and before
   * network I/O. `false` refuses (scope stays not run, run stops at "limit"); a
   * ticket is settled exactly once after the provider call, success or failure.
   */
  admitRequest?: (request: { modelId: string; role: "owner"; scopeId: string; body: Record<string, unknown>; maxOutputTokens: number }) => OperatorAdmission | boolean | Promise<OperatorAdmission | boolean>;
  /** Retry one selected scope; successful siblings remain untouched. */
  retryScopeId?: string;
  /** Retry several selected scopes in one pass through the same pool (takes precedence over `retryScopeId`). */
  retryScopeIds?: readonly string[];
  /**
   * Batch retry (CLA-258): the unselected ancestors of the selected scopes join the pass and wait on
   * their target children. Such an ancestor re-runs only when one of its children got a new accepted
   * explanation in this pass — its prompt input changed — and none of its in-cap children is still "not run";
   * otherwise it is skipped with no admission, no row and no stale mark. An ancestor with a changed descendant
   * that did not itself get a new accepted explanation (refused, halted, failed, or skipped) is marked stale
   * if it has one.
   * Without this flag a retry marks every accepted ancestor stale up front (the CLA-134 behaviour).
   */
  reReduceAncestors?: boolean;
  /** Explicit parent refresh; normal retry only marks ancestors with an accepted explanation stale. */
  refreshStale?: boolean;
}

export interface OperatorEnrichmentRunResult {
  modelId: string;
  attempts: OperatorEnrichmentAttempt[];
  staleScopes: string[];
  stopped: "complete" | "cancelled" | "limit" | "unavailable";
  /** Unselected ancestors that re-reduce mode skipped because nothing below them changed. */
  skippedScopes?: string[];
}

const DEFAULT_LIMITS: OperatorEnrichmentLimits = { maxDepth: 5, maxConcurrent: 64, maxScopes: 512, maxTokens: 4_000_000, maxDollars: 5 };
const MAX_OUTPUT_TOKENS = 4096;

function usageTotal(usage?: GatewayUsage): number { return usage?.totalTokens ?? 0; }
const addOptional = (left?: number, right?: number) => left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
/** Sum of both calls when a scope is retried once inside the same attempt. */
function addUsage(left: GatewayUsage | undefined, right: GatewayUsage | undefined): GatewayUsage | undefined {
  if (!left || !right) return left ?? right;
  const promptTokens = addOptional(left.promptTokens, right.promptTokens); const completionTokens = addOptional(left.completionTokens, right.completionTokens); const costUsd = addOptional(left.costUsd, right.costUsd);
  return { totalTokens: left.totalTokens + right.totalTokens, ...(promptTokens !== undefined ? { promptTokens } : {}), ...(completionTokens !== undefined ? { completionTokens } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
}
/** The only failures retried once: a request timeout or an empty/missing message content. */
function isRetryOnce(error: unknown): boolean { return classifyLlmGatewayFailure(error) === "timeout" || (error instanceof Error && /missing message content/.test(error.message)); }
function usageCost(usage?: GatewayUsage): number { return usage?.costUsd ?? 0; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isEvidence(value: unknown): value is OperatorEvidenceRef {
  return isObject(value) && (typeof value.entityId === "string" || typeof value.path === "string")
    && (value.startLine === undefined || typeof value.startLine === "number") && (value.endLine === undefined || typeof value.endLine === "number");
}
function evidenceKey(ref: OperatorEvidenceRef): string { return `${ref.entityId ?? ""}|${ref.path ?? ""}|${ref.startLine ?? ""}|${ref.endLine ?? ""}`; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function inputHash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

const INTERACTION_TEXT_KEYS = ["description", "summary", "text", "note", "detail", "label"] as const;
/**
 * Live MiMo runs (CLA-254) returned interactions as relation objects such as
 * {from, to, kind, relationId?, direction?, note?} instead of sentences. Those are
 * rendered to plain text from the model's own fields; nothing is invented. null
 * means absent. Anything else that is not a string or a plain object still rejects.
 */
export function normalizeInteractions(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("malformed explanation: interactions");
  const text = (item: unknown): string => {
    if (typeof item === "string") return item.trim();
    if (!isObject(item)) throw new Error("malformed explanation: interactions");
    const field = (...keys: string[]) => keys.map(key => item[key]).find((candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "")?.trim();
    const edge = [field("from", "source"), field("kind", "type", "relation"), field("to", "target", "peerName", "peerId")].filter(Boolean).join(" ");
    const prose = field(...INTERACTION_TEXT_KEYS);
    return [edge, prose].filter(Boolean).join(": ");
  };
  const items = value.map(text).filter(item => item !== "");
  return items.length ? items : undefined;
}

/** Strictly accepts explanation-shaped output; it cannot alter scanner facts. */
export function validateOperatorExplanation(value: unknown, allowedEvidence: readonly OperatorEvidenceRef[]): OperatorExplanation {
  if (!isObject(value) || typeof value.summary !== "string" || !value.summary.trim()) throw new Error("malformed explanation: summary is required");
  if (!Array.isArray(value.evidence) || !value.evidence.every(isEvidence)) throw new Error("malformed explanation: evidence is required");
  const allowed = new Set(allowedEvidence.map(evidenceKey));
  // Canonical fields only: models decorate refs with note/quote/confidence, which must not be stored as evidence.
  const evidence = (value.evidence as OperatorEvidenceRef[]).map(ref => ({ ...(ref.entityId !== undefined ? { entityId: ref.entityId } : {}), ...(ref.path !== undefined ? { path: ref.path } : {}), ...(ref.startLine !== undefined ? { startLine: ref.startLine } : {}), ...(ref.endLine !== undefined ? { endLine: ref.endLine } : {}) }));
  if (evidence.some(ref => !allowed.has(evidenceKey(ref)))) throw new Error("rejected explanation: unknown evidence reference");
  if (value.roleWithinParent !== undefined && value.roleWithinParent !== null && typeof value.roleWithinParent !== "string") throw new Error("malformed explanation: roleWithinParent");
  const interactions = normalizeInteractions(value.interactions);
  let diagram: OperatorExplanation["diagram"]; let diagramError: string | undefined;
  if (value.diagram !== undefined && value.diagram !== null) {
    const entityIds = new Set(allowedEvidence.map(ref => ref.entityId).filter((id): id is string => id !== undefined));
    const candidate = value.diagram;
    if (!isObject(candidate) || !Array.isArray(candidate.nodes) || !candidate.nodes.every(id => typeof id === "string" && entityIds.has(id)) || !Array.isArray(candidate.edges) || !candidate.edges.every(edge => isObject(edge) && typeof edge.from === "string" && typeof edge.to === "string" && entityIds.has(edge.from) && entityIds.has(edge.to) && (edge.label === undefined || typeof edge.label === "string"))) diagramError = "rejected diagram: unknown or malformed entity reference";
    else diagram = { nodes: candidate.nodes as string[], edges: candidate.edges as Array<{ from: string; to: string; label?: string }> };
  }
  return { summary: value.summary.trim(), evidence, ...(typeof value.roleWithinParent === "string" && value.roleWithinParent.trim() ? { roleWithinParent: value.roleWithinParent.trim() } : {}), ...(interactions ? { interactions } : {}), ...(diagram ? { diagram } : {}), ...(diagramError ? { diagramError } : {}) };
}

function completionText(result: LlmChatCompletionResult): unknown { return parseChatCompletionDocument(result.json); }
const PROMPT_VERSION = "operator-enrichment/v2";
/** Output schema spelled out verbatim: live probes showed object-shaped interactions, null roles and invented refs without it. */
export const OPERATOR_OUTPUT_SCHEMA_PROMPT = "Use only supplied deterministic facts and evidence. Return one JSON object only, exactly this shape: {\"summary\": string (2-4 sentences, specific to this code), \"roleWithinParent\": string (optional; omit rather than null), \"interactions\": string[] (optional; each a short plain-text sentence, not an object), \"evidence\": [{\"entityId\": string, \"path\": string, \"startLine\"?: number, \"endLine\"?: number}] (copy entries verbatim from allowedEvidence; no other fields; at least one), \"diagram\": {\"nodes\": string[], \"edges\": [{\"from\": string, \"to\": string, \"label\"?: string}]} (optional; node ids must be entityIds from allowedEvidence)}.";
const PARENT_PROMPT = " This scope has child explanations: synthesise how the children fit together to serve this scope rather than restating each child.";
/** JSON-character budget for a component's below-cap symbol digest. */
export const SYMBOL_DIGEST_BUDGET = 6000;
/** Per-line cap on digest heads, so one minified line cannot consume the budget. */
export const DIGEST_LINE_CHARS = 160;
/** Parents cannot cite child evidence or reuse child diagrams, so only the prose travels up (live probe: evidence+diagram were ~61% of a 354KB container prompt). */
export function childPromptInput(child: { scopeId: string; explanation?: OperatorExplanation; state: OperatorChildState }): Record<string, unknown> {
  const explanation = child.explanation;
  return { scopeId: child.scopeId, state: child.state, ...(explanation ? { summary: explanation.summary, ...(explanation.roleWithinParent ? { roleWithinParent: explanation.roleWithinParent } : {}), ...(explanation.interactions?.length ? { interactions: explanation.interactions } : {}) } : {}) };
}
function bodyFor(model: string, scope: OperatorEnrichmentScope, children: readonly { scopeId: string; explanation?: OperatorExplanation; state: OperatorChildState }[], reasoningOff = false): Record<string, unknown> {
  return { model, max_tokens: MAX_OUTPUT_TOKENS, ...(reasoningOff ? { reasoning: { enabled: false } } : {}), messages: [{ role: "system", content: OPERATOR_OUTPUT_SCHEMA_PROMPT + (children.length ? PARENT_PROMPT : "") }, { role: "user", content: scrubGithubTokens(JSON.stringify({ promptVersion: PROMPT_VERSION, scope: { scopeId: scope.scopeId, name: scope.name, kind: scope.kind, facts: scope.facts, allowedEvidence: scope.allowedEvidence }, children: children.map(childPromptInput) })) }], response_format: { type: "json_object" } };
}
function firstExcerpt(facts: unknown): { sourceStartLine?: unknown; sourceEndLine?: unknown; startLine?: unknown; endLine?: unknown; text?: unknown; lines?: unknown } | undefined {
  const excerpts = isObject(facts) ? facts.sourceExcerpts : undefined;
  return Array.isArray(excerpts) && isObject(excerpts[0]) ? excerpts[0] : undefined;
}
/**
 * Deterministic digest of a scope's below-cap (code) children: sorted by first
 * source line then scopeId, cut at {@link SYMBOL_DIGEST_BUDGET} JSON chars.
 * Included children's refs become allowed evidence for the parent.
 */
export function symbolDigest(symbols: readonly OperatorEnrichmentScope[]): { symbols: Array<{ name: string; exported: boolean; lines?: string; head?: string }>; symbolCount: number; evidence: OperatorEvidenceRef[] } {
  const line = (scope: OperatorEnrichmentScope) => scope.allowedEvidence[0]?.startLine ?? Number.MAX_SAFE_INTEGER;
  const ordered = [...symbols].sort((left, right) => line(left) - line(right) || (left.scopeId < right.scopeId ? -1 : left.scopeId > right.scopeId ? 1 : 0));
  const digest: Array<{ name: string; exported: boolean; lines?: string; head?: string }> = []; const evidence: OperatorEvidenceRef[] = []; let used = 2;
  for (const symbol of ordered) {
    const excerpt = firstExcerpt(symbol.facts); const exposure = isObject(symbol.facts) && Array.isArray(symbol.facts.exposure) ? symbol.facts.exposure : [];
    const start = typeof excerpt?.sourceStartLine === "number" ? excerpt.sourceStartLine : excerpt?.startLine; const end = typeof excerpt?.sourceEndLine === "number" ? excerpt.sourceEndLine : excerpt?.endLine;
    const text = typeof excerpt?.text === "string" ? excerpt.text : Array.isArray(excerpt?.lines) ? excerpt.lines.filter(item => typeof item === "string").join("\n") : undefined;
    const entry = { name: symbol.name, exported: exposure.some(item => isObject(item) && item.kind === "moduleExport"), ...(typeof start === "number" && typeof end === "number" ? { lines: `${start}-${end}` } : {}), ...(text !== undefined ? { head: text.split("\n").slice(0, 4).map(value => value.length > DIGEST_LINE_CHARS ? `${value.slice(0, DIGEST_LINE_CHARS)}…` : value).join("\n") } : {}) };
    const size = JSON.stringify(entry).length + 1;
    if (used + size > SYMBOL_DIGEST_BUDGET) continue; // one oversized entry must not starve the smaller symbols after it
    used += size; digest.push(entry); evidence.push(...symbol.allowedEvidence.map(ref => ({ ...ref, entityId: symbol.scopeId })));
  }
  return { symbols: digest, symbolCount: symbols.length, evidence };
}
/**
 * Fan out, then reduce (CLA-254). Every in-cap leaf is queued at once; a parent
 * is queued only when all of its in-cap children have settled (accepted or
 * failed), so a container can run while unrelated subtrees are still in flight.
 * Whenever several scopes are ready, parents dispatch before leaves, then by
 * scopeId, so upper levels complete as early as possible. Completion order
 * still depends on provider latency. Component prompts carry a bounded,
 * deterministic digest of their below-cap code symbols (see symbolDigest).
 *
 * Incomplete-parent policy: "not run". A failed child counts as settled and is
 * passed to its parent with state "failed" and no explanation. A child that was
 * never run (budget stop, cancellation) leaves its parent not run as well.
 * Budget admission happens before an attempt row exists: a refused admission
 * records nothing, sets `stopped = "limit"`, and admits no further scopes while
 * in-flight scopes finish and are stored. Scopes below `maxKind` are never
 * attempted; an explicit retry target bypasses that depth cap.
 *
 * Retry-once: a request timeout or an empty/missing message content gets exactly
 * one more request inside the same attempt row (usage summed). The retry is
 * admitted like any request (run cap + admitRequest, after the first ticket is
 * settled); if refused, the attempt fails with the original error and the run
 * stops at "limit". Nothing else is retried here (429s live in the limiter).
 */
export async function runOperatorEnrichment(options: OperatorEnrichmentRunOptions): Promise<OperatorEnrichmentRunResult> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const modelId = options.gateway?.modelId ?? resolveLlmGatewayConfig().modelId;
  const maxKind = options.maxKind ?? "component";
  const inCap = (scope: OperatorEnrichmentScope): boolean => maxKind === "code" || scope.kind !== "code";
  const byId = new Map(options.scopes.map(scope => [scope.scopeId, scope]));
  if (byId.size !== options.scopes.length) throw new Error("duplicate enrichment scope");
  const children = new Map<string, string[]>();
  for (const scope of options.scopes) if (scope.parentScopeId) {
    if (!byId.has(scope.parentScopeId) || scope.parentScopeId === scope.scopeId) throw new Error("invalid enrichment containment");
    const list = children.get(scope.parentScopeId) ?? []; list.push(scope.scopeId); children.set(scope.parentScopeId, list);
  }
  for (const list of children.values()) list.sort();
  const ancestors = (scopeId: string): string[] => { const result: string[] = []; let cursor = byId.get(scopeId)?.parentScopeId; const seen = new Set<string>(); while (cursor) { if (seen.has(cursor)) throw new Error("enrichment containment cycle"); seen.add(cursor); result.push(cursor); cursor = byId.get(cursor)?.parentScopeId; } return result; };
  for (const scope of options.scopes) if (ancestors(scope.scopeId).length > limits.maxDepth) throw new Error("enrichment depth limit exceeded");
  const retryIds = options.retryScopeIds ? [...new Set(options.retryScopeIds)] : options.retryScopeId ? [options.retryScopeId] : undefined;
  if (retryIds && !retryIds.length) throw new Error("empty retry selection");
  if (retryIds?.some(scopeId => !byId.has(scopeId))) throw new Error("unknown retry scope");
  const selected = new Set(retryIds ?? []);
  const reReduce = Boolean(retryIds && options.reReduceAncestors);
  /** Unselected ancestors of the selection, nearest first per selected scope. */
  const selectionAncestors = [...new Set((retryIds ?? []).flatMap(ancestors))].filter(scopeId => !selected.has(scopeId));
  const target = retryIds ? new Set([...retryIds, ...(options.refreshStale || reReduce ? selectionAncestors : [])]) : new Set(options.scopes.filter(inCap).map(scope => scope.scopeId));
  // Nothing can run without a gateway: every scope stays "not run" and no row or stale mark is written.
  if (!options.gateway) return { modelId, attempts: [], staleScopes: [], stopped: "unavailable" };
  const gateway = options.gateway;
  // Only an ancestor with a pinned explanation can go stale; a not-run ancestor stays not run.
  const staleScopes = retryIds && !reReduce ? (await Promise.all(selectionAncestors.map(async scopeId => (await options.store.getAcceptedExplanation(scopeId)) ? scopeId : undefined))).filter((scopeId): scopeId is string => scopeId !== undefined) : [];
  if (staleScopes.length) await options.store.markStale(staleScopes);
  /** Re-reduce mode: `dirty` = a child got a new accepted explanation (input changed); `changedBelow` = any descendant did. */
  const dirty = new Set<string>(); const changedBelow = new Set<string>(); const acceptedNow = new Set<string>(); const skippedScopes: string[] = [];
  const attempts: OperatorEnrichmentAttempt[] = []; let tokens = 0; let dollars = 0; let requests = 0; let stopped: OperatorEnrichmentRunResult["stopped"] = "complete";
  let halted = false;
  const halt = (reason: "cancelled" | "limit") => { if (stopped !== "cancelled") stopped = reason; halted = true; };
  const finish = async (attempt: OperatorEnrichmentAttempt, patch: Partial<Pick<OperatorEnrichmentAttempt, "state" | "updatedAt" | "usage" | "error">>) => { await options.store.updateAttempt(attempt.attemptId, patch); Object.assign(attempt, patch); };
  const errorText = (error: unknown) => scrubGithubTokens(error instanceof Error ? error.message : String(error));
  /** "settled" = accepted or failed; "skipped" = re-reduce found nothing to do (parents may proceed); "unrun" = not run. */
  const execute = async (definition: OperatorEnrichmentScope): Promise<"settled" | "skipped" | "unrun"> => {
    if (halted) return "unrun";
    const reReduceOnly = reReduce && !selected.has(definition.scopeId);
    if (reReduceOnly && !dirty.has(definition.scopeId)) { skippedScopes.push(definition.scopeId); return "skipped"; }
    if (await options.cancelled?.()) { halt("cancelled"); return "unrun"; }
    // Below-cap children are omitted unless they already carry a known state (retry of a code-level scope's parent).
    const belowCap = (children.get(definition.scopeId) ?? []).map(scopeId => byId.get(scopeId)!).filter(child => !inCap(child));
    const digest = belowCap.length ? symbolDigest(belowCap) : undefined;
    const scope: OperatorEnrichmentScope = digest ? { ...definition, facts: { ...(isObject(definition.facts) ? definition.facts : { observed: definition.facts }), symbols: digest.symbols, symbolCount: digest.symbolCount }, allowedEvidence: [...definition.allowedEvidence, ...digest.evidence] } : definition;
    const childInputs = (await Promise.all((children.get(scope.scopeId) ?? []).map(async scopeId => { const latest = await options.store.latestAttempt(scopeId); const explanation = await options.store.getAcceptedExplanation(scopeId); if (!latest && !explanation && !inCap(byId.get(scopeId)!)) return undefined; const state: OperatorChildState = latest?.state ?? (explanation ? "accepted" : "not run"); return { scopeId, state, ...(explanation ? { explanation } : {}) }; }))).filter((input): input is NonNullable<typeof input> => input !== undefined);
    // Incomplete-parent policy also holds for a re-reduce: a parent with a not-run child is not re-run.
    if (reReduceOnly && childInputs.some(input => input.state === "not run")) { skippedScopes.push(definition.scopeId); return "skipped"; }
    const reasoning = options.leafReasoning === "off" && childInputs.length === 0 ? "off" : "provider-default";
    const hash = inputHash({ promptVersion: PROMPT_VERSION, modelId, reasoning, facts: scope.facts, allowedEvidence: scope.allowedEvidence, children: childInputs.map(input => ({ scopeId: input.scopeId, state: input.state, explanation: input.explanation })) });
    const body = bodyFor(modelId, scope, childInputs, reasoning === "off");
    // Admission before the attempt row: the run-level check and increment are synchronous so concurrent scopes cannot over-admit.
    // Admission errors propagate (the runner records a run error); only an explicit refusal is a limit stop.
    const admit = async (): Promise<OperatorAdmission | boolean> => {
      if (requests >= limits.maxScopes || tokens >= limits.maxTokens || dollars >= limits.maxDollars) return false;
      requests += 1;
      const granted = await (options.admitRequest?.({ modelId, role: "owner", scopeId: scope.scopeId, body, maxOutputTokens: MAX_OUTPUT_TOKENS }) ?? true);
      if (!granted) requests -= 1;
      return granted;
    };
    const first = await admit();
    if (!first) { halt("limit"); return "unrun"; }
    let current: OperatorAdmission | boolean | undefined = first; let usage: GatewayUsage | undefined;
    const settleCurrent = async (callUsage?: GatewayUsage) => { const ticket = current; current = undefined; if (ticket && typeof ticket === "object") await ticket.settle(callUsage); };
    const attempt: OperatorEnrichmentAttempt = { attemptId: options.nextAttemptId?.() ?? randomUUID(), scopeId: scope.scopeId, role: "owner", state: "running", modelId, inputHash: hash, createdAt: now(), updatedAt: now() };
    try { await options.store.createAttempt(attempt); } catch (error) { await settleCurrent(); throw error; }
    attempts.push(attempt);
    /** One provider call under the current ticket; settles it with that call's usage. */
    const send = async (): Promise<{ parsed: unknown } | { retry: unknown }> => {
      let reply: LlmChatCompletionResult;
      try { reply = await gateway.chatCompletions(body); } catch (error) { await settleCurrent(); if (isRetryOnce(error)) return { retry: error }; throw error; }
      if (reply.usage) { tokens += usageTotal(reply.usage); dollars += usageCost(reply.usage); await options.onUsage?.(reply.usage); const summed = addUsage(usage, reply.usage)!; usage = summed; attempt.usage = summed; }
      await settleCurrent(reply.usage);
      try { return { parsed: completionText(reply) }; } catch (error) { if (isRetryOnce(error)) return { retry: error }; throw error; }
    };
    let admissionError: { error: unknown } | undefined;
    try {
      let outcome = await send();
      if ("retry" in outcome) {
        // Exactly one more request, admitted (and counted) like any other; a refusal fails the attempt with the original error.
        const original = outcome.retry;
        let second: OperatorAdmission | boolean;
        try { second = await admit(); } catch (error) { admissionError = { error }; throw error; }
        if (!second) { halt("limit"); throw original; }
        current = second;
        outcome = await send();
        if ("retry" in outcome) throw outcome.retry;
      }
      if (await options.cancelled?.()) { halt("cancelled"); await finish(attempt, { state: "cancelled", updatedAt: now(), ...(attempt.usage ? { usage: attempt.usage } : {}) }); return "unrun"; }
      const explanation = validateOperatorExplanation(outcome.parsed, scope.allowedEvidence);
      await options.store.putAcceptedExplanation(scope.scopeId, explanation, attempt.attemptId, hash);
      await finish(attempt, { state: "accepted", updatedAt: now(), ...(attempt.usage ? { usage: attempt.usage } : {}) });
      acceptedNow.add(scope.scopeId); if (reReduce) { if (scope.parentScopeId) dirty.add(scope.parentScopeId); for (const ancestorId of ancestors(scope.scopeId)) changedBelow.add(ancestorId); }
    } catch (error) {
      await settleCurrent();
      await finish(attempt, { state: "failed", updatedAt: now(), ...(attempt.usage ? { usage: attempt.usage } : {}), error: errorText(error) });
      if (admissionError) throw admissionError.error;
    }
    return "settled";
  };
  // Dependency-driven pool: a target scope waits only on its target children.
  const waitingOn = new Map<string, number>();
  for (const scopeId of target) waitingOn.set(scopeId, (children.get(scopeId) ?? []).filter(child => target.has(child)).length);
  // Ready order: parents before leaves so upper levels finish as early as possible, then scopeId.
  const isParent = new Set([...waitingOn].filter(([, count]) => count > 0).map(([scopeId]) => scopeId));
  const byPriority = (left: string, right: string) => Number(isParent.has(right)) - Number(isParent.has(left)) || (left < right ? -1 : left > right ? 1 : 0);
  const ready = [...target].filter(scopeId => waitingOn.get(scopeId) === 0).sort(byPriority);
  const cap = Math.max(1, Math.floor(limits.maxConcurrent));
  let poolFailure: { error: unknown } | undefined;
  try { await new Promise<void>((resolve, reject) => {
    let active = 0; let failure: { error: unknown } | undefined;
    const pump = () => {
      while (!halted && active < cap && ready.length) {
        const scopeId = ready.shift()!; active += 1;
        execute(byId.get(scopeId)!).then(outcome => {
          active -= 1;
          const parentId = byId.get(scopeId)!.parentScopeId;
          if (outcome !== "unrun" && parentId && target.has(parentId)) { const remaining = waitingOn.get(parentId)! - 1; waitingOn.set(parentId, remaining); if (remaining === 0) { ready.push(parentId); ready.sort(byPriority); } }
          pump();
        }, error => { active -= 1; failure ??= { error }; halted = true; pump(); });
      }
      // A thrown scope halts admission; in-flight scopes drain (and settle their tickets) before the run rejects.
      if (active === 0 && (halted || !ready.length)) { if (failure) reject(failure.error); else resolve(); }
    };
    pump();
  }); } catch (error) { poolFailure = { error }; }
  // Honest staleness: any scope (selected or a re-reduce ancestor) with a changed descendant that has no new accepted
  // explanation of its own keeps its old one and is marked stale. Runs even when a scope threw mid-pass.
  const markChangedStale = async () => {
    const unrefreshed = [...changedBelow].filter(scopeId => !acceptedNow.has(scopeId));
    const stale = (await Promise.all(unrefreshed.map(async scopeId => (await options.store.getAcceptedExplanation(scopeId)) ? scopeId : undefined))).filter((scopeId): scopeId is string => scopeId !== undefined);
    if (stale.length) await options.store.markStale(stale);
    staleScopes.push(...stale);
  };
  if (reReduce) { if (poolFailure) await markChangedStale().catch(() => undefined); else await markChangedStale(); }
  if (poolFailure) throw poolFailure.error;
  return { modelId, attempts, staleScopes, stopped, ...(reReduce ? { skippedScopes } : {}) };
}
