// CLA-149 phase 2: Jev block planner vs the default Overview order on thiss/okie nodes. Finite and opt-in.
//
//   node scripts/evaluate-block-planner.mjs --capture --artifact=<dir holding copies of snapshot.json + operator-explanations.json> [--version=publication-…]
//       Read-only; copy the two files out of another checkout into a scratch dir first.
//       Rebuilds fixtures/judgments/block-planner/nodes.json: the web composer (bundled with esbuild) decides which
//       blocks render; the server derivation supplies size and previews, exactly as POST /api/block-plan does.
//   node scripts/evaluate-block-planner.mjs --live --output=/tmp/block-planner-live.json [--write-replay] [--timeout-ms=30000] [--max-dollars=0.05]
//       One Jev request per node through the real planner service (JEV_API). Ledger capped at $0.10 (or lower).
//   node scripts/evaluate-block-planner.mjs --replay --output=/tmp/block-planner-replay.json
//       Same pipeline offline against fixtures/judgments/block-planner/replay.json.
//
// Requires a built server (`pnpm --filter @okie/server build`).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = name => process.argv.includes(`--${name}`);
const nodesUrl = new URL('../fixtures/judgments/block-planner/nodes.json', import.meta.url);
const replayUrl = new URL('../fixtures/judgments/block-planner/replay.json', import.meta.url);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

if (flag('capture')) await capture();
else await evaluate();

async function capture() {
  const artifact = arg('artifact');
  if (!artifact) throw new Error('--capture requires --artifact=<artifact dir with snapshot.json + operator-explanations.json>');
  const { build } = await import(pathToFileURL(join(repoRoot, 'node_modules/esbuild/lib/main.js')).href);
  const work = mkdtempSync(join(tmpdir(), 'okie-block-planner-capture-'));
  try {
    const entry = join(repoRoot, '.block-planner-capture-entry.ts');
    writeFileSync(entry, "export { composeOverviewBlocks, usesBlockOverview } from './apps/web/src/blocks/composeBlocks';\nexport { DEFAULT_PLAN_BUDGET } from './apps/web/src/blocks/blockPlanner';\nexport { buildContextualOverview } from './apps/web/src/inspector/contextualOverview';\n");
    try { await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: join(work, 'compose.mjs'), loader: { '.css': 'empty' }, logLevel: 'warning' }); }
    finally { rmSync(entry, { force: true }); }
    const web = await import(pathToFileURL(join(work, 'compose.mjs')).href);
    const { buildBlockPlanIndex, blockPlanJob, parseBlockPlanRequest } = await import('../apps/server/dist/blockPlans.js');
    const snapshot = JSON.parse(readFileSync(resolve(artifact, 'snapshot.json'), 'utf8'));
    const sidecar = JSON.parse(readFileSync(resolve(artifact, 'operator-explanations.json'), 'utf8'));
    const explanations = new Map((sidecar.explanations ?? []).map(row => [row.scopeId, row.content ?? row.explanation]));
    const names = new Map(snapshot.entities.map(entity => [entity.id, entity.name]));
    // Server facts (what the route derives); web composer only decides WHICH blocks the client renders.
    const index = buildBlockPlanIndex(snapshot, sidecar);
    const scan = { slug: 'thiss__okie', versionId: arg('version') ?? 'evaluation' };
    const targets = [...index.values()].sort((a, b) => (a.kind === 'softwareSystem' ? -1 : 0) - (b.kind === 'softwareSystem' ? -1 : 0) || a.id.localeCompare(b.id));
    const nodes = targets.map(facts => {
      const overview = web.buildContextualOverview(snapshot, facts.id);
      const composed = web.composeOverviewBlocks({ overview, explanation: explanations.get(facts.id), entityName: id => names.get(id) });
      const request = parseBlockPlanRequest({ scan, nodeId: facts.id, node: { kind: facts.kind }, context: 'overview', budget: { maxBlocks: web.DEFAULT_PLAN_BUDGET.maxBlocks }, candidates: composed.planInput.candidates.map(({ id, type }) => ({ id, type })) });
      if (request.error) throw new Error(`${facts.id}: ${request.error}`);
      const built = blockPlanJob(request.request, facts);
      if (built.error) throw new Error(`${facts.id}: ${built.error}`);
      const { job } = built;
      return { nodeId: job.nodeId, name: job.name, kind: job.kind, size: job.size, maxBlocks: job.budget.maxBlocks, candidates: job.candidates };
    });
    const fixture = { origin: `Captured by scripts/evaluate-block-planner.mjs --capture from a local thiss/okie operator artifact (snapshot commit ${snapshot.commitSha}) with the web composer (which blocks render) and the server's derivation (previews, size). Previews are exactly what the route forwards to Jev.`, scan: { slug: 'thiss__okie', versionId: arg('version') ?? 'evaluation' }, nodes };
    writeFileSync(nodesUrl, JSON.stringify(fixture, null, 2) + '\n');
    console.log(`wrote ${nodes.length} nodes to ${fileURLToPath(nodesUrl)}`);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

