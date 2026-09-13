import { createHash, randomUUID } from "node:crypto";
import { scrubGithubTokens } from "@okie/scan";
import { parseChatCompletionDocument } from "./enrichment.js";
import { resolveLlmGatewayConfig, type GatewayUsage, type LlmChatCompletionResult } from "./llmGateway.js";

/**
 * CLA-134's runtime boundary.  This deliberately does not own draft storage or
 * publication: CLA-132 binds this small, durable seam to its store.
 */
export type OperatorExplanationState = "queued" | "running" | "accepted" | "failed" | "stale" | "cancelled";

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
  role: "coordinator" | "owner";
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
  maxScopes: number;
  /** Bounds all supplied nodes as well as actual gateway tasks. */
  maxNodes: number;
  maxTokens: number;
  maxDollars: number;
}

export interface OperatorEnrichmentRunOptions {
  draftRevisionId: string;
  scopes: readonly OperatorEnrichmentScope[];
  store: OperatorEnrichmentStore;
  gateway?: OperatorEnrichmentGateway;
  limits?: Partial<OperatorEnrichmentLimits>;
  now?: () => number;
  nextAttemptId?: () => string;
  cancelled?: () => boolean | Promise<boolean>;
  /** Bind to CLA-38's process-wide ledger. Called even for malformed replies. */
  onUsage?: (usage: GatewayUsage) => void | Promise<void>;
  /** Atomic durable/global reservation hook, called before every provider request. */
  admitRequest?: (request: { modelId: string; role: "coordinator" | "owner"; maxOutputTokens: number }) => boolean | Promise<boolean>;
  /** Retry one selected scope; successful siblings remain untouched. */
  retryScopeId?: string;
  /** Explicit parent refresh; normal retry only marks ancestors stale. */
  refreshStale?: boolean;
}

export interface OperatorEnrichmentRunResult {
  modelId: string;
  attempts: OperatorEnrichmentAttempt[];
  staleScopes: string[];
  stopped: "complete" | "cancelled" | "limit" | "unavailable";
}

const DEFAULT_LIMITS: OperatorEnrichmentLimits = { maxDepth: 5, maxConcurrent: 2, maxScopes: 64, maxNodes: 256, maxTokens: 200_000, maxDollars: 1 };
const MAX_OUTPUT_TOKENS = 4096;

