import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join, resolve, sep } from "node:path";
import { coverageIncomplete, type OperatorAcceptedExplanation, type OperatorArtifactRevision, type OperatorDraftRevision, type OperatorEvent, type OperatorPublication, type OperatorRun, type OperatorScopeAttempt, type PublishDraftOptions, type PublishResult } from "./operatorContracts.js";
import { scrubIdentifierValues } from "@okie/scan";
import { normalizeGatewayErrorText } from "./llmGateway.js";

export interface OperatorStoreState { runs: OperatorRun[]; drafts: OperatorDraftRevision[]; attempts: OperatorScopeAttempt[]; explanations: OperatorAcceptedExplanation[]; events: OperatorEvent[]; artifacts: OperatorArtifactRevision[]; publications: OperatorPublication[]; }
export interface CreateRunInput { idempotencyKey: string; source: OperatorRun["source"]; incremental?: OperatorRun["incremental"]; }
export interface CreateDraftInput { runId: string; artifactRevisionId: string; coverage?: OperatorDraftRevision["coverage"]; basePublicationVersionId?: string; }
export interface WriteArtifactInput { repositoryId: string; sourceCommitSha?: string; files: Readonly<Record<string, string | Uint8Array>>; }
export interface OperatorStoreOptions { now?: () => number; pid?: number; isProcessAlive?: (pid: number) => boolean; }
const empty = (): OperatorStoreState => ({ runs: [], drafts: [], attempts: [], explanations: [], events: [], artifacts: [], publications: [] });
const idOk = (value: string, repo = false): void => { if (!(repo ? /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,240}$/ : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,180}$/).test(value)) throw new Error("invalid identifier"); };
/**
 * Withholds text that names a credential, a URL or an address: any `key`/`token`/`secret`/`password` substring, so camelCase
 * names (`authToken`, `clientSecret`, `masterKey`) withhold too. Only known-safe validator vocabulary is removed before the
 * test, so "5 keyPoints (allowed 2-4)" is shown (CLA-264). Values are scrubbed separately (CLA-261).
 */
const SAFE_VOCABULARY = /\bkeyPoints\b/g;
const publicValue = (value: string | undefined): string | undefined => value && !/(?:key|token|secret|password|passwd|bearer|https?:\/\/|@)/i.test(value.replace(SAFE_VOCABULARY, "")) ? value : undefined;
/** CLA-261: provider bodies are normalized and account identifiers scrubbed before the existing withhold/cap rules. */
const errorValue = (value: string | undefined): string => publicValue(value === undefined ? undefined : normalizeGatewayErrorText(value))?.slice(0, 800) ?? "operation failed (details withheld)";
type EventDetailValue = string | number | boolean | null;
/**
 * Event details are mostly structured ids (scopeId, reason codes), so only value-shaped identifiers are scrubbed —
 * never the generic `key: value` rule, which would mangle `component:email:sender`. A gateway error still normalizes.
 */
const eventDetailValue = (value: EventDetailValue): EventDetailValue => { if (typeof value !== "string") return value; const bounded = value.slice(0, 800); return publicValue(/llm gateway \d{3}/.test(bounded) ? normalizeGatewayErrorText(bounded) : scrubIdentifierValues(bounded)) ?? "[redacted]"; };
/**
 * CLA-261 migration: rows written before provider errors were normalized may
 * hold a raw provider body (with its `user_id`). Opening the store re-applies
 * the error rules once and persists the result; every write path applies them
 * too. Re-applying them to already-scrubbed rows leaves them unchanged (tested).
 */
function scrubStoredErrors(state: OperatorStoreState): boolean {
  let changed = false;
  const scrub = (row: { error?: string }) => { if (typeof row.error === "string") { const next = errorValue(row.error); if (next !== row.error) { row.error = next; changed = true; } } };
  state.runs.forEach(scrub); state.attempts.forEach(scrub);
  for (const event of state.events) {
    if (!event.detail) continue;
    for (const [key, value] of Object.entries(event.detail)) { const next = eventDetailValue(value); if (next !== value) { event.detail[key] = next; changed = true; } }
  }
  return changed;
}

