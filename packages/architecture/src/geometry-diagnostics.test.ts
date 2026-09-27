import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GEOMETRY_DIAGNOSTIC_KINDS,
  GEOMETRY_DIAGNOSTIC_TOLERANCES,
  diagnoseGeometry,
  visibleGeometryProblems,
  type GeometryDiagnosticEdge,
  type GeometryDiagnosticLabel,
  type GeometryDiagnosticNode,
  type GeometryDiagnosticsInput,
  type GeometryFinding,
} from './geometry-diagnostics.js';

const node = (id: string, x: number, y: number, width = 20, height = 10, parentId?: string): GeometryDiagnosticNode => ({
  id, bounds: { x, y, width, height }, ...(parentId ? { parentId } : {}),
});
const edge = (id: string, from: string, to: string, points: [number, number][], extra: Partial<GeometryDiagnosticEdge> = {}): GeometryDiagnosticEdge => ({
  id, fromNodeId: from, toNodeId: to, points: points.map(([x, y]) => ({ x, y })), canonicalRelationIds: [`relation:${id}`], ...extra,
});
const of = (findings: GeometryFinding[], kind: GeometryFinding['kind']) => findings.filter(finding => finding.kind === kind);

/** Four far-apart unrelated terminals so crossings are not near any shared node. */
const terminals = [node('n:w', -200, 0), node('n:e', 200, 0), node('n:n', 0, -200), node('n:s', 0, 200), node('n:x', 400, 400)];

test('CLA-140: a proper interior crossing is reported; a T-junction is not', () => {
  const crossing = diagnoseGeometry({
    zoom: 1,
    nodes: terminals,
    edges: [
      edge('e:h', 'n:w', 'n:e', [[-180, 5], [200, 5]]),
      edge('e:v', 'n:n', 'n:s', [[10, -190], [10, 200]]),
    ],
  });
  const found = of(crossing.findings, 'edge-crossing');
  assert.equal(found.length, 1);
  assert.deepEqual(found[0]!.edgeIds, ['e:h', 'e:v']);
  assert.deepEqual(found[0]!.canonicalRelationIds, ['relation:e:h', 'relation:e:v']);
  assert.deepEqual(found[0]!.geometry.points, [{ x: 10, y: 5 }]);
  assert.equal(found[0]!.visibility, 'visible');

  const tee = diagnoseGeometry({
    zoom: 1,
    nodes: terminals,
    edges: [
      edge('e:h', 'n:w', 'n:e', [[-180, 5], [200, 5]]),
      edge('e:v', 'n:n', 'n:x', [[10, -190], [10, 5]]),
    ],
  });
  assert.equal(of(tee.findings, 'edge-crossing').length, 0, 'an endpoint touching another route is a junction, not a crossing');
});

test('CLA-140: crossings near a shared endpoint node are exempt; far ones still count', () => {
  const nodes = [node('n:hub', 0, 0), node('n:a', 300, -100), node('n:b', 300, 100)];
  const near = diagnoseGeometry({
    zoom: 1,
    nodes,
    edges: [
      edge('e:1', 'n:hub', 'n:a', [[20, 2], [30, 2], [30, -100], [300, -100]]),
      edge('e:2', 'n:hub', 'n:b', [[10, 10], [10, -5], [60, -5], [60, 100], [300, 100]]),
    ],
  });
  const crossing = of(near.findings, 'edge-crossing');
  assert.equal(crossing.length, 1);
  assert.equal(crossing[0]!.exemption, 'shared-endpoint');
  assert.equal(visibleGeometryProblems(near).filter(finding => finding.kind === 'edge-crossing').length, 0);

  const far = diagnoseGeometry({
    zoom: 1,
    nodes,
    edges: [
      edge('e:1', 'n:hub', 'n:a', [[20, 5], [150, 5], [150, -100], [300, -100]]),
      edge('e:2', 'n:hub', 'n:b', [[20, 8], [100, 8], [100, -50], [200, -50], [200, 100], [300, 100]]),
    ],
  });
  const farCrossing = of(far.findings, 'edge-crossing');
  assert.deepEqual(farCrossing.map(finding => finding.geometry.points), [[{ x: 100, y: 5 }], [{ x: 150, y: -50 }]]);
  assert.ok(farCrossing.every(finding => finding.exemption === undefined));
});

