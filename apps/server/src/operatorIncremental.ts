import { randomUUID } from "node:crypto";
import type { ArchitectureSnapshot } from "@okie/architecture";
import { stableJson, type GithubClient, type GithubSourceRef, type ScanArtifacts } from "@okie/scan";
import type { ScanGithubAccess } from "./githubAccess.js";
import { computeIncrementalImpact, type ImpactStaleReason } from "./incrementalImpact.js";
import { buildStoredChangelog, incrementalChangelogView, INCREMENTAL_CHANGELOG_FILE, unfinishedScopes, type IncrementalChangelog, type IncrementalHashCheck, type StoredIncrementalChangelog, type UnfinishedReason } from "./incrementalChangelog.js";
import { belowEnrichmentCap, coverageFor, coverageIncomplete, legacyEnrichmentCap, sidecarState, type OperatorEnrichmentCap, type OperatorIncrementalRunInfo, type OperatorRun } from "./operatorContracts.js";
import { operatorInputHash, preparedOperatorScope, type OperatorChildInput, type OperatorEnrichmentScope, type OperatorExplanation } from "./operatorEnrichment.js";
import { operatorScopesFromSnapshot } from "./operatorFacts.js";
import type { OperatorPublicationService } from "./operatorPublication.js";
import { isPublishableArtifact } from "./operatorPublishCheck.js";
import { canonicalOperatorRepositoryId, type OperatorStore } from "./operatorStore.js";

/**
 * CLA-271 incremental runs: a full deterministic re-scan at a new commit, diffed against the repository's baseline
 * (the newest reviewable incremental draft chained on the current publication, else the publication, else the latest
 * draft; see incrementalBaseline). Every non-dirty explanation is carried over byte-for-byte; only the dirty
 * set is re-enriched, through the ordinary batch-retry pass (ledger admission, rate limiter, sidecar install and CAS).
 *
 * Run/draft linkage: each incremental pass is its own run (`kind: "incremental"`, `incremental.baseline` names the
 * baseline run/draft/publication/commit) so the run list shows one row per update with its own commit, budget and
 * events, and the baseline run's draft chain is never rewritten.
 */
export interface SidecarScope { scopeId: string; parentScopeId?: string; name: string; kind: string; sourceRefs: unknown; state?: string; stale?: boolean; staleReason?: ImpactStaleReason }
export interface SidecarExplanation { scopeId: string; content?: unknown; explanationVersionId?: string; inputHash?: string; [key: string]: unknown }
export interface OperatorSidecar { schemaVersion?: number; maxKind?: OperatorEnrichmentCap; scopes: SidecarScope[]; explanations: SidecarExplanation[]; [key: string]: unknown }

const ACTIVE = new Set(["queued", "running"]);
/** A queued or running run for the repository (any kind); incremental starts are refused while one exists. */
export function activeRunFor(store: OperatorStore, repositoryId: string): OperatorRun | undefined {
  const canonical = canonicalOperatorRepositoryId(repositoryId);
  return store.snapshot().runs.find(run => canonicalOperatorRepositoryId(run.source.repositoryId) === canonical && ACTIVE.has(run.state));
}

const REVIEWABLE = new Set(["awaiting_review", "complete"]);
/**
 * The draft an incremental run diffs against. With a current publication: the newest reviewable (awaiting review or
 * complete) incremental draft chained on top of that same publication, else the publication's own draft — so a chain
 * A→B→C diffs C against B and reuses B's re-enrichment, and a manual publish restarts the chain from it. Without a
 * publication: the most recently created reviewable run's current draft (any kind). `publicationVersionId` always names
 * the publication under the chain, which is what auto-publish expects to replace.
 */
