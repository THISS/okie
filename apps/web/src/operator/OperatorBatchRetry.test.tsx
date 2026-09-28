import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OperatorScope } from './api';
import { completionBanner } from './completion';
import { OperatorCompletionBanner, OperatorRetryConfirm } from './OperatorBatchRetry';
import { OperatorScopeList, selectionSummary, type ScopeListProps } from './OperatorScopeList';
import { applyFraction, confirmText, fitToBudget, retryEstimate } from './scopeSelection';

const noop = () => undefined;
const scopes: OperatorScope[] = [
  { scopeId: 'sys', name: 'System', kind: 'softwareSystem', depth: 0, state: 'accepted', explanation: { summary: 's', evidence: [] } },
  { scopeId: 'c1', name: 'Parser', kind: 'component', depth: 1, parentScopeId: 'sys', state: 'failed' },
  { scopeId: 'c2', name: 'Lexer', kind: 'component', depth: 1, parentScopeId: 'sys', state: 'accepted', explanation: { summary: 's', evidence: [] } },
  { scopeId: 'fn', name: 'tokenize', kind: 'code', depth: 2, parentScopeId: 'c2', state: 'below cap' },
];
function list(overrides: Partial<ScopeListProps> = {}) {
  return renderToStaticMarkup(<OperatorScopeList filter="all" onFilter={noop} onOpen={noop} onQuery={noop} onReview={noop} onSelection={noop} onShowBelowCap={noop} onSort={noop} query="" scopes={scopes} selected={new Set()} showBelowCap={false} sort="hierarchy" {...overrides}/>);
}