test('CLA-140: a shared vertex with opposite outgoing legs is still a crossing (parallel segments)', () => {
  const nodes = [node('a1', -300, -5, 10, 10), node('a2', -5, -300, 10, 10), node('b1', -300, -300, 10, 10), node('b2', -5, 300, 10, 10)];
  const run = (b: [number, number][]) => of(diagnoseGeometry({ zoom: 1, nodes, edges: [
    edge('A', 'a1', 'a2', [[-290, 0], [0, 0], [0, -290]]),
    edge('B', 'b1', 'b2', b),
  ] }).findings, 'edge-crossing').map(finding => finding.geometry.points);
  assert.deepEqual(run([[-290, -290], [0, 0], [0, 290]]), [[{ x: 0, y: 0 }]], 'B enters inside A\'s corner and leaves opposite A\'s out-leg');
  assert.deepEqual(run([[290, 0], [0, 0], [0, 290]]), [], 'back-to-back Ls only touch');
});

test('CLA-140: a label at a huge coordinate terminates and matches the oracle', () => {
  const result = diagnoseGeometry({
    zoom: 1,
    nodes: [node('a', 0, 0), node('b', 100, 0)],
    edges: [edge('e', 'a', 'b', [[20, 5], [100, 5]])],
    labels: [{ id: 'l', edgeId: 'e', bounds: { x: 1e18, y: 0, width: 10, height: 4 } }],
  });
  assert.deepEqual(result.findings, diagnoseGeometry({
    zoom: 1,
    nodes: [node('a', 0, 0), node('b', 100, 0)],
    edges: [edge('e', 'a', 'b', [[20, 5], [100, 5]])],
    labels: [{ id: 'l', edgeId: 'e', bounds: { x: 1e18, y: 0, width: 10, height: 4 } }],
  }, { broadPhase: 'all-pairs' }).findings);
});

test('CLA-140: shared-endpoint exemption is measured from the ports, not the (container) node rect', () => {
  const nodes = [node('sys', 0, 0, 1000, 1000), node('a', 100, 100, 20, 10, 'sys'), node('b', 800, 800, 20, 10, 'sys'), node('c', 100, 800, 20, 10, 'sys')];
  const result = diagnoseGeometry({ zoom: 1, nodes, edges: [
    edge('e1', 'sys', 'b', [[500, 0], [500, 800]]),
    edge('e2', 'sys', 'c', [[0, 500], [110, 500], [800, 500], [800, 800]]),
  ] });
  const crossing = of(result.findings, 'edge-crossing');
  assert.equal(crossing.length, 1);
  assert.equal(crossing[0]!.exemption, undefined, 'a crossing 500px from both ports is not near the shared endpoint');
});

