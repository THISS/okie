// Explicit opt-in; never imported by CI. Only captured public fixture source is sent.
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJevProvider, runOperatorJudgments } from '../apps/server/dist/operatorJudgments.js';
import { OperatorStore } from '../apps/server/dist/operatorStore.js';
import { OperatorPublicationService } from '../apps/server/dist/operatorPublication.js';
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { choice } = require('@typesafe-ai/sdk');
if (!process.argv.includes('--live')) throw new Error('Requires --live');
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
if (!output) throw new Error('Requires --output=path');
const fixture = JSON.parse(readFileSync(new URL('../fixtures/judgments/baseline.json', import.meta.url)));
const smoke = process.argv.includes('--smoke');
const cases = smoke ? fixture.cases.filter(row => ['okie-reject', 'zod-name'].includes(row.id)) : fixture.cases;
const root = mkdtempSync(join(tmpdir(), 'okie-jev-live-'));
const report = { kind: 'live', model: 'jev-1.13.0', capRequests: 100, admissionBudgetUsd: 1, estimatedReservationPerRequestUsd: 0.003, measuredCostUsd: null, rows: [] };
try {
  const store = new OperatorStore(root);
  const publication = new OperatorPublicationService(store);
  const provider = createJevProvider();
  if (!provider) throw new Error('JEV_API is required');
  for (const row of cases) {
    // Synthetic conflict is a replay-only test, not captured public evidence.
    if (row.conflictingNote) { report.rows.push({ id: row.id, state: 'excluded-synthetic-conflict' }); continue; }
    if (row.evidenceMode) { report.rows.push({ id: row.id, predicted: 'unknown', expected: row.label, requests: 0, reason: row.evidenceMode }); continue; }
    const source = fixture.sources[row.source];
    const run = store.createRun({ idempotencyKey: row.id, source: { repositoryId: `repo:${source.repository}`, owner: source.repository.split('/')[0], repo: source.repository.split('/')[1], slug: row.id } }).run;
    const artifact = store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: source.commit, files: { 'snapshot.json': JSON.stringify({ entities: [{ id: 'component:subject', name: 'Subject', sourceExcerpts: [{ path: source.path, startLine: source.startLine, endLine: source.endLine, lines: source.text.split('\n') }] }], relations: [] }) } });
    const draft = publication.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
    store.updateRun(run.runId, { state: 'awaiting_review' });
    const started = performance.now();
    const outcome = await runOperatorJudgments({ store, publication, provider, limits: { timeoutMs: 30000, maxConcurrent: 1 }, request: {
      runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeId: 'component:subject', batchId: 'evaluation', questionVersion: 'evidence-relation-v1', inputs: { claim: row.claim, conflictingNote: null },
      questions: { relation: choice('How does the captured evidence relate to inputs.claim? Use only supplied evidence; conflicting sources without a resolution are unknown.', { supports: 'Evidence directly supports the claim', contradicts: 'Evidence directly contradicts the claim', unknown: 'Insufficient or unresolved conflicting evidence' }) },
    } });
    const result = { id: row.id, split: row.split, expected: row.label, state: outcome.state, latencyMs: Math.round(performance.now() - started), requests: 1, usage: store.snapshot().attempts.at(-1)?.usage, ...(outcome.state === 'accepted' ? { model: outcome.artifact.modelId, answer: outcome.artifact.answers.relation, predicted: outcome.artifact.answers.relation.choice } : {}) };
    report.rows.push(result);
    writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(result));
    if (smoke && outcome.state !== 'accepted') break;
  }
} finally {
  writeFileSync(output, JSON.stringify(report, null, 2));
  rmSync(root, { recursive: true, force: true });
}