/**
 * Operator storage is keyed by GitHub's case-insensitive owner/repository
 * identity. This intentionally applies only to the operator `repo:o/r` key:
 * scanner-produced semantic repository IDs remain opaque artifact contents.
 */
export function canonicalOperatorRepositoryId(repositoryId: string): string {
  const match = /^repo:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(repositoryId);
  return match ? `repo:${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}` : repositoryId;
}

function canonicalOperatorSource(source: OperatorRun["source"]): OperatorRun["source"] {
  const repositoryId = canonicalOperatorRepositoryId(source.repositoryId);
  return repositoryId === source.repositoryId ? { ...source } : {
    ...source,
    repositoryId,
    owner: source.owner.toLowerCase(),
    repo: source.repo.toLowerCase(),
  };
}

/** A live owner is never evicted. A lock from a dead PID is recovered once. */
class OwnerLock {
  private depth = 0;
  private readonly token = randomUUID();
  constructor(private readonly path: string, private readonly pid: number, private readonly alive: (pid: number) => boolean) {}
  with<T>(work: () => T): T {
    if (this.depth > 0) { this.depth += 1; try { return work(); } finally { this.depth -= 1; } }
    for (let retry = 0; retry < 2; retry += 1) {
      try {
        const fd = openSync(this.path, "wx", 0o600);
        writeFileSync(fd, JSON.stringify({ pid: this.pid, token: this.token })); closeSync(fd);
        this.depth = 1;
        try { return work(); } finally { this.depth = 0; rmSync(this.path, { force: true }); }
      } catch (cause: unknown) {
        if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
        let owner: { pid?: number } = {};
        try { owner = JSON.parse(readFileSync(this.path, "utf8")) as { pid?: number }; } catch { /* incomplete owner file is busy */ }
        if (typeof owner.pid === "number" && !this.alive(owner.pid)) { rmSync(this.path, { force: true }); continue; }
        throw new Error("operator store is busy");
      }
    }
    throw new Error("operator store is busy");
  }
}

