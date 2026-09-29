import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OperatorApiError, type Bounded, type ChangelogEntity, type IncrementalChangelog, type OperatorRun, type OperatorScope } from './api';
import { incrementalRunLabel, noDraftMessage, repositoryIdOf, requestUpdate, staleReasonText, updateButtonState, updateOutcome } from './incremental';
import { changelogHeading, OperatorChangelog, OperatorUpdateResult } from './OperatorIncremental';
import { OperatorScopeList } from './OperatorScopeList';
import { ScopeInspector } from './OperatorWorkspace';
import { operatorEventLabel } from './reviewState';

/** CLA-271: "Update to latest commit", incremental run labels, the changelog panel and stale reasons. */
const noop = () => undefined;
const FROM = 'aaaaaaa1111111111111111111111111111111111'.slice(0, 40);
const TO = 'bbbbbbb2222222222222222222222222222222222'.slice(0, 40);
const run = (patch: Partial<OperatorRun> = {}): OperatorRun => ({ runId: 'run-1', state: 'awaiting_review', createdAt: 0, updatedAt: 1, source: { owner: 'acme', repo: 'app', slug: 'acme__app', commitSha: FROM }, ...patch });
const incrementalRun = (patch: Partial<OperatorRun> = {}): OperatorRun => run({ runId: 'run-2', kind: 'incremental', incremental: { baseline: { runId: 'run-1', draftRevisionId: 'draft-1', commitSha: FROM }, trigger: 'operator' }, source: { owner: 'acme', repo: 'app', slug: 'acme__app', commitSha: TO }, ...patch });
const none = <T,>(): Bounded<T> => ({ total: 0, items: [] });
const entity = (id: string, name: string, kind = 'component'): ChangelogEntity => ({ id, kind, name });
function changelog(patch: Partial<IncrementalChangelog> = {}): IncrementalChangelog {
  return {
    schemaVersion: 1, fromCommit: FROM, toCommit: TO,
    counts: { entitiesAdded: 0, entitiesRemoved: 1, entitiesChanged: 1, surfaceChanges: 0, internalChanges: 1, entitiesMoved: 0, relationsAdded: 0, relationsRemoved: 1, removedExports: 1, dirty: 3, stale: 1, reused: 4, removedScopes: 0 },
    entities: { added: none(), removed: { total: 1, items: [entity('code:mul', 'mul', 'code')] }, changed: { total: 1, items: [{ ...entity('component:math', 'math'), change: 'internal' }] }, moved: none() },
    relations: { added: none(), removed: { total: 1, items: [{ from: 'component:api', to: 'component:math', kind: 'uses' }] } },
    removedExports: { total: 1, items: [{ ...entity('code:mul', 'mul', 'code'), consumerCount: 3 }] },
    stale: { total: 2, items: [{ scopeId: 'scope:api', reason: 'dependency-internal' }, { scopeId: 'scope:math', reason: 'moved' }] },
    dirty: { total: 3, items: [] },
    hashCheck: { checked: 4, mismatches: 0, unknown: 0 },
    outcome: { state: 'settled', resummarised: { total: 2, items: [entity('container:lib', 'demo-lib', 'container'), entity('component:math', 'math')] }, resummarisedByKind: { container: 1, component: 1 }, keptStale: none(), failed: none(), notRun: none() },
    summary: 'removed export mul; 3 consumers updated; 1 changed, 1 removed, 1 edge change; container demo-lib re-summarised; 1 stale (claim re-check); 4 reused',
    ...patch,
  };
}
const scopes: OperatorScope[] = [{ scopeId: 'scope:api', entityId: 'component:api', name: 'API', state: 'accepted', stale: true, staleReason: 'dependency-internal' }, { scopeId: 'scope:math', entityId: 'component:math', name: 'Math', state: 'accepted', stale: true, staleReason: 'moved' }];