test('CLA-140: collinear overlap is a shared corridor; separation is judged in screen px', () => {
  const lanes = (gap: number): GeometryDiagnosticsInput => ({
    zoom: 1,
    nodes: terminals,
    edges: [
      edge('e:a', 'n:w', 'n:e', [[-180, 0], [0, 0], [0, 100], [150, 100]]),
      edge('e:b', 'n:n', 'n:s', [[50, -190], [50, 100 + gap], [120, 100 + gap], [120, 200]]),
    ],
  });
  const overlap = of(diagnoseGeometry(lanes(0)).findings, 'shared-corridor');
  assert.equal(overlap.length, 1);
  assert.equal(overlap[0]!.geometry.screenLength, 70);
  assert.equal(overlap[0]!.geometry.screenDistance, 0);
  assert.equal(of(diagnoseGeometry(lanes(1)).findings, 'shared-corridor').length, 1, '1px lanes read as one stroke');
  assert.equal(of(diagnoseGeometry(lanes(12)).findings, 'shared-corridor').length, 0, '12px lanes are distinct');
  assert.equal(
    of(diagnoseGeometry({ ...lanes(12), zoom: 0.1 }).findings, 'shared-corridor').length,
    1,
    'the same 12-unit lanes merge at 0.1x (1.2px)',
  );
  const tiny = of(diagnoseGeometry({ ...lanes(0), zoom: 0.02 }).findings, 'shared-corridor')
    .find(finding => finding.geometry.screenDistance === 0);
  assert.equal(tiny?.visibility, 'hidden', '70 world units at 0.02x is 1.4px — below the hidden threshold');
});

test('CLA-140: intentional bundles are exempt from corridor, crossing and crowding', () => {
  const result = diagnoseGeometry({
    zoom: 1,
    nodes: [node('n:a', 0, 0), node('n:b', 200, 0)],
    edges: [
      edge('e:1', 'n:a', 'n:b', [[20, 5], [200, 5]], { bundleKey: 'pair' }),
      edge('e:2', 'n:a', 'n:b', [[20, 6], [200, 6]], { bundleKey: 'pair' }),
    ],
  });
  assert.ok(result.findings.length > 0);
  assert.ok(result.findings.every(finding => finding.exemption === 'bundle'));
  assert.equal(result.summary.exemptions.bundle, result.findings.length);
  assert.equal(visibleGeometryProblems(result).length, 0);
});

test('CLA-140: labels must clear other routes and nodes; containers of both endpoints are exempt', () => {
  const nodes = [
    node('n:box', -50, -50, 500, 300),
    node('n:a', 0, 0, 20, 10, 'n:box'),
    node('n:b', 300, 0, 20, 10, 'n:box'),
    node('n:c', 150, 100, 40, 20, 'n:box'),
    node('n:far', 800, 0),
  ];
  const labels: GeometryDiagnosticLabel[] = [
    { id: 'label:ab', edgeId: 'e:ab', bounds: { x: 100, y: -8, width: 40, height: 6 } },
    { id: 'label:cfar', edgeId: 'e:cfar', bounds: { x: 145, y: 90, width: 30, height: 8 } },
  ];
  const result = diagnoseGeometry({
    zoom: 1,
    nodes,
    labels,
    edges: [
      edge('e:ab', 'n:a', 'n:b', [[20, 5], [300, 5]]),
      edge('e:other', 'n:c', 'n:far', [[150, 110], [120, 110], [120, -20], [800, -20]]),
      edge('e:cfar', 'n:c', 'n:far', [[190, 110], [800, 110], [800, 10]]),
    ],
  });
  const clearance = of(result.findings, 'label-clearance');
  const route = clearance.find(finding => finding.labelIds[0] === 'label:ab' && finding.nodeIds.length === 0);
  assert.ok(route, 'label:ab sits on e:other');
  assert.deepEqual(route!.edgeIds, ['e:ab', 'e:other']);
  const box = (labelId: string) => clearance.find(finding => finding.labelIds[0] === labelId && finding.nodeIds[0] === 'n:box');
  assert.equal(box('label:ab')?.exemption, 'containment', 'n:box contains both endpoints of e:ab');
  assert.ok(box('label:cfar') && !box('label:cfar')!.exemption, 'n:box holds only one endpoint of e:cfar, so it is an obstacle');
  const card = clearance.find(finding => finding.labelIds[0] === 'label:cfar' && finding.nodeIds[0] === 'n:c');
  assert.ok(card && !card.exemption, 'labels overlapping their own endpoint card are reported');
  assert.ok(!clearance.some(finding => finding.labelIds[0] === 'label:ab' && finding.edgeIds.length === 1 && finding.nodeIds.length === 0));
});