export class OperatorStore {
  readonly root: string;
  private readonly statePath: string;
  private readonly now: () => number;
  private readonly ownerLock: OwnerLock;
  constructor(root: string, nowOrOptions: (() => number) | OperatorStoreOptions = () => Date.now()) {
    const options = typeof nowOrOptions === "function" ? { now: nowOrOptions } : nowOrOptions;
    this.root = resolve(root, "operator-v1"); this.statePath = join(this.root, "state.json"); this.now = options.now ?? (() => Date.now());
    const alive = options.isProcessAlive ?? (pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    mkdirSync(join(this.root, "artifacts"), { recursive: true }); this.ownerLock = new OwnerLock(join(this.root, ".lock"), options.pid ?? process.pid, alive); this.scrubPersisted(); this.recoverInterrupted();
  }
  withExclusiveLock<T>(work: () => T): T { return this.ownerLock.with(work); }
  private load(): OperatorStoreState { return existsSync(this.statePath) ? { ...empty(), ...(JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<OperatorStoreState>) } : empty(); }
  /** CLA-261: scrub a pre-existing store once at open, on disk; writes keep it clean after that. */
  private scrubPersisted(): void { this.ownerLock.with(() => { const state = this.load(); if (scrubStoredErrors(state)) this.save(state); }); }
  private save(state: OperatorStoreState): void { const temp = `${this.statePath}.${randomUUID()}.tmp`; writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 }); renameSync(temp, this.statePath); }
  private id(prefix: string): string { return `${prefix}-${randomUUID()}`; }
  createRun(input: CreateRunInput): { run: OperatorRun; deduped: boolean } { const source = canonicalOperatorSource(input.source); idOk(input.idempotencyKey); idOk(source.repositoryId, true); idOk(source.slug); return this.ownerLock.with(() => { const state = this.load(); const prior = state.runs.find(run => run.idempotencyKey === input.idempotencyKey); if (prior) return { run: prior, deduped: true }; const at = this.now(); const run: OperatorRun = { runId: this.id("run"), idempotencyKey: input.idempotencyKey, source, state: "queued", createdAt: at, updatedAt: at, ...(input.incremental ? { kind: "incremental" as const, incremental: input.incremental } : {}) }; state.runs.push(run); this.save(state); return { run, deduped: false }; }); }
  updateRun(runId: string, patch: Pick<Partial<OperatorRun>, "state" | "draftRevisionId" | "error" | "source" | "incremental">): OperatorRun | undefined { return this.ownerLock.with(() => { const state = this.load(); const run = state.runs.find(value => value.runId === runId); if (!run) return undefined; if (patch.state && patch.state !== run.state) state.events.push({ eventId: this.id("event"), runId, at: this.now(), type: "run.state", detail: { previous: run.state, state: patch.state } }); Object.assign(run, { ...patch, ...(patch.error !== undefined ? { error: errorValue(patch.error) } : {}), updatedAt: this.now() }); this.save(state); return run; }); }
  writeArtifactRevision(input: WriteArtifactInput): OperatorArtifactRevision { const repositoryId = canonicalOperatorRepositoryId(input.repositoryId); idOk(repositoryId, true); const names = Object.keys(input.files); if (!names.length || names.some(name => basename(name) !== name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(name))) throw new Error("unsafe artifact file name"); return this.ownerLock.with(() => { const state = this.load(); const artifactRevisionId = this.id("artifact"); const destination = join(this.root, "artifacts", artifactRevisionId); const temp = `${destination}.tmp`; mkdirSync(temp, { recursive: true }); try { for (const [name, content] of Object.entries(input.files)) writeFileSync(join(temp, name), content, { flag: "wx", mode: 0o600 }); renameSync(temp, destination); } catch (cause) { rmSync(temp, { recursive: true, force: true }); throw cause; } const artifact: OperatorArtifactRevision = { artifactRevisionId, repositoryId, ...(input.sourceCommitSha ? { sourceCommitSha: input.sourceCommitSha } : {}), createdAt: this.now(), sizeBytes: Object.values(input.files).reduce((sum, value) => sum + (typeof value === "string" ? Buffer.byteLength(value) : value.byteLength), 0), files: names.sort() }; state.artifacts.push(artifact); this.save(state); return artifact; }); }
  createDraftRevision(input: CreateDraftInput): OperatorDraftRevision { return this.ownerLock.with(() => { const state = this.load(); const run = state.runs.find(value => value.runId === input.runId); const artifact = state.artifacts.find(value => value.artifactRevisionId === input.artifactRevisionId); if (!run || !artifact) throw new Error("draft must reference its run and repository artifact"); const repositoryId = canonicalOperatorRepositoryId(run.source.repositoryId); if (repositoryId !== canonicalOperatorRepositoryId(artifact.repositoryId)) throw new Error("draft must reference its run and repository artifact"); const draft: OperatorDraftRevision = { draftRevisionId: this.id("draft"), runId: run.runId, repositoryId, revision: state.drafts.filter(value => canonicalOperatorRepositoryId(value.repositoryId) === repositoryId).length + 1, state: "open", ...(input.basePublicationVersionId ? { basePublicationVersionId: input.basePublicationVersionId } : {}), artifactRevisionId: artifact.artifactRevisionId, coverage: input.coverage ?? { total: 0, accepted: 0, failed: 0, notRun: 0, stale: 0 }, createdAt: this.now() }; state.drafts.push(draft); run.draftRevisionId = draft.draftRevisionId; run.updatedAt = this.now(); this.save(state); return draft; }); }
  appendAttempt(input: Omit<OperatorScopeAttempt, "attemptId" | "createdAt" | "updatedAt">): OperatorScopeAttempt { return this.ownerLock.with(() => { const state = this.load(); if (!state.drafts.some(value => value.draftRevisionId === input.draftRevisionId)) throw new Error("unknown draft"); const at = this.now(); const { provider: _provider, modelId: _modelId, error: _error, ...rest } = input; const attempt: OperatorScopeAttempt = { ...rest, attemptId: this.id("attempt"), createdAt: at, updatedAt: at, ...(publicValue(input.provider) ? { provider: input.provider } : {}), ...(publicValue(input.modelId) ? { modelId: input.modelId } : {}), ...(input.error ? { error: errorValue(input.error) } : {}) }; state.attempts.push(attempt); this.save(state); return attempt; }); }
  createAttempt(input: Omit<OperatorScopeAttempt, "attemptId" | "createdAt" | "updatedAt">): OperatorScopeAttempt { return this.appendAttempt(input); }
  getAttempt(attemptId: string): OperatorScopeAttempt | undefined { return this.load().attempts.find(value => value.attemptId === attemptId); }
  listAttempts(draftRevisionId: string, scopeId?: string): OperatorScopeAttempt[] { return this.load().attempts.filter(value => value.draftRevisionId === draftRevisionId && (scopeId === undefined || value.scopeId === scopeId)); }
  updateAttempt(attemptId: string, patch: Pick<Partial<OperatorScopeAttempt>, "state" | "stale" | "usage" | "error" | "validation">): OperatorScopeAttempt | undefined { return this.ownerLock.with(() => { const state = this.load(); const attempt = state.attempts.find(value => value.attemptId === attemptId); if (!attempt) return undefined; Object.assign(attempt, { ...patch, ...(patch.error !== undefined ? { error: errorValue(patch.error) } : {}), updatedAt: this.now() }); this.save(state); return attempt; }); }
  markScopeStale(draftRevisionId: string, scopeId: string): number { return this.ownerLock.with(() => { const state = this.load(); const matches = state.attempts.filter(value => value.draftRevisionId === draftRevisionId && value.scopeId === scopeId && !value.stale); matches.forEach(attempt => Object.assign(attempt, { stale: true, updatedAt: this.now() })); if (matches.length) this.save(state); return matches.length; }); }
  isCancelled(runId: string): boolean { return this.load().runs.find(value => value.runId === runId)?.state === "cancelled"; }
  putAcceptedExplanation(input: Omit<OperatorAcceptedExplanation, "explanationVersionId" | "createdAt">): OperatorAcceptedExplanation { if (!input.validation.accepted) throw new Error("accepted explanation needs accepted validation"); return this.ownerLock.with(() => { const state = this.load(); if (!state.attempts.some(value => value.attemptId === input.attemptId && value.draftRevisionId === input.draftRevisionId && value.scopeId === input.scopeId)) throw new Error("explanation must belong to an attempt"); const explanation: OperatorAcceptedExplanation = { ...input, explanationVersionId: this.id("explanation"), createdAt: this.now() }; state.explanations.push(explanation); this.save(state); return explanation; }); }
  getAcceptedExplanation(draftRevisionId: string, scopeId: string): OperatorAcceptedExplanation | undefined { return this.load().explanations.filter(value => value.draftRevisionId === draftRevisionId && value.scopeId === scopeId).at(-1); }
  appendEvent(input: Omit<OperatorEvent, "eventId" | "at">): OperatorEvent { return this.ownerLock.with(() => { const detail = input.detail ? Object.fromEntries(Object.entries(input.detail).map(([key, value]) => [key, eventDetailValue(value)])) : undefined; const event: OperatorEvent = { runId: input.runId, type: input.type, ...(detail ? { detail } : {}), eventId: this.id("event"), at: this.now() }; const state = this.load(); state.events.push(event); this.save(state); return event; }); }
  readArtifactFile(artifactRevisionId: string, fileName: string): Buffer | undefined { const path = this.artifactFilePath(artifactRevisionId, fileName); return path ? readFileSync(path) : undefined; }
  /** Path of an existing artifact file (same basename + containment checks as readArtifactFile), for callers that must stat before reading. */
  artifactFilePath(artifactRevisionId: string, fileName: string): string | undefined { if (basename(fileName) !== fileName) return undefined; const path = resolve(this.root, "artifacts", artifactRevisionId, fileName); return path.startsWith(join(this.root, "artifacts") + sep) && existsSync(path) ? path : undefined; }
  snapshot(): Readonly<OperatorStoreState> { return this.load(); }
  freezeForPublication(options: PublishDraftOptions, currentVersionId: string | undefined): PublishResult { const repositoryId = canonicalOperatorRepositoryId(options.repositoryId); return this.ownerLock.with(() => { const state = this.load(); const draft = state.drafts.find(value => value.draftRevisionId === options.draftRevisionId && canonicalOperatorRepositoryId(value.repositoryId) === repositoryId); if (!draft) return { ok: false, reason: "missing_draft", ...(currentVersionId ? { currentVersionId } : {}) }; if (currentVersionId !== options.expectedCurrentVersionId) return { ok: false, reason: "stale_publication", ...(currentVersionId ? { currentVersionId } : {}) }; const prior = state.publications.find(value => value.draftRevisionId === draft.draftRevisionId); if (draft.state === "frozen" && prior) { if (prior.previousVersionId !== currentVersionId) return { ok: false, reason: "stale_publication", ...(currentVersionId ? { currentVersionId } : {}) }; return { ok: true, publication: prior }; } if (draft.state !== "open" || !state.artifacts.some(value => value.artifactRevisionId === draft.artifactRevisionId)) return { ok: false, reason: "invalid_draft", ...(currentVersionId ? { currentVersionId } : {}) }; if (coverageIncomplete(options.coverage ?? draft.coverage) && !options.acknowledgeCoverage) return { ok: false, reason: "invalid_draft", ...(currentVersionId ? { currentVersionId } : {}) }; const publication: OperatorPublication = { versionId: this.id("publication"), repositoryId: draft.repositoryId, draftRevisionId: draft.draftRevisionId, artifactRevisionId: draft.artifactRevisionId, ...(currentVersionId ? { previousVersionId: currentVersionId } : {}), createdAt: this.now() }; draft.state = "frozen"; draft.frozenAt = publication.createdAt; state.publications.push(publication); this.save(state); return { ok: true, publication }; }); }
  /**
   * CLA-271: removes a repository's earlier up-to-date no-op incremental runs (complete, `incremental.upToDate`, no draft),
   * keeping `keepRunId`. A run is removed only when nothing else refers to it: no draft revision, hence no attempts or
   * artifacts. Its own events go with it. Holds the store lock; returns how many runs were removed.
   */
  pruneUpToDateRuns(repositoryId: string, keepRunId: string): number { return this.ownerLock.with(() => { const state = this.load(); const canonical = canonicalOperatorRepositoryId(repositoryId); const referenced = new Set(state.drafts.map(value => value.runId)); const removable = new Set(state.runs.filter(run => run.runId !== keepRunId && run.kind === "incremental" && run.state === "complete" && run.incremental?.upToDate && !run.draftRevisionId && !referenced.has(run.runId) && canonicalOperatorRepositoryId(run.source.repositoryId) === canonical).map(run => run.runId)); if (!removable.size) return 0; state.runs = state.runs.filter(run => !removable.has(run.runId)); state.events = state.events.filter(event => !removable.has(event.runId)); this.save(state); return removable.size; }); }
  recoverInterrupted(): void { this.ownerLock.with(() => { const state = this.load(); let changed = false; for (const run of state.runs) if (run.state === "queued" || run.state === "running") { run.state = "interrupted"; run.updatedAt = this.now(); changed = true; } for (const attempt of state.attempts) if (attempt.state === "queued" || attempt.state === "running") { attempt.state = "interrupted"; attempt.updatedAt = this.now(); changed = true; } if (changed) this.save(state); }); }
}
