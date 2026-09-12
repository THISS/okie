/** Durable, secret-free records for the operator scan workflow (CLA-132). */
export type OperatorRunState = "queued" | "running" | "awaiting_review" | "complete" | "failed" | "cancelled" | "interrupted";
export type OperatorDraftState = "open" | "frozen" | "superseded";
export type OperatorAttemptState = "queued" | "running" | "accepted" | "failed" | "cancelled" | "interrupted";
export type OperatorAttemptKind = "scan" | "enrichment" | "retry" | "refresh";

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
  coverage: { total: number; accepted: number; failed: number; stale: number };
  createdAt: number;
  frozenAt?: number;
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
}

export interface OperatorPublication {
  versionId: string;
  repositoryId: string;
  draftRevisionId: string;
  artifactRevisionId: string;
  previousVersionId?: string;
  createdAt: number;
}
export interface PublishDraftOptions { repositoryId: string; draftRevisionId: string; expectedCurrentVersionId?: string; acknowledgeCoverage?: boolean; }

export type PublishResult =
  | { ok: true; publication: OperatorPublication }
  | { ok: false; reason: "stale_publication" | "missing_draft" | "invalid_draft"; currentVersionId?: string };
