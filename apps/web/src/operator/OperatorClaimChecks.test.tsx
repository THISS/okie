import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ClaimCheckState, ClaimChecksInfo, OperatorEvent, OperatorScope, ScopeClaimChecks } from './api';
import { OperatorClaimChecks } from './OperatorClaimChecks';
import { attentionCueFor, attentionLabel, attentionRollup, attentionTier, CLAIM_CHECK_CAPTION, claimCheckAttemptScope, splitActivityAttempts, claimChipText, claimCountsSummary, evidenceLabel } from './claimChecks';
import { orderTree, scopeComparator, scopeListView } from './scopeList';
import { ScopeInspector } from './OperatorWorkspace';
import { attemptLabel, latestClaimPassMessage, operatorEventLabel } from './reviewState';
import { activeClaimPass, completionBanner } from './completion';

const noop = () => undefined;
const info: ClaimChecksInfo = { enabled: true, label: CLAIM_CHECK_CAPTION, threshold: 0.5, state: 'ready' };
const counts = (partial: Partial<Record<ClaimCheckState, number>>): Record<ClaimCheckState, number> => ({ supported: 0, contradicted: 0, insufficient: 0, uncertain: 0, unavailable: 0, 'failed-check': 0, 'insufficient-context': 0, 'not-evaluated': 0, stale: 0, ...partial });
const checks: ScopeClaimChecks = { mapping: 'claims', counts: counts({ supported: 1, contradicted: 1, 'failed-check': 1, stale: 1, unavailable: 1, uncertain: 1 }), rows: [
  { claimId: 'c1', text: 'Rows are written as JSON.', origin: 'keyPoint', index: 0, evidence: [{ entityId: 'code:a', path: 'src/a.ts', startLine: 10, endLine: 14, outcome: 'ok' }], state: 'supported', source: 'jev', choice: 'supports', confidence: 0.91 },
  { claimId: 'c2', text: 'It never touches disk.', origin: 'summary', index: 0, evidence: [{ entityId: 'code:a', path: 'src/a.ts', startLine: 10, endLine: 14, outcome: 'ok' }], state: 'contradicted', source: 'jev', choice: 'contradicts', confidence: 0.77 },
  { claimId: 'c3', text: 'The helper exists.', origin: 'keyPoint', index: 1, evidence: [{ entityId: 'code:gone', path: 'x.ts', outcome: 'unknown-entity' }], state: 'failed-check', source: 'code', reason: 'Cited entity is not in this revision\'s snapshot.' },
  { claimId: 'c4', text: 'Old claim.', origin: 'keyPoint', index: 2, evidence: [{ path: 'src/a.ts', startLine: 3, endLine: 3, outcome: 'ok' }], state: 'stale', source: 'jev', choice: 'supports', confidence: 0.9, reason: 'Explanation is stale (a child changed); refresh it, then re-check.' },
  { claimId: 'c5', text: 'Budget claim.', origin: 'keyPoint', index: 3, evidence: [{ path: 'src/a.ts', outcome: 'ok' }], state: 'unavailable', source: 'jev', reason: 'This run\'s claim-check budget is exhausted (OKIE_JEV_MAX_*).' },
  { claimId: 'c6', text: 'Maybe claim.', origin: 'keyPoint', index: 4, evidence: [{ path: 'src/a.ts', outcome: 'ok' }], state: 'uncertain', source: 'jev', choice: 'supports', confidence: 0.2 },
] };
const scope: OperatorScope = { scopeId: 'component:c', name: 'Storage', state: 'accepted', explanation: { format: 'v3', summary: 'Storage keeps rows. It never touches disk.', keyPoints: ['Rows are written as JSON.', 'Two.'], evidence: [] }, claimChecks: checks };
const source = { owner: 'acme', repo: 'demo', commitSha: 'a'.repeat(40) };

