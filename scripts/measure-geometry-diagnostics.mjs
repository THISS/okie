#!/usr/bin/env node
/**
 * CLA-140: regenerate the geometry-diagnostics baseline, the deterministic SVG
 * renders, and print the runtime/memory benchmark (machine-dependent; recorded
 * in docs/architecture/geometry-diagnostics.md, never gated).
 *
 *   pnpm --filter @okie/scene-compiler build
 *   node --expose-gc scripts/measure-geometry-diagnostics.mjs [--no-bench]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { diagnoseGeometry } from '../packages/architecture/dist/index.js';
import {
  GEOMETRY_DIAGNOSTIC_FIXTURES,
  diagnoseC4Scene,
  measureGeometryDiagnosticsBaseline,
  renderGeometryDiagnosticsSvg,
} from '../packages/scene-compiler/dist/geometry-diagnostics-c4.js';

const resolve = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const baseline = measureGeometryDiagnosticsBaseline();
const baselinePath = resolve('fixtures/architecture/geometry-diagnostics-baseline.json');
await writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(`wrote ${baselinePath}`);
for (const fixture of baseline.fixtures) {
  for (const row of fixture.rows) {
    const counts = Object.entries(row.counts).map(([kind, value]) => `${kind}=${value.visible}/${value.hidden}/${value.exempt}`).join(' ');
    console.log(`${fixture.id} ${row.band} ${row.level} z=${row.zoom} edges=${row.edgeCount} ${counts}`);
  }
}

/** A handful of reproducible renders: fixture id → [band, level]. */
const RENDERS = [
  ['golden-okie', 'container', 'focus'],
  ['golden-okie', 'component', 'focus'],
  ['dense-default-40', 'component', 'focus'],
  ['dense-code-25', 'code', 'enter'],
  ['cla68-before', 'code', 'enter'],
  ['cla68-after-tight', 'code', 'enter'],
  ['cla68-after-scan', 'code', 'enter'],
];
const renderDir = resolve('docs/qa/geometry-diagnostics');
await mkdir(renderDir, { recursive: true });
for (const [id, band, level] of RENDERS) {
  const fixture = GEOMETRY_DIAGNOSTIC_FIXTURES.find(value => value.id === id);
  const run = diagnoseC4Scene(fixture.compile(), [band], [level])[0];
  const file = resolve(`docs/qa/geometry-diagnostics/${id}-${band}-${level}.svg`);
  await writeFile(file, renderGeometryDiagnosticsSvg(run.input, run.result, `${id} · ${band} @ ${level} (zoom ${run.input.zoom})`));
  console.log(`wrote ${file}`);
}

if (process.argv.includes('--no-bench')) process.exit(0);

// ---- benchmark: seeded synthetic layouts (cards in 4 containers, orthogonal routes) ----
function rng(seed) {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function syntheticLayout(seed, edgeCount) {
  const random = rng(seed);
  const side = Math.ceil(Math.sqrt(edgeCount / 2)) + 1;
  const nodes = [];
  for (let group = 0; group < 4; group += 1) {
    const gx = (group % 2) * side * 60;
    const gy = Math.floor(group / 2) * side * 40;
    nodes.push({ id: `box:${group}`, bounds: { x: gx - 10, y: gy - 10, width: side * 30 + 20, height: side * 20 + 20 } });
    for (let index = 0; index < (side * side) / 4; index += 1) {
      nodes.push({
        id: `card:${group}:${index}`,
        parentId: `box:${group}`,
        bounds: { x: gx + (index % side) * 30, y: gy + Math.floor(index / side) * 20, width: 20, height: 10 },
      });
    }
  }
  const cards = nodes.filter(node => node.parentId);
  const edges = [];
  const labels = [];
  for (let index = 0; index < edgeCount; index += 1) {
    // Mostly neighbour dependencies (±3 cards), 5% reach a row away — like packed C4 bands.
    const fromIndex = Math.floor(random() * cards.length);
    const reach = random() < 0.05 ? side : 3;
    const toIndex = Math.min(cards.length - 1, Math.max(0, fromIndex + Math.round((random() - 0.5) * 2 * reach)));
    const from = cards[fromIndex];
    const to = cards[toIndex];
    const start = { x: from.bounds.x + 20, y: from.bounds.y + Math.round(random() * 10) };
    const end = { x: to.bounds.x, y: to.bounds.y + Math.round(random() * 10) };
    const midX = Math.round((start.x + end.x) / 2 + (random() - 0.5) * 20);
    const id = `edge:${String(index).padStart(5, '0')}`;
    edges.push({
      id,
      fromNodeId: from.id,
      toNodeId: to.id,
      points: [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end],
      canonicalRelationIds: [`relation:${index}`],
    });
    if (random() < 0.3) labels.push({ id: `label:${id}`, edgeId: id, bounds: { x: midX - 8, y: (start.y + end.y) / 2 - 3, width: 16, height: 6 } });
  }
  return { band: 'synthetic', zoom: 1, nodes, edges, labels };
}

function measure(input, broadPhase, samples) {
  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  let result;
  let peak = 0;
  const times = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    result = diagnoseGeometry(input, { broadPhase });
    times.push(performance.now() - started);
    peak = Math.max(peak, process.memoryUsage().heapUsed - heapBefore);
    globalThis.gc?.();
  }
  times.sort((left, right) => left - right);
  return { ms: times[Math.floor(times.length / 2)], heapMb: peak / 2 ** 20, result };
}

console.log('\n| layout | edges | segments | grid ms | grid heap MB | examined pairs | candidate pairs | naive pairs | all-pairs ms | same findings |');
console.log('|---|---:|---:|---:|---:|---:|---:|---:|---:|:---:|');
for (const [name, edgeCount, outlier] of [['local', 50], ['local', 500], ['local', 5000], ['local + outlier@1e6', 5000, true]]) {
  const base = syntheticLayout(140, edgeCount);
  const input = outlier ? { ...base, nodes: [...base.nodes, { id: 'zz:far', bounds: { x: 1e6, y: 1e6, width: 20, height: 10 } }] } : base;
  diagnoseGeometry(input);
  const grid = measure(input, 'grid', edgeCount >= 5000 ? 3 : 7);
  const brute = measure(input, 'all-pairs', edgeCount >= 5000 ? 1 : 3);
  const equal = JSON.stringify(grid.result.findings) === JSON.stringify(brute.result.findings);
  const { segmentCount, broadPhase } = grid.result.summary;
  console.log(`| ${name} | ${edgeCount} | ${segmentCount} | ${grid.ms.toFixed(1)} | ${grid.heapMb.toFixed(1)} | ${broadPhase.examinedPairs} | ${broadPhase.candidatePairs} | ${broadPhase.naivePairs} | ${brute.ms.toFixed(1)} | ${equal ? 'yes' : 'NO'} |`);
}