export function incrementalBaseline(store: OperatorStore, publications: OperatorPublicationService, repositoryId: string): { run: OperatorRun; baseline: OperatorIncrementalRunInfo["baseline"] } | undefined {
  const canonical = canonicalOperatorRepositoryId(repositoryId);
  const state = store.snapshot();
  const usable = (draftRevisionId: string | undefined) => {
    const draft = state.drafts.find(value => value.draftRevisionId === draftRevisionId);
    const artifact = draft && state.artifacts.find(value => value.artifactRevisionId === draft.artifactRevisionId);
    const run = draft && state.runs.find(value => value.runId === draft.runId);
    return draft && artifact?.sourceCommitSha && run && artifact.files.includes("snapshot.json") && artifact.files.includes("operator-explanations.json") ? { draft, artifact, run } : undefined;
  };
  const baselineOf = (found: NonNullable<ReturnType<typeof usable>>, publicationVersionId?: string) => ({ run: found.run, baseline: { runId: found.run.runId, draftRevisionId: found.draft.draftRevisionId, artifactRevisionId: found.artifact.artifactRevisionId, ...(publicationVersionId ? { publicationVersionId } : {}), commitSha: found.artifact.sourceCommitSha! } });
  const newestFirst = (runs: OperatorRun[]) => runs.filter(run => canonicalOperatorRepositoryId(run.source.repositoryId) === canonical && run.draftRevisionId && REVIEWABLE.has(run.state)).sort((left, right) => right.createdAt - left.createdAt || (left.runId < right.runId ? 1 : -1));
  const current = publications.currentPublication(canonical);
  const published = current ? usable(current.draftRevisionId) : undefined;
  if (current && published) {
    for (const run of newestFirst(state.runs.filter(value => value.kind === "incremental" && value.incremental?.baseline.publicationVersionId === current.versionId))) {
      const found = usable(run.draftRevisionId);
      if (found) return baselineOf(found, current.versionId);
    }
    return baselineOf(published, current.versionId);
  }
  for (const run of newestFirst(state.runs)) {
    const found = usable(run.draftRevisionId);
    if (found) return baselineOf(found);
  }
  return undefined;
}

export type IncrementalStartResult =
  | { status: "started"; runId: string; baselineCommitSha: string; commitSha?: string }
  | { status: "up_to_date"; commitSha: string; baselineCommitSha: string }
  | { status: "active"; runId: string }
  | { status: "no_baseline" };
export interface IncrementalStartContext {
  store: OperatorStore;
  publications: OperatorPublicationService;
  /** Must not await the job: triggers answer immediately and the runner scans later. */
  enqueue(job: { kind: "incremental"; runId: string; githubAccess: ScanGithubAccess }): void | Promise<void>;
}
/** Safe explicit ref/SHA: branch, tag or hex SHA characters only. */
export function validIncrementalRef(ref: unknown): ref is string { return typeof ref === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(ref) && !ref.includes(".."); }

/**
 * Starts one incremental run: refused while any run for the repository is active; a no-op when a given full commit SHA
 * equals the baseline's (the chain's newest draft already covers it). Nothing here touches the network: a ref or the
 * default branch is resolved by the runner, which records `incremental.up_to_date` when HEAD is the baseline commit.
 * The active check and the run creation hold the store lock together. A run whose job cannot be queued is marked
 * failed, never left "queued".
 */
export async function startIncrementalRun(ctx: IncrementalStartContext, input: { repositoryId: string; ref?: string; commitSha?: string; trigger: OperatorIncrementalRunInfo["trigger"]; githubAccess: ScanGithubAccess; autoPublish?: boolean }): Promise<IncrementalStartResult> {
  const active = activeRunFor(ctx.store, input.repositoryId);
  if (active) return { status: "active", runId: active.runId };
  const found = incrementalBaseline(ctx.store, ctx.publications, input.repositoryId);
  if (!found) return { status: "no_baseline" };
  const { run: baselineRun, baseline } = found;
  const ref = input.commitSha ?? input.ref;
  const target: string | undefined = input.commitSha ?? (ref && /^[0-9a-f]{40}$/.test(ref) ? ref : undefined);
  if (target && target === baseline.commitSha) return { status: "up_to_date", commitSha: target, baselineCommitSha: baseline.commitSha };
  const created = ctx.store.withExclusiveLock((): { active: string } | { run: OperatorRun } => {
    const again = activeRunFor(ctx.store, input.repositoryId);
    if (again) return { active: again.runId };
    const { commitSha: _commit, ref: _ref, ...source } = baselineRun.source;
    const pinned = target ?? ref;
    return { run: ctx.store.createRun({ idempotencyKey: `incremental-${randomUUID()}`, source: { ...source, ...(pinned ? { ref: pinned } : {}) }, incremental: { baseline, ...(pinned ? { ref: pinned } : {}), ...(target ? { targetCommitSha: target } : {}), trigger: input.trigger, ...(input.autoPublish ? { autoPublish: true } : {}) } }).run };
  });
  if ("active" in created) return { status: "active", runId: created.active };
  try { await ctx.enqueue({ kind: "incremental", runId: created.run.runId, githubAccess: input.githubAccess }); } catch (error) {
    ctx.store.updateRun(created.run.runId, { state: "failed", error: "The incremental run could not be queued." });
    throw error;
  }
  return { status: "started", runId: created.run.runId, baselineCommitSha: baseline.commitSha, ...(target ? { commitSha: target } : {}) };
}