describe('batch retry views', () => {
  it('renders the complete banner as a status with Preview → Publish', () => {
    const banner = completionBanner({ run: { state: 'awaiting_review', createdAt: 0, updatedAt: 252_000 }, events: [], scopes: scopes.filter(scope => scope.state !== 'failed'), usage: { measuredCostUsd: 0.33 } })!;
    const markup = renderToStaticMarkup(<OperatorCompletionBanner banner={banner} onPreview={noop} onPublish={noop} onRetryFailed={noop} onRetryNotRun={noop}/>);
    expect(markup).toContain('role="status"'); expect(markup).toContain('Enrichment complete — 2/2 accepted in 4m 12s · $0.33');
    expect(markup).toContain('>Preview</button>'); expect(markup).toContain('>Publish</button>');
  });
  it('renders "Review newer revision" in the older-revision banner', () => {
    const banner = completionBanner({ run: { state: 'awaiting_review', createdAt: 0, updatedAt: 1 }, events: [], scopes, newerRevision: true })!;
    const markup = renderToStaticMarkup(<OperatorCompletionBanner banner={banner} onPreview={noop} onPublish={noop} onRetryFailed={noop} onRetryNotRun={noop} onReviewNewer={noop}/>);
    expect(markup).toContain('A newer revision exists'); expect(markup).toContain('>Review newer revision</button>'); expect(markup).not.toContain('>Publish</button>');
  });
  it('shows duplicate component names with their container as a secondary label, under their container in the tree', () => {
    const dupes: OperatorScope[] = [
      { scopeId: 'sys', name: 'okie', kind: 'softwareSystem', state: 'accepted' },
      { scopeId: 'tooling', name: 'Build & fixture tooling', kind: 'container', path: 'scripts', parentScopeId: 'sys', state: 'accepted' },
      { scopeId: 'web', name: '@okie/web', kind: 'container', path: 'apps/web', parentScopeId: 'sys', state: 'accepted' },
      { scopeId: 'share-a', name: 'api/share.ts', kind: 'component', path: 'api/share.ts', parentScopeId: 'tooling', state: 'accepted' },
      { scopeId: 'share-b', name: 'api/share.ts', kind: 'component', path: 'apps/web/api/share.ts', parentScopeId: 'web', state: 'failed' },
    ];
    const markup = list({ scopes: dupes, query: 'share' });
    expect(markup).toContain('title="apps/web/api/share.ts (in @okie/web)"');
    expect(markup).toContain('class="operator-scope-hint">@okie/web</small>'); expect(markup).toContain('class="operator-scope-hint">Build &amp; fixture tooling</small>');
    expect(markup).toContain('2 of 5'); expect(markup).toContain('Select matching (2)');
    expect(markup).toMatch(/aria-level="2"[^>]*class="context"[^>]*data-scope-id="web"/);
  });
  it('lists scopes as a tree (system first, collapsed children not rendered), hides below-cap scopes by default, and offers the opt-in toggle', () => {
    const markup = list();
    expect(markup.indexOf('System')).toBeLessThan(markup.indexOf('Parser'));
    expect(markup).toContain('class="operator-level">component</em>');
    expect(markup).not.toContain('tokenize');
    expect(markup).toContain('Show 1 below depth cap');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Code<\/button>/);
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('placeholder="Search name, path or id  ( / )"');
    expect(markup).toContain('<option value="cost">Cost / tokens</option>');
    const opted = list({ showBelowCap: true });
    expect(opted).toContain('explicit opt-in'); expect(opted).not.toContain('tokenize'); // Lexer is collapsed
    expect(list({ showBelowCap: true, initialExpanded: new Map([['c2', true]]) })).toContain('tokenize');
    expect(list({ query: 'zzz' })).toContain('No scopes match this search.');
    // Disclosure pattern: plain list, toggle buttons carry aria-expanded/aria-controls, the open row is aria-current.
    const open = list({ openScopeId: 'sys' });
    expect(open).not.toContain('role="tree'); expect(open).not.toContain('aria-selected');
    expect(open).toMatch(/<li aria-current="true" aria-level="1"[^>]*data-scope-id="sys"/);
    expect(open).toMatch(/<button aria-controls="[^"]+" aria-expanded="true" aria-label="Collapse System"/);
    expect(open).toMatch(/<ul aria-label="Scope tree" class="operator-scope-rows" id="[^"]+"/);
  });
  it('counts selected scopes hidden by the current search or filter', () => {
    expect(selectionSummary(new Set(['a', 'b']), [{ scopeId: 'a' }, { scopeId: 'b' }])).toBe('2 selected');
    expect(selectionSummary(new Set(['a', 'b', 'c']), [{ scopeId: 'a' }])).toBe('3 selected (2 hidden by filter)');
    expect(list({ selected: new Set(['c1', 'c2']), filter: 'failed' })).toContain('2 selected (1 hidden by filter)');
  });
  it('shows the selection bar and a confirm step with the estimate and fraction controls', () => {
    expect(list({ selected: new Set(['c1']) })).toContain('1 selected');
    const selection = ['c1', 'c2'];
    const summary = confirmText(retryEstimate(scopes, selection, 0.0013, { maxDollars: 5, spentDollars: 0.33 }));
    const markup = renderToStaticMarkup(<OperatorRetryConfirm avgCostPerScopeUsd={0.0013} busy={false} fit={fitToBudget(selection, scopes, 4.67, 0.0013)} warning="The estimate exceeds the remaining budget" firstCount={1} fraction={{ mode: 'all' }} includesBelowCap={false} onCancel={noop} onConfirm={noop} onFirstCount={noop} onFraction={noop} remainingUsd={4.67} selectionSize={2} sendCount={applyFraction(selection, { mode: 'all' }).length} summary={summary}/>);
    expect(markup).toContain('Retry 2 scopes (+ up to 1 parent re-reduced) · est. $0.0039 (avg $0.0013/scope this run) · remaining budget $4.67');
    expect(markup).toContain('fit to remaining budget (2 of $4.67 left)');
    expect(markup).toContain('>Retry 2 scopes</button>'); expect(markup).toContain('role="alert">The estimate exceeds the remaining budget');
    const noAvg = renderToStaticMarkup(<OperatorRetryConfirm busy={false} error="Below-cap scopes are selected" fit={fitToBudget(selection, scopes, undefined, undefined)} firstCount={1} fraction={{ mode: 'all' }} includesBelowCap onCancel={noop} onConfirm={noop} onFirstCount={noop} onFraction={noop} selectionSize={2} sendCount={2} summary="x"/>);
    const capped = renderToStaticMarkup(<OperatorRetryConfirm avgCostPerScopeUsd={0.0013} busy={false} fit={fitToBudget(selection, scopes, 4.67, 0.0013, 0)} firstCount={1} fraction={{ mode: 'all' }} includesBelowCap={false} onCancel={noop} onConfirm={noop} onFirstCount={noop} onFraction={noop} remainingRequests={0} remainingUsd={4.67} selectionSize={2} sendCount={2} summary="x"/>);
    expect(capped).toContain('Fit to budget unavailable: No requests left in the run budget'); expect(capped).toMatch(/<input disabled=""[^>]*name="retry-fraction"/);
    const withRequests = renderToStaticMarkup(<OperatorRetryConfirm avgCostPerScopeUsd={0.0013} busy={false} fit={fitToBudget(selection, scopes, 4.67, 0.0013, 2)} firstCount={1} fraction={{ mode: 'all' }} includesBelowCap={false} onCancel={noop} onConfirm={noop} onFirstCount={noop} onFraction={noop} remainingRequests={2} remainingUsd={4.67} selectionSize={2} sendCount={2} summary="x"/>);
    expect(withRequests).toContain('fit to remaining budget (1 of $4.67 / 2 requests left)');
    expect(noAvg).toContain('Fit to budget unavailable'); expect(noAvg).toMatch(/<button disabled=""[^>]*>Retry 2 scopes/); expect(noAvg).toContain('below the depth cap (explicit opt-in)');
  });
});