test('CLA-140: long runs along a container border are flagged; own endpoint and exit stubs are exempt', () => {
  const nodes = [
    node('n:box', 0, 0, 400, 200),
    node('n:a', 20, 50, 80, 20, 'n:box'),
    node('n:b', 340, 50, 40, 20, 'n:box'),
    node('n:out', 600, 3),
  ];
  const result = diagnoseGeometry({
    zoom: 1,
    nodes,
    edges: [
      edge('e:hug', 'n:a', 'n:b', [[40, 50], [40, 2], [360, 2], [360, 50]]),
      edge('e:exit', 'n:box', 'n:out', [[400, 3], [600, 3]]),
      edge('e:own', 'n:a', 'n:out', [[20, 70], [100, 70], [100, 120], [600, 120], [600, 13]]),
    ],
  });
  const runs = of(result.findings, 'container-border-run');
  const hug = runs.find(finding => finding.edgeIds[0] === 'e:hug' && finding.nodeIds[0] === 'n:box');
  assert.ok(hug && !hug.exemption && hug.visibility === 'visible');
  assert.equal(hug!.geometry.screenDistance, 2);
  assert.equal(hug!.geometry.screenLength, 320);
  const own = runs.find(finding => finding.edgeIds[0] === 'e:own' && finding.nodeIds[0] === 'n:a');
  assert.equal(own?.exemption, 'own-endpoint');
  assert.ok(!runs.some(finding => finding.edgeIds[0] === 'e:hug' && finding.nodeIds[0] !== 'n:box'));
  assert.equal(
    diagnoseGeometry({ zoom: 0.1, nodes, edges: [edge('e:hug', 'n:a', 'n:b', [[40, 50], [40, 2], [360, 2], [360, 50]])] })
      .findings.filter(finding => finding.kind === 'container-border-run').length,
    0,
    'at 0.1x the run is 32px — shorter than the minimum run',
  );
});

test('CLA-140: containment exempts only the terminal stub within its own card; own-endpoint only terminal legs', () => {
  const stub = diagnoseGeometry({
    zoom: 1,
    nodes: [node('n:box', 0, 0, 400, 200), node('n:a', 0, 0, 100, 20, 'n:box'), node('n:out', 600, 300)],
    edges: [edge('e:stub', 'n:a', 'n:out', [[10, 1], [380, 1], [380, 300], [600, 300]])],
  });
  const runs = of(stub.findings, 'container-border-run').filter(finding => finding.nodeIds[0] === 'n:box')
    .map(finding => [finding.exemption ?? '-', finding.geometry.screenLength]);
  assert.deepEqual(runs, [['containment', 90], ['-', 280]], 'the 280px beyond the card still hugs the owner');
  const beyond = diagnoseGeometry({
    zoom: 1,
    nodes: [node('n:box', 0, 0, 400, 200), node('n:a', 0, 0, 40, 20, 'n:box'), node('n:out', 600, 300)],
    edges: [edge('e:stub', 'n:a', 'n:out', [[40, 1], [380, 1], [380, 300], [600, 300]])],
  });
  assert.deepEqual(of(beyond.findings, 'container-border-run').map(finding => finding.exemption ?? '-'), ['-']);
  const wrap = diagnoseGeometry({
    zoom: 1,
    nodes: [node('n:a', 0, 0, 300, 40), node('n:out', 600, 300)],
    edges: [edge('e:wrap', 'n:a', 'n:out', [[300, 20], [310, 20], [310, 42], [-10, 42], [-10, 300], [600, 300]])],
  });
  assert.deepEqual(of(wrap.findings, 'container-border-run').map(finding => finding.exemption ?? '-'), ['-'],
    'a middle leg wrapping its own card is reported');
});