export interface IncrementalRunContext {
  store: OperatorStore;
  publication: OperatorPublicationService;
  client(access: ScanGithubAccess): GithubClient;
  resolveCommit(source: GithubSourceRef, client: GithubClient): Promise<string>;
  scan(source: GithubSourceRef, client: GithubClient): Promise<{ commitSha: string; artifacts: ScanArtifacts }>;
  /** Public artifact files for a scan (atlas bundle, snapshot, view, scene, stories, timeline). */
  publicFiles(artifacts: ScanArtifacts): Record<string, string>;
  defaultCap(): OperatorEnrichmentCap;
  /** Model and leaf-reasoning the pass would use, for the reuse hash cross-check. */
  hashModel(): { modelId: string; leafReasoning: "off" | "provider-default" };
  /** The runner's batch retry pass on the new draft (re-reduces ancestors; one install). */
  retry(job: { runId: string; draftRevisionId: string; scopeIds: string[] }): Promise<void>;
}

const readJson = <T>(store: OperatorStore, artifactRevisionId: string, name: string): T | undefined => { const bytes = store.readArtifactFile(artifactRevisionId, name); return bytes ? JSON.parse(bytes.toString("utf8")) as T : undefined; };

/** Depth cap of a baseline sidecar: the recorded one, else the CLA-254 legacy inference, else the server default. */
function baselineCap(sidecar: OperatorSidecar, fallback: OperatorEnrichmentCap): OperatorEnrichmentCap {
  if (sidecar.maxKind === "component" || sidecar.maxKind === "code") return sidecar.maxKind;
  return legacyEnrichmentCap(sidecar.scopes, new Set(sidecar.explanations.map(row => row.scopeId))) ?? fallback;
}

/**
 * Recomputes each reused explanation's input hash on the new snapshot (children with their baseline states and
 * explanations) and compares it with the stored hash. Only a count is kept; a mismatch never fails the run.
 */
export function reuseHashCheck(input: { scopes: readonly OperatorEnrichmentScope[]; cap: OperatorEnrichmentCap; baseline: OperatorSidecar; reused: readonly string[]; modelId: string; leafReasoning: "off" | "provider-default"; storedHash(row: SidecarExplanation): string | undefined }): IncrementalHashCheck {
  const byId = new Map(input.scopes.map(scope => [scope.scopeId, scope]));
  const children = new Map<string, OperatorEnrichmentScope[]>();
  for (const scope of input.scopes) if (scope.parentScopeId) { const list = children.get(scope.parentScopeId) ?? []; list.push(scope); children.set(scope.parentScopeId, list); }
  for (const list of children.values()) list.sort((left, right) => left.scopeId < right.scopeId ? -1 : left.scopeId > right.scopeId ? 1 : 0);
  const rows = new Map(input.baseline.explanations.map(row => [row.scopeId, row]));
  const states = new Map(input.baseline.scopes.map(scope => [scope.scopeId, scope]));
  const inCap = (scope: OperatorEnrichmentScope) => !belowEnrichmentCap(scope.kind, input.cap);
  const result: IncrementalHashCheck = { checked: 0, mismatches: 0, unknown: 0 };
  for (const scopeId of input.reused) {
    const row = rows.get(scopeId); const definition = byId.get(scopeId);
    if (!row || !definition) continue;
    const stored = input.storedHash(row);
    if (!stored) { result.unknown += 1; continue; }
    const kids = children.get(scopeId) ?? [];
    const childInputs: OperatorChildInput[] = kids.filter(inCap).map(child => {
      const childRow = rows.get(child.scopeId); const recorded = states.get(child.scopeId);
      const state = childRow ? (recorded?.stale ? "stale" : "accepted") : recorded?.state === "failed" ? "failed" : "not run";
      return { scopeId: child.scopeId, name: child.name, kind: child.kind, state, ...(childRow ? { explanation: childRow.content as OperatorExplanation } : {}) };
    });
    const scope = preparedOperatorScope(definition, kids.filter(child => !inCap(child)));
    const reasoning = input.leafReasoning === "off" && childInputs.length === 0 ? "off" : "provider-default";
    result.checked += 1;
    if (operatorInputHash({ modelId: input.modelId, reasoning, scope, children: childInputs }) !== stored) result.mismatches += 1;
  }
  return result;
}

/**
 * The incremental draft's sidecar: new scope definitions; every surviving baseline explanation copied unchanged
 * (dirty ones keep theirs, marked stale, until the pass replaces them); removed scopes dropped; stale scopes marked,
 * including explained below-cap scopes the diff touched (`belowCapTouched`).
 */
