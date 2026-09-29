import { useState, type ReactNode } from 'react';
import type { Bounded, ChangelogEntity, IncrementalChangelog, OperatorScope } from './api';
import { shortSha, staleReasonText, type UpdateOutcome } from './incremental';
import { count } from './scopeSelection';

/** Inline result of "Update to latest commit" (CLA-271): up to date, already running (with a way to it), or an error. */
export function OperatorUpdateResult({ outcome, onOpenRun }: { outcome: UpdateOutcome; onOpenRun(runId: string): void }) {
  if (outcome.kind === 'started') return null;
  if (outcome.kind === 'error') return <div className="operator-alert operator-update-result" data-update={outcome.kind} role="alert"><p>{outcome.message}</p></div>;
  return <div className="operator-notice operator-update-result" data-update={outcome.kind} role="status"><p>{outcome.message}</p>{outcome.kind === 'active' && <button onClick={() => onOpenRun(outcome.runId)} type="button">Open active run</button>}</div>;
}

const CHANGE_TEXT = { surface: 'interface changed', internal: 'internal change' } as const;

function ChangelogList<T>({ id, label, list, render }: { id: string; label: string; list: Bounded<T> | undefined; render(item: T): ReactNode }) {
  if (!list || list.total === 0) return null;
  const more = list.total - list.items.length;
  return <details className="operator-changelog-list" data-list={id}><summary>{label} · {count(list.total)}</summary><ul>{list.items.map((item, index) => <li key={index}>{render(item)}</li>)}</ul>{more > 0 && <p className="operator-muted operator-note">+{count(more)} more</p>}</details>;
}

function Entity({ entity, children }: { entity: ChangelogEntity; children?: ReactNode }) {
  return <><span className="operator-changelog-name" title={entity.id}>{entity.name}</span> <em className="operator-level">{entity.kind}</em>{children}</>;
}

export type ChangelogView = 'cumulative' | 'update';

/**
 * "Published abc1234 → this draft def5678 (2 updates)"; undefined without a publication under the chain. `updatesText`
 * is "≥N updates" when the chain passes through a draft made before the chain was recorded (its length is unknown), and
 * `superseded` when that publication is no longer the live one, unless this draft itself is now live (`draftIsLive`).
 */
export function changelogHeading(changelog: Pick<IncrementalChangelog, 'publication' | 'chain' | 'chainLength' | 'chainPartial' | 'toCommit'>, currentPublicationVersionId?: string, draftIsLive = false): { published: string; draft: string; updates: number; updatesText: string; superseded: boolean; draftIsLive: boolean } | undefined {
  if (!changelog.publication) return undefined;
  const updates = (changelog.chainLength ?? changelog.chain?.length ?? 0) + 1;
  const updatesText = `${changelog.chainPartial ? '≥' : ''}${count(updates)} update${updates === 1 && !changelog.chainPartial ? '' : 's'}`;
  return { published: shortSha(changelog.publication.commitSha)!, draft: shortSha(changelog.toCommit)!, updates, updatesText, superseded: !draftIsLive && currentPublicationVersionId !== undefined && changelog.publication.versionId !== currentPublicationVersionId, draftIsLive };
}

/**
 * The changelog of an incremental revision (CLA-271). With a publication under the update chain the panel opens on the
 * cumulative view (publication → this draft: what publishing would ship, with explanations split into "reused from
 * publication" and "re-enriched since publication (unreviewed)"); "This update only" shows the last step's diff.
 * Lists are bounded (`total` is the full count; at most 50 items are sent, the rest show as "+N more").
 */