test('CLA-140: redundant collinear vertices are merged, so crossings and runs are not split', () => {
  const crossing = (h: [number, number][], v: [number, number][]) => of(diagnoseGeometry({
    zoom: 1, nodes: terminals, edges: [edge('h', 'n:w', 'n:e', h), edge('v', 'n:n', 'n:s', v)],
  }).findings, 'edge-crossing').length;
  assert.equal(crossing([[-180, 5], [10, 5], [200, 5]], [[10, -190], [10, 200]]), 1);
  assert.equal(crossing([[-180, 5], [10, 5], [200, 5]], [[10, -190], [10, 5], [10, 200]]), 1);
  const nodes = [node('box', 0, 0, 400, 200), node('a', 20, 50, 80, 20, 'box'), node('b', 340, 50, 40, 20, 'box')];
  const split = diagnoseGeometry({ zoom: 1, nodes, edges: [edge('hug', 'a', 'b',
    [[40, 50], [40, 2], ...[80, 120, 160, 200, 240, 280, 320].map(x => [x, 2] as [number, number]), [360, 2], [360, 50]])] });
  assert.deepEqual(of(split.findings, 'container-border-run').map(finding => finding.geometry.screenLength), [320]);
});

test('CLA-140: a route bending exactly on another counts as crossing only when it passes through', () => {
  const run = (d: [number, number][]) => of(diagnoseGeometry({
    zoom: 1, nodes: terminals, edges: [edge('h', 'n:w', 'n:e', [[-180, 5], [200, 5]]), edge('d', 'n:n', 'n:s', d)],
  }).findings, 'edge-crossing');
  assert.deepEqual(run([[0, -190], [10, 5], [0, 200]]).map(finding => finding.geometry.points), [[{ x: 10, y: 5 }]]);
  assert.equal(run([[0, -190], [10, 5], [30, -190]]).length, 0, 'touching and bouncing back is not a crossing');
  assert.equal(run([[0, -190], [0, 5], [60, 5], [60, 200]]).length, 0, 'joining and leaving on the other side is a merge (corridor)');
});

test('CLA-140: crowded endpoints on one side are reported unless bundled', () => {
  const nodes = [node('n:hub', 0, 0, 100, 40), node('n:a', 0, 200), node('n:b', 80, 200), node('n:c', 200, 200)];
  const result = diagnoseGeometry({
    zoom: 1,
    nodes,
    edges: [
      edge('e:a', 'n:a', 'n:hub', [[10, 200], [10, 100], [48, 100], [48, 40]]),
      edge('e:b', 'n:b', 'n:hub', [[90, 200], [90, 100], [52, 100], [52, 40]]),
      edge('e:c', 'n:c', 'n:hub', [[210, 200], [210, 150], [90, 150], [90, 40]]),
    ],
  });
  const crowding = of(result.findings, 'endpoint-crowding');
  assert.equal(crowding.length, 1);
  assert.deepEqual(crowding[0]!.edgeIds, ['e:a', 'e:b']);
  assert.deepEqual(crowding[0]!.nodeIds, ['n:hub']);
  assert.equal(crowding[0]!.geometry.screenDistance, 4);
  const merged = diagnoseGeometry({ zoom: 1, nodes, edges: [
    edge('e:a', 'n:a', 'n:hub', [[10, 200], [10, 100], [48, 100], [48, 40]]),
    edge('e:d', 'n:c', 'n:hub', [[210, 200], [210, 120], [48, 120], [48, 40]]),
  ] });
  assert.equal(of(merged.findings, 'endpoint-crowding')[0]?.exemption, 'shared-port', 'coincident ports are one shared port');
  const corner = diagnoseGeometry({ zoom: 1, nodes: [node('hub', 0, 0, 100, 40), node('a', -200, -200), node('b', -200, 200)], edges: [
    edge('ea', 'a', 'hub', [[-180, -195], [1, -195], [1, 0]]),
    edge('eb', 'b', 'hub', [[-180, 205], [-100, 205], [-100, 1], [0, 1]]),
  ] });
  const across = of(corner.findings, 'endpoint-crowding');
  assert.deepEqual(across.map(finding => [finding.visibility, finding.geometry.screenDistance]), [['hidden', 1.414]],
    'ports on adjacent sides 1.4px apart across a corner are compared (sub-2px → hidden)');
  const zoomed = diagnoseGeometry({ zoom: 3, nodes, edges: [
    edge('e:a', 'n:a', 'n:hub', [[10, 200], [10, 100], [48, 100], [48, 40]]),
    edge('e:b', 'n:b', 'n:hub', [[90, 200], [90, 100], [52, 100], [52, 40]]),
  ] });
  assert.equal(of(zoomed.findings, 'endpoint-crowding').length, 0, '4 units at 3x = 12px is enough spacing');
});