async function evaluate() {
  const live = flag('live'); const offline = flag('replay');
  if (live === offline) throw new Error('Pass exactly one of --live, --replay or --capture');
  const output = arg('output');
  if (!output) throw new Error('Requires --output=path');
  const writeReplay = flag('write-replay');
  if (writeReplay && !live) throw new Error('--write-replay records live responses only');
  const timeoutMs = Number(arg('timeout-ms') ?? 30000);
  const { createJevProvider, JEV_MODEL } = await import('../apps/server/dist/operatorJudgments.js');
  const { runBlockPlanEvaluation } = await import('../apps/server/dist/blockPlanEvaluation.js');
  const fixture = JSON.parse(readFileSync(nodesUrl, 'utf8'));
  const raw = {}; const usage = {};
  let provider;
  if (live) {
    if (!process.env.JEV_API) throw new Error('JEV_API required for --live');
    provider = createJevProvider(process.env, async (url, init) => {
      const response = await fetch(url, init);
      try {
        const name = JSON.parse(String(init?.body)).state.node.name;
        const body = await response.clone().json();
        if (body?.answers) raw[name] = body.answers;
        if (body?.usage) usage[name] = body.usage;
      } catch { /* recording is best-effort; the service validates the response itself */ }
      return response;
    });
  } else {
    const replay = JSON.parse(readFileSync(replayUrl, 'utf8'));
    provider = createJevProvider({ JEV_API: 'offline-replay' }, async (_url, init) => {
      const name = JSON.parse(String(init?.body)).state.node.name;
      return Response.json({ model: replay.model, answers: replay.answers[name] ?? {}, usage: replay.usage?.[name] ?? {} });
    });
  }
  const startedAt = new Date().toISOString();
  const maxDollars = Number(arg('max-dollars') ?? 0.1);
  if (!(maxDollars > 0 && maxDollars <= 0.1)) throw new Error('--max-dollars must be in (0, 0.10]');
  const rows = await runBlockPlanEvaluation({ fixture, provider, timeoutMs, maxDollars });
  const totals = rows.reduce((sum, row) => ({ inputTokens: sum.inputTokens + (row.inputTokens ?? 0), estimatedCostUsd: sum.estimatedCostUsd + (row.estimatedCostUsd ?? 0), latencyMs: [...sum.latencyMs, row.latencyMs ?? 0] }), { inputTokens: 0, estimatedCostUsd: 0, latencyMs: [] });
  const sorted = [...totals.latencyMs].sort((a, b) => a - b);
  const report = { kind: live ? 'live-block-planner' : 'replay-block-planner', model: provider.modelId ?? JEV_MODEL, startedAt, origin: fixture.origin, nodes: rows.length, planned: rows.filter(row => row.jevOrder).length, totals: { inputTokens: totals.inputTokens, estimatedCostUsd: Math.round(totals.estimatedCostUsd * 1e6) / 1e6, latencyMs: { p50: sorted[Math.floor(sorted.length / 2)] ?? 0, max: sorted.at(-1) ?? 0 } }, rows };
  writeFileSync(output, JSON.stringify(report, null, 2));
  const short = id => id.replace('enrichment:', 'e:').replace('relations:', 'r:').replace('nodeRefs:', 'n:');
  for (const row of rows) {
    console.log(`\n${row.name} (${row.kind})  latency=${row.latencyMs ?? '-'}ms tokens=${row.inputTokens ?? '-'} cost=$${row.estimatedCostUsd ?? '-'}`);
    console.log(`  default: ${row.defaultOrder.map(short).join(' > ')}`);
    if (row.jevOrder) {
      console.log(`  jev:     ${row.jevOrder.map(short).join(' > ')}`);
      if (row.omitted?.length) console.log(`  omitted: ${row.omitted.map(item => `${short(item.id)} (${item.why})`).join(', ')}`);
      for (const id of row.jevOrder) console.log(`    ${short(id).padEnd(16)} ${row.reasons[id]}`);
    } else console.log(`  unavailable: ${row.unavailable}`);
  }
  console.log(`\n${JSON.stringify({ kind: report.kind, planned: report.planned, nodes: report.nodes, totals: report.totals })}`);
  if (writeReplay) {
    writeFileSync(replayUrl, JSON.stringify({ origin: `LIVE: raw ${report.model} System One answers recorded by scripts/evaluate-block-planner.mjs on ${startedAt}, keyed by node name. Not labels.`, model: report.model, usage, answers: raw }, null, 2) + '\n');
    console.log(`wrote ${Object.keys(raw).length} raw answer sets to ${fileURLToPath(replayUrl)}`);
  }
}
