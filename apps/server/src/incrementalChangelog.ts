import type { OperatorEnrichmentCap } from "./operatorContracts.js";
import type { ImpactEntityChange, ImpactEntityRef, ImpactRelationKey, ImpactStaleReason, IncrementalImpact } from "./incrementalImpact.js";

/**
 * CLA-271 changelog for one incremental draft. The diff part is stored in the draft's immutable artifact
 * (`incremental-changelog.json`, copied into every later revision of the run); the enrichment outcome, the reuse
 * provenance and the summary lines are derived from the same artifact's sidecar (and the live publication's sidecar),
 * so every revision reports its own outcome. Pure: no I/O.
 *
 * Two views of one draft:
 * - this update only: the baseline (the previous unpublished chain step, or the publication) → this commit;
 * - cumulative (`cumulative`): the publication → this commit, computed by the same pure diff over the publication's
 *   snapshot, i.e. what publishing this draft would ship. `chain` lists the unpublished steps in between.
 */
export const INCREMENTAL_CHANGELOG_FILE = "incremental-changelog.json";
/** Upper bound on every list in the changelog; `total` always carries the full count. */
export const CHANGELOG_LIST_LIMIT = 50;
export interface Bounded<T> { total: number; items: T[] }
export interface IncrementalHashCheck { checked: number; mismatches: number; unknown: number }
export interface ChangelogCounts {
  entitiesAdded: number; entitiesRemoved: number; entitiesChanged: number; surfaceChanges: number; internalChanges: number; entitiesMoved: number;
  relationsAdded: number; relationsRemoved: number; removedExports: number;
  /** Commit-caused dirty scopes (this diff). */
  dirty: number;
  /** Scopes a previous unpublished chain step left unfinished, re-seeded by this run (absent before round 2). */
  carried?: number;
  /**
   * Stored: every stale-with-reason scope of the draft (this diff's, inherited from the chain, and below-cap ones). In the
   * response it also includes the `unfinished` scopes, so it counts every scope whose explanation is not current.
   */
  stale: number;
  /** Response only: stale scopes without a reason plus dropped scopes (see `unfinished`). */
  unfinished?: number;
  reused: number; removedScopes: number;
}
export interface ChangelogDiff {
  counts: ChangelogCounts;
  entities: { added: Bounded<ImpactEntityRef>; removed: Bounded<ImpactEntityRef>; changed: Bounded<ImpactEntityChange>; moved: Bounded<ImpactEntityRef> };
  relations: { added: Bounded<ImpactRelationKey>; removed: Bounded<ImpactRelationKey> };
  removedExports: Bounded<ImpactEntityRef & { consumerCount: number }>;
}
export interface ChangelogScopeRef { scopeId: string; kind: string; name: string; baselineExplanationVersionId?: string }
/** The publication → head diff (what publishing this draft would ship). */
export interface CumulativeChangelog extends ChangelogDiff { fromCommit: string; toCommit: string; dirty: Bounded<ImpactEntityRef> }
export interface StoredIncrementalChangelog extends ChangelogDiff {
  schemaVersion: 1;
  fromCommit: string;
  toCommit: string;
  baseline: { runId: string; draftRevisionId: string; publicationVersionId?: string };
  cap: OperatorEnrichmentCap;
  stale: Bounded<{ scopeId: string; reason: ImpactStaleReason }>;
  /** Reused explanations whose recomputed input hash differs from the stored one (never fails the run). */
  hashCheck: IncrementalHashCheck;
  /** Every commit-caused dirty scope (unbounded: the outcome needs them all) with its baseline explanation version. */
  dirty: ChangelogScopeRef[];
  /** Every re-seeded scope from the chain (unbounded), with its baseline explanation version. */
  carried?: ChangelogScopeRef[];
  /** The live publication under the chain when the run started. */
  publication?: { versionId: string; commitSha: string; draftRevisionId: string; artifactRevisionId: string };
  /** Earlier unpublished chain steps on that publication, oldest first (this run excluded); the last 20 only. */
  chain?: Array<{ runId: string; draftRevisionId: string; toCommit: string }>;
  /** Total earlier chain steps (`chain` is bounded). */
  chainLength?: number;
  /** The chain passes through a draft made before `chain` existed: `chainLength` is a lower bound. */
  chainPartial?: true;
  /** In-cap scopes the carry gave up on (two consecutive chain steps failed them), still unfinished, with earlier drops. */
  dropped?: ChangelogScopeRef[];
  cumulative?: CumulativeChangelog;
}
export interface IncrementalOutcome {
  /** "pending" while the run's re-enrichment pass is still writing to this revision. */
  state: "pending" | "settled";
  /** Dirty or carried scopes with a new explanation in this revision, by C4 kind. */
  resummarised: Bounded<ImpactEntityRef>;
  resummarisedByKind: Record<string, number>;
  /** Dirty scopes that kept their baseline explanation (marked stale): refused, failed, or skipped by the pass. */
  keptStale: Bounded<ImpactEntityRef>;
  failed: Bounded<ImpactEntityRef>;
  notRun: Bounded<ImpactEntityRef>;
}
/** Where each explanation of this revision comes from, relative to the live publication. */
export interface ChangelogReuse {
  /** Byte-for-byte the published explanation. */
  fromPublication: Bounded<ImpactEntityRef>;
  /** Re-enriched by an earlier unpublished chain step and carried here: not yet reviewed by anyone. */
  sincePublication: Bounded<ImpactEntityRef>;
}
/** Why an unfinished scope's explanation is not current. */
export type UnfinishedReason = "pending" | "dropped" | "inherited";
export interface IncrementalChangelog extends Omit<StoredIncrementalChangelog, "dirty" | "carried" | "dropped"> {
  dirty: Bounded<ImpactEntityRef>;
  carried: Bounded<ImpactEntityRef>;
  /**
   * Scopes of this revision whose explanation is not current and that carry no stale reason: "pending" = selected by
   * this update but not re-enriched (budget stop or failure; the next chain step retries it); "dropped" = two
   * consecutive updates failed it; "inherited" = left unfinished before this chain. The last two need a Refresh. Counted in `counts.stale`; never "reused from publication".
   */
  unfinished: Bounded<ImpactEntityRef & { reason: UnfinishedReason }>;
  outcome: IncrementalOutcome;
  reuse?: ChangelogReuse;
  /** This update only. */
  summary: string;
  /** Publication → this draft; absent without a publication. */
  cumulativeSummary?: string;
}