export function OperatorChangelog({ changelog, scopes, initialView, currentPublicationVersionId, draftIsLive = false }: { changelog: IncrementalChangelog; scopes: readonly Pick<OperatorScope, 'scopeId' | 'entityId' | 'name'>[]; initialView?: ChangelogView; currentPublicationVersionId?: string; draftIsLive?: boolean }) {
  const hasCumulative = Boolean(changelog.cumulative && changelog.publication);
  const [chosen, setView] = useState<ChangelogView>(initialView ?? (hasCumulative ? 'cumulative' : 'update'));
  const view: ChangelogView = hasCumulative ? chosen : 'update';
  const byScope = new Map(scopes.map(scope => [scope.scopeId, scope.name]));
  const byEntity = new Map(scopes.flatMap(scope => scope.entityId ? [[scope.entityId, scope.name] as const] : []));
  const nameOf = (id: string) => byEntity.get(id) ?? byScope.get(id) ?? id;
  const { outcome } = changelog;
  const pending = outcome.state === 'pending';
  const diff = view === 'cumulative' ? changelog.cumulative! : changelog;
  const { counts, entities, relations } = diff;
  const carried = changelog.carried?.total ?? 0;
  const unreviewed = outcome.resummarised.total + (changelog.reuse?.sincePublication.total ?? 0);
  const unfinished = changelog.counts.unfinished ?? 0;
  const staleChip = `${count(changelog.counts.stale)} stale${unfinished ? ` (${count(unfinished)} unfinished)` : ''}`;
  const chips = view === 'cumulative' ? [
    `${count(unreviewed)} re-summarised since publication (unreviewed)`,
    `${count(changelog.reuse?.fromPublication.total ?? 0)} reused from publication`,
    staleChip,
    `${count(counts.entitiesRemoved)} removed`,
  ] : [
    `${count(outcome.resummarised.total)} re-summarised`,
    `${count(changelog.counts.reused)} reused`,
    staleChip,
    `${count(counts.entitiesRemoved)} removed`,
  ];
  const quiet = [carried ? `${count(carried)} carried from the previous update` : '', outcome.failed.total ? `${count(outcome.failed.total)} failed` : '', !pending && outcome.keptStale.total ? `${count(outcome.keptStale.total)} kept stale` : '', !pending && outcome.notRun.total ? `${count(outcome.notRun.total)} not run` : '', pending ? `${count(changelog.counts.dirty + carried)} to re-enrich` : ''].filter(Boolean);
  const lists = [diff.removedExports, entities.added, entities.removed, entities.changed, entities.moved, relations.added, relations.removed, changelog.stale, changelog.unfinished, changelog.carried, outcome.resummarised, outcome.keptStale, outcome.failed, outcome.notRun, ...(view === 'cumulative' ? [changelog.reuse?.sincePublication] : [])];
  const relation = (item: { from: string; to: string; kind: string }) => <>{nameOf(item.from)} → {nameOf(item.to)} <em className="operator-level">{item.kind}</em></>;
  const heading = changelogHeading(changelog, currentPublicationVersionId, draftIsLive);
  return <section className="operator-changelog" data-changelog-state={outcome.state} data-changelog-view={view} aria-label="Changes in this draft">
    <header>
      <h3>{view === 'cumulative' ? 'Changes since publication' : 'Changes in this update'}</h3>
      {heading
        ? <p className="operator-muted" data-changelog-heading {...(heading.superseded ? { 'data-publication-superseded': '' } : {})}>Published <code>{heading.published}</code>{heading.superseded ? <strong className="operator-changelog-flag" title="Another version was published after this chain started. Auto-publish is refused; publishing this draft replaces the live version."> (no longer the live publication)</strong> : null} → this draft <code>{heading.draft}</code>{heading.draftIsLive ? <strong className="operator-changelog-flag" data-draft-live=""> (live)</strong> : null} ({heading.updatesText}){view === 'update' && heading.updates > 1 ? <> · this update <code>{shortSha(changelog.fromCommit)}</code> → <code>{shortSha(changelog.toCommit)}</code></> : null}{pending ? ' · re-enrichment in progress' : ''}</p>
        : <p className="operator-muted"><code>{shortSha(changelog.fromCommit)}</code> → <code>{shortSha(changelog.toCommit)}</code>{pending ? ' · re-enrichment in progress' : ''}</p>}
      {hasCumulative && <div className="operator-changelog-views" role="group" aria-label="Changelog view">
        <button aria-pressed={view === 'cumulative'} data-view="cumulative" onClick={() => setView('cumulative')} type="button">Since publication</button>
        <button aria-pressed={view === 'update'} data-view="update" onClick={() => setView('update')} type="button">This update only</button>
      </div>}
    </header>
    <p className="operator-changelog-summary">{view === 'cumulative' ? changelog.cumulativeSummary ?? changelog.summary : changelog.summary}</p>
    <div className="operator-coverage">{chips.map(chip => <span key={chip}>{chip}</span>)}{quiet.map(chip => <span className="operator-chip-quiet" key={chip}>{chip}</span>)}</div>
    {lists.every(list => !list?.total) ? <p className="operator-muted operator-note">No entity or relation changes.</p> : <div className="operator-changelog-lists">
      <ChangelogList id="removed-exports" label="Removed exports" list={diff.removedExports} render={item => <Entity entity={item}> · {item.consumerCount === 0 ? 'no consumers' : `${count(item.consumerCount)} consumer${item.consumerCount === 1 ? '' : 's'}`}</Entity>}/>
      <ChangelogList id="added" label="Added" list={entities.added} render={item => <Entity entity={item}/>}/>
      <ChangelogList id="removed" label="Removed" list={entities.removed} render={item => <Entity entity={item}/>}/>
      <ChangelogList id="changed" label="Changed" list={entities.changed} render={item => <Entity entity={item}> · {CHANGE_TEXT[item.change] ?? item.change}</Entity>}/>
      <ChangelogList id="moved" label="Moved" list={entities.moved} render={item => <Entity entity={item}/>}/>
      <ChangelogList id="relations-added" label="Relations added" list={relations.added} render={relation}/>
      <ChangelogList id="relations-removed" label="Relations removed" list={relations.removed} render={relation}/>
      <ChangelogList id="stale" label="Stale for a recorded reason" list={changelog.stale} render={item => <><span className="operator-changelog-name" title={item.scopeId}>{nameOf(item.scopeId)}</span> · {staleReasonText(item.reason) ?? item.reason}</>}/>
      <ChangelogList id="unfinished" label="Unfinished (explanation not current)" list={changelog.unfinished} render={item => <Entity entity={item}> · {staleReasonText(item.reason) ?? item.reason}</Entity>}/>
      <ChangelogList id="carried" label="Carried from the previous update" list={changelog.carried} render={item => <Entity entity={item}/>}/>
      <ChangelogList id="resummarised" label={view === 'cumulative' ? 'Re-summarised in this update (unreviewed)' : 'Re-summarised'} list={outcome.resummarised} render={item => <Entity entity={item}/>}/>
      {view === 'cumulative' && <ChangelogList id="since-publication" label="Re-enriched since publication in earlier updates (unreviewed)" list={changelog.reuse?.sincePublication} render={item => <Entity entity={item}/>}/>}
      <ChangelogList id="kept-stale" label="Kept stale in this update (changed; not re-enriched)" list={outcome.keptStale} render={item => <Entity entity={item}/>}/>
      <ChangelogList id="failed" label="Failed" list={outcome.failed} render={item => <Entity entity={item}/>}/>
      <ChangelogList id="not-run" label="Not run" list={outcome.notRun} render={item => <Entity entity={item}/>}/>
    </div>}
    {changelog.hashCheck && changelog.hashCheck.mismatches > 0 && <p className="operator-muted operator-note">{count(changelog.hashCheck.mismatches)} reused explanation{changelog.hashCheck.mismatches === 1 ? '' : 's'} had a different input hash than recorded.</p>}
  </section>;
}
