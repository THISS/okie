import type { ClaimCheckRow, ClaimCheckState, OperatorScope, ScopeClaimChecks } from './api';

/**
 * CLA-145 operator review model for claim checks (pure, unit-tested). Every label keeps the dimensions
 * separate — failed code checks, stale/missing coverage, contradiction, model uncertainty — and none
 * of them ever says a scope is "correct".
 */
export const CLAIM_CHECK_CAPTION = 'Model judgment over captured excerpts, not verification';
/** Same text as the server's stale-row reason and its claim_scopes_stale refusal. */
export const CLAIM_STALE_REASON = 'Explanation is stale; refresh it, then re-check.';
/** "3 statements could not be mapped to evidence and were not evaluated" (from the stored claimsNote). */
export function droppedSummary(count: number): string { return `${count} statement${count === 1 ? '' : 's'} could not be mapped to evidence and ${count === 1 ? 'was' : 'were'} not evaluated`; }

export const CLAIM_STATE_LABEL: Record<ClaimCheckState, string> = {
  'failed-check': 'Failed check',
  stale: 'Stale',
  contradicted: 'Contradicted',
  uncertain: 'Uncertain',
  insufficient: 'Insufficient evidence',
  'insufficient-context': 'Context not captured',
  unavailable: 'Unavailable',
  supported: 'Supported by excerpt',
  'not-evaluated': 'Not evaluated',
};
/** Summary order: what needs attention first. */
const ORDER: ClaimCheckState[] = ['failed-check', 'stale', 'contradicted', 'uncertain', 'insufficient', 'insufficient-context', 'unavailable', 'not-evaluated', 'supported'];

/** "2 failed check · 1 contradicted · 3 supported by excerpt": counts only, never a verdict on the scope. */
export function claimCountsSummary(checks: ScopeClaimChecks | undefined): string {
  if (!checks) return '';
  if (checks.mapping === 'none') return 'Not evaluated: no claim mapping';
  return ORDER.filter(state => (checks.counts[state] ?? 0) > 0).map(state => `${checks.counts[state]} ${CLAIM_STATE_LABEL[state].toLowerCase()}`).join(' · ');
}

/** Verdict chip: state, and the model's reported confidence when Jev answered. */
export function claimChipText(row: Pick<ClaimCheckRow, 'state' | 'confidence' | 'choice' | 'source'>): string {
  const label = CLAIM_STATE_LABEL[row.state];
  if (row.confidence === undefined || row.source !== 'jev') return label;
  const confidence = `${Math.round(row.confidence * 100)}% confidence`;
  // Uncertain and stale rows name the choice they kept, so no answer is hidden.
  return row.state === 'uncertain' || row.state === 'stale' ? `${label} · leaned ${row.choice ?? '?'} · ${confidence}` : `${label} · ${confidence}`;
}

/** `path:start-end` for an evidence ref; unknown lines are left out. */
export function evidenceLabel(ref: { path?: string; entityId?: string; startLine?: number; endLine?: number }): string {
  const where = ref.path ?? ref.entityId ?? '(unknown)';
  if (ref.startLine === undefined) return where;
  return ref.endLine !== undefined && ref.endLine !== ref.startLine ? `${where}:${ref.startLine}-${ref.endLine}` : `${where}:${ref.startLine}`;
}

/**
 * Review-attention tier (lower first), so real results outrank missing coverage on a partial draft (CLA-145 QA M2):
 * 0 failed checks; 1 stale (the explanation is stale in the sidecar, or a check is stale); 2 contradicted; 3 uncertain or
 * insufficient; 4 context not captured; 5 not checked / not run / not evaluated (not-run or failed scopes, claims never
 * checked, checks unavailable or off, explanations without a claim mapping); 6 nothing to review. Sorting never hides a scope.
 */
export function attentionTier(scope: Pick<OperatorScope, 'state' | 'stale' | 'claimChecks' | 'explanation'>): number {
  const counts = scope.claimChecks?.mapping === 'claims' ? scope.claimChecks.counts : undefined;
  const has = (state: ClaimCheckState) => (counts?.[state] ?? 0) > 0;
  if (has('failed-check')) return 0;
  if (scope.stale || has('stale')) return 1;
  if (has('contradicted')) return 2;
  if (has('uncertain') || has('insufficient')) return 3;
  if (has('insufficient-context')) return 4;
  if (scope.state === 'failed' || scope.state === 'not run' || has('not-evaluated') || has('unavailable') || (scope.explanation && scope.claimChecks?.mapping === 'none')) return 5;
  return 6;
}
/** Tier names, used for the roll-up cue on collapsed parents ("… below"). */
export const ATTENTION_REASON = ['Failed checks', 'Stale', 'Contradicted', 'Uncertain or insufficient', 'Context not captured', 'Not checked or not run', ''];
/** Tiers that are review results (shown as roll-up cues); tier 5 is missing coverage and never rolls up as a cue. */
export const RESULT_TIERS = 4;

