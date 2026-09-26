import { describe, expect, it } from 'vitest';
import { PATH_EXPLORATION_DISCLAIMER, type ArchitectureSnapshot } from '@okie/architecture';
import { goldenSnapshot } from '@okie/scene-compiler';
import {
  defaultPathScope,
  evidenceExcerpt,
  explorePathView,
  navigationPathFromDraft,
  pathDraftFromNavigation,
  pathGraphCoverage,
  presentRelationKinds,
  setPathEndpoint,
  swapPathEndpoints,
  togglePathKind,
  type PathDraft,
} from './pathExploration';

const sha = 'abc123';
const excerptLines = ['export function load() {', '  return fetch(url);', '}'];

function snapshot(): ArchitectureSnapshot {
  return {
    ...goldenSnapshot,
    id: 'snapshot:test',
    commitSha: sha,
    entities: [
      { id: 'system', kind: 'softwareSystem', name: 'System', sourceRefs: [] },
      { id: 'web', kind: 'container', name: 'Web', parentId: 'system', sourceRefs: [] },
      { id: 'api', kind: 'container', name: 'API', parentId: 'system', sourceRefs: [] },
      { id: 'web.ui', kind: 'component', name: 'UI', parentId: 'web', sourceRefs: [] },
      { id: 'web.client', kind: 'component', name: 'Client', parentId: 'web', sourceRefs: [],
        sourceExcerpts: [{ path: 'src/client.ts', language: 'typescript', startLine: 10, endLine: 12, highlightLine: 10, frozenRevision: sha, lines: excerptLines, text: excerptLines.join('\n') }] },
      { id: 'api.handler', kind: 'component', name: 'Handler', parentId: 'api', sourceRefs: [] },
      { id: 'island', kind: 'component', name: 'Island', sourceRefs: [] },
    ],
    relations: [
      { id: 'r1', from: 'web.ui', to: 'web.client', kind: 'calls', confidence: .9, evidence: [{ reason: 'imports client', source: { path: 'src/ui.ts', commitSha: sha, startLine: 3 } }] },
      { id: 'r2', from: 'web.client', to: 'api.handler', kind: 'calls', evidence: [{ reason: 'HTTP call', source: { path: 'src/client.ts', commitSha: sha, startLine: 11 } }] },
      { id: 'r3', from: 'api.handler', to: 'ghost', kind: 'calls', evidence: [] },
    ],
  } as ArchitectureSnapshot;
}

function draft(overrides: Partial<Omit<PathDraft, 'kinds'>> & { kinds?: readonly string[] } = {}): PathDraft {
  return { fromId: 'web.ui', toId: 'api.handler', containment: false, scope: 'exact', ...overrides, kinds: [...(overrides.kinds ?? ['calls'])] };
}