describe('claim-check review model (CLA-145)', () => {
  it('summarises counts without ever calling a scope correct', () => {
    expect(claimCountsSummary(checks)).toBe('1 failed check · 1 stale · 1 contradicted · 1 uncertain · 1 unavailable · 1 supported by excerpt');
    expect(claimCountsSummary({ mapping: 'none', counts: counts({}), rows: [] })).toBe('Not evaluated: no claim mapping');
    expect(claimCountsSummary(checks)).not.toMatch(/correct|verified/i);
  });
  it('chips carry state and model confidence; uncertain keeps the leaning choice', () => {
    expect(claimChipText(checks.rows[0]!)).toBe('Supported by excerpt · 91% confidence');
    expect(claimChipText(checks.rows[5]!)).toBe('Uncertain · leaned supports · 20% confidence');
    expect(claimChipText(checks.rows[2]!)).toBe('Failed check');
    expect(evidenceLabel({ path: 'src/a.ts', startLine: 10, endLine: 14 })).toBe('src/a.ts:10-14');
    expect(evidenceLabel({ path: 'src/a.ts' })).toBe('src/a.ts');
  });
  it('labels claim-check events and budget rows as report-only claim checks', () => {
    expect(operatorEventLabel({ type: 'claim_checks.finished', detail: { stopped: 'limit', claims: 3 } })).toBe('Claim checks stopped at the claim-check budget · 3 claims · report-only');
    expect(operatorEventLabel({ type: 'budget.reserved', detail: { kind: 'claim-check', tokens: 81920, dollars: 0.003 } })).toMatch(/^Claim-check budget reserved/);
  });
  it('surfaces the pass outcome from its claim_checks.finished event, never from run.error', () => {
    const message = 'Claim checks were not run: Explanation is stale; refresh it, then re-check.';
    expect(operatorEventLabel({ type: 'claim_checks.finished', detail: { stopped: 'stale', message } })).toBe(`Claim checks not run (stale) · report-only · ${message}`);
    const events: Array<Pick<OperatorEvent, 'type' | 'detail'>> = [{ type: 'claim_checks.finished', detail: { stopped: 'limit', message: 'older' } }, { type: 'run.state', detail: {} }, { type: 'claim_checks.finished', detail: { stopped: 'stale', message } }];
    expect(latestClaimPassMessage(events)).toBe(message);
    expect(latestClaimPassMessage([...events, { type: 'claim_checks.finished', detail: { stopped: 'complete' } }])).toBeUndefined();
    expect(latestClaimPassMessage(undefined)).toBeUndefined();
    // L1: the message is shown once at the draft level (OperatorWorkspace), never inside every scope's panel.
    expect(renderToStaticMarkup(<OperatorClaimChecks busy={false} info={info} onRecheck={noop} scope={scope}/>)).not.toContain('Last claim-check pass');
  });
  it('review attention: failed checks, then stale/missing coverage, contradicted, uncertain/insufficient — siblings only', () => {
    const make = (scopeId: string, partial: Partial<Record<ClaimCheckState, number>>, extra: Partial<OperatorScope> = {}): OperatorScope => ({ scopeId, name: scopeId, state: 'accepted', parentScopeId: 'root', kind: 'component', claimChecks: { mapping: 'claims', counts: counts(partial), rows: [] }, ...extra });
    const scopes = [make('e-clean', { supported: 3 }), make('d-unsure', { uncertain: 1 }), make('c-contra', { contradicted: 1, supported: 2 }), make('b-stale', { stale: 1 }), make('a-failed', { 'failed-check': 1 }), make('f-notrun', {}, { state: 'not run', claimChecks: undefined })];
    expect(scopes.map(attentionTier)).toEqual([6, 3, 2, 1, 0, 5]);
    const sorted = [...scopes].sort(scopeComparator('attention'));
    expect(sorted.map(item => item.scopeId)).toEqual(['a-failed', 'b-stale', 'c-contra', 'd-unsure', 'f-notrun', 'e-clean']);
  });
  it('M2: missing coverage never outranks real results, and each cue says what its tier is', () => {
    const make = (scopeId: string, partial: Partial<Record<ClaimCheckState, number>>, extra: Partial<OperatorScope> = {}): OperatorScope => ({ scopeId, name: scopeId, state: 'accepted', parentScopeId: 'root', kind: 'component', explanation: scope.explanation!, claimChecks: { mapping: 'claims', counts: counts(partial), rows: [] }, ...extra });
    const scopes = [
      make('g-unchecked', { 'not-evaluated': 3 }), make('h-notrun', {}, { state: 'not run', explanation: undefined, claimChecks: undefined }), make('i-off', { 'not-evaluated': 2 }),
      make('j-context', { 'insufficient-context': 2, supported: 1 }), make('k-unsure', { insufficient: 1 }), make('l-contra', { contradicted: 1, 'not-evaluated': 1 }),
      make('m-stale-sidecar', { 'insufficient-context': 1 }, { stale: true }), make('n-failed', { 'failed-check': 1, stale: 1 }), make('o-clean', { supported: 2 }),
      make('p-unmapped', {}, { claimChecks: { mapping: 'none', counts: counts({}), rows: [] } }), make('q-unavailable', { unavailable: 1 }),
    ];
    expect([...scopes].sort(scopeComparator('attention')).map(item => item.scopeId)).toEqual(['n-failed', 'm-stale-sidecar', 'l-contra', 'k-unsure', 'j-context', 'g-unchecked', 'h-notrun', 'i-off', 'p-unmapped', 'q-unavailable', 'o-clean']);
    const label = (id: string) => attentionLabel(scopes.find(item => item.scopeId === id)!);
    expect(['g-unchecked', 'h-notrun', 'p-unmapped', 'q-unavailable', 'j-context', 'm-stale-sidecar', 'o-clean'].map(label)).toEqual(['Not checked yet', 'Not run', 'No claim mapping', 'Check unavailable', 'Context not captured', 'Stale', '']);
    expect(scopes.map(item => attentionLabel(item))).not.toContain('Stale or missing coverage');
    // Roll-up: only review results surface on a collapsed parent; untouched children never make a parent "… below".
    const tree = [make('root', { supported: 1 }, { parentScopeId: undefined }), make('child', { 'not-evaluated': 4 }, { parentScopeId: 'root' }), make('leaf', {}, { parentScopeId: 'child', state: 'not run', claimChecks: undefined })];
    const rollup = attentionRollup(tree);
    expect(attentionCueFor(tree[0]!, true, rollup)).toBeUndefined();
    expect(attentionCueFor(tree[1]!, true, rollup)).toMatchObject({ text: 'Not checked yet', below: false });
  });
  it('review attention rolls up: a parent sorts and cues by the worst tier anywhere in its subtree', () => {
    const node = (scopeId: string, parentScopeId: string | undefined, partial: Partial<Record<ClaimCheckState, number>>, kind = 'container'): OperatorScope => ({ scopeId, name: scopeId, state: 'accepted', kind, ...(parentScopeId ? { parentScopeId } : {}), claimChecks: { mapping: 'claims', counts: counts(partial), rows: [] } });
    const scopes = [node('sys', undefined, { supported: 1 }, 'softwareSystem'), node('z-clean', 'sys', { supported: 2 }), node('a-comp', 'z-clean', { supported: 1 }, 'component'), node('deep', 'a-comp', { 'failed-check': 1 }, 'code'), node('b-contra', 'sys', { contradicted: 1 })];
    const rollup = attentionRollup(scopes);
    expect(Object.fromEntries(rollup)).toEqual({ sys: 0, 'z-clean': 0, 'a-comp': 0, deep: 0, 'b-contra': 2 });
    // Own tiers alone would put b-contra (2) above z-clean (5), as hierarchy does by name; the roll-up surfaces the deep failed check.
    expect(orderTree(scopes, 'attention').map(scope => scope.scopeId)).toEqual(['sys', 'z-clean', 'a-comp', 'deep', 'b-contra']);
    expect(orderTree(scopes, 'hierarchy').map(scope => scope.scopeId)).toEqual(['sys', 'b-contra', 'z-clean', 'a-comp', 'deep']);
    expect([...scopes].sort(scopeComparator('attention')).map(scope => scope.scopeId)[0]).toBe('deep');
    const rows = scopeListView(scopes, { query: '', filter: 'all', showBelowCap: true, sort: 'attention' }).rows;
    expect(rows.map(row => row.scope.scopeId)).toEqual(['sys', 'z-clean', 'b-contra']);
    const aClean = scopes[1]!;
    expect(attentionCueFor(aClean, true, rollup)).toMatchObject({ tier: 0, text: 'Failed checks below', below: true });
    expect(attentionCueFor(aClean, false, rollup)).toBeUndefined();
    expect(attentionCueFor(scopes[4]!, true, rollup)).toMatchObject({ tier: 2, text: 'Contradicted', below: false });
    // Cycles and foreign parents never loop or leak.
    expect(Object.fromEntries(attentionRollup([node('x', 'y', { stale: 1 }), node('y', 'x', {}), node('z', 'missing', {})]))).toEqual({ x: 1, y: 1, z: 6 });
  });
});