export function incrementalSidecar(input: { next: ArchitectureSnapshot; baseline: OperatorSidecar; cap: OperatorEnrichmentCap; dirty: ReadonlySet<string>; stale: ReadonlyMap<string, ImpactStaleReason>; belowCapTouched?: ReadonlyMap<string, ImpactStaleReason> }): OperatorSidecar {
  const priorScopes = new Map(input.baseline.scopes.map(scope => [scope.scopeId, scope]));
  const alive = new Set(input.next.entities.map(entity => entity.id));
  const explanations = input.baseline.explanations.filter(row => alive.has(row.scopeId));
  const explained = new Set(explanations.map(row => row.scopeId));
  const scopes: SidecarScope[] = input.next.entities.map(entity => {
    const prior = priorScopes.get(entity.id); const belowCap = belowEnrichmentCap(entity.kind, input.cap); const hasExplanation = explained.has(entity.id);
    const dirty = input.dirty.has(entity.id);
    const state = dirty ? sidecarState(hasExplanation, false, undefined, belowCap) : sidecarState(hasExplanation, false, prior?.state, belowCap);
    const priorStale = Boolean(prior?.stale) && !prior?.staleReason;
    // A below-cap explanation is never re-enriched by the pass: when its own source changed, moved or gained/lost a
    // relation it is marked stale (with its reason) instead of being carried through as fresh.
    const overlay = !dirty && !priorStale ? input.stale.get(entity.id) ?? (belowCap ? input.belowCapTouched?.get(entity.id) : undefined) ?? prior?.staleReason : undefined;
    const stale = hasExplanation && (dirty || priorStale || overlay !== undefined);
    // A dirty scope keeps its baseline explanation marked stale (no reason: its input changed) until the pass replaces it.
    // A claim re-check or moved-evidence overlay records its reason, so it never holds a re-reduced parent stale.
    return { scopeId: entity.id, ...(entity.parentId ? { parentScopeId: entity.parentId } : {}), name: entity.name, kind: entity.kind, sourceRefs: entity.sourceRefs, state, ...(stale ? { stale: true } : {}), ...(stale && overlay ? { staleReason: overlay } : {}) };
  });
  return { schemaVersion: 1, maxKind: input.cap, scopes, explanations };
}

/** Parses the stored changelog of an artifact and derives its outcome from the same artifact's sidecar. */
export function readIncrementalChangelog(store: OperatorStore, artifactRevisionId: string, pending: boolean): IncrementalChangelog | undefined {
  try {
    const stored = readJson<StoredIncrementalChangelog>(store, artifactRevisionId, INCREMENTAL_CHANGELOG_FILE);
    const sidecar = readJson<OperatorSidecar>(store, artifactRevisionId, "operator-explanations.json");
    const published = stored?.publication ? readJson<OperatorSidecar>(store, stored.publication.artifactRevisionId, "operator-explanations.json") : undefined;
    return stored && sidecar ? incrementalChangelogView(stored, sidecar, pending, published) : undefined;
  } catch { return undefined; }
}

/** Unfinished-scope reasons of an incremental revision, for the scope list and detail (`staleReason` "pending" / "dropped"). */
export function readUnfinishedReasons(store: OperatorStore, artifactRevisionId: string): Map<string, UnfinishedReason> {
  try {
    const stored = readJson<StoredIncrementalChangelog>(store, artifactRevisionId, INCREMENTAL_CHANGELOG_FILE);
    const sidecar = readJson<OperatorSidecar>(store, artifactRevisionId, "operator-explanations.json");
    return stored && sidecar ? new Map(unfinishedScopes(stored, sidecar).map(item => [item.id, item.reason])) : new Map();
  } catch { return new Map(); }
}

const unfinishedScope = (scope: SidecarScope | undefined) => Boolean(scope && ((scope.stale && !scope.staleReason) || scope.state === "failed" || scope.state === "not run"));
const attemptedBy = (changelog: StoredIncrementalChangelog | undefined) => new Set([...(changelog?.dirty ?? []), ...(changelog?.carried ?? [])].map(item => item.scopeId));

/** At most this many earlier chain steps are listed in a changelog; `chainLength` keeps the full count. */
export const CHAIN_LIST_LIMIT = 20;
interface ChainInfo { chain: NonNullable<StoredIncrementalChangelog["chain"]>; chainLength: number; chainPartial?: true; publication?: NonNullable<StoredIncrementalChangelog["publication"]> }

/**
 * The chain under an incremental run and the scopes to re-seed from it. Only a previous UNPUBLISHED chain step's own
 * leftovers are carried: in-cap scopes that step selected (commit-caused or carried) and left failed, not run or stale
 * without a reason. Gaps in the publication itself are never re-seeded automatically (the operator retries them).
 * A step FAILED a scope when that run attempted it and the scope is still unfinished in the run's final sidecar (an
 * ancestor re-reduced but held stale by an unfinished child counts; a scope a budget stop never reached does not).
 * A scope two consecutive steps failed is dropped, with every ancestor it holds stale: never carried again, and listed
 * as `dropped` (with the earlier steps' drops that are still unfinished) until a commit touches it or the operator
 * refreshes it. Commit-caused dirty
 * scopes are excluded (they are attempted anyway).
 */