function usageTotal(usage?: GatewayUsage): number { return usage?.totalTokens ?? 0; }
function usageCost(usage?: GatewayUsage): number { return usage?.costUsd ?? 0; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isEvidence(value: unknown): value is OperatorEvidenceRef {
  return isObject(value) && (typeof value.entityId === "string" || typeof value.path === "string")
    && (value.startLine === undefined || typeof value.startLine === "number") && (value.endLine === undefined || typeof value.endLine === "number");
}
function evidenceKey(ref: OperatorEvidenceRef): string { return `${ref.entityId ?? ""}|${ref.path ?? ""}|${ref.startLine ?? ""}|${ref.endLine ?? ""}`; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function inputHash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

/** Strictly accepts explanation-shaped output; it cannot alter scanner facts. */
export function validateOperatorExplanation(value: unknown, allowedEvidence: readonly OperatorEvidenceRef[]): OperatorExplanation {
  if (!isObject(value) || typeof value.summary !== "string" || !value.summary.trim()) throw new Error("malformed explanation: summary is required");
  if (!Array.isArray(value.evidence) || !value.evidence.every(isEvidence)) throw new Error("malformed explanation: evidence is required");
  const allowed = new Set(allowedEvidence.map(evidenceKey));
  const evidence = value.evidence as OperatorEvidenceRef[];
  if (evidence.some(ref => !allowed.has(evidenceKey(ref)))) throw new Error("rejected explanation: unknown evidence reference");
  if (value.roleWithinParent !== undefined && typeof value.roleWithinParent !== "string") throw new Error("malformed explanation: roleWithinParent");
  if (value.interactions !== undefined && (!Array.isArray(value.interactions) || !value.interactions.every(item => typeof item === "string"))) throw new Error("malformed explanation: interactions");
  let diagram: OperatorExplanation["diagram"]; let diagramError: string | undefined;
  if (value.diagram !== undefined) {
    const entityIds = new Set(allowedEvidence.map(ref => ref.entityId).filter((id): id is string => id !== undefined));
    const candidate = value.diagram;
    if (!isObject(candidate) || !Array.isArray(candidate.nodes) || !candidate.nodes.every(id => typeof id === "string" && entityIds.has(id)) || !Array.isArray(candidate.edges) || !candidate.edges.every(edge => isObject(edge) && typeof edge.from === "string" && typeof edge.to === "string" && entityIds.has(edge.from) && entityIds.has(edge.to) && (edge.label === undefined || typeof edge.label === "string"))) diagramError = "rejected diagram: unknown or malformed entity reference";
    else diagram = { nodes: candidate.nodes as string[], edges: candidate.edges as Array<{ from: string; to: string; label?: string }> };
  }
  return { summary: value.summary.trim(), evidence, ...(typeof value.roleWithinParent === "string" ? { roleWithinParent: value.roleWithinParent } : {}), ...(Array.isArray(value.interactions) ? { interactions: value.interactions as string[] } : {}), ...(diagram ? { diagram } : {}), ...(diagramError ? { diagramError } : {}) };
}

/** Parses a coordinator response and rejects assignments outside its owned children. */
export function validateDelegation(value: unknown, scopeId: string, allowedChildren: readonly string[]): string[] {
  if (!isObject(value) || !Array.isArray(value.assignments)) throw new Error("malformed coordinator assignments");
  const allowed = new Set(allowedChildren);
  const assigned: string[] = [];
  for (const assignment of value.assignments) {
    if (!isObject(assignment) || typeof assignment.scopeId !== "string") throw new Error("malformed coordinator assignment");
    if (!allowed.has(assignment.scopeId) || assignment.scopeId === scopeId || assigned.includes(assignment.scopeId)) throw new Error("rejected coordinator assignment");
    assigned.push(assignment.scopeId);
  }
  return assigned.sort();
}

function completionText(result: LlmChatCompletionResult): unknown { return parseChatCompletionDocument(result.json); }
function bodyFor(model: string, scope: OperatorEnrichmentScope, children: readonly { scopeId: string; explanation?: OperatorExplanation; state: OperatorExplanationState }[]): Record<string, unknown> {
  return { model, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: "system", content: "Use only supplied deterministic facts and evidence. Return JSON with summary, evidence, optional roleWithinParent, interactions, and optional structured diagram {nodes,edges}; diagram IDs must be supplied entity IDs." }, { role: "user", content: scrubGithubTokens(JSON.stringify({ promptVersion: "operator-enrichment/v1", scope: { scopeId: scope.scopeId, name: scope.name, kind: scope.kind, facts: scope.facts, allowedEvidence: scope.allowedEvidence }, children })) }], response_format: { type: "json_object" } };
}
function coordinatorBody(model: string, scope: OperatorEnrichmentScope, directChildren: readonly string[]): Record<string, unknown> {
  return { model, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: "system", content: "You are a coordinator. Return JSON only: {assignments:[{scopeId:string}]}. You may assign only the supplied direct descendants. Do not execute tools, access URLs, or request files." }, { role: "user", content: scrubGithubTokens(JSON.stringify({ promptVersion: "operator-enrichment/v1", role: "coordinator", scopeId: scope.scopeId, directChildren })) }], response_format: { type: "json_object" } };
}