test('CLA-140: degenerate zero-length steps are tolerated and tiny routes are short/hidden', () => {
  const result = diagnoseGeometry({
    zoom: 1,
    nodes: [node('n:a', 0, 0), node('n:b', 21, 0), node('n:c', 100, 0)],
    edges: [
      edge('e:dot', 'n:a', 'n:b', [[20, 5], [20, 5], [20, 5]]),
      edge('e:hop', 'n:a', 'n:b', [[20, 5], [20, 5], [21, 5]]),
      edge('e:long', 'n:b', 'n:c', [[41, 5], [100, 5]]),
    ],
  });
  const short = of(result.findings, 'short-route');
  assert.deepEqual(short.map(finding => [finding.edgeIds[0], finding.visibility]), [['e:dot', 'hidden'], ['e:hop', 'hidden']]);
  assert.equal(result.summary.segmentCount, 2);
  assert.equal(of(diagnoseGeometry({ zoom: 10, nodes: [node('n:a', 0, 0), node('n:b', 21, 0)], edges: [edge('e:hop', 'n:a', 'n:b', [[20, 5], [21, 5]])] }).findings, 'short-route')[0]!.visibility, 'visible');
});

test('CLA-140: huge coordinates give the same counts as the translated layout', () => {
  const base = randomLayout(7, 40);
  const shifted = translate(base, 1e7, -1e7);
  const expected = diagnoseGeometry(base).summary;
  assert.ok(expected.totals.visible > 0 && expected.totals.exempt > 0, 'layout must exercise findings');
  assert.deepEqual(diagnoseGeometry(shifted).summary.counts, expected.counts);
});

test('CLA-140: legs shorter than the corner radius are short-leg findings (CLA-68 tight U)', () => {
  const u = (zoom: number) => of(diagnoseGeometry({
    zoom,
    nodes: [node('n:a', 0, 0, 16, 8), node('n:b', 17.146, 0, 16, 8)],
    edges: [edge('e:u', 'n:a', 'n:b', [[8, 8], [8, 8.573], [25.146, 8.573], [25.146, 8]])],
  }).findings, 'short-leg').map(finding => finding.geometry.screenLength);
  assert.deepEqual(u(7.1), [4.068, 4.068], 'both U legs are ~4px at code entry');
  assert.deepEqual(u(13.96), [], 'and 8px at focus');
});

test('CLA-140: input validation rejects duplicate ids and non-positive zoom', () => {
  assert.throws(() => diagnoseGeometry({ zoom: 1, nodes: [node('n', Number.NaN, 0)], edges: [] }), /non-finite/);
  assert.throws(() => diagnoseGeometry({ zoom: 1, nodes: [], edges: [edge('e', 'a', 'b', [[0, 0], [Infinity, 0]])] }), /non-finite/);
  assert.throws(() => diagnoseGeometry({ zoom: 1, nodes: [], edges: [], tolerances: { hiddenLengthPx: Number.NaN } }), /invalid tolerance/);
  assert.deepEqual(
    diagnoseGeometry({ ...randomLayout(3, 20), tolerances: { hiddenLengthPx: undefined } }),
    diagnoseGeometry(randomLayout(3, 20)),
    'undefined overrides keep the defaults',
  );
  assert.throws(() => diagnoseGeometry({ zoom: 1, nodes: [node('n', 0, 0), node('n', 1, 1)], edges: [] }), /duplicate node id/);
  assert.throws(() => diagnoseGeometry({ zoom: 0, nodes: [], edges: [] }), /positive finite zoom/);
  assert.deepEqual(diagnoseGeometry({ zoom: 1, nodes: [], edges: [] }).findings, []);
});