export function chainCarry(store: OperatorStore, info: OperatorIncrementalRunInfo, next: ArchitectureSnapshot, cap: OperatorEnrichmentCap, commitDirty: ReadonlySet<string>): { carried: string[]; dropped: string[] } & ChainInfo {
  const state = store.snapshot();
  const publicationRecord = info.baseline.publicationVersionId ? state.publications.find(value => value.versionId === info.baseline.publicationVersionId) : undefined;
  const publicationArtifact = publicationRecord && state.artifacts.find(value => value.artifactRevisionId === publicationRecord.artifactRevisionId);
  const publication = publicationRecord && publicationArtifact?.sourceCommitSha ? { versionId: publicationRecord.versionId, commitSha: publicationArtifact.sourceCommitSha, draftRevisionId: publicationRecord.draftRevisionId, artifactRevisionId: publicationRecord.artifactRevisionId } : undefined;
  const baselineRun = state.runs.find(value => value.runId === info.baseline.runId);
  const isChainStep = baselineRun?.kind === "incremental" && info.baseline.draftRevisionId !== publicationRecord?.draftRevisionId;
  if (!isChainStep) return { carried: [], dropped: [], chain: [], chainLength: 0, ...(publication ? { publication } : {}) };
  const last = readJson<StoredIncrementalChangelog>(store, info.baseline.artifactRevisionId, INCREMENTAL_CHANGELOG_FILE);
  const lastSidecar = readJson<OperatorSidecar>(store, info.baseline.artifactRevisionId, "operator-explanations.json");
  // A changelog without `chain` predates the field: its own predecessors are unknown unless it started at the publication.
  const legacy = Boolean(last && !Array.isArray(last.chain) && last.baseline.draftRevisionId !== publicationRecord?.draftRevisionId);
  const priorLength = last?.chainLength ?? last?.chain?.length ?? 0;
  const fullChain = [...(last?.chain ?? []), { runId: info.baseline.runId, draftRevisionId: info.baseline.draftRevisionId, toCommit: info.baseline.commitSha }];
  const failedIn = (step: { runId: string; draftRevisionId: string } | undefined) => {
    if (!step) return new Set<string>();
    const drafts = new Set(state.drafts.filter(draft => draft.runId === step.runId).map(draft => draft.draftRevisionId));
    const attempted = new Set(state.attempts.filter(value => drafts.has(value.draftRevisionId)).map(value => value.scopeId));
    const finalDraft = state.drafts.find(draft => draft.draftRevisionId === step.draftRevisionId);
    const sidecar = finalDraft ? (finalDraft.artifactRevisionId === info.baseline.artifactRevisionId ? lastSidecar : readJson<OperatorSidecar>(store, finalDraft.artifactRevisionId, "operator-explanations.json")) : undefined;
    const scopes = new Map((sidecar?.scopes ?? []).map(scope => [scope.scopeId, scope]));
    return new Set([...attempted].filter(scopeId => unfinishedScope(scopes.get(scopeId))));
  };
  const failedLast = failedIn(info.baseline); const failedBefore = failedIn(last?.chain?.at(-1));
  const lastScopes = new Map((lastSidecar?.scopes ?? []).map(scope => [scope.scopeId, scope]));
  const kinds = new Map(next.entities.map(entity => [entity.id, entity.kind]));
  const eligible = (scopeId: string) => kinds.has(scopeId) && !belowEnrichmentCap(kinds.get(scopeId), cap) && !commitDirty.has(scopeId) && unfinishedScope(lastScopes.get(scopeId));
  const leftovers = [...attemptedBy(last)].filter(eligible);
  const failedTwice = leftovers.filter(scopeId => failedLast.has(scopeId) && failedBefore.has(scopeId));
  const inherited = (last?.dropped ?? []).map(item => item.scopeId).filter(eligible);
  // An ancestor of a dropped scope is dropped with it: re-reducing it cannot make it fresh while that child is unfinished.
  const parents = new Map(next.entities.map(entity => [entity.id, entity.parentId]));
  const holding = new Set<string>();
  for (const scopeId of [...failedTwice, ...inherited]) for (let parent = parents.get(scopeId); parent; parent = parents.get(parent)) holding.add(parent);
  const droppedNow = leftovers.filter(scopeId => failedTwice.includes(scopeId) || holding.has(scopeId));
  const carried = leftovers.filter(scopeId => !droppedNow.includes(scopeId)).sort();
  const dropped = [...new Set([...droppedNow, ...inherited])].sort();
  return { carried, dropped, chain: fullChain.slice(-CHAIN_LIST_LIMIT), chainLength: priorLength + 1, ...(legacy || last?.chainPartial ? { chainPartial: true } : {}), ...(publication ? { publication } : {}) };
}

