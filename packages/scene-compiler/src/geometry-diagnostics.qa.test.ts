import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { diagnoseGeometry, visibleGeometryProblems } from '@okie/architecture';
import {
  GEOMETRY_DIAGNOSTIC_FIXTURES,
  c4BandGeometryInput,
  c4DiagnosticZoom,
  diagnoseC4Scene,
  measureGeometryDiagnosticsBaseline,
  type GeometryDiagnosticsBaseline,
} from './geometry-diagnostics-c4.js';

/**
 * CLA-140 calibrated regression gate. Diagnostics are report-only. The gate
 * compares, per fixture × band × zoom level: finding counts (visible/hidden/
 * exempt per kind), the visible-problem list, and a fingerprint of the judged
 * geometry (node rects, route points, label rects). Any routing/layout drift
 * therefore fails until the baseline is regenerated on purpose
 * (`node scripts/measure-geometry-diagnostics.mjs`) and the delta explained.
 * Structural checks are not a substitute for browser QA.
 */
const baseline = JSON.parse(
  readFileSync(new URL('../../../fixtures/architecture/geometry-diagnostics-baseline.json', import.meta.url), 'utf8'),
) as GeometryDiagnosticsBaseline;

const fixture = (id: string) => GEOMETRY_DIAGNOSTIC_FIXTURES.find(value => value.id === id)!;

function shuffled<T>(values: readonly T[], seed: number): T[] {
  let state = (seed * 2654435761) >>> 0 || 1;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

test('CLA-140: per-fixture, per-band diagnostics and geometry fingerprints match the committed baseline', () => {
  const measured = measureGeometryDiagnosticsBaseline();
  assert.deepEqual(measured.tolerances, baseline.tolerances, 'tolerance defaults changed — regenerate the baseline');
  assert.deepEqual(measured.fixtures.map(value => value.id), baseline.fixtures.map(value => value.id));
  for (const [index, expected] of baseline.fixtures.entries()) {
    assert.deepEqual(measured.fixtures[index], expected, `${expected.id} drifted — regenerate and review the renders`);
  }
});

test('CLA-140: CLA-68 evidence — legacy hop and tight U flagged at code entry; scan U is clean', () => {
  const problems = (id: string) => diagnoseC4Scene(fixture(id).compile(), ['code'])
    .map(run => visibleGeometryProblems(run.result).map(finding => `${finding.kind} ${finding.geometry.screenLength}`));
  // [enter, focus]
  assert.deepEqual(problems('cla68-before'), [['short-route 8.138'], []], 'the facing hop is 8px at entry, 16px at focus');
  assert.deepEqual(problems('cla68-after-tight'), [['short-leg 4.069', 'short-leg 4.069'], []],
    'the tight U legs are ~4px at entry, under the 6px corner radius (known-degraded)');
  assert.deepEqual(problems('cla68-after-scan'), [[], []]);
});

test('CLA-140: diagnostics on real fixtures are shuffle-invariant and grid == all-pairs oracle', () => {
  for (const value of GEOMETRY_DIAGNOSTIC_FIXTURES) {
    const compiled = value.compile();
    for (const [bandIndex, band] of value.bands.entries()) {
      const input = c4BandGeometryInput(compiled, band, c4DiagnosticZoom(band, 'enter'));
      const expected = diagnoseGeometry(input);
      for (const seed of [1, 2]) {
        const salt = seed * 97 + bandIndex;
        const reordered = diagnoseGeometry({
          ...input,
          nodes: shuffled(input.nodes, salt),
          edges: shuffled(input.edges, salt + 1),
          labels: shuffled(input.labels ?? [], salt + 2),
        });
        assert.equal(JSON.stringify(reordered), JSON.stringify(expected), `${value.id} ${band} seed ${seed}`);
      }
      assert.deepEqual(diagnoseGeometry(input, { broadPhase: 'all-pairs' }).findings, expected.findings, `${value.id} ${band} oracle`);
    }
  }
});

test('CLA-140: diagnosing is read-only — compiled scene bytes are unchanged', () => {
  const compiled = fixture('golden-okie').compile();
  const before = JSON.stringify(compiled);
  diagnoseC4Scene(compiled);
  assert.equal(JSON.stringify(compiled), before);
});