describe('incremental run labels', () => {
  it('labels an incremental run "Update from <baseline> → <target>" and leaves full runs unlabelled', () => {
    expect(incrementalRunLabel(incrementalRun())).toBe('Update from aaaaaaa → bbbbbbb');
    expect(incrementalRunLabel(run())).toBeUndefined();
    // Before the scan records a commit: the pinned SHA ref, else "latest".
    expect(incrementalRunLabel(incrementalRun({ source: { owner: 'acme', repo: 'app', slug: 'acme__app', ref: 'ccccccc3333' } }))).toBe('Update from aaaaaaa → ccccccc');
    expect(incrementalRunLabel(incrementalRun({ source: { owner: 'acme', repo: 'app', slug: 'acme__app' } }))).toBe('Update from aaaaaaa → latest');
  });
  it('shows the resolved target commit as soon as the server records it, before the scan', () => {
    const queued = incrementalRun({ state: 'running', source: { owner: 'acme', repo: 'app', slug: 'acme__app' } });
    expect(incrementalRunLabel({ ...queued, incremental: { ...queued.incremental!, targetCommitSha: TO } })).toBe('Update from aaaaaaa → bbbbbbb');
  });
  it('reads the run\'s upToDate record (no events needed) and the below-cap "changed" stale reason', () => {
    const upToDate = incrementalRun({ state: 'complete', source: { owner: 'acme', repo: 'app', slug: 'acme__app' } });
    expect(noDraftMessage({ ...upToDate, incremental: { ...upToDate.incremental!, upToDate: { commitSha: FROM } } }, [])).toBe('Already at the latest commit (aaaaaaa). No draft was needed.');
    expect(staleReasonText('changed')).toContain('below the depth cap');
  });
  it('uses the canonical repository id when the run has one', () => {
    expect(repositoryIdOf(run())).toBe('repo:acme/app');
    expect(repositoryIdOf(run({ source: { owner: 'Acme', repo: 'App', slug: 's', repositoryId: 'repo:acme/app' } }))).toBe('repo:acme/app');
  });
  it('explains a finished run with no draft: up to date, or simply no draft (never "loading")', () => {
    const upToDate = [{ type: 'incremental.up_to_date', detail: { commitSha: FROM, baselineCommitSha: FROM } }];
    expect(noDraftMessage(incrementalRun({ state: 'complete' }), upToDate)).toBe('Already at the latest commit (aaaaaaa). No draft was needed.');
    expect(noDraftMessage(incrementalRun({ state: 'complete' }), [])).toBe('This run finished without a draft.');
    expect(noDraftMessage(run({ state: 'failed' }))).toBe('This run ended without a draft.');
    expect(noDraftMessage(incrementalRun({ state: 'running' }), upToDate)).toContain('Loading draft');
    // QA R2: while the run detail or its draft is still loading, never say the run has no draft.
    expect(noDraftMessage(incrementalRun({ state: 'complete' }), [], false)).toBe('Loading draft…');
    expect(noDraftMessage(incrementalRun({ state: 'awaiting_review', draftRevisionId: 'draft-9' }), [])).toBe('Loading draft…');
  });
  it('labels the incremental events in the event log', () => {
    expect(operatorEventLabel({ type: 'incremental.up_to_date', detail: { commitSha: FROM } })).toBe('Already at the latest commit (aaaaaaa)');
    expect(operatorEventLabel({ type: 'incremental.diff', detail: { fromCommit: FROM, toCommit: TO, dirty: 3, reused: 4, stale: 1 } })).toBe('Changes aaaaaaa → bbbbbbb · 3 to re-enrich, 4 reused, 1 stale');
    expect(operatorEventLabel({ type: 'incremental.auto_publish', detail: { published: false, reason: 'coverage_incomplete' } })).toBe('Not auto-published (coverage incomplete)');
    expect(operatorEventLabel({ type: 'enrichment.finished', detail: { pass: 'incremental', accepted: 2, inScope: 3 } })).toBe('Update pass finished · 2/3 in scope accepted');
  });
});