const bounded = <T>(items: readonly T[]): Bounded<T> => ({ total: items.length, items: items.slice(0, CHANGELOG_LIST_LIMIT) });
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function diffPart(impact: IncrementalImpact): ChangelogDiff {
  const diff = impact.diff;
  return {
    counts: {
      entitiesAdded: diff.added.length, entitiesRemoved: diff.removed.length, entitiesChanged: diff.changed.length,
      surfaceChanges: diff.changed.filter(item => item.change === "surface").length, internalChanges: diff.changed.filter(item => item.change === "internal").length, entitiesMoved: diff.moved.length,
      relationsAdded: diff.relationsAdded.length, relationsRemoved: diff.relationsRemoved.length, removedExports: diff.removedExports.length,
      dirty: impact.dirty.length, stale: impact.stale.length, reused: impact.reused.length, removedScopes: impact.removed.length,
    },
    entities: { added: bounded(diff.added), removed: bounded(diff.removed), changed: bounded(diff.changed), moved: bounded(diff.moved) },
    relations: { added: bounded(diff.relationsAdded), removed: bounded(diff.relationsRemoved) },
    removedExports: bounded(diff.removedExports.map(({ consumers, ...entity }) => ({ ...entity, consumerCount: consumers.length }))),
  };
}

export function buildStoredChangelog(input: {
  impact: IncrementalImpact; fromCommit: string; toCommit: string; baseline: StoredIncrementalChangelog["baseline"]; hashCheck: IncrementalHashCheck;
  scopes: ReadonlyMap<string, { kind: string; name: string }>; baselineVersions: ReadonlyMap<string, string>;
  /** Re-seeded scopes (not commit-caused). */
  carried?: readonly string[];
  /** Every stale-with-reason scope of the new sidecar (inherited overlays and below-cap ones included). */
  stale?: ReadonlyArray<{ scopeId: string; reason: ImpactStaleReason }>;
  /** Scopes of the new sidecar left unfinished and not attempted by this run (inherited or dropped): never counted as reused. */
  unfinished?: readonly string[];
  dropped?: readonly string[];
  publication?: StoredIncrementalChangelog["publication"];
  chain?: StoredIncrementalChangelog["chain"];
  chainLength?: number;
  chainPartial?: boolean;
  /** publication snapshot → next snapshot, by the same pure diff. */
  cumulativeImpact?: IncrementalImpact;
}): StoredIncrementalChangelog {
  const { impact } = input;
  const ref = (scopeId: string): ChangelogScopeRef => { const scope = input.scopes.get(scopeId); const version = input.baselineVersions.get(scopeId); return { scopeId, kind: scope?.kind ?? "unknown", name: scope?.name ?? scopeId, ...(version ? { baselineExplanationVersionId: version } : {}) }; };
  const carried = [...(input.carried ?? [])];
  const stale = [...(input.stale ?? impact.stale)].sort((left, right) => left.scopeId < right.scopeId ? -1 : left.scopeId > right.scopeId ? 1 : 0);
  const staleIds = new Set([...stale.map(item => item.scopeId), ...(input.unfinished ?? []), ...(input.dropped ?? [])]); const carriedIds = new Set(carried);
  const part = diffPart(impact);
  const reused = impact.reused.filter(id => !staleIds.has(id) && !carriedIds.has(id)).length;
  const cumulative = input.cumulativeImpact && input.publication ? (() => {
    const whole = diffPart(input.cumulativeImpact);
    const { stale: _stale, reused: _reused, ...counts } = whole.counts;
    return { fromCommit: input.publication.commitSha, toCommit: input.toCommit, ...whole, counts: { ...counts, stale: stale.length, reused: input.cumulativeImpact.reused.filter(id => !staleIds.has(id)).length }, dirty: bounded(input.cumulativeImpact.dirty.map(id => { const scope = input.scopes.get(id); return { id, kind: scope?.kind ?? "unknown", name: scope?.name ?? id }; })) };
  })() : undefined;
  return {
    schemaVersion: 1, fromCommit: input.fromCommit, toCommit: input.toCommit, baseline: input.baseline, cap: impact.cap,
    ...part,
    counts: { ...part.counts, carried: carried.length, stale: stale.length, reused },
    stale: bounded(stale),
    hashCheck: input.hashCheck,
    dirty: impact.dirty.map(ref),
    carried: carried.map(ref),
    ...(input.publication ? { publication: input.publication } : {}),
    ...(input.chain ? { chain: input.chain, chainLength: input.chainLength ?? input.chain.length } : {}),
    ...(input.chainPartial ? { chainPartial: true as const } : {}),
    ...(input.dropped?.length ? { dropped: input.dropped.map(ref) } : {}),
    ...(cumulative ? { cumulative } : {}),
  };
}

