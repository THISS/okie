// Exercise actual deterministic scan ownership/captured excerpts, not hand-built sections.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { createJevProvider } from '../apps/server/dist/operatorJudgments.js';
import { buildSectionState, runSectionProfile } from '../apps/server/dist/sectionProfiles.js';
import { OperatorStore } from '../apps/server/dist/operatorStore.js';
import { OperatorPublicationService } from '../apps/server/dist/operatorPublication.js';
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const { scanRepository } = require('@okie/scan');
const live = process.argv.includes('--live');
if (!live && !process.argv.includes('--capture')) throw new Error('Requires --capture or --live');
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
if (!output) throw new Error('Requires --output=path');
const base = 'c9c0306d16216c5420790fff4f6d2ac6f2354b05';
const scan = scanRepository(process.cwd(), { revision: base, analysisMode: 'quick' });
const paths = ['apps/server/src/operatorStore.ts', 'apps/server/src/operatorEnrichment.ts', 'apps/server/src/operatorRunner.ts', 'crates/atlas-gpu/src/mesh.rs'];
const sections = scan.snapshot.entities.filter(entity => entity.kind === 'component' && entity.sourceRefs.some(ref => paths.includes(ref.path)));
if (sections.length !== 4) throw new Error('Expected four selected scanner components');
const report = { kind: live ? 'live-actual-scan' : 'capture-only', base, analysis: scan.analysis, capRequests: 4, estimatedAdmissionUsd: 0.012, measuredCostUsd: null, rows: [] };
const root = mkdtempSync(join(tmpdir(), 'okie-scan-profiles-'));
try {
  const store = new OperatorStore(root);
  const publication = new OperatorPublicationService(store);
  const run = store.createRun({ idempotencyKey: 'scan-profiles', source: { repositoryId: 'repo:thiss/okie', owner: 'thiss', repo: 'okie', slug: 'okie' } }).run;
  const artifact = store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: base, files: { 'snapshot.json': JSON.stringify(scan.snapshot) } });
  let draft = publication.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId }).draftRevisionId;
  store.updateRun(run.runId, { state: 'awaiting_review' });
  const provider = live ? createJevProvider() : undefined;
  if (live && !provider) throw new Error('JEV_API required');
  for (const entity of sections) {
    const observed = buildSectionState(scan.snapshot, entity.id, base);
    const start = performance.now();
    const outcome = live ? await runSectionProfile({ store, publication, provider, runId: run.runId, draftRevisionId: draft, scopeId: entity.id, limits: { maxRequests: 4, maxTokens: 400000, maxDollars: 0.012, timeoutMs: 30000, maxConcurrent: 1 } }) : undefined;
    if (outcome?.state === 'accepted') draft = outcome.draftRevisionId;
    const row = { scopeId: entity.id, path: entity.sourceRefs[0]?.path, observed, outcome, latencyMs: Math.round(performance.now() - start) };
    report.rows.push(row);
    writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ scopeId: row.scopeId, state: outcome?.state ?? 'captured', coverage: observed.coverage, inferred: outcome?.profile ? Object.entries(outcome.profile.roles).filter(([, role]) => role.status === 'inferred').map(([role]) => role) : [] }));
  }
  report.attempts = store.snapshot().attempts;
} finally {
  writeFileSync(output, JSON.stringify(report, null, 2));
  rmSync(root, { recursive: true, force: true });
}