describe('"Update to latest commit" button state', () => {
  it('is enabled on an idle run and disabled while requesting or while any run of the repository is active', () => {
    expect(updateButtonState({ run: run(), runs: [run()], requesting: false })).toMatchObject({ disabled: false, label: 'Update to latest commit' });
    expect(updateButtonState({ run: run(), runs: [run()], requesting: true })).toMatchObject({ disabled: true, label: 'Checking for updates…' });
    expect(updateButtonState({ run: run({ state: 'running' }), runs: [], requesting: false })).toMatchObject({ disabled: true, activeRunId: 'run-1' });
    const other = incrementalRun({ state: 'queued' });
    expect(updateButtonState({ run: run(), runs: [run(), other], requesting: false })).toMatchObject({ disabled: true, activeRunId: 'run-2', title: 'Another run for this repository is in progress.' });
    // A different repository's active run does not block this one.
    expect(updateButtonState({ run: run(), runs: [run(), { ...other, source: { owner: 'acme', repo: 'web', slug: 'acme__web' } }], requesting: false }).disabled).toBe(false);
  });
});

describe('"Update to latest commit" responses', () => {
  it('maps started, up to date and active', () => {
    expect(updateOutcome({ status: 'started', runId: 'run-2', baselineCommitSha: FROM, commitSha: TO })).toEqual({ kind: 'started', runId: 'run-2', message: 'Update queued from aaaaaaa → bbbbbbb.' });
    expect(updateOutcome({ status: 'up_to_date', commitSha: FROM, baselineCommitSha: FROM })).toEqual({ kind: 'up-to-date', message: 'Already at the latest commit (aaaaaaa).' });
    expect(updateOutcome({ status: 'active', runId: 'run-2' })).toMatchObject({ kind: 'active', runId: 'run-2' });
  });
  it('turns 422 no_baseline and other refusals into inline errors, and rethrows access failures', async () => {
    const refuse = (status: number, body: Record<string, unknown>) => () => Promise.reject(new OperatorApiError(status, String(body.error ?? 'x'), body));
    expect(await requestUpdate(refuse(422, { code: 'no_baseline', error: 'repository has no draft or publication to update' }))).toEqual({ kind: 'error', message: 'Nothing to update yet: this repository has no draft or publication.' });
    expect(await requestUpdate(refuse(422, { error: 'ref must be a branch, tag or commit SHA' }))).toEqual({ kind: 'error', message: 'ref must be a branch, tag or commit SHA' });
    await expect(requestUpdate(refuse(401, { code: 'session_expired' }))).rejects.toBeInstanceOf(OperatorApiError);
    await expect(requestUpdate(refuse(403, { code: 'csrf_rejected' }))).rejects.toBeInstanceOf(OperatorApiError);
    const start = vi.fn(async () => ({ status: 'up_to_date' as const, commitSha: TO, baselineCommitSha: TO }));
    expect(await requestUpdate(start)).toMatchObject({ kind: 'up-to-date' }); expect(start).toHaveBeenCalledOnce();
  });
  it('renders the inline result: a notice, a link to the active run, or an alert; nothing for a started run', () => {
    expect(renderToStaticMarkup(<OperatorUpdateResult onOpenRun={noop} outcome={{ kind: 'up-to-date', message: 'Already at the latest commit (aaaaaaa).' }}/>)).toContain('role="status"');
    const active = renderToStaticMarkup(<OperatorUpdateResult onOpenRun={noop} outcome={{ kind: 'active', runId: 'run-2', message: 'An update or scan is already running for this repository.' }}/>);
    expect(active).toContain('Open active run');
    const error = renderToStaticMarkup(<OperatorUpdateResult onOpenRun={noop} outcome={{ kind: 'error', message: 'Nope.' }}/>);
    expect(error).toContain('role="alert"'); expect(error).not.toContain('<button');
    expect(renderToStaticMarkup(<OperatorUpdateResult onOpenRun={noop} outcome={{ kind: 'started', runId: 'run-2', message: 'Update queued.' }}/>)).toBe('');
  });
});

