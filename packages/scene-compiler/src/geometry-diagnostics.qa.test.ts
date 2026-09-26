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
 * CLA-140 calibrated regression gate. Diagnostics are report-only: this gate
 * fails when routed geometry drifts so a routing/layout change must regenerate
 * the committed baseline on purpose (`node scripts/measure-geometry-diagnostics.mjs`)
 * and explain the delta. Structural counts are not a substitute for browser QA.
 */
const baseline = JSON.parse(
  readFileSync(new URL('../../../fixtures/architecture/geometry-diagnostics-baseline.json', import.meta.url), 'utf8'),
) as GeometryDiagnosticsBaseline;

const fixture = (id: string) => GEOMETRY_DIAGNOSTIC_FIXTURES.find(value => value.id === id)!;

test('CLA-140: per-fixture, per-band diagnostics match the committed baseline', () => {
  const measured = measureGeometryDiagnosticsBaseline();
  assert.deepEqual(measured.tolerances, baseline.tolerances, 'tolerance defaults changed — regenerate the baseline');
  assert.deepEqual(measured.fixtures.map(value => value.id), baseline.fixtures.map(value => value.id));
  for (const [index, expected] of baseline.fixtures.entries()) {
    assert.deepEqual(measured.fixtures[index], expected, `${expected.id} drifted — regenerate and review the renders`);
  }
});

test('CLA-140: CLA-68 legacy gutter hop is flagged at code entry; the shipped U-loop is clean', () => {
  const [enter, focus] = diagnoseC4Scene(fixture('cla68-before').compile(), ['code']);
  const hop = visibleGeometryProblems(enter!.result);
  assert.deepEqual(hop.map(finding => finding.kind), ['short-route']);
  assert.deepEqual(hop[0]!.canonicalRelationIds, ['relation:dup:alpha-beta']);
  assert.ok(hop[0]!.geometry.screenLength! < 16, `legacy hop is ${hop[0]!.geometry.screenLength}px at code entry`);
  assert.equal(visibleGeometryProblems(focus!.result).length, 0, 'at focus the same hop reaches 16px');
  for (const id of ['cla68-after-tight', 'cla68-after-scan']) {
    for (const run of diagnoseC4Scene(fixture(id).compile(), ['code'])) {
      assert.deepEqual(visibleGeometryProblems(run.result), [], `${id} ${run.level}`);
    }
  }
});

test('CLA-140: diagnostics on real fixtures are shuffle-invariant and grid == all-pairs oracle', () => {
  for (const value of GEOMETRY_DIAGNOSTIC_FIXTURES) {
    const compiled = value.compile();
    for (const band of value.bands) {
      const input = c4BandGeometryInput(compiled, band, c4DiagnosticZoom(band, 'enter'));
      const expected = diagnoseGeometry(input);
      const reversed = diagnoseGeometry({
        ...input,
        nodes: [...input.nodes].reverse(),
        edges: [...input.edges].reverse(),
        labels: [...(input.labels ?? [])].reverse(),
      });
      assert.equal(JSON.stringify(reversed), JSON.stringify(expected), `${value.id} ${band} reversed`);
      assert.deepEqual(diagnoseGeometry(input, { broadPhase: 'all-pairs' }).findings, expected.findings, `${value.id} ${band} oracle`);
    }
  }
});

test('CLA-140: diagnosing is read-only — compiled scene bytes are unchanged', () => {
  const compiled = fixture('golden-okie').compile();
  const before = JSON.stringify(compiled);
  diagnoseC4Scene(compiled);
  assert.equal(JSON.stringify(compiled), before);
  assert.equal(JSON.stringify(fixture('golden-okie').compile()), before);
});
