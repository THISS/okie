import { mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import type { OperatorAcceptedExplanation, OperatorArtifactRevision, OperatorDraftRevision, OperatorEvent, OperatorPublication, OperatorRun, OperatorScopeAttempt, PublishDraftOptions, PublishResult } from "./operatorContracts.js";

export interface OperatorStoreState { runs: OperatorRun[]; drafts: OperatorDraftRevision[]; attempts: OperatorScopeAttempt[]; explanations: OperatorAcceptedExplanation[]; events: OperatorEvent[]; artifacts: OperatorArtifactRevision[]; publications: OperatorPublication[]; }
export interface CreateRunInput { idempotencyKey: string; source: OperatorRun["source"]; }
export interface CreateDraftInput { runId: string; artifactRevisionId: string; coverage?: OperatorDraftRevision["coverage"]; }
export interface WriteArtifactInput { repositoryId: string; sourceCommitSha?: string; files: Readonly<Record<string, string | Uint8Array>>; }

const emptyState = (): OperatorStoreState => ({ runs: [], drafts: [], attempts: [], explanations: [], events: [], artifacts: [], publications: [] });
const safe = (value: string, field: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,180}$/.test(value)) throw new Error(`invalid ${field}`);
  return value;
};
const safeRepositoryId = (value: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,240}$/.test(value)) throw new Error("invalid repository id");
  return value;
};
const publicLabel = (value: string | undefined): string | undefined => value && !/(?:key|token|secret|password|https?:\/\/|@)/i.test(value) ? value : undefined;
const safeError = (value: string | undefined): string | undefined => value && publicLabel(value) ? value.slice(0, 800) : "operation failed (details withheld)";

/**
 * A small local transactional store. State is replaced atomically and immutable
 * artifact directories are written before their metadata becomes visible.
 */