describe('path exploration view model', () => {
  it('finds a path with named hops, evidence locations, excerpts, limits and a reveal set', () => {
    const view = explorePathView(snapshot(), draft(), 'complete');
    expect(view.state).toBe('found');
    expect(view.title).toBe('Path found: 2 hops.');
    expect(view.disclaimer).toBe(PATH_EXPLORATION_DISCLAIMER);
    expect(view.hops.map(hop => `${hop.from.name}->${hop.to.name}`)).toEqual(['UI->Client', 'Client->Handler']);
    expect(view.hops[0]!.confidenceLabel).toBe('90%');
    expect(view.hops[1]!.confidenceLabel).toBe('Not scored');
    expect(view.hops[1]!.limits.map(limit => limit.label)).toEqual(['Confidence not scored']);
    expect(view.hops[1]!.evidence[0]).toMatchObject({ reason: 'HTTP call', location: 'src/client.ts:11@abc123' });
    expect(view.hops[1]!.evidence[0]!.excerpt?.highlightLine).toBe(11);
    expect(view.hops[0]!.evidence[0]!.excerpt).toBeUndefined();
    expect(view.reveal).toEqual({ relationIds: ['r1', 'r2'], entityIds: ['web.ui', 'web.client', 'api.handler'] });
    expect(view.notes).toContain('1 relation of the selected kinds points outside this snapshot and was ignored.');
  });

  it('shows the resolved descendants under subtree scope', () => {
    const snap = snapshot();
    expect(defaultPathScope(snap, 'web', 'api')).toBe('subtree');
    expect(defaultPathScope(snap, 'web.ui', 'api.handler')).toBe('exact');
    const view = explorePathView(snap, draft({ fromId: 'web', toId: 'api', scope: 'subtree' }), 'complete');
    expect(view.state).toBe('found');
    expect(view.from?.name).toBe('Web');
    expect(view.resolvedFrom?.id).toBe('web.client');
    expect(view.resolvedTo?.id).toBe('api.handler');
    expect(view.hops).toHaveLength(1);
  });

  it('flags containment hops as having no map route', () => {
    const view = explorePathView(snapshot(), draft({ fromId: 'system', toId: 'web.ui', kinds: [], containment: true }), 'complete');
    expect(view.state).toBe('found');
    expect(view.hops.every(hop => hop.via === 'parentContainment' && hop.mapNote)).toBe(true);
    expect(view.hops[0]!.limits.map(limit => limit.code)).toEqual(['noEvidence', 'structuralContainment']);
    expect(view.reveal?.relationIds).toEqual([]);
  });

  it('distinguishes unreachable (complete graph) from partial-graph unavailability', () => {
    const complete = explorePathView(snapshot(), draft({ fromId: 'api.handler', toId: 'island' }), 'complete');
    expect(complete.state).toBe('unreachable');
    expect(complete.message).toContain('Explored 1 entity');
    const partial = explorePathView(snapshot(), draft({ fromId: 'api.handler', toId: 'island' }), 'partial');
    expect(partial.state).toBe('unavailable');
    expect(partial.reason).toBe('partialGraph');
    expect(partial.message).toContain('More of the map must be loaded');
  });

  it('flags a path found on a partial graph', () => {
    const view = explorePathView(snapshot(), draft(), 'partial');
    expect(view.state).toBe('found');
    expect(view.result?.status === 'found' && view.result.limits).toContain('partialGraph');
    expect(view.notes[0]).toContain('partially loaded map');
  });

  it.each([
    [{ fromId: 'gone' }, 'complete', 'unknownFromEntity', "isn't in this snapshot"],
    [{ toId: 'gone' }, 'complete', 'unknownToEntity', "isn't in this snapshot"],
    [{ toId: 'gone' }, 'partial', 'endpointNotLoaded', "isn't loaded"],
    [{ kinds: [] }, 'complete', 'noEligibleKinds', 'Choose at least one'],
    [{ kinds: ['reads'] }, 'complete', 'noEligibleRelations', 'no relations of the selected kinds'],
    [{ fromId: 'web', toId: 'web.ui', scope: 'subtree' as const }, 'complete', 'nestedEndpoints', 'inside the other'],
  ] as const)('reports unavailable %j honestly', (overrides, coverage, reason, title) => {
    const view = explorePathView(snapshot(), draft(overrides), coverage);
    expect(view.state).toBe('unavailable');
    expect(view.reason).toBe(reason);
    expect(view.title).toContain(title);
    expect(view.result?.status === 'unavailable' && view.message.startsWith(view.result.message)).toBe(true);
  });

  it('refuses unknown kinds and snapshot mismatches without running a different query', () => {
    const unknown = explorePathView(snapshot(), draft({ kinds: ['calls', 'teleports'] }), 'complete');
    expect(unknown.state).toBe('unknownKinds');
    expect(unknown.result).toBeUndefined();
    expect(unknown.message).toContain('teleports');
    expect(unknown.kinds.find(option => option.kind === 'teleports')).toMatchObject({ checked: true, known: false });
    const mismatch = explorePathView(snapshot(), draft({ linkSnapshotId: 'snapshot:older' }), 'complete');
    expect(mismatch.state).toBe('snapshotMismatch');
    expect(mismatch.message).toContain('snapshot:older');
    expect(mismatch.result).toBeUndefined();
  });

  it('keeps stale endpoint IDs visible so the engine can report them', () => {
    const view = explorePathView(snapshot(), draft({ fromId: 'code:renamed' }), 'complete');
    expect(view.from).toEqual({ id: 'code:renamed', name: 'code:renamed', known: false });
    expect(view.reason).toBe('unknownFromEntity');
  });

  it('derives share state from UI state only, never from an invalid result query', () => {
    const invalid = draft({ kinds: ['calls', 'calls', 'teleports'] });
    const view = explorePathView(snapshot(), invalid, 'complete');
    expect(view.result).toBeUndefined();
    expect(navigationPathFromDraft(invalid)).toEqual({ fromId: 'web.ui', toId: 'api.handler', kinds: ['calls', 'teleports'], containment: false, scope: 'exact' });
    // A malformed endpoint never produces a share link.
    expect(navigationPathFromDraft(draft({ fromId: ' padded ' }))).toBeUndefined();
    expect(navigationPathFromDraft(draft({ toId: undefined }))).toBeUndefined();
    const round = pathDraftFromNavigation(navigationPathFromDraft(draft({ linkSnapshotId: 'snapshot:other' })));
    expect(round?.linkSnapshotId).toBe('snapshot:other');
  });

  it('builds drafts from selection with present-kind defaults and auto scope', () => {
    const snap = snapshot();
    expect(presentRelationKinds(snap)).toEqual(['calls']);
    const first = setPathEndpoint(undefined, 'from', 'web', snap);
    expect(first).toEqual({ fromId: 'web', kinds: ['calls'], containment: false, scope: 'subtree' });
    expect(explorePathView(snap, first, 'complete').state).toBe('incomplete');
    const both = setPathEndpoint(first, 'to', 'api', snap);
    expect(both.toId).toBe('api');
    expect(swapPathEndpoints(both)).toMatchObject({ fromId: 'api', toId: 'web' });
    expect(togglePathKind(both, 'calls').kinds).toEqual([]);
    // Editing a mismatched link starts fresh rather than inheriting its stale query.
    expect(setPathEndpoint({ ...both, linkSnapshotId: 'old' }, 'to', 'api', snap)).not.toHaveProperty('fromId');
  });

  it('marks neighborhood scan boots as partial coverage', () => {
    expect(pathGraphCoverage({ scanBoot: 'neighborhood' })).toBe('partial');
    expect(pathGraphCoverage({ scanBoot: 'full' })).toBe('complete');
    expect(pathGraphCoverage({})).toBe('complete');
  });

  it('matches evidence excerpts by path, revision, and line', () => {
    const snap = snapshot();
    expect(evidenceExcerpt(snap, { source: { path: 'src/client.ts', commitSha: sha, startLine: 12 } })?.highlightLine).toBe(12);
    expect(evidenceExcerpt(snap, { source: { path: 'src/client.ts', commitSha: sha, startLine: 40 } })).toBeUndefined();
    expect(evidenceExcerpt(snap, { source: { path: 'src/client.ts', commitSha: 'other', startLine: 11 } })).toBeUndefined();
  });

  it('explores the golden self-map', () => {
    const view = explorePathView(goldenSnapshot, draft({ fromId: 'component:web-shell', toId: 'component:web-navigation', kinds: presentRelationKinds(goldenSnapshot), scope: 'subtree' }), 'complete');
    expect(view.state).toBe('found');
    expect(view.resolvedFrom?.id).toBe('code:web-shell:app');
  });
});