test('CLA-140: output is identical under input shuffling', () => {
  for (const seed of [1, 2, 3]) {
    const layout = randomLayout(seed, 60);
    const expected = JSON.stringify(diagnoseGeometry(layout));
    for (let round = 0; round < 3; round += 1) {
      const random = rng(seed * 100 + round);
      const shuffled = {
        ...layout,
        nodes: shuffle(layout.nodes, random),
        edges: shuffle(layout.edges, random),
        labels: shuffle(layout.labels ?? [], random),
      };
      assert.equal(JSON.stringify(diagnoseGeometry(shuffled)), expected, `seed ${seed} round ${round}`);
    }
  }
});

test('CLA-140: grid broad phase matches the all-pairs oracle and prunes candidates', () => {
  const exercised = new Set<string>();
  for (const seed of [11, 12, 13, 14, 15]) {
    for (const zoom of [0.3, 1, 4]) {
      const layout = { ...randomLayout(seed, 80), zoom };
      const grid = diagnoseGeometry(layout);
      const oracle = diagnoseGeometry(layout, { broadPhase: 'all-pairs' });
      assert.deepEqual(grid.findings, oracle.findings, `seed ${seed} zoom ${zoom}`);
      assert.deepEqual(grid.summary.counts, oracle.summary.counts);
      assert.equal(grid.summary.broadPhase.candidatePairs, oracle.summary.broadPhase.candidatePairs, 'each pair emitted exactly once');
      for (const finding of grid.findings) exercised.add(finding.kind);
    }
  }
  assert.deepEqual([...exercised].sort(), [...GEOMETRY_DIAGNOSTIC_KINDS].sort(), 'oracle cases exercise every kind');
  const layout = randomLayout(99, 600);
  const big = { ...layout, nodes: [...layout.nodes, node('zz:world', -5000, -5000, 40000, 30000), node('zz:wide', -50, -50, 30000, 12)] };
  const bigGrid = diagnoseGeometry(big);
  assert.ok(bigGrid.summary.broadPhase.largeItems > 0, 'the owner boxes take the large-item path');
  const bigOracle = diagnoseGeometry(big, { broadPhase: 'all-pairs' });
  assert.deepEqual(bigGrid.findings, bigOracle.findings);
  assert.equal(bigGrid.summary.broadPhase.candidatePairs, bigOracle.summary.broadPhase.candidatePairs, 'large×large pairs are not duplicated');
  const { examinedPairs, naivePairs, candidatePairs } = bigGrid.summary.broadPhase;
  assert.ok(examinedPairs * 4 < naivePairs, `grid examined ${examinedPairs} vs naive ${naivePairs} (random long routes: adversarial)`);
  assert.ok(candidatePairs * 10 < naivePairs, `candidates ${candidatePairs} vs naive ${naivePairs}`);
});

test('CLA-140: one far outlier node does not collapse the grid to all-pairs', () => {
  for (const edgeCount of [400, 1600]) {
    const base = randomLayout(21, edgeCount);
    const withOutlier = { ...base, nodes: [...base.nodes, node('zz:far', 1e6, 1e6)] };
    const plain = diagnoseGeometry(base).summary.broadPhase;
    const far = diagnoseGeometry(withOutlier);
    assert.ok(
      far.summary.broadPhase.examinedPairs <= plain.examinedPairs * 1.1 + 10,
      `${edgeCount} edges: outlier examined ${far.summary.broadPhase.examinedPairs} vs ${plain.examinedPairs}`,
    );
    assert.equal(far.summary.broadPhase.largeItems, plain.largeItems, 'the outlier does not turn items into large items');
    if (edgeCount === 400) {
      const oracle = diagnoseGeometry(withOutlier, { broadPhase: 'all-pairs' });
      assert.deepEqual(far.findings, oracle.findings);
      assert.equal(far.summary.broadPhase.candidatePairs, oracle.summary.broadPhase.candidatePairs);
    }
  }
});