/**
 * "Update stopped at the run budget (OKIE_LLM_OPERATOR_*): 15 re-summarised, 19 not run, 52 kept stale (changed; not
 * re-enriched)." The stop reason comes from the passes' own errors (budget, no gateway, scope failures); any other error
 * text is kept verbatim after the counts, so nothing the passes reported is lost.
 */
export function incrementalRunError(passError: string, view: IncrementalChangelog): string {
  const stop = /process-wide operator budget/.test(passError) ? "stopped at the process-wide operator budget (OKIE_LLM_GLOBAL_*)"
    : /run budget|enrichment budget is exhausted/.test(passError) ? "stopped at the run budget (OKIE_LLM_OPERATOR_*)"
    : /no enrichment gateway is configured/.test(passError) ? "was not run: no enrichment gateway is configured"
    : /selected scopes? failed/.test(passError) ? "finished with failures" : undefined;
  const { outcome } = view;
  const parts = [`${outcome.resummarised.total} re-summarised`, ...(outcome.failed.total ? [`${outcome.failed.total} failed`] : []), ...(outcome.notRun.total ? [`${outcome.notRun.total} not run`] : []), ...(outcome.keptStale.total ? [`${outcome.keptStale.total} kept stale (changed; not re-enriched)`] : [])];
  return stop ? `Update ${stop}: ${parts.join(", ")}.` : `Update finished with an error: ${parts.join(", ")}. ${passError}`;
}

/**
 * The carried pass runs only when the commit's own pass finished ("complete"), or when there was no commit pass. A
 * budget ("limit"), cancelled or unavailable first pass admits nothing further, so the commit-caused work is never
 * displaced and the stop reason stays the first pass's.
 */
export function carriedPassAllowed(commitSeeds: number, firstPassStop: string | undefined): boolean { return commitSeeds === 0 || firstPassStop === "complete"; }

/** How the last enrichment pass of a run ended: "complete", "limit" (budget), "unavailable", or another stop. */
function lastPassStop(store: OperatorStore, runId: string): string | undefined {
  const event = store.snapshot().events.filter(value => value.runId === runId && (value.type === "enrichment.finished" || value.type === "enrichment.budget_refused" || value.type === "enrichment.unavailable")).at(-1);
  if (!event) return undefined;
  return event.type === "enrichment.budget_refused" ? "limit" : event.type === "enrichment.unavailable" ? "unavailable" : typeof event.detail?.stopped === "string" ? event.detail.stopped : undefined;
}