export async function runOperatorEnrichment(options: OperatorEnrichmentRunOptions): Promise<OperatorEnrichmentRunResult> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const modelId = options.gateway?.modelId ?? resolveLlmGatewayConfig().modelId;
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
  const target = options.retryScopeId ? new Set([options.retryScopeId, ...(options.refreshStale ? ancestors(options.retryScopeId) : [])]) : new Set(options.scopes.map(scope => scope.scopeId));
  if (options.retryScopeId && !byId.has(options.retryScopeId)) throw new Error("unknown retry scope");
  const staleScopes = options.retryScopeId ? ancestors(options.retryScopeId) : [];
  if (staleScopes.length) await options.store.markStale(staleScopes);
  const attempts: OperatorEnrichmentAttempt[] = []; let tokens = 0; let dollars = 0; let requests = 0; let stopped: OperatorEnrichmentRunResult["stopped"] = options.gateway ? "complete" : "unavailable";
  let inFlight = 0;
  const waiters: Array<() => void> = [];
  const withPermit = async <T>(role: "coordinator" | "owner", work: () => Promise<T>): Promise<T> => {
    if (inFlight >= Math.max(1, limits.maxConcurrent)) await new Promise<void>(resolve => waiters.push(resolve));
    inFlight += 1;
    try {
      if (await options.cancelled?.()) { stopped = "cancelled"; throw new Error("enrichment cancelled"); }
      if (requests >= limits.maxScopes || tokens >= limits.maxTokens || dollars >= limits.maxDollars || !(await options.admitRequest?.({ modelId, role, maxOutputTokens: MAX_OUTPUT_TOKENS }) ?? true)) { stopped = "limit"; throw new Error("enrichment request limit reached"); }
      requests += 1;
      return await work();
    } finally { inFlight -= 1; waiters.shift()?.(); }
  };
  const execute = async (scope: OperatorEnrichmentScope): Promise<void> => {
    if (await options.cancelled?.()) { stopped = "cancelled"; return; }
    let delegated = children.get(scope.scopeId) ?? [];
    if (delegated.length && options.gateway && target.has(scope.scopeId)) {
      const id = options.nextAttemptId?.() ?? randomUUID();
      const attempt: OperatorEnrichmentAttempt = { attemptId: id, scopeId: scope.scopeId, role: "coordinator", state: "running", modelId, inputHash: inputHash({ promptVersion: "operator-enrichment/v1", modelId, directChildren: delegated }), createdAt: now(), updatedAt: now() };
      attempts.push(attempt); await options.store.createAttempt(attempt);
      try {
        const reply = await withPermit("coordinator", () => options.gateway!.chatCompletions(coordinatorBody(modelId, scope, delegated)));
        if (reply.usage) { tokens += usageTotal(reply.usage); dollars += usageCost(reply.usage); await options.onUsage?.(reply.usage); attempt.usage = reply.usage; }
        if (await options.cancelled?.()) { stopped = "cancelled"; const patch = { state: "cancelled" as const, updatedAt: now(), ...(attempt.usage ? { usage: attempt.usage } : {}) }; await options.store.updateAttempt(id, patch); Object.assign(attempt, patch); return; }
        delegated = validateDelegation(completionText(reply), scope.scopeId, delegated);
        const patch = { state: "accepted" as const, updatedAt: now(), ...(reply.usage ? { usage: reply.usage } : {}) }; await options.store.updateAttempt(id, patch); Object.assign(attempt, patch);
      } catch (error) {
        delegated = [];
        const patch = { state: "failed" as const, updatedAt: now(), ...(attempt.usage ? { usage: attempt.usage } : {}), error: scrubGithubTokens(error instanceof Error ? error.message : String(error)) }; await options.store.updateAttempt(id, patch); Object.assign(attempt, patch);
      }
    }
    await Promise.all(delegated.map(childId => execute(byId.get(childId)!)));
    if (!target.has(scope.scopeId)) return;
    if (stopped === "cancelled" || stopped === "limit") return;
    const childInputs = await Promise.all((children.get(scope.scopeId) ?? []).map(async scopeId => { const latest = await options.store.latestAttempt(scopeId); const explanation = await options.store.getAcceptedExplanation(scopeId); return { scopeId, state: latest?.state ?? "failed", ...(explanation ? { explanation } : {}) }; }));
    const id = options.nextAttemptId?.() ?? randomUUID();
    const hash = inputHash({ promptVersion: "operator-enrichment/v1", modelId, facts: scope.facts, allowedEvidence: scope.allowedEvidence, children: childInputs.map(input => ({ scopeId: input.scopeId, state: input.state, explanation: input.explanation })) });
    const attempt: OperatorEnrichmentAttempt = { attemptId: id, scopeId: scope.scopeId, role: "owner", state: "running", modelId, inputHash: hash, createdAt: now(), updatedAt: now() }; attempts.push(attempt); await options.store.createAttempt(attempt);
    if (!options.gateway) { const patch = { state: "failed" as const, updatedAt: now(), error: "no enrichment gateway configured" }; await options.store.updateAttempt(id, patch); Object.assign(attempt, patch); return; }
    try {
      const reply = await withPermit("owner", () => options.gateway!.chatCompletions(bodyFor(modelId, scope, childInputs)));
      if (reply.usage) { tokens += usageTotal(reply.usage); dollars += usageCost(reply.usage); await options.onUsage?.(reply.usage); attempt.usage = reply.usage; }
      if (await options.cancelled?.()) { stopped = "cancelled"; const patch = { state: "cancelled" as const, updatedAt: now(), ...(attempt.usage ? { usage: attempt.usage } : {}) }; await options.store.updateAttempt(id, patch); Object.assign(attempt, patch); return; }
      const explanation = validateOperatorExplanation(completionText(reply), scope.allowedEvidence);
      await options.store.putAcceptedExplanation(scope.scopeId, explanation, id, hash);
      const patch = { state: "accepted" as const, updatedAt: now(), ...(reply.usage ? { usage: reply.usage } : {}) }; await options.store.updateAttempt(id, patch); Object.assign(attempt, patch);
    } catch (error) {
      const patch = { state: "failed" as const, updatedAt: now(), ...(attempt.usage ? { usage: attempt.usage } : {}), error: scrubGithubTokens(error instanceof Error ? error.message : String(error)) }; await options.store.updateAttempt(id, patch); Object.assign(attempt, patch);
    }
  };
  await Promise.all(options.scopes.filter(scope => !scope.parentScopeId).sort((a, b) => a.scopeId.localeCompare(b.scopeId)).map(execute));
  return { modelId, attempts, staleScopes, stopped };
}
