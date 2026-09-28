/** Durable, secret-free records for the operator scan workflow (CLA-132). */
export type OperatorRunState = "queued" | "running" | "awaiting_review" | "complete" | "failed" | "cancelled" | "interrupted";
export type OperatorDraftState = "open" | "frozen" | "superseded";
export type OperatorAttemptState = "queued" | "running" | "accepted" | "failed" | "cancelled" | "interrupted";
export type OperatorAttemptKind = "scan" | "enrichment" | "retry" | "refresh" | "judgment";

export interface OperatorRepository {
  repositoryId: string;
  owner: string;
  repo: string;
  slug: string;
}

/** A source identity is separate from artifacts and from a publication version. */
export interface OperatorSourceIdentity extends OperatorRepository {
  ref?: string;
  commitSha?: string;
}

export interface OperatorUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** Undefined means the provider did not report a measured cost. */
  measuredCostUsd?: number;
  estimatedCostUsd?: number;
}

export interface OperatorRun {
  runId: string;
  idempotencyKey: string;
  source: OperatorSourceIdentity;
  state: OperatorRunState;
  createdAt: number;
  updatedAt: number;
  draftRevisionId?: string;
  error?: string;
}

export interface OperatorDraftRevision {
  draftRevisionId: string;
  runId: string;
  repositoryId: string;
  revision: number;
  state: OperatorDraftState;
  /** Version current when the draft was created; used to surface stale review. */
  basePublicationVersionId?: string;
  artifactRevisionId: string;
  /**
   * accepted/failed/notRun/belowCap partition `total` (all scopes) by per-scope state; stale overlays
   * accepted scopes. In scope = total − belowCap. `belowCap` is absent on drafts written before CLA-258.
   */
  coverage: OperatorCoverage;
  createdAt: number;
  frozenAt?: number;
}

export interface OperatorCoverage { total: number; accepted: number; failed: number; notRun: number; stale: number; belowCap?: number }

/**
 * Per-scope enrichment state recorded in an artifact sidecar; `stale` stays a separate overlay.
 * "below cap": never attempted because the scope's kind is below the run's enrichment depth cap.
 * "not run": an in-scope scope left unrun by a budget stop, cancellation, or a missing gateway.
 */
export type OperatorSidecarScopeState = "accepted" | "failed" | "not run" | "below cap";
export type OperatorEnrichmentCap = "component" | "code";
/** C4 kinds ordered by level; `code` is the only kind below the default `component` cap. */
export function belowEnrichmentCap(kind: unknown, cap: OperatorEnrichmentCap): boolean { return cap === "component" && kind === "code"; }

/**
 * Depth cap to assume for a legacy (CLA-254, no `maxKind`) sidecar. Every CLA-254 run used the default
 * "component" cap unless OKIE_LLM_ENRICH_DEPTH=code opted symbols in; a code scope recorded accepted or failed, or with
 * an explanation row, is the signal of such an opt-in run, and then nothing is inferred (undefined). Only immutable
 * sidecar signals count: draft attempts (e.g. an in-flight retry of a code scope) must never flip the inference.
 */
export function legacyEnrichmentCap(scopes: readonly { scopeId: string; kind?: unknown; state?: unknown }[], explained: ReadonlySet<string>): "component" | undefined {
  return scopes.some(scope => scope.kind === "code" && (scope.state === "accepted" || scope.state === "failed" || explained.has(scope.scopeId))) ? undefined : "component";
}

/** Accepted = pinned explanation; failed = attempted without one; untouched scopes keep "failed"/"below cap"; else below cap by kind, or not run. */
export function sidecarState(hasExplanation: boolean, attempted: boolean, prior?: unknown, belowCap = false): OperatorSidecarScopeState {
  if (hasExplanation) return "accepted";
  if (attempted) return "failed";
  if (prior === "failed") return "failed";
  if (prior === "below cap" || belowCap) return "below cap";
  return "not run";
}

/**
 * Coverage is derived from the same per-scope states the scope list shows. A transient state
 * (running/queued/cancelled/interrupted) counts as accepted when an explanation is pinned, else not run.
 */
export function coverageFor(scopes: readonly { scopeId: string; stale?: boolean; state?: string }[], explanations: readonly { scopeId: string }[] = []): Required<OperatorCoverage> {
  const explained = new Set(explanations.map(value => value.scopeId));
  const state = (scope: { scopeId: string; state?: string }) => scope.state === "accepted" || scope.state === "failed" || scope.state === "not run" || scope.state === "below cap" ? scope.state : explained.has(scope.scopeId) ? "accepted" : "not run";
  const counts = { accepted: 0, failed: 0, "not run": 0, "below cap": 0 };
  for (const scope of scopes) counts[state(scope)] += 1;
  return { total: scopes.length, accepted: counts.accepted, failed: counts.failed, notRun: counts["not run"], stale: scopes.filter(scope => scope.stale).length, belowCap: counts["below cap"] };
}

/** Publish gate: any failed, not-run or stale scope, or any in-scope scope not accepted. Below-cap scopes never count. */
export function coverageIncomplete(coverage: OperatorCoverage): boolean {
  return coverage.failed > 0 || (coverage.notRun ?? 0) > 0 || coverage.stale > 0 || coverage.accepted < coverage.total - (coverage.belowCap ?? 0);
}

export interface OperatorScopeAttempt {
  attemptId: string;
  draftRevisionId: string;
  scopeId: string;
  kind: OperatorAttemptKind;
  state: OperatorAttemptState;
  createdAt: number;
  updatedAt: number;
  /** Labels only; never a gateway URL, credential, or provider response. */
  provider?: string;
  modelId?: string;
  usage?: OperatorUsage;
  stale?: boolean;
  error?: string;
  taskId?: string;
  parentTaskId?: string;
  inputHash?: string;
  validation?: { accepted: boolean; validator: string; evidenceHash?: string; reason?: string };
}

/** Immutable accepted explanation content. A subsequent retry always creates another record. */
export interface OperatorAcceptedExplanation {
  explanationVersionId: string;
  draftRevisionId: string;
  scopeId: string;
  attemptId: string;
  inputHash: string;
  content: unknown;
  validation: NonNullable<OperatorScopeAttempt["validation"]>;
  createdAt: number;
}

export interface OperatorEvent {
  eventId: string;
  runId: string;
  at: number;
  type: string;
  detail?: Record<string, string | number | boolean | null>;
}

export interface OperatorArtifactRevision {
  artifactRevisionId: string;
  repositoryId: string;
  sourceCommitSha?: string;
  createdAt: number;
  /** File names only. Bytes are immutable in the artifact directory. */
  files: readonly string[];
  /** Total immutable artifact bytes, excluding filesystem metadata. */
  sizeBytes?: number;
}

export interface OperatorPublication {
  versionId: string;
  repositoryId: string;
  draftRevisionId: string;
  artifactRevisionId: string;
  previousVersionId?: string;
  createdAt: number;
}
/**
 * `coverage` overrides the draft's stored coverage for the publish gate. The API passes the coverage
 * derived from the draft's immutable sidecar (+ attempts), so legacy drafts without `belowCap` gate correctly.
 */
export interface PublishDraftOptions { repositoryId: string; draftRevisionId: string; expectedCurrentVersionId?: string; acknowledgeCoverage?: boolean; coverage?: OperatorCoverage; }

export type PublishResult =
  | { ok: true; publication: OperatorPublication }
  | { ok: false; reason: "stale_publication" | "missing_draft" | "invalid_draft"; currentVersionId?: string };