/** What the tier actually is for this scope: "Not checked yet" never reads as a coverage problem. */
export function attentionLabel(scope: Pick<OperatorScope, 'state' | 'stale' | 'claimChecks' | 'explanation'>): string {
  const tier = attentionTier(scope);
  if (tier !== 5) return ATTENTION_REASON[tier] ?? '';
  const counts = scope.claimChecks?.mapping === 'claims' ? scope.claimChecks.counts : undefined;
  if (scope.state === 'not run') return 'Not run';
  if (scope.state === 'failed') return 'Enrichment failed';
  if (scope.claimChecks?.mapping === 'none') return 'No claim mapping';
  if ((counts?.unavailable ?? 0) > 0) return 'Check unavailable';
  return 'Not checked yet';
}

/** Short, list-row cue for a scope's attention reason (empty when nothing needs attention). */
export function attentionCue(scope: Pick<OperatorScope, 'state' | 'stale' | 'claimChecks' | 'explanation'>): string { return attentionLabel(scope); }

/**
 * Roll-up for the review-attention sort and the collapsed-parent cue: each scope takes the worst (lowest) tier found
 * anywhere in its subtree, so a failed check deep in the tree surfaces at the top level. Linear in the scope count;
 * parent links outside the set are ignored and cycles are cut.
 */
export function attentionRollup(scopes: readonly Pick<OperatorScope, 'scopeId' | 'parentScopeId' | 'state' | 'stale' | 'claimChecks' | 'explanation'>[]): Map<string, number> {
  const ids = new Set(scopes.map(scope => scope.scopeId));
  const children = new Map<string, string[]>();
  for (const scope of scopes) if (scope.parentScopeId && scope.parentScopeId !== scope.scopeId && ids.has(scope.parentScopeId)) { const list = children.get(scope.parentScopeId); if (list) list.push(scope.scopeId); else children.set(scope.parentScopeId, [scope.scopeId]); }
  const own = new Map(scopes.map(scope => [scope.scopeId, attentionTier(scope)]));
  const result = new Map<string, number>(); const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = result.get(id); if (known !== undefined) return known;
    if (visiting.has(id)) return own.get(id)!;
    visiting.add(id);
    let tier = own.get(id)!;
    // Iterative over children, recursive over depth (C4 trees are shallow: system → container → component → code).
    for (const child of children.get(id) ?? []) tier = Math.min(tier, visit(child));
    visiting.delete(id); result.set(id, tier);
    return tier;
  };
  for (const scope of scopes) visit(scope.scopeId);
  return result;
}

/**
 * The list-row cue for a scope with a claim mapping: its own attention label (tiers 0-5, e.g. "Not checked yet"), or, on a
 * collapsed parent, the worst review RESULT in its subtree when that is worse ("… below"), so a problem hidden under a
 * collapsed node stays visible. Missing coverage (tier 5) never rolls up: untouched containers stay quiet.
 */
export function attentionCueFor(scope: Pick<OperatorScope, 'scopeId' | 'state' | 'stale' | 'claimChecks' | 'explanation'>, collapsed: boolean, rollup: ReadonlyMap<string, number>): { tier: number; text: string; title: string; below: boolean } | undefined {
  const mapped = scope.claimChecks?.mapping === 'claims';
  const own = mapped ? attentionTier(scope) : 9;
  const worst = collapsed ? rollup.get(scope.scopeId) ?? own : own;
  if (worst < own && worst <= RESULT_TIERS) return { tier: worst, text: `${ATTENTION_REASON[worst]} below`, title: `A scope inside this one needs review attention: ${ATTENTION_REASON[worst]!.toLowerCase()}`, below: true };
  if (own <= 5) return { tier: own, text: attentionLabel(scope), title: claimCountsSummary(scope.claimChecks), below: false };
  return undefined;
}

/** Durable claim-check batch attempts use this scope-id prefix: `claim-check:<scopeId>#<hash>` (older: `claim-check:<hash>`). */
export const CLAIM_CHECK_ATTEMPT_PREFIX = 'claim-check:';
export function isClaimCheckAttempt(attempt: { scopeId: string }): boolean { return attempt.scopeId.startsWith(CLAIM_CHECK_ATTEMPT_PREFIX); }
/** The checked scope of a claim-check attempt, when its id carries one. */
export function claimCheckAttemptScope(scopeId: string): string | undefined {
  if (!scopeId.startsWith(CLAIM_CHECK_ATTEMPT_PREFIX)) return undefined;
  const rest = scopeId.slice(CLAIM_CHECK_ATTEMPT_PREFIX.length); const hash = rest.lastIndexOf('#');
  return hash > 0 ? rest.slice(0, hash) : undefined;
}
/** Enrichment attempts and claim-check attempts, listed separately so claim checks never crowd enrichment out of the capped list. */
export function splitActivityAttempts<T extends { scopeId: string }>(attempts: readonly T[]): { enrichment: T[]; claimChecks: T[] } {
  const enrichment: T[] = []; const claimChecks: T[] = [];
  for (const attempt of attempts) (isClaimCheckAttempt(attempt) ? claimChecks : enrichment).push(attempt);
  return { enrichment, claimChecks };
}