/** Runner body for `kind: "incremental"`. The run already exists (see startIncrementalRun) with its baseline recorded. */
export async function runIncremental(ctx: IncrementalRunContext, run: OperatorRun, access: ScanGithubAccess): Promise<void> {
  const info = run.incremental;
  if (!info) { ctx.store.updateRun(run.runId, { state: "failed", error: "incremental run has no baseline" }); return; }
  const startedAt = Date.now();
  // Cancelled while queued: never mark it running (and never scan or spend).
  if (ctx.store.isCancelled(run.runId)) return;
  ctx.store.updateRun(run.runId, { state: "running" });
  try {
    const client = ctx.client(access);
    const source: GithubSourceRef = { owner: run.source.owner, repo: run.source.repo, dirSlug: run.source.slug, ...(info.ref ? { ref: info.ref } : {}) };
    const commitSha = await ctx.resolveCommit(source, client);
    const withTarget: OperatorIncrementalRunInfo = { ...info, targetCommitSha: commitSha };
    if (ctx.store.isCancelled(run.runId)) return;
    if (commitSha === info.baseline.commitSha) {
      ctx.store.appendEvent({ runId: run.runId, type: "incremental.up_to_date", detail: { commitSha, baselineCommitSha: info.baseline.commitSha } });
      ctx.store.updateRun(run.runId, { state: "complete", source: { ...run.source, commitSha }, incremental: { ...withTarget, upToDate: { commitSha } }, error: undefined as never });
      // A cron tick makes one of these per repository: keep only the newest no-op run of the repository.
      ctx.store.pruneUpToDateRuns(run.source.repositoryId, run.runId);
      return;
    }
    ctx.store.updateRun(run.runId, { incremental: withTarget });
    const scanned = await ctx.scan({ ...source, ref: commitSha }, client);
    if (ctx.store.isCancelled(run.runId)) return;
    const previous = readJson<ArchitectureSnapshot>(ctx.store, info.baseline.artifactRevisionId, "snapshot.json");
    const baseline = readJson<OperatorSidecar>(ctx.store, info.baseline.artifactRevisionId, "operator-explanations.json");
    if (!previous || !baseline) throw new Error("incremental baseline artifact is missing");
    const next = scanned.artifacts.snapshot;
    const cap = baselineCap(baseline, ctx.defaultCap());
    const impact = computeIncrementalImpact({ previous, next, cap });
    const { carried, dropped, chain, chainLength, chainPartial, publication } = chainCarry(ctx.store, info, next, cap, new Set(impact.dirty));
    const publicationSnapshot = publication ? (publication.artifactRevisionId === info.baseline.artifactRevisionId ? previous : readJson<ArchitectureSnapshot>(ctx.store, publication.artifactRevisionId, "snapshot.json")) : undefined;
    const cumulativeImpact = publicationSnapshot ? (publicationSnapshot === previous ? impact : computeIncrementalImpact({ previous: publicationSnapshot, next, cap })) : undefined;
    const scopes = operatorScopesFromSnapshot(next);
    const { modelId, leafReasoning } = ctx.hashModel();
    const storedRows = new Map(ctx.store.snapshot().explanations.map(row => [row.explanationVersionId, row.inputHash]));
    const hashCheck = reuseHashCheck({ scopes, cap, baseline, reused: impact.reused, modelId, leafReasoning, storedHash: row => row.inputHash ?? (row.explanationVersionId ? storedRows.get(row.explanationVersionId) : undefined) });
    const seeded = new Set([...impact.dirty, ...carried]);
    const sidecar = incrementalSidecar({ next, baseline, cap, dirty: seeded, stale: new Map(impact.stale.map(item => [item.scopeId, item.reason])), belowCapTouched: new Map(impact.belowCap.map(item => [item.scopeId, item.reason])) });
    const versions = new Map(baseline.explanations.filter(row => row.explanationVersionId).map(row => [row.scopeId, row.explanationVersionId!]));
    const changelog = buildStoredChangelog({ impact, fromCommit: info.baseline.commitSha, toCommit: scanned.commitSha, baseline: { runId: info.baseline.runId, draftRevisionId: info.baseline.draftRevisionId, ...(info.baseline.publicationVersionId ? { publicationVersionId: info.baseline.publicationVersionId } : {}) }, hashCheck, scopes: new Map(next.entities.map(entity => [entity.id, { kind: entity.kind, name: entity.name }])), baselineVersions: versions, carried, stale: sidecar.scopes.filter(scope => scope.stale && scope.staleReason).map(scope => ({ scopeId: scope.scopeId, reason: scope.staleReason! })), unfinished: sidecar.scopes.filter(scope => unfinishedScope(scope) && !seeded.has(scope.scopeId)).map(scope => scope.scopeId), dropped, chain, chainLength, chainPartial: Boolean(chainPartial), ...(publication ? { publication } : {}), ...(cumulativeImpact ? { cumulativeImpact } : {}) });
    const files = { ...ctx.publicFiles(scanned.artifacts), "operator-explanations.json": stableJson(sidecar), [INCREMENTAL_CHANGELOG_FILE]: stableJson(changelog) };
    const artifact = ctx.store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: scanned.commitSha, files });
    const draft = ctx.publication.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId, coverage: coverageFor(sidecar.scopes) });
    ctx.store.updateRun(run.runId, { draftRevisionId: draft.draftRevisionId, source: { ...run.source, commitSha: scanned.commitSha } });
    ctx.store.appendEvent({ runId: run.runId, type: "incremental.diff", detail: { fromCommit: info.baseline.commitSha, toCommit: scanned.commitSha, ...changelog.counts, seeds: impact.seeds.length, chainSteps: chain.length, hashChecked: hashCheck.checked, hashMismatches: hashCheck.mismatches, hashUnknown: hashCheck.unknown } });
    // The commit's own seeds are admitted first; scopes carried from the chain get a second pass only if the first one
    // finished within budget.
    if (impact.seeds.length && !ctx.store.isCancelled(run.runId)) await ctx.retry({ runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeIds: impact.seeds });
    if (carried.length && !ctx.store.isCancelled(run.runId) && carriedPassAllowed(impact.seeds.length, impact.seeds.length ? lastPassStop(ctx.store, run.runId) : undefined)) {
      const before = ctx.store.snapshot().runs.find(value => value.runId === run.runId);
      await ctx.retry({ runId: run.runId, draftRevisionId: before?.draftRevisionId ?? draft.draftRevisionId, scopeIds: carried });
      // Each pass sets the run error from its own failures: keep the commit pass's error alongside the carried pass's.
      const firstError = before?.error; const secondError = ctx.store.snapshot().runs.find(value => value.runId === run.runId)?.error;
      if (firstError && !ctx.store.isCancelled(run.runId)) ctx.store.updateRun(run.runId, { error: secondError ? `${firstError} Carried scopes — ${secondError}` : firstError });
    }
    if (ctx.store.isCancelled(run.runId)) return;
    const after = ctx.store.snapshot().runs.find(value => value.runId === run.runId);
    // A pass that re-enriched nothing (no seeds, or nothing to install) leaves the run on the incremental draft.
    if (after?.state === "running" || after?.state === "queued") ctx.store.updateRun(run.runId, { state: "awaiting_review" });
    const current = ctx.store.snapshot().drafts.find(value => value.draftRevisionId === (after?.draftRevisionId ?? draft.draftRevisionId))!;
    const view = readIncrementalChangelog(ctx.store, current.artifactRevisionId, false);
    // One run error for the whole update, in the changelog outcome's numbers (the passes' own errors count their
    // selections, which disagree with the chips): both passes are covered, and the stop reason is kept.
    const passError = ctx.store.snapshot().runs.find(value => value.runId === run.runId)?.error;
    if (view && passError && !ctx.store.isCancelled(run.runId)) ctx.store.updateRun(run.runId, { error: incrementalRunError(passError, view) });
    const published = info.autoPublish ? autoPublish(ctx, run, current.draftRevisionId, current.artifactRevisionId, info) : undefined;
    ctx.store.appendEvent({ runId: run.runId, type: "incremental.finished", detail: { durationMs: Math.max(0, Date.now() - startedAt), dirty: impact.dirty.length, carried: carried.length, dropped: dropped.length, reused: view?.counts.reused ?? changelog.counts.reused, stale: view?.counts.stale ?? changelog.counts.stale, ...(view ? { unfinished: view.unfinished.total, resummarised: view.outcome.resummarised.total, failed: view.outcome.failed.total, notRun: view.outcome.notRun.total, keptStale: view.outcome.keptStale.total, summary: view.summary.slice(0, 700) } : {}), ...(published ? { autoPublished: published.published, ...(published.reason ? { autoPublishReason: published.reason } : {}) } : {}) } });
  } catch (error) { ctx.store.updateRun(run.runId, { state: "failed", error: error instanceof Error ? error.message : String(error) }); }
}

