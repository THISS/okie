import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const commit = 'ef89f2ed0da29906b44fa5da58553cb28694f102';
// Regenerates fixtures/judgments/cla145/heldout.json (CLA-145). Labels below were fixed before any live run;
// only the excerpt text is re-extracted from the pinned commit. No network, no model.
const root = fileURLToPath(new URL('..', import.meta.url));
const windows = {
  'budget-release': ['apps/server/src/operatorBudget.ts', 112, 120],
  'global-spend': ['apps/server/src/globalSpend.ts', 62, 89],
  'runner-pass-cost': ['apps/server/src/operatorRunner.ts', 31, 39],
  'retry-selection': ['apps/server/src/operatorApi.ts', 14, 37],
  'scan-excerpt': ['packages/scan/src/excerpt.ts', 32, 76],
  'jev-provider': ['apps/server/src/operatorJudgments.ts', 65, 84],
  'operator-budget-env': ['apps/server/src/llmGateway.ts', 158, 193],
  'runner-imports': ['apps/server/src/operatorRunner.ts', 1, 15],
};
const sources = {};
for (const [id, [path, startLine, endLine]] of Object.entries(windows)) {
  const file = execFileSync('git', ['-C', root, 'show', `${commit}:${path}`], { encoding: 'utf8', maxBuffer: 8e6 });
  sources[id] = { repository: 'thiss/okie', commit, path, startLine, endLine, text: file.split('\n').slice(startLine - 1, endLine).join('\n') };
}
const c = (id, category, source, claim, expected, rationale, lines) => ({ id, category, source, claim, expected, rationale, ...(lines ? { lines } : {}) });
const cases = [
  c('release-settled-throws', 'supported', 'budget-release', 'Releasing a reservation that already has settled usage throws an error.', 'supported', 'Line 117 throws "settled budget reservation cannot be released" when row.usage is set.'),
  c('release-unknown-throws', 'supported', 'budget-release', 'Releasing an unknown reservation id throws an error.', 'supported', 'Line 116 throws "unknown budget reservation" when no row exists.'),
  c('release-settled-allowed', 'negation', 'budget-release', 'A reservation that has settled usage can still be released.', 'contradicted', 'Negated form of line 117: settled rows throw instead of releasing.'),
  c('spend-positive-only', 'supported', 'global-spend', 'Token and dollar spend are recorded only when the reported values are finite and positive.', 'supported', 'record() guards both with Number.isFinite and > 0 (lines 81, 84).'),
  c('exhausted-ten-percent', 'wrong-assertion', 'global-spend', 'isExhausted reports exhaustion once dollar spend comes within 10% of the cap.', 'contradicted', 'Real citation, wrong threshold: line 76 compares spent.dollars >= cap.maxDollars.'),
  c('never-caps-tokens', 'negation', 'global-spend', 'The global spend ledger never caps tokens.', 'contradicted', 'Lines 71 and 75 enforce cap.maxTokens when it is set.'),
  c('add-dollars-rounding', 'incomplete-coverage', 'global-spend', 'addDollars rounds sums to six decimal places.', 'insufficient', 'addDollars is only called here; its body is outside the cited window (it is true in the file, but not shown).'),
  c('retry-dedupe', 'supported', 'retry-selection', 'Duplicate scope ids in a batch retry are removed.', 'supported', 'Line 31 builds scopeIds from a Set.'),
  c('retry-cap-512', 'compound-one-false', 'retry-selection', 'A batch retry removes duplicate scope ids and accepts at most 512 scopes at once.', 'contradicted', 'Dedupe is true (line 31) but MAX_RETRY_SCOPES is 1024 (line 15).'),
  c('below-cap-single-free', 'wrong-assertion', 'retry-selection', 'A below-cap scope named in the single scopeId form is retried without any opt-in.', 'contradicted', 'Line 26 returns the opt-in error for a below-cap single scope without includeBelowCap.'),
  c('empty-scopeids-rejected', 'supported', 'retry-selection', 'An empty scopeIds array is rejected.', 'supported', 'Line 29 returns "scopeIds must not be empty".'),
  c('excerpt-lines-not-cut', 'supported', 'scan-excerpt', 'Source lines are never cut; an overlong first line is skipped so the window starts on the next usable line.', 'supported', 'Lines 56-59 skip an overlong leading line; no slicing of line text occurs.'),
  c('excerpt-no-original-range', 'negation', 'scan-excerpt', 'The excerpt does not record the originally requested line range.', 'contradicted', 'Line 72 stores sourceStartLine and sourceEndLine from the input.'),
  c('excerpt-crlf-and-truncate', 'compound-one-false', 'scan-excerpt', 'The excerpt normalises CRLF line endings and truncates overlong lines to the character limit.', 'contradicted', 'CRLF normalisation is true (line 43); overlong lines are skipped or end the window, never truncated (lines 56-58).'),
  c('scrub-replacement-text', 'incomplete-coverage', 'scan-excerpt', 'scrubGithubTokens replaces every token with the literal string [redacted].', 'insufficient', 'scrubGithubTokens is only called here (line 54); its replacement text is not shown.'),
  c('pass-cost-completion-record', 'contradictory-context', 'runner-pass-cost', 'passCost returns the durable completion record with the installed draft\'s coverage counts.', 'contradicted', 'A stray doc comment (line 31) says this, but the code (lines 33-36) returns only an optional costUsd sum.'),
  c('pass-cost-omits', 'supported', 'runner-pass-cost', 'passCost omits the cost field when no attempt reported a cost.', 'supported', 'Line 35 returns {} when costs is empty.'),
  c('finished-detail-cost', 'contradictory-context', 'runner-pass-cost', 'finishedDetail computes the pass\'s provider cost itself.', 'insufficient', 'The cost comment sits next to finishedDetail, but finishedDetail (lines 37-38) only spreads caller-supplied extra values; whether cost is passed is not shown.'),
  c('jev-no-retries', 'supported', 'jev-provider', 'The Jev client is created with SDK retries disabled.', 'supported', 'Lines 69 and 76 set retry: { maxRetries: 0 }.'),
  c('jev-openai', 'wrong-assertion', 'jev-provider', 'createJevProvider sends requests to the OpenAI API.', 'contradicted', 'Line 69 pins baseURL https://api.typesafe.ai.'),
  c('jev-rethrows', 'negation', 'jev-provider', 'Provider errors are rethrown to the caller with their original message.', 'contradicted', 'Lines 78-81 catch and return { failed: true } without the message.'),
  c('usage-cost-field', 'incomplete-coverage', 'jev-provider', 'usageOf reads a cost_usd field from the response when present.', 'insufficient', 'usageOf is only called here; its body is outside the window.'),
  c('runner-rate-limits-every-request', 'dependency-as-runtime', 'runner-imports', 'The operator runner sends every enrichment request through the rate limiter.', 'insufficient', 'Only the import of rateLimitedGateway/sharedLlmRateLimiter (line 11) is shown; an import is not runtime use.'),
  c('runner-publishes', 'dependency-as-runtime', 'runner-imports', 'The operator runner publishes drafts through OperatorPublicationService.', 'insufficient', 'Only the import (line 5) is shown. (In fact the runner never publishes; it only creates drafts.)'),
  c('budget-env-fallback', 'supported', 'operator-budget-env', 'Operator budget values that parse to zero or less fall back to the defaults.', 'supported', 'parsePositiveNumber returns the fallback when parsed <= 0 (line 160), and lines 188-191 use it for every operator budget value. (How optionalFiniteNumber parses strings is not shown, so the claim avoids it.)'),
  c('budget-defaults-50', 'compound-one-false', 'operator-budget-env', 'The operator request cap defaults to 512 and the operator dollar cap defaults to $50.', 'contradicted', '512 is true (line 175); DEFAULT_OPERATOR_MAX_DOLLARS is 5 (line 177).'),
  c('budget-shared-timeout', 'wrong-assertion', 'operator-budget-env', 'Operator enrichment reads its request timeout from OKIE_LLM_TIMEOUT_MS.', 'contradicted', 'Line 188 reads OKIE_LLM_OPERATOR_TIMEOUT_MS; OKIE_LLM_TIMEOUT_MS is the public budget (line 167).'),
  c('budget-timeout-fixed', 'negation', 'operator-budget-env', 'The operator per-request timeout is not configurable.', 'contradicted', 'Line 188 reads it from OKIE_LLM_OPERATOR_TIMEOUT_MS.'),
];
// Code-check cases: the citation or capture is broken; code decides and Jev is never called.
const codeChecks = [
  { id: 'code-unknown-entity', category: 'code-check', source: 'budget-release', claim: 'Releasing an unknown reservation id throws an error.', expected: 'failed-check', expectedReason: 'unknown-entity', mutation: 'cite-missing-entity', rationale: 'The claim cites an entity id that is not in the snapshot.' },
  { id: 'code-out-of-bounds', category: 'code-check', source: 'budget-release', claim: 'Releasing an unknown reservation id throws an error.', expected: 'failed-check', expectedReason: 'out-of-bounds', mutation: 'cite-outside-range', rationale: 'Cited lines 100-130 fall outside the entity\'s declared range 112-120.' },
  { id: 'code-identity-mismatch', category: 'code-check', source: 'global-spend', claim: 'The global spend ledger never caps tokens.', expected: 'failed-check', expectedReason: 'identity-mismatch', mutation: 'foreign-commit-capture', rationale: 'The captured excerpt is frozen at a different commit than the artifact.' },
  { id: 'code-truncated', category: 'code-check', source: 'scan-excerpt', claim: 'The excerpt normalises CRLF line endings.', expected: 'insufficient-context', expectedReason: 'truncated-capture', mutation: 'truncated-capture', rationale: 'The scanner recorded an original range to line 140 but captured only through line 76.' },
  { id: 'code-missing', category: 'code-check', source: 'jev-provider', claim: 'The Jev client is created with SDK retries disabled.', expected: 'insufficient-context', expectedReason: 'missing-capture', mutation: 'no-capture', rationale: 'The cited symbol has no captured excerpt.' },
];
const fixture = {
  schemaVersion: 1,
  ticket: 'CLA-145',
  labelOrigin: 'Provisional engineering source-inspection labels fixed before any live claim-check inference (2026-09-29); not model output and not independent human adjudication.',
  license: 'Excerpts from thiss/okie under ../LICENSE (MIT, Okie excerpts).',
  extraction: `git show ${commit}:<path>, lines startLine..endLine inclusive`,
  expectedStates: ['supported', 'contradicted', 'insufficient', 'failed-check', 'insufficient-context'],
  categories: ['supported', 'wrong-assertion', 'negation', 'dependency-as-runtime', 'compound-one-false', 'incomplete-coverage', 'contradictory-context', 'code-check'],
  sources, cases, codeChecks,
};
writeFileSync(`${root}/fixtures/judgments/cla145/heldout.json`, JSON.stringify(fixture, null, 2) + '\n');
console.log(`${cases.length} judged cases, ${codeChecks.length} code-check cases`);