describe('changelog panel', () => {
  it('shows commits, the summary, the four headline counts and expandable lists with readable stale reasons', () => {
    const markup = renderToStaticMarkup(<OperatorChangelog changelog={changelog()} scopes={scopes}/>);
    expect(markup).toContain('<code>aaaaaaa</code> → <code>bbbbbbb</code>');
    expect(markup).toContain('removed export mul; 3 consumers updated');
    for (const chip of ['2 re-summarised', '4 reused', '1 stale', '1 removed']) expect(markup).toContain(chip);
    expect(markup).not.toContain('data-changelog-heading'); expect(markup).not.toContain('Since publication'); // no publication: this update only
    expect(markup).toContain('Removed exports · 1'); expect(markup).toContain('3 consumers');
    expect(markup).toContain('internal change');
    expect(markup).toContain('API → Math'); // relation ends resolve through scope names
    expect(markup).toContain('API</span> · dependency changed internally — re-check claims');
    expect(markup).toContain('Math</span> · moved lines — evidence may be off by a few lines');
    expect(markup).not.toContain('Added ·'); // empty lists are omitted
    expect(markup).not.toContain('more</p>');
  });
  it('says "+N more" when a list is bounded', () => {
    const items = Array.from({ length: 50 }, (_, index) => entity(`code:f${index}`, `f${index}`, 'code'));
    const markup = renderToStaticMarkup(<OperatorChangelog changelog={changelog({ entities: { ...changelog().entities, added: { total: 73, items } } })} scopes={[]}/>);
    expect(markup).toContain('Added · 73'); expect(markup).toContain('+23 more');
    expect(markup.match(/<li>/g)!.length).toBeGreaterThanOrEqual(50);
  });
  it('renders an empty changelog quietly and marks a pending one', () => {
    const empty = changelog({ counts: { ...changelog().counts, entitiesRemoved: 0, entitiesChanged: 0, relationsRemoved: 0, removedExports: 0, dirty: 0, stale: 0 }, entities: { added: none(), removed: none(), changed: none(), moved: none() }, relations: { added: none(), removed: none() }, removedExports: none(), stale: none(), outcome: { ...changelog().outcome, resummarised: none() }, summary: 'no content changes; 4 reused' });
    const markup = renderToStaticMarkup(<OperatorChangelog changelog={empty} scopes={[]}/>);
    expect(markup).toContain('No entity or relation changes.'); expect(markup).toContain('0 re-summarised'); expect(markup).not.toContain('<details');
    const pending = renderToStaticMarkup(<OperatorChangelog changelog={changelog({ outcome: { ...changelog().outcome, state: 'pending' } })} scopes={[]}/>);
    expect(pending).toContain('data-changelog-state="pending"'); expect(pending).toContain('re-enrichment in progress'); expect(pending).toContain('3 to re-enrich');
  });
});

