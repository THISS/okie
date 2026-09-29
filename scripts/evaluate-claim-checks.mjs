// CLA-145 held-out claim-check evaluation. Finite and opt-in: `--live` calls Jev (JEV_API) through the real
// server pipeline (code checks → per-scope batches → Jev → verdicts); `--replay` runs the same pipeline offline
// against fixtures/judgments/cla145/replay.json. Labels and rationales are never provider inputs.
//
//   node scripts/evaluate-claim-checks.mjs --live --output=/tmp/cla145-live.json [--write-replay] [--timeout-ms=30000]
//   node scripts/evaluate-claim-checks.mjs --replay --output=/tmp/cla145-replay.json
//
// Requires a built server (`pnpm --filter @okie/server build`). Spend: one request per source window (8 windows,
// ≤8 claims each; code-check cases never reach Jev), each reserving $0.003 on a $0.25 evaluation ledger.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJevProvider, JEV_MODEL } from '../apps/server/dist/operatorJudgments.js';
import { runClaimCheckEvaluation, scoreClaimCheckEvaluation } from '../apps/server/dist/claimCheckEvaluation.js';

const live = process.argv.includes('--live');
const offline = process.argv.includes('--replay');
if (live === offline) throw new Error('Pass exactly one of --live or --replay');
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
if (!output) throw new Error('Requires --output=path');
const writeReplay = process.argv.includes('--write-replay');
if (writeReplay && !live) throw new Error('--write-replay records live responses only');
const timeoutMs = Number(process.argv.find(arg => arg.startsWith('--timeout-ms='))?.slice(13) ?? 30000);
const fixtureUrl = new URL('../fixtures/judgments/cla145/heldout.json', import.meta.url);
const replayUrl = new URL('../fixtures/judgments/cla145/replay.json', import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, 'utf8'));
const byClaim = new Map(fixture.cases.map(row => [row.claim, row.id]));
const claimOf = question => JSON.parse(/Claim: (".*")$/.exec(question.instructions.question)[1]);

/** Raw per-claim answers exactly as the provider returned them (for --write-replay). */
const raw = {}; const rawUsage = [];
let provider;
if (live) {
  if (!process.env.JEV_API) throw new Error('JEV_API required for --live');
  provider = createJevProvider(process.env, async (url, init) => {
    const response = await fetch(url, init);
    try {
      const questions = JSON.parse(String(init?.body)).questions;
      const body = await response.clone().json();
      for (const [id, question] of Object.entries(questions)) { const caseId = byClaim.get(claimOf(question)); if (caseId && body?.answers?.[id]) raw[caseId] = body.answers[id]; }
      if (body?.usage) rawUsage.push(body.usage);
    } catch { /* recording is best-effort; the pipeline validates the response itself */ }
    return response;
  });
} else {
  const replay = JSON.parse(readFileSync(replayUrl, 'utf8'));
  provider = createJevProvider({ JEV_API: 'offline-replay' }, async (_url, init) => {
    const questions = JSON.parse(String(init?.body)).questions;
    const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, replay.answers[byClaim.get(claimOf(question))]]));
    const count = Object.keys(answers).length;
    return Response.json({ model: replay.model, answers, usage: { input_tokens: (replay.usagePerQuestion?.input_tokens ?? 0) * count, output_tokens: (replay.usagePerQuestion?.output_tokens ?? 0) * count } });
  });
}

const root = mkdtempSync(join(tmpdir(), 'okie-claim-check-eval-'));
const report = { kind: live ? 'live-claim-checks' : 'replay-claim-checks', synthetic: !live && JSON.parse(readFileSync(replayUrl, 'utf8')).synthetic === true, model: provider.modelId ?? JEV_MODEL, labelOrigin: fixture.labelOrigin, startedAt: new Date().toISOString() };
try {
  const result = await runClaimCheckEvaluation({ fixture, root, provider, timeoutMs });
  report.outcome = result.outcome;
  report.metrics = scoreClaimCheckEvaluation(result.rows, result.requests);
  report.rows = result.rows.map(row => ({ ...row, rationale: [...fixture.cases, ...fixture.codeChecks].find(item => item.id === row.id)?.rationale }));
  report.requests = result.requests;
  writeFileSync(output, JSON.stringify(report, null, 2));
  const { overall, byCategory, latencyMs, cost, thresholds } = report.metrics;
  console.log(JSON.stringify({ kind: report.kind, synthetic: report.synthetic, overall, latencyMs, cost }, null, 2));
  for (const [category, row] of Object.entries(byCategory)) console.log(`${category.padEnd(24)} n=${row.n} acc=${row.accuracy?.toFixed(2)} falseAccept=${row.falseAcceptance} falseAlarm=${row.falseAlarm} review=${row.reviewLoad?.toFixed(2)}`);
  for (const row of thresholds) console.log(`threshold ${row.threshold.toFixed(2)} acc=${row.accuracy?.toFixed(2)} falseAccept=${row.falseAcceptance} falseAlarm=${row.falseAlarm} uncertain=${row.uncertain} review=${row.reviewLoad?.toFixed(2)}`);
  if (writeReplay) {
    const recorded = { origin: `LIVE: raw ${report.model} System One answers recorded by scripts/evaluate-claim-checks.mjs on ${report.startedAt}. Not labels.`, synthetic: false, model: report.model, usagePerRequest: rawUsage, usagePerQuestion: rawUsage.length ? { input_tokens: Math.round(rawUsage.reduce((sum, usage) => sum + (usage.input_tokens ?? 0), 0) / Math.max(1, Object.keys(raw).length)), output_tokens: Math.round(rawUsage.reduce((sum, usage) => sum + (usage.output_tokens ?? 0), 0) / Math.max(1, Object.keys(raw).length)) } : undefined, answers: raw };
    writeFileSync(replayUrl, JSON.stringify(recorded, null, 2) + '\n');
    console.log(`wrote ${Object.keys(raw).length} raw answers to ${replayUrl.pathname}`);
  }
} finally {
  writeFileSync(output, JSON.stringify(report, null, 2));
  rmSync(root, { recursive: true, force: true });
}
