import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PATH_EXPLORATION_DISCLAIMER, type ArchitectureSnapshot } from '@okie/architecture';
import { goldenSnapshot } from '@okie/scene-compiler';
import { PathExplorer } from './PathExplorer';
import { explorePathView, type PathDraft } from './pathExploration';

const snapshot = {
  ...goldenSnapshot,
  id: 'snapshot:ui',
  commitSha: 'sha1',
  entities: [
    { id: 'parent', kind: 'container', name: 'Parent', sourceRefs: [] },
    { id: 'a', kind: 'component', name: 'Alpha', parentId: 'parent', sourceRefs: [] },
    { id: 'b', kind: 'component', name: 'Beta', sourceRefs: [] },
    { id: 'c', kind: 'component', name: 'Gamma', sourceRefs: [] },
  ],
  relations: [
    { id: 'ab', from: 'a', to: 'b', kind: 'calls', evidence: [{ reason: 'direct call', source: { path: 'src/a.ts', commitSha: 'sha1', startLine: 4 } }] },
  ],
} as ArchitectureSnapshot;

const noop = () => undefined;
function render(draft: PathDraft, coverage: 'complete' | 'partial' = 'complete') {
  return renderToStaticMarkup(<PathExplorer onClear={noop} onOpenEvidence={noop} onShowHop={noop} onSwap={noop} onToggleContainment={noop} onToggleKind={noop} onToggleScope={noop} view={explorePathView(snapshot, draft, coverage)}/>);
}
const draft = (overrides: Partial<PathDraft> = {}): PathDraft => ({ fromId: 'a', toId: 'b', kinds: ['calls'], containment: false, scope: 'exact', ...overrides });

describe('PathExplorer', () => {
  it('renders found hops with evidence, limit badges, show-on-map, and the disclaimer', () => {
    const markup = render(draft());
    expect(markup).toContain('data-testid="path-explorer"');
    expect(markup).toContain('data-path-status="found"');
    expect(markup).toContain('data-testid="path-hop"');
    expect(markup).toContain('src/a.ts:4@sha1');
    expect(markup).toContain('direct call');
    expect(markup).toContain('Confidence not scored');
    expect(markup).toContain('data-testid="path-hop-show"');
    expect(markup).toContain('No frozen source excerpt was captured for this evidence.');
    expect(markup).toContain(`data-testid="path-disclaimer">${PATH_EXPLORATION_DISCLAIMER}`);
  });

  it('renders containment hops without a map action', () => {
    const markup = render(draft({ fromId: 'parent', toId: 'a', kinds: [], containment: true }));
    expect(markup).toContain('data-path-hop-via="parentContainment"');
    expect(markup).toContain('no relation route to show on the map');
    expect(markup).not.toContain('data-testid="path-hop-show"');
  });

  it.each([
    [draft({ fromId: 'b', toId: 'c' }), 'complete', 'unreachable', 'No path exists'],
    [draft({ fromId: 'b', toId: 'c' }), 'partial', 'unavailable', 'More of the map must be loaded'],
    [draft({ toId: 'stale' }), 'complete', 'unavailable', 'refers to an entity that isn&#x27;t in this snapshot'],
    [draft({ kinds: ['teleports'] }), 'complete', 'unknownKinds', 'teleports'],
    [draft({ linkSnapshotId: 'snapshot:old' }), 'complete', 'snapshotMismatch', 'snapshot:old'],
  ] as const)('renders honest state %#', (input, coverage, status, copy) => {
    const markup = render(input, coverage);
    expect(markup).toContain(`data-path-status="${status}"`);
    expect(markup).toContain(copy);
    expect(markup).toContain('data-testid="path-disclaimer"');
    expect(markup).not.toContain('data-testid="path-hop"');
  });

  it('asks for the second endpoint without a disclaimer before anything ran', () => {
    const markup = render({ fromId: 'a', kinds: ['calls'], containment: false, scope: 'exact' });
    expect(markup).toContain('data-path-status="incomplete"');
    expect(markup).toContain('Path to here');
    expect(markup).not.toContain('data-testid="path-disclaimer"');
  });
});