test('CLA-140: default tolerances are frozen screen-pixel values', () => {
  assert.ok(Object.isFrozen(GEOMETRY_DIAGNOSTIC_TOLERANCES));
  assert.equal(GEOMETRY_DIAGNOSTIC_TOLERANCES.minRouteLengthPx, 16);
  assert.equal(GEOMETRY_DIAGNOSTIC_TOLERANCES.minLegLengthPx, 6);
});

// ---- seeded synthetic layouts ---------------------------------------------

function rng(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

/** Containers holding cards, orthogonal (and some diagonal) routes, labels on midpoints. */
function randomLayout(seed: number, edgeCount: number): GeometryDiagnosticsInput {
  const random = rng(seed);
  const nodes: GeometryDiagnosticNode[] = [];
  const side = Math.ceil(Math.sqrt(edgeCount / 2)) + 1;
  for (let group = 0; group < 4; group += 1) {
    const gx = (group % 2) * side * 60;
    const gy = Math.floor(group / 2) * side * 40;
    nodes.push(node(`box:${group}`, gx - 10, gy - 10, side * 30 + 20, side * 20 + 20));
    for (let index = 0; index < (side * side) / 4; index += 1) {
      nodes.push(node(`card:${group}:${index}`, gx + (index % side) * 30, gy + Math.floor(index / side) * 20, 20, 10, `box:${group}`));
    }
  }
  const cards = nodes.filter(value => value.parentId);
  const edges: GeometryDiagnosticEdge[] = [];
  const labels: GeometryDiagnosticLabel[] = [];
  for (let index = 0; index < edgeCount; index += 1) {
    const from = cards[Math.floor(random() * cards.length)]!;
    const to = cards[Math.floor(random() * cards.length)]!;
    const start = { x: from.bounds.x + from.bounds.width, y: from.bounds.y + Math.round(random() * 10) };
    const end = { x: to.bounds.x, y: to.bounds.y + Math.round(random() * 10) };
    const midX = Math.round((start.x + end.x) / 2 + (random() - 0.5) * 20);
    const points: [number, number][] = random() < 0.1
      ? [[start.x, start.y], [end.x, end.y]]
      : [[start.x, start.y], [midX, start.y], [midX, end.y], [end.x, end.y]];
    const id = `edge:${String(index).padStart(4, '0')}`;
    edges.push(edge(id, from.id, to.id, points, random() < 0.2 ? { bundleKey: [from.id, to.id].sort().join('|') } : {}));
    if (random() < 0.3) labels.push({ id: `label:${id}`, edgeId: id, bounds: { x: midX - 8, y: (start.y + end.y) / 2 - 3, width: 16, height: 6 } });
  }
  return { band: 'synthetic', zoom: 1, nodes, edges, labels };
}

function translate(input: GeometryDiagnosticsInput, dx: number, dy: number): GeometryDiagnosticsInput {
  return {
    ...input,
    nodes: input.nodes.map(value => ({ ...value, bounds: { ...value.bounds, x: value.bounds.x + dx, y: value.bounds.y + dy } })),
    edges: input.edges.map(value => ({ ...value, points: value.points.map(point => ({ x: point.x + dx, y: point.y + dy })) })),
    labels: (input.labels ?? []).map(value => ({ ...value, bounds: { ...value.bounds, x: value.bounds.x + dx, y: value.bounds.y + dy } })),
  };
}