export class OperatorStore {
  readonly root: string;
  private readonly statePath: string;
  private counter = 0;
  constructor(root: string, private readonly now: () => number = () => Date.now()) {
    this.root = resolve(root, "operator-v1");
    this.statePath = join(this.root, "state.json");
    mkdirSync(join(this.root, "artifacts"), { recursive: true });
    this.recoverInterrupted();
  }
  private load(): OperatorStoreState {
    if (!existsSync(this.statePath)) return emptyState();
    const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<OperatorStoreState>;
    return { ...emptyState(), ...parsed };
  }
  private save(state: OperatorStoreState): void {
    const tmp = `${this.statePath}.${process.pid}.${++this.counter}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(tmp, this.statePath);
  }
  private lock<T>(work: () => T): T {
    const path = join(this.root, ".lock");
    for (let retry = 0; retry < 20; retry += 1) {
      try {
        const fd = openSync(path, "wx", 0o600);
        try { return work(); } finally { closeSync(fd); rmSync(path, { force: true }); }
      } catch (error: unknown) {
        if (!(error instanceof Error) || !/EEXIST/.test(String((error as NodeJS.ErrnoException).code))) throw error;
        try { if (this.now() - statSync(path).mtimeMs > 30_000) rmSync(path, { force: true }); } catch { /* another writer released it */ }
      }
    }
    throw new Error("operator store is busy");
  }
  private id(prefix: string): string { return `${prefix}-${this.now().toString(36)}-${(++this.counter).toString(36)}`; }
  createRun(input: CreateRunInput): { run: OperatorRun; deduped: boolean } {
    safe(input.idempotencyKey, "idempotency key"); safeRepositoryId(input.source.repositoryId); safe(input.source.slug, "slug");
    return this.lock(() => { const state = this.load(); const prior = state.runs.find(run => run.idempotencyKey === input.idempotencyKey); if (prior) return { run: prior, deduped: true };
      const at = this.now(); const run: OperatorRun = { runId: this.id("run"), idempotencyKey: input.idempotencyKey, source: { ...input.source }, state: "queued", createdAt: at, updatedAt: at }; state.runs.push(run); this.save(state); return { run, deduped: false }; });
  }
  updateRun(runId: string, patch: Pick<Partial<OperatorRun>, "state" | "draftRevisionId" | "error" | "source">): OperatorRun | undefined {
    return this.lock(() => { const state = this.load(); const run = state.runs.find(value => value.runId === runId); if (!run) return undefined; Object.assign(run, { ...patch, ...(patch.error !== undefined ? { error: safeError(patch.error) } : {}), updatedAt: this.now() }); this.save(state); return run; });
  }
  writeArtifactRevision(input: WriteArtifactInput): OperatorArtifactRevision {
    safeRepositoryId(input.repositoryId); const names = Object.keys(input.files); if (!names.length) throw new Error("artifact revision needs files"); names.forEach(name => { if (basename(name) !== name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name)) throw new Error("unsafe artifact file name"); });
    return this.lock(() => { const state = this.load(); const artifactRevisionId = this.id("artifact"); const finalDir = join(this.root, "artifacts", artifactRevisionId); const tempDir = `${finalDir}.tmp`; mkdirSync(tempDir, { recursive: true });
      try { for (const [name, content] of Object.entries(input.files)) writeFileSync(join(tempDir, name), content, { flag: "wx", mode: 0o600 }); renameSync(tempDir, finalDir); }
      catch (error) { rmSync(tempDir, { recursive: true, force: true }); throw error; }
      const artifact: OperatorArtifactRevision = { artifactRevisionId, repositoryId: input.repositoryId, ...(input.sourceCommitSha ? { sourceCommitSha: input.sourceCommitSha } : {}), createdAt: this.now(), files: names.sort() }; state.artifacts.push(artifact); this.save(state); return artifact; });
  }
  createDraftRevision(input: CreateDraftInput): OperatorDraftRevision {
    return this.lock(() => { const state = this.load(); const run = state.runs.find(value => value.runId === input.runId); const artifact = state.artifacts.find(value => value.artifactRevisionId === input.artifactRevisionId); if (!run || !artifact || run.source.repositoryId !== artifact.repositoryId) throw new Error("draft must reference its run and repository artifact");
      const prior = state.drafts.filter(value => value.repositoryId === run.source.repositoryId); const current = state.publications.filter(value => value.repositoryId === run.source.repositoryId).at(-1); const draft: OperatorDraftRevision = { draftRevisionId: this.id("draft"), runId: run.runId, repositoryId: run.source.repositoryId, revision: prior.length + 1, state: "open", ...(current ? { basePublicationVersionId: current.versionId } : {}), artifactRevisionId: artifact.artifactRevisionId, coverage: input.coverage ?? { total: 0, accepted: 0, failed: 0, stale: 0 }, createdAt: this.now() }; state.drafts.push(draft); run.draftRevisionId = draft.draftRevisionId; run.updatedAt = this.now(); this.save(state); return draft; });
  }
  appendAttempt(input: Omit<OperatorScopeAttempt, "attemptId" | "createdAt" | "updatedAt">): OperatorScopeAttempt {
    return this.lock(() => { const state = this.load(); if (!state.drafts.some(value => value.draftRevisionId === input.draftRevisionId)) throw new Error("unknown draft"); const at = this.now(); const attempt: OperatorScopeAttempt = { draftRevisionId: input.draftRevisionId, scopeId: input.scopeId, kind: input.kind, state: input.state, ...(input.usage ? { usage: input.usage } : {}), ...(input.stale !== undefined ? { stale: input.stale } : {}), ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}), ...(input.inputHash ? { inputHash: input.inputHash } : {}), ...(input.validation ? { validation: input.validation } : {}), attemptId: this.id("attempt"), createdAt: at, updatedAt: at, ...(publicLabel(input.provider) ? { provider: input.provider } : {}), ...(publicLabel(input.modelId) ? { modelId: input.modelId } : {}), ...(input.error ? { error: safeError(input.error)! } : {}) }; state.attempts.push(attempt); this.save(state); return attempt; });
  }
  createAttempt(input: Omit<OperatorScopeAttempt, "attemptId" | "createdAt" | "updatedAt">): OperatorScopeAttempt { return this.appendAttempt(input); }
  getAttempt(attemptId: string): OperatorScopeAttempt | undefined { return this.load().attempts.find(value => value.attemptId === attemptId); }
  listAttempts(draftRevisionId: string, scopeId?: string): OperatorScopeAttempt[] { return this.load().attempts.filter(value => value.draftRevisionId === draftRevisionId && (scopeId === undefined || value.scopeId === scopeId)); }
  updateAttempt(attemptId: string, patch: Pick<Partial<OperatorScopeAttempt>, "state" | "stale" | "usage" | "error" | "validation">): OperatorScopeAttempt | undefined {
    return this.lock(() => { const state = this.load(); const attempt = state.attempts.find(value => value.attemptId === attemptId); if (!attempt) return undefined; Object.assign(attempt, { ...patch, ...(patch.error !== undefined ? { error: safeError(patch.error) } : {}), updatedAt: this.now() }); this.save(state); return attempt; });
  }
  markScopeStale(draftRevisionId: string, scopeId: string): number { return this.lock(() => { const state = this.load(); const matching = state.attempts.filter(value => value.draftRevisionId === draftRevisionId && value.scopeId === scopeId && !value.stale); for (const attempt of matching) { attempt.stale = true; attempt.updatedAt = this.now(); } if (matching.length) this.save(state); return matching.length; }); }
  isCancelled(runId: string): boolean { return this.load().runs.find(value => value.runId === runId)?.state === "cancelled"; }
  putAcceptedExplanation(input: Omit<OperatorAcceptedExplanation, "explanationVersionId" | "createdAt">): OperatorAcceptedExplanation {
    if (!input.validation.accepted) throw new Error("accepted explanation needs accepted validation"); return this.lock(() => { const state = this.load(); const attempt = state.attempts.find(value => value.attemptId === input.attemptId && value.draftRevisionId === input.draftRevisionId && value.scopeId === input.scopeId); if (!attempt) throw new Error("explanation must belong to an attempt"); const explanation: OperatorAcceptedExplanation = { ...input, explanationVersionId: this.id("explanation"), createdAt: this.now() }; state.explanations.push(explanation); this.save(state); return explanation; });
  }
  getAcceptedExplanation(draftRevisionId: string, scopeId: string): OperatorAcceptedExplanation | undefined { return this.load().explanations.filter(value => value.draftRevisionId === draftRevisionId && value.scopeId === scopeId).at(-1); }
  appendEvent(input: Omit<OperatorEvent, "eventId" | "at">): OperatorEvent { return this.lock(() => { const state = this.load(); const detail = input.detail ? Object.fromEntries(Object.entries(input.detail).map(([key, value]) => [key, typeof value === "string" ? (publicLabel(value) ?? "[redacted]") : value])) : undefined; const event: OperatorEvent = { runId: input.runId, type: input.type, ...(detail ? { detail } : {}), eventId: this.id("event"), at: this.now() }; state.events.push(event); this.save(state); return event; }); }
  readArtifactFile(artifactRevisionId: string, fileName: string): Buffer | undefined { safe(artifactRevisionId, "artifact id"); if (basename(fileName) !== fileName) return undefined; const path = resolve(this.root, "artifacts", artifactRevisionId, fileName); if (!path.startsWith(join(this.root, "artifacts") + sep) || !existsSync(path)) return undefined; return readFileSync(path); }
  snapshot(): Readonly<OperatorStoreState> { return this.load(); }
  freezeForPublication(options: PublishDraftOptions, currentVersionId: string | undefined): PublishResult {
    return this.lock(() => { const state = this.load(); const draft = state.drafts.find(value => value.draftRevisionId === options.draftRevisionId && value.repositoryId === options.repositoryId); if (!draft) return { ok: false, reason: "missing_draft", ...(currentVersionId ? { currentVersionId } : {}) }; if (currentVersionId !== options.expectedCurrentVersionId) return { ok: false, reason: "stale_publication", ...(currentVersionId ? { currentVersionId } : {}) };
      if (draft.state !== "open" || !state.artifacts.some(value => value.artifactRevisionId === draft.artifactRevisionId)) return { ok: false, reason: "invalid_draft", ...(currentVersionId ? { currentVersionId } : {}) }; if ((draft.coverage.failed > 0 || draft.coverage.stale > 0 || draft.coverage.accepted < draft.coverage.total) && !options.acknowledgeCoverage) return { ok: false, reason: "invalid_draft", ...(currentVersionId ? { currentVersionId } : {}) };
      const publication: OperatorPublication = { versionId: this.id("publication"), repositoryId: draft.repositoryId, draftRevisionId: draft.draftRevisionId, artifactRevisionId: draft.artifactRevisionId, ...(currentVersionId ? { previousVersionId: currentVersionId } : {}), createdAt: this.now() }; draft.state = "frozen"; draft.frozenAt = publication.createdAt; state.publications.push(publication); this.save(state); return { ok: true, publication }; });
  }
  recoverInterrupted(): void { this.lock(() => { const state = this.load(); let changed = false; for (const run of state.runs) if (run.state === "queued" || run.state === "running") { run.state = "interrupted"; run.updatedAt = this.now(); changed = true; } for (const attempt of state.attempts) if (attempt.state === "queued" || attempt.state === "running") { attempt.state = "interrupted"; attempt.updatedAt = this.now(); changed = true; } if (changed) this.save(state); }); }
}