describe('changelog panel: cumulative view over an update chain', () => {
  const PUBLISHED = 'ccccccc3333333333333333333333333333333333'.slice(0, 40);
  const chained = () => changelog({
    publication: { versionId: 'publication-1', commitSha: PUBLISHED },
    chain: [{ runId: 'run-b', draftRevisionId: 'draft-b', toCommit: FROM }],
    carried: { total: 1, items: [entity('component:util', 'util')] },
    cumulative: { fromCommit: PUBLISHED, toCommit: TO, counts: { ...changelog().counts, entitiesChanged: 2, entitiesRemoved: 0 }, entities: { added: none(), removed: none(), changed: { total: 2, items: [{ ...entity('component:math', 'math'), change: 'internal' }, { ...entity('component:util', 'util'), change: 'surface' }] }, moved: none() }, relations: { added: none(), removed: none() }, removedExports: none(), dirty: { total: 4, items: [] } },
    reuse: { fromPublication: { total: 3, items: [] }, sincePublication: { total: 1, items: [entity('component:util', 'util')] } },
    cumulativeSummary: 'since published ccccccc (2 updates): 2 changed; 3 re-summarised since publication (unreviewed); 1 stale; 3 reused from publication',
  });
  it('states the live published commit and opens on the cumulative view', () => {
    const markup = renderToStaticMarkup(<OperatorChangelog changelog={chained()} scopes={scopes}/>);
    expect(markup).toContain('Published <code>ccccccc</code> → this draft <code>bbbbbbb</code> (2 updates)');
    expect(markup).toContain('data-changelog-view="cumulative"'); expect(markup).toContain('Changes since publication');
    expect(markup).toContain('since published ccccccc (2 updates)');
    for (const chip of ['3 re-summarised since publication (unreviewed)', '3 reused from publication', '1 stale', '1 carried from the previous update']) expect(markup).toContain(chip);
    expect(markup).toContain('Changed · 2'); expect(markup).toContain('interface changed'); // the cumulative diff, not this step's
    expect(markup).toContain('Re-enriched since publication in earlier updates (unreviewed) · 1');
    expect(markup).toContain('Carried from the previous update · 1');
    expect(markup).toMatch(/aria-pressed="true"[^>]*data-view="cumulative"/);
  });
  it('offers "This update only" as the secondary view', () => {
    const markup = renderToStaticMarkup(<OperatorChangelog changelog={chained()} initialView="update" scopes={scopes}/>);
    expect(markup).toContain('data-changelog-view="update"'); expect(markup).toContain('Changes in this update');
    expect(markup).toContain('this update <code>aaaaaaa</code> → <code>bbbbbbb</code>');
    expect(markup).toContain('removed export mul'); expect(markup).toContain('Changed · 1');
    expect(markup).not.toContain('Re-enriched since publication in earlier updates');
    expect(markup).toMatch(/aria-pressed="true"[^>]*data-view="update"/);
  });
  it('labels a first update on a publication with one update', () => {
    expect(changelogHeading({ publication: { versionId: 'p', commitSha: PUBLISHED }, toCommit: TO })).toEqual({ published: 'ccccccc', draft: 'bbbbbbb', updates: 1, updatesText: '1 update', superseded: false, draftIsLive: false });
    expect(changelogHeading({ toCommit: TO })).toBeUndefined();
  });
  it('counts every update from chainLength, and gives a lower bound when the chain passes through a legacy draft', () => {
    const publication = { versionId: 'p', commitSha: PUBLISHED };
    expect(changelogHeading({ publication, chain: [{ runId: 'r', draftRevisionId: 'd', toCommit: FROM }], chainLength: 25, toCommit: TO })!.updatesText).toBe('26 updates');
    expect(changelogHeading({ publication, chain: [{ runId: 'r', draftRevisionId: 'd', toCommit: FROM }], chainLength: 1, chainPartial: true, toCommit: TO })!.updatesText).toBe('≥2 updates');
    const markup = renderToStaticMarkup(<OperatorChangelog changelog={{ ...chained(), chainLength: 1, chainPartial: true }} scopes={scopes}/>);
    expect(markup).toContain('this draft <code>bbbbbbb</code> (≥2 updates)');
  });
  it('flags the published commit when that publication is no longer the live one', () => {
    const live = renderToStaticMarkup(<OperatorChangelog changelog={chained()} currentPublicationVersionId="publication-1" scopes={scopes}/>);
    expect(live).not.toContain('no longer the live publication');
    const replaced = renderToStaticMarkup(<OperatorChangelog changelog={chained()} currentPublicationVersionId="publication-2" scopes={scopes}/>);
    expect(replaced).toContain('data-publication-superseded'); expect(replaced).toContain('(no longer the live publication)');
    expect(replaced).toContain('Auto-publish is refused; publishing this draft replaces the live version.'); expect(replaced).not.toContain('refused as stale');
    // Once this draft is published, the newer live version is this draft: "live", never "no longer live".
    const published = renderToStaticMarkup(<OperatorChangelog changelog={chained()} currentPublicationVersionId="publication-2" draftIsLive scopes={scopes}/>);
    expect(published).not.toContain('no longer the live publication'); expect(published).toContain('data-draft-live'); expect(published).toContain('(live)');
  });
  it('lists unfinished scopes with their reason in both views and counts them as stale', () => {
    const unfinished = { total: 2, items: [{ ...entity('component:util', 'util'), reason: 'dropped' as const }, { ...entity('system:demo', 'Demo', 'softwareSystem'), reason: 'pending' as const }] };
    const withUnfinished = { ...chained(), counts: { ...chained().counts, stale: 4, unfinished: 2 }, unfinished };
    for (const view of ['cumulative', 'update'] as const) {
      const markup = renderToStaticMarkup(<OperatorChangelog changelog={withUnfinished} initialView={view} scopes={scopes}/>);
      expect(markup).toContain('4 stale (2 unfinished)');
      expect(markup).toContain('Unfinished (explanation not current) · 2');
      expect(markup).toContain('util</span> <em class="operator-level">component</em> · not re-enriched: two updates in a row failed it');
      expect(markup).toContain('Demo</span> <em class="operator-level">softwareSystem</em> · changed; not re-enriched (budget stop or failure)');
    }
  });
});