describe('claim checks panel', () => {
  it('renders one row per claim with evidence links, verdict chips, reasons, the caption and a re-check action', () => {
    const markup = renderToStaticMarkup(<OperatorClaimChecks busy={false} info={info} onRecheck={noop} scope={scope} source={source}/>);
    expect(markup).toContain('Claim checks'); expect(markup).toContain(`${CLAIM_CHECK_CAPTION}.`); expect(markup).toContain('Re-check claims');
    for (const state of ['supported', 'contradicted', 'failed-check', 'stale', 'unavailable', 'uncertain']) expect(markup).toContain(`data-claim-state="${state}"`);
    expect(markup).toContain(`href="https://github.com/acme/demo/blob/${'a'.repeat(40)}/src/a.ts#L10-L14"`);
    expect(markup).toContain('Code check: Cited entity');
    expect(markup).toContain('refresh it, then re-check');
    expect(markup).toContain('claim-check budget is exhausted');
    expect(markup).not.toMatch(/✓|verified|correct/i);
  });
  it('renders disabled, no-mapping and corrupt states distinctly with their reasons', () => {
    const disabled = renderToStaticMarkup(<OperatorClaimChecks busy={false} info={{ ...info, enabled: false, disabledReason: 'Claim checks are off on this server. Set OKIE_JEV_CLAIM_CHECKS=on (and JEV_API) to enable them.' }} onRecheck={noop} scope={scope} source={source}/>);
    expect(disabled).toContain('data-claim-checks="disabled"'); expect(disabled).toContain('OKIE_JEV_CLAIM_CHECKS=on'); expect(disabled).toMatch(/<button disabled=""[^>]*>Re-check claims/);
    const none = renderToStaticMarkup(<OperatorClaimChecks busy={false} info={info} onRecheck={noop} scope={{ ...scope, claimChecks: { mapping: 'none', note: 'Not evaluated: this explanation has no claim mapping.', counts: counts({}), rows: [] } }}/>);
    expect(none).toContain('data-claim-checks="none"'); expect(none).toContain('no claim mapping'); expect(none).toContain('data-claim-state="not-evaluated"');
    const corrupt = renderToStaticMarkup(<OperatorClaimChecks busy={false} info={{ ...info, state: 'corrupt', file: 'claim-checks.json' }} onRecheck={noop} scope={scope}/>);
    expect(corrupt).toContain('Stored claim checks are corrupt (claim-checks.json)');
    const superseded = renderToStaticMarkup(<OperatorClaimChecks busy={false} disabledHint="This revision is superseded." info={info} onRecheck={noop} scope={scope}/>);
    expect(superseded).toMatch(/<button disabled=""[^>]*title="This revision is superseded\."/);
  });
  it('the inspector keeps the prose visible and the existing retry next to the panel', () => {
    const markup = renderToStaticMarkup(<ScopeInspector canRetry claimInfo={info} hidden="visible" lookup={new Map([[scope.scopeId, scope]])} onRecheck={noop} onRetry={noop} rechecking={false} retrying={false} scope={scope} source={source}/>);
    expect(markup).toContain('It never touches disk.'); expect(markup).toContain('Retry this scope…'); expect(markup).toContain('Re-check claims');
    const older = renderToStaticMarkup(<ScopeInspector canRetry hidden="visible" lookup={new Map()} onRetry={noop} retrying={false} scope={{ ...scope, claimChecks: undefined }}/>);
    expect(older).not.toContain('Claim checks'); // an older server without claim checks renders the inspector as before
  });
  it('M1: dropped mappings are surfaced with a collapsible note; L2: claim text renders inline markdown', () => {
    const withDropped = { ...scope, claimChecks: { ...checks, dropped: 3, droppedNote: 'dropped claim mapping: keyPoints[1]: evidence index out of range; summaryClaims[0]: no evidence' } };
    const markup = renderToStaticMarkup(<OperatorClaimChecks busy={false} info={info} onRecheck={noop} scope={withDropped}/>);
    expect(markup).toMatch(/<details class="operator-claim-dropped" data-claim-dropped="3"><summary>3 statements could not be mapped to evidence and were not evaluated<\/summary>/);
    expect(markup).toContain('evidence index out of range');
    const allDropped = renderToStaticMarkup(<OperatorClaimChecks busy={false} info={info} onRecheck={noop} scope={{ ...scope, claimChecks: { mapping: 'none', note: 'Not evaluated: all 1 claim mapping was dropped when the explanation was written.', counts: counts({}), rows: [], dropped: 1, droppedNote: 'dropped claim mapping: x' } }}/>);
    expect(allDropped).toContain('all 1 claim mapping was dropped'); expect(allDropped).toContain('1 statement could not be mapped to evidence and was not evaluated');
    const md = renderToStaticMarkup(<OperatorClaimChecks busy={false} info={info} onRecheck={noop} scope={{ ...scope, claimChecks: { ...checks, rows: [{ ...checks.rows[0]!, text: '**`src/githubAccess.ts`** resolves the token.' }] } }}/>);
    expect(md).toContain('<strong><code>src/githubAccess.ts</code></strong>'); expect(md).not.toContain('**');
  });
  it('M3: a fully stale scope blocks re-check with the reason inline; a refusal also shows inline', () => {
    const stale = renderToStaticMarkup(<OperatorClaimChecks busy={false} info={info} onRecheck={noop} scope={{ ...scope, stale: true, claimChecks: { ...checks, stale: true } }}/>);
    expect(stale).toMatch(/<button disabled=""[^>]*title="Explanation is stale; refresh it, then re-check\."/);
    expect(stale).toContain('data-claim-recheck-blocked="stale"');
    const refused = renderToStaticMarkup(<OperatorClaimChecks busy={false} error="Every selected scope's explanation is stale; refresh it, then re-check." info={info} onRecheck={noop} scope={scope}/>);
    expect(refused).toMatch(/data-claim-error="true" role="alert">Every selected scope/);
    const inspector = renderToStaticMarkup(<ScopeInspector canRetry claimError="Refused." claimInfo={info} hidden="visible" lookup={new Map([[scope.scopeId, scope]])} onRecheck={noop} onRetry={noop} rechecking={false} retrying={false} scope={scope}/>);
    expect(inspector).toContain('data-claim-error');
  });
  it('L4/L5: claim-check attempts get readable labels and their own list; a running claim pass reads "Checking claims…"', () => {
    const names = (id: string) => (id === 'component:c' ? 'Storage' : undefined);
    expect(attemptLabel({ kind: 'enrichment', state: 'accepted', scopeId: 'claim-check:component:c#0123456789abcdef' }, names)).toBe('Storage: claim check accepted');
    expect(attemptLabel({ kind: 'enrichment', state: 'failed', scopeId: 'claim-check:' + 'a'.repeat(32) }, names)).toBe('Claim check failed');
    expect(claimCheckAttemptScope('claim-check:code:x:y#0123456789abcdef')).toBe('code:x:y');
    const split = splitActivityAttempts([{ scopeId: 'a' }, { scopeId: 'claim-check:a#1' }, { scopeId: 'b' }]);
    expect([split.enrichment.length, split.claimChecks.length]).toEqual([2, 1]);
    const running = { state: 'running' as const, createdAt: 0, updatedAt: 0 };
    const started: Array<Pick<OperatorEvent, 'type' | 'detail'>> = [{ type: 'run.state', detail: { state: 'running' } }, { type: 'claim_checks.started', detail: { scopes: 1 } }];
    expect(activeClaimPass(started)?.type).toBe('claim_checks.started');
    const banner = completionBanner({ run: running, events: started, scopes: [scope], progress: { accepted: 0, failed: 0, inFlight: 0 } })!;
    expect(banner.title).toBe('Checking claims…'); expect(banner.detail).toContain('1 scope selected'); expect(banner.title).not.toMatch(/Enriching/);
    expect(activeClaimPass([...started, { type: 'claim_checks.finished', detail: { stopped: 'complete' } }])).toBeUndefined();
    expect(activeClaimPass([...started, { type: 'run.state', detail: { state: 'awaiting_review' } }, { type: 'run.state', detail: { state: 'running' } }])).toBeUndefined();
    expect(completionBanner({ run: running, events: [{ type: 'run.state', detail: { state: 'running' } }], scopes: [scope], progress: { accepted: 0, failed: 0, inFlight: 0 } })!.title).toMatch(/^Enriching/);
    expect(operatorEventLabel({ type: 'claim_checks.started', detail: { scopes: 2 } })).toBe('Claim checks started · 2 scopes · report-only');
  });
});