/** The sidecar as the outcome reads it. */
export interface ChangelogSidecar { scopes: ReadonlyArray<{ scopeId: string; name?: string; kind?: string; state?: string; stale?: boolean; staleReason?: string }>; explanations: ReadonlyArray<{ scopeId: string; explanationVersionId?: string }> }

/** Every unfinished scope of a revision (unbounded), sorted: stale without a reason ("pending" when this update selected it, else "inherited") or dropped by the carry. */
export function unfinishedScopes(stored: Pick<StoredIncrementalChangelog, "dropped" | "dirty" | "carried">, sidecar: ChangelogSidecar): Array<ImpactEntityRef & { reason: UnfinishedReason }> {
  const droppedIds = new Set((stored.dropped ?? []).map(item => item.scopeId));
  // Only a scope this update selected (commit-caused or carried) is retried by the next update; any other one was
  // left unfinished before this chain (e.g. in the publication) and waits for a Refresh.
  const selected = new Set([...stored.dirty, ...(stored.carried ?? [])].map(item => item.scopeId));
  return sidecar.scopes.filter(scope => (scope.stale && !scope.staleReason) || (droppedIds.has(scope.scopeId) && (scope.stale || scope.state === "failed" || scope.state === "not run")))
    .map(scope => ({ id: scope.scopeId, kind: scope.kind ?? "unknown", name: scope.name ?? scope.scopeId, reason: (droppedIds.has(scope.scopeId) ? "dropped" : selected.has(scope.scopeId) ? "pending" : "inherited") as UnfinishedReason }))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/**
 * The response shape: stored diff + the outcome and summaries of the revision whose sidecar is given. With the live
 * publication's sidecar, reused explanations are split into "reused from publication" and "re-enriched since
 * publication (unreviewed)".
 */
export function incrementalChangelogView(stored: StoredIncrementalChangelog, sidecar: ChangelogSidecar, pending = false, publicationSidecar?: ChangelogSidecar): IncrementalChangelog {
  const states = new Map(sidecar.scopes.map(scope => [scope.scopeId, scope]));
  const versions = new Map(sidecar.explanations.map(row => [row.scopeId, row.explanationVersionId]));
  const resummarised: ImpactEntityRef[] = []; const keptStale: ImpactEntityRef[] = []; const failed: ImpactEntityRef[] = []; const notRun: ImpactEntityRef[] = [];
  const attempted = [...stored.dirty, ...(stored.carried ?? [])];
  for (const scope of attempted) {
    const entity = { id: scope.scopeId, kind: scope.kind, name: scope.name };
    const hasExplanation = versions.has(scope.scopeId);
    if (hasExplanation && versions.get(scope.scopeId) !== scope.baselineExplanationVersionId) resummarised.push(entity);
    else if (hasExplanation) keptStale.push(entity);
    else if (states.get(scope.scopeId)?.state === "failed") failed.push(entity);
    else notRun.push(entity);
  }
  const resummarisedByKind: Record<string, number> = {};
  for (const entity of resummarised) resummarisedByKind[entity.kind] = (resummarisedByKind[entity.kind] ?? 0) + 1;
  const outcome: IncrementalOutcome = { state: pending ? "pending" : "settled", resummarised: bounded(resummarised), resummarisedByKind, keptStale: bounded(keptStale), failed: bounded(failed), notRun: bounded(notRun) };
  const droppedIds = new Set((stored.dropped ?? []).map(item => item.scopeId));
  const unfinished = unfinishedScopes(stored, sidecar);
  let reuse: ChangelogReuse | undefined;
  if (publicationSidecar) {
    const published = new Map(publicationSidecar.explanations.map(row => [row.scopeId, row.explanationVersionId]));
    const now = new Set(resummarised.map(item => item.id));
    const fromPublication: ImpactEntityRef[] = []; const sincePublication: ImpactEntityRef[] = [];
    for (const row of sidecar.explanations) {
      const scope = states.get(row.scopeId);
      // A stale explanation (with or without a reason) is listed as stale or unfinished, never as reused.
      if (now.has(row.scopeId) || scope?.stale || droppedIds.has(row.scopeId)) continue; const entity = { id: row.scopeId, kind: scope?.kind ?? "unknown", name: scope?.name ?? row.scopeId };
      if (row.explanationVersionId && published.get(row.scopeId) === row.explanationVersionId) fromPublication.push(entity); else sincePublication.push(entity);
    }
    const byId = (left: ImpactEntityRef, right: ImpactEntityRef) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    reuse = { fromPublication: bounded(fromPublication.sort(byId)), sincePublication: bounded(sincePublication.sort(byId)) };
  }
  const { dirty, carried, dropped: _dropped, ...rest } = stored;
  const toRef = (scope: ChangelogScopeRef) => ({ id: scope.scopeId, kind: scope.kind, name: scope.name });
  const counts: ChangelogCounts = { ...stored.counts, carried: stored.counts.carried ?? 0, stale: stored.counts.stale + unfinished.length, unfinished: unfinished.length };
  const view = { ...rest, counts, ...(stored.cumulative ? { cumulative: { ...stored.cumulative, counts: { ...stored.cumulative.counts, stale: counts.stale, unfinished: unfinished.length } } } : {}) };
  return {
    ...view,
    dirty: bounded(dirty.map(toRef)), carried: bounded((carried ?? []).map(toRef)), unfinished: bounded(unfinished), outcome, ...(reuse ? { reuse } : {}),
    summary: changelogSummary(view, view, resummarised, outcome),
    ...(stored.cumulative && stored.publication ? { cumulativeSummary: cumulativeSummary(view, outcome, reuse) } : {}),
  };
}

type ChangelogHead = Omit<StoredIncrementalChangelog, "dirty" | "carried" | "dropped">;
/** "3 stale", or "54 stale (52 unfinished)" when some carry no reason. */
const staleText = (counts: ChangelogCounts) => `${counts.stale} stale${counts.unfinished ? ` (${counts.unfinished} unfinished)` : ""}`;

function changeParts(diff: ChangelogDiff): string[] {
  const parts: string[] = [];
  const exports = diff.removedExports.items;
  if (exports.length) {
    const names = exports.slice(0, 2).map(item => item.name).join(", ");
    parts.push(`removed export${diff.removedExports.total === 1 ? "" : "s"} ${names}${diff.removedExports.total > 2 ? ` (+${diff.removedExports.total - 2} more)` : ""}`);
    const consumers = exports.reduce((total, item) => total + item.consumerCount, 0);
    if (consumers) parts.push(`${plural(consumers, "consumer")} updated`);
  }
  const counts = diff.counts;
  const changes = [counts.entitiesChanged ? `${counts.entitiesChanged} changed` : "", counts.entitiesAdded ? `${counts.entitiesAdded} added` : "", counts.entitiesRemoved ? `${counts.entitiesRemoved} removed` : "", counts.relationsAdded + counts.relationsRemoved ? plural(counts.relationsAdded + counts.relationsRemoved, "edge change") : ""].filter(Boolean);
  if (changes.length) parts.push(changes.join(", "));
  return parts;
}

/** e.g. "removed export mul; 3 consumers updated; 2 changed, 1 added; container demo-lib re-summarised; system re-summarised; 1 stale; 4 reused". */
function changelogSummary(stored: ChangelogHead, diff: ChangelogDiff, resummarised: readonly ImpactEntityRef[], outcome: IncrementalOutcome): string {
  const parts = changeParts(diff);
  const counts = stored.counts;
  const containers = resummarised.filter(item => item.kind === "container");
  if (containers.length) parts.push(containers.length <= 2 ? containers.map(item => `container ${item.name} re-summarised`).join("; ") : `${containers.length} containers re-summarised`);
  const components = resummarised.filter(item => item.kind === "component").length;
  if (components) parts.push(`${plural(components, "component")} re-summarised`);
  const code = resummarised.filter(item => item.kind === "code").length;
  if (code) parts.push(`${plural(code, "symbol")} re-summarised`);
  if (resummarised.some(item => item.kind === "softwareSystem")) parts.push("system re-summarised");
  if (counts.carried) parts.push(`${plural(counts.carried, "unfinished scope")} carried from the previous update`);
  if (outcome.state === "pending") parts.push(`${plural(counts.dirty + (counts.carried ?? 0), "scope")} to re-enrich`);
  if (outcome.failed.total) parts.push(`${outcome.failed.total} failed`);
  if (outcome.notRun.total && outcome.state === "settled") parts.push(`${outcome.notRun.total} not run`);
  if (counts.stale) parts.push(staleText(counts));
  parts.push(`${counts.reused} reused`);
  if (!counts.dirty && !counts.stale && !counts.carried) parts.unshift("no content changes");
  return parts.join("; ");
}

/** e.g. "since published abc1234 (2 updates): 5 changed, 3 added; 14 re-summarised since publication (unreviewed); 2 stale; 230 reused from publication". */
function cumulativeSummary(stored: ChangelogHead, outcome: IncrementalOutcome, reuse: ChangelogReuse | undefined): string {
  const cumulative = stored.cumulative!;
  const steps = (stored.chainLength ?? stored.chain?.length ?? 0) + 1;
  const parts = changeParts(cumulative);
  const unreviewed = outcome.resummarised.total + (reuse?.sincePublication.total ?? 0);
  if (unreviewed) parts.push(`${unreviewed} re-summarised since publication (unreviewed)`);
  if (stored.counts.stale) parts.push(staleText(stored.counts));
  if (reuse) parts.push(`${reuse.fromPublication.total} reused from publication`);
  if (!cumulative.counts.dirty && !stored.counts.stale) parts.unshift("no content changes");
  // A chain through a draft made before `chain` existed has an unknown length: a lower bound only.
  return `since published ${stored.publication!.commitSha.slice(0, 7)} (${stored.chainPartial ? "≥" : ""}${plural(steps, "update")}): ${parts.join("; ")}`;
}