describe('stale reasons on scopes', () => {
  it('tags stale rows in the scope list and explains the reason in the scope detail', () => {
    const list = renderToStaticMarkup(<OperatorScopeList filter="all" onFilter={noop} onOpen={noop} onQuery={noop} onReview={noop} onSelection={noop} onShowBelowCap={noop} onSort={noop} query="" scopes={scopes} selected={new Set()} showBelowCap={false} sort="hierarchy"/>);
    expect(list).toContain('data-stale-reason="dependency-internal"'); expect(list).toContain('stale · re-check'); expect(list).toContain('stale · moved');
    const inspector = renderToStaticMarkup(<ScopeInspector canRetry hidden="visible" lookup={new Map(scopes.map(item => [item.scopeId, item]))} onRetry={noop} retrying={false} scope={scopes[1]}/>);
    expect(inspector).toContain('Stale: moved lines — evidence may be off by a few lines.');
    expect(renderToStaticMarkup(<ScopeInspector canRetry hidden="visible" lookup={new Map()} onRetry={noop} retrying={false} scope={{ ...scopes[1]!, staleReason: undefined }}/>)).not.toContain('data-stale-reason');
    // Unfinished scopes of an incremental draft: kept stale by a budget stop (pending), or dropped by the carry.
    const unfinished: OperatorScope[] = [{ scopeId: 'scope:util', name: 'util', state: 'accepted', stale: true, staleReason: 'pending' }, { scopeId: 'scope:sys', name: 'Demo', state: 'accepted', stale: true, staleReason: 'dropped' }];
    const rows = renderToStaticMarkup(<OperatorScopeList filter="all" onFilter={noop} onOpen={noop} onQuery={noop} onReview={noop} onSelection={noop} onShowBelowCap={noop} onSort={noop} query="" scopes={unfinished} selected={new Set()} showBelowCap={false} sort="hierarchy"/>);
    expect(rows).toContain('stale · pending'); expect(rows).toContain('stale · dropped');
    expect(renderToStaticMarkup(<ScopeInspector canRetry hidden="visible" lookup={new Map()} onRetry={noop} retrying={false} scope={unfinished[0]!}/>)).toContain('Stale: changed; not re-enriched (budget stop or failure)');
    // Left unfinished before the chain: no promise that the next update retries it.
    expect(staleReasonText('inherited')).not.toContain('next update'); expect(staleReasonText('inherited')).toContain('Refresh');
  });
});
