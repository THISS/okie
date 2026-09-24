// Finite, opt-in public-source experiment. Labels/tasks are never provider inputs.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJevProvider } from '../apps/server/dist/operatorJudgments.js';
import { buildSectionState, runSectionProfile, SECTION_ROLES } from '../apps/server/dist/sectionProfiles.js';
import { OperatorStore } from '../apps/server/dist/operatorStore.js';
import { OperatorPublicationService } from '../apps/server/dist/operatorPublication.js';
if (!process.argv.includes('--live')) throw new Error('Requires --live');
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
if (!output) throw new Error('Requires --output=path');
const base = 'c9c0306d16216c5420790fff4f6d2ac6f2354b05';
const baseline = JSON.parse(readFileSync(new URL('../fixtures/judgments/baseline.json', import.meta.url)));
const sources = { ...baseline.sources };
for (const [id, path, startLine, endLine] of [
  ['okie-store', 'apps/server/src/operatorStore.ts', 74, 74],
  ['okie-runner', 'apps/server/src/operatorRunner.ts', 119, 123],
  ['okie-mesh', 'crates/atlas-gpu/src/mesh.rs', 782, 791],
  ['okie-test', 'apps/server/src/operatorJudgments.test.ts', 50, 55],
  ['okie-generated', 'packages/scene-compiler/src/golden-source-excerpts.ts', 1, 12],
]) {
  const file = execFileSync('git', ['show', `${base}:${path}`], { encoding: 'utf8', maxBuffer: 4e6 });
  sources[id] = { repository: 'thiss/okie', commit: base, path, startLine, endLine, text: file.split('\n').slice(startLine - 1, endLine).join('\n') };
}
// Provisional engineering annotations fixed before first live profile inference.
const cases = [
  { id: 'okie-validation', roles: ['validation'], split: 'development' },
  { id: 'okie-store', roles: ['persistence'], split: 'development' },
  { id: 'okie-runner', roles: ['validation', 'orchestration', 'external'], split: 'development' },
  { id: 'okie-mesh', roles: ['presentation'], split: 'held-out' },
  { id: 'zod-safe', roles: ['validation'], split: 'development' },
  { id: 'zod-wrapper', roles: [], split: 'held-out' },
  { id: 'tokio-send', roles: [], split: 'held-out' },
  { id: 'tokio-blocking', roles: [], split: 'held-out' },
  { id: 'okie-test', roles: ['validation'], split: 'held-out' },
  { id: 'okie-generated', roles: [], split: 'held-out' },
  { id: 'missing', source: 'okie-store', missing: true, roles: [], split: 'held-out' },
];
const tasks = [
  { query: 'Where are invalid evidence references rejected?', role: 'validation', relevant: ['okie-validation'] },
  { query: 'Where does the durable state get saved to disk?', role: 'persistence', relevant: ['okie-store'] },
  { query: 'Where are mesh quads converted into triangles?', role: 'presentation', relevant: ['okie-mesh'] },
  { query: 'Where is public repository validation coordinated with scanning?', role: 'orchestration', relevant: ['okie-runner'] },
];
const report = { kind: 'live-section-profiles', base, labelOrigin: 'Provisional engineering source-inspection labels; not independent human adjudication', capRequests: 100, admissionBudgetUsd: 1, measuredCostUsd: null, sources, rows: [], retrieval: [] };
const root = mkdtempSync(join(tmpdir(), 'okie-profile-eval-'));
try {
  const store = new OperatorStore(root);
  const publication = new OperatorPublicationService(store);
  const provider = createJevProvider();
  if (!provider) throw new Error('JEV_API required');
  for (const row of cases) {
    const source = sources[row.source ?? row.id];
    const scopeId = `component:${row.id}`;
    const excerpt = { path: source.path, startLine: source.startLine, endLine: source.endLine, highlightLine: source.startLine, language: source.path.endsWith('.rs') ? 'rust' : 'typescript', frozenRevision: source.commit, lines: source.text.split('\n'), text: source.text };
    const snapshot = { entities: [{ id: scopeId, name: source.path.split('/').at(-1), kind: 'component', sourceRefs: [{ path: source.path, startLine: source.startLine, endLine: source.endLine, commitSha: source.commit }], sourceExcerpts: row.missing ? [] : [excerpt] }], relations: [] };
    const run = store.createRun({ idempotencyKey: row.id, source: { repositoryId: `repo:${source.repository}`, owner: source.repository.split('/')[0], repo: source.repository.split('/')[1], slug: row.id } }).run;
    const artifact = store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: source.commit, files: { 'snapshot.json': JSON.stringify(snapshot) } });
    const draft = publication.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
    store.updateRun(run.runId, { state: 'awaiting_review' });
    const started = performance.now();
    const outcome = await runSectionProfile({ store, publication, provider, runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeId, limits: { timeoutMs: 30000, maxConcurrent: 1 } });
    const profile = outcome.state === 'accepted' ? outcome.profile : undefined;
    const inferred = profile ? Object.entries(profile.roles).filter(([, value]) => value.status === 'inferred').map(([role]) => role) : [];
    const result = { id: row.id, split: row.split, expectedRoles: row.roles, inferred, state: outcome.state, latencyMs: Math.round(performance.now() - started), requests: store.snapshot().attempts.filter(attempt => attempt.draftRevisionId === draft.draftRevisionId).length, usage: store.snapshot().attempts.filter(attempt => attempt.draftRevisionId === draft.draftRevisionId).at(-1)?.usage, coverage: buildSectionState(snapshot, scopeId, source.commit).coverage, profile };
    report.rows.push(result);
    writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...result, profile: undefined }));
  }
  for (const task of tasks) {
    const words = task.query.toLowerCase().match(/[a-z]{4,}/g);
    const lexical = report.rows.map(row => ({ id: row.id, score: words.filter(word => `${sources[row.id]?.path} ${sources[row.id]?.text}`.toLowerCase().includes(word)).length })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const semantic = report.rows.map(row => ({ id: row.id, score: Object.entries(row.profile?.roles[task.role].answer.probabilities ?? {}).filter(([key]) => key.startsWith('e')).reduce((sum, [, p]) => sum + p, 0) })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    report.retrieval.push({ ...task, lexicalTop3: lexical.slice(0, 3), profileTop3: semantic.slice(0, 3), lexicalRecallAt3: task.relevant.filter(id => lexical.slice(0, 3).some(row => row.id === id)).length / task.relevant.length, profileRecallAt3: task.relevant.filter(id => semantic.slice(0, 3).some(row => row.id === id)).length / task.relevant.length });
  }
  report.metrics = Object.fromEntries(['development', 'held-out'].map(split => {
    const rows = report.rows.filter(row => row.split === split);
    const tp = rows.reduce((n, row) => n + row.inferred.filter(role => row.expectedRoles.includes(role)).length, 0);
    const predicted = rows.reduce((n, row) => n + row.inferred.length, 0);
    const expected = rows.reduce((n, row) => n + row.expectedRoles.length, 0);
    return [split, { truePositiveRoles: tp, inferredRoles: predicted, expectedRoles: expected, precision: predicted ? tp / predicted : null, recall: expected ? tp / expected : null, exactRoleSets: rows.filter(row => [...row.inferred].sort().join() === [...row.expectedRoles].sort().join()).length, sections: rows.length }];
  }));
  console.log(JSON.stringify({ metrics: report.metrics, retrieval: report.retrieval }));
} finally {
  writeFileSync(output, JSON.stringify(report, null, 2));
  rmSync(root, { recursive: true, force: true });
}
