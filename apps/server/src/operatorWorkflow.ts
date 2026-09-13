import type { ScanGithubAccess } from "./githubAccess.js";
import type { OperatorScopeAttempt, OperatorUsage } from "./operatorContracts.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore } from "./operatorStore.js";

export interface OperatorScopeDto { scopeId: string; entityId?: string; parentScopeId?: string; name: string; state: string; stale: boolean; explanation?: unknown; explanationVersionId?: string; diagramError?: string; attempts?: OperatorScopeAttempt[]; }
export interface OperatorWorkflowJob { kind: "run" | "retry" | "refresh"; runId: string; draftRevisionId?: string; scopeIds?: string[]; githubAccess: ScanGithubAccess; }
export interface OperatorWorkflowOptions { store: OperatorStore; publications: OperatorPublicationService; enqueue: (job: OperatorWorkflowJob) => void | Promise<void>; }

/** Safe controller façade: draft data stays here, never under public /scan routes. */
export class OperatorWorkflow {
  constructor(private readonly options: OperatorWorkflowOptions) {}
  runDetail(runId: string) {
    const state = this.options.store.snapshot();
    const run = state.runs.find(value => value.runId === runId);
    if (!run) return undefined;
    const draftIds = new Set(state.drafts.filter(value => value.runId === runId).map(value => value.draftRevisionId));
    const attempts = state.attempts.filter(value => draftIds.has(value.draftRevisionId));
    return {
      run,
      draft: state.drafts.find(value => value.draftRevisionId === run.draftRevisionId),
      attempts: attempts.slice(-100),
      events: state.events.filter(value => value.runId === runId).slice(-100),
      usage: usage(attempts),
    };
  }
  draftDetail(draftRevisionId: string) {
    const state = this.options.store.snapshot();
    const draft = state.drafts.find(value => value.draftRevisionId === draftRevisionId);
    if (!draft) return undefined;
    const run = state.runs.find(value => value.runId === draft.runId);
    if (!run) return undefined;
    const attempts = state.attempts.filter(value => value.draftRevisionId === draftRevisionId);
    const scopes = readArtifactScopes(this.options.store, draft.artifactRevisionId, attempts);
    const current = this.options.publications.currentPublication(draft.repositoryId);
    const artifact = state.artifacts.find(value => value.artifactRevisionId === draft.artifactRevisionId);
    return { draft, source: run.source, scopes, usage: usage(attempts), artifact,
      ...(current ? { currentPublicationVersionId: current.versionId } : {}) };
  }
  bundle(draftRevisionId: string): Buffer | undefined { const detail = this.draftDetail(draftRevisionId); return detail ? this.options.store.readArtifactFile(detail.draft.artifactRevisionId, "atlas.okie.json") : undefined; }
  async enqueue(job: OperatorWorkflowJob): Promise<void> { await this.options.enqueue(job); }
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Artifact content is authoritative, so later attempts cannot rewrite a frozen preview. */
export function readArtifactScopes(store: OperatorStore, artifactRevisionId: string, attempts: OperatorScopeAttempt[] = []): OperatorScopeDto[] {
  const bytes = store.readArtifactFile(artifactRevisionId, "operator-explanations.json");
  if (!bytes) return [];
  const sidecar = object(JSON.parse(bytes.toString("utf8")));
  const definitions = Array.isArray(sidecar.scopes) ? sidecar.scopes : [];
  const explanations = Array.isArray(sidecar.explanations) ? sidecar.explanations : [];
  const byScope = new Map<string, Record<string, unknown>>();
  for (const value of explanations) {
    const row = object(value);
    if (typeof row.scopeId === "string") byScope.set(row.scopeId, row);
  }
  const staleScopes = new Set(Array.isArray(sidecar.staleScopes) ? sidecar.staleScopes : []);
  return definitions.flatMap(value => {
    const scope = object(value);
    if (typeof scope.scopeId !== "string" || typeof scope.name !== "string") return [];
    const row = byScope.get(scope.scopeId);
    const content = row?.content ?? row?.explanation;
    const explanation = object(content);
    const rows = attempts.filter(attempt => attempt.scopeId === scope.scopeId);
    const latest = rows.at(-1);
    return [{
      scopeId: scope.scopeId, entityId: scope.scopeId, name: scope.name,
      ...(typeof scope.parentScopeId === "string" ? { parentScopeId: scope.parentScopeId } : {}),
      state: latest?.state ?? (typeof scope.state === "string" ? scope.state : row ? "accepted" : "failed"),
      stale: Boolean(scope.stale || row?.stale || staleScopes.has(scope.scopeId) || latest?.stale),
      ...(typeof explanation.summary === "string" ? { explanation } : {}),
      ...(typeof row?.explanationVersionId === "string" ? { explanationVersionId: row.explanationVersionId } : {}),
      ...(typeof explanation.diagramError === "string" ? { diagramError: explanation.diagramError } : {}),
      ...(rows.length ? { attempts: rows } : {}),
    }];
  });
}

export function usage(attempts: OperatorScopeAttempt[]): OperatorUsage & { costStatus: "measured" | "estimated" | "unknown"; unknownCostAttempts: number } {
  const rows = attempts.map(value => value.usage);
  const measured = rows.filter(value => value?.measuredCostUsd !== undefined);
  const estimated = rows.filter(value => value?.estimatedCostUsd !== undefined && value.measuredCostUsd === undefined);
  const unknownCostAttempts = rows.filter(value => value?.measuredCostUsd === undefined && value?.estimatedCostUsd === undefined).length;
  return {
    inputTokens: rows.reduce((total, value) => total + (value?.inputTokens ?? 0), 0),
    outputTokens: rows.reduce((total, value) => total + (value?.outputTokens ?? 0), 0),
    ...(measured.length ? { measuredCostUsd: measured.reduce((total, value) => total + value!.measuredCostUsd!, 0) } : {}),
    ...(estimated.length ? { estimatedCostUsd: estimated.reduce((total, value) => total + value!.estimatedCostUsd!, 0) } : {}),
    costStatus: unknownCostAttempts || !rows.length ? "unknown" : estimated.length ? "estimated" : "measured",
    unknownCostAttempts,
  };
}