/**
 * Opt-in auto-publish: only a fully accepted draft (no failed, not run or stale scope; every in-scope scope accepted)
 * whose artifact passes publish validation, through the normal publication service, and only over the publication the
 * run started from (a newer manual publication wins: stale_publication, nothing published).
 */
export function autoPublishGate(coverage: Parameters<typeof coverageIncomplete>[0]): boolean { return !coverageIncomplete(coverage); }
function autoPublish(ctx: IncrementalRunContext, run: OperatorRun, draftRevisionId: string, artifactRevisionId: string, info: OperatorIncrementalRunInfo): { published: boolean; reason?: string } {
  const sidecar = readJson<OperatorSidecar>(ctx.store, artifactRevisionId, "operator-explanations.json");
  const coverage = coverageFor(sidecar?.scopes ?? []);
  if (!sidecar || !autoPublishGate(coverage)) { ctx.store.appendEvent({ runId: run.runId, type: "incremental.auto_publish", detail: { published: false, reason: "coverage_incomplete", failed: coverage.failed, notRun: coverage.notRun, stale: coverage.stale } }); return { published: false, reason: "coverage_incomplete" }; }
  const latest = ctx.store.snapshot().runs.find(value => value.runId === run.runId) ?? run;
  if (!isPublishableArtifact(ctx.store, artifactRevisionId, latest.source)) { ctx.store.appendEvent({ runId: run.runId, type: "incremental.auto_publish", detail: { published: false, reason: "invalid_artifact" } }); return { published: false, reason: "invalid_artifact" }; }
  const result = ctx.publication.publishDraft({ repositoryId: run.source.repositoryId, draftRevisionId, ...(info.baseline.publicationVersionId ? { expectedCurrentVersionId: info.baseline.publicationVersionId } : {}), coverage });
  ctx.store.appendEvent({ runId: run.runId, type: "incremental.auto_publish", detail: result.ok ? { published: true, versionId: result.publication.versionId } : { published: false, reason: result.reason } });
  return result.ok ? { published: true } : { published: false, reason: result.reason };
}
