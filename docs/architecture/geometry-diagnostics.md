# Geometry diagnostics (CLA-140)

Report-only, screen-space diagnostics for routed C4 bands. They measure what
the router and label placer produce; they never feed back into routing or
layout, and compiled scene bytes are unchanged. Structural counts are a
regression signal, **not a substitute for browser visual QA**.

- Engine: `packages/architecture/src/geometry-diagnostics.ts`
  (`diagnoseGeometry`, `GEOMETRY_DIAGNOSTIC_TOLERANCES`) — pure and
  renderer-agnostic: node rects, polylines and label rects in world
  coordinates plus a world→screen `zoom`.
- C4 adapter + fixtures + SVG render: `packages/scene-compiler/src/geometry-diagnostics-c4.ts`.
- Gate: `packages/scene-compiler/src/geometry-diagnostics.qa.test.ts` against
  `fixtures/architecture/geometry-diagnostics-baseline.json`.
- Renders: `docs/qa/geometry-diagnostics/*.svg`.

## Kinds

| Kind | Reported when | Geometry |
|---|---|---|
| `edge-crossing` | Two segments of different edges cross at a point interior to both. T-junctions, touching endpoints and collinear overlaps are not crossings. | crossing point, both segments |
| `shared-corridor` | Parallel segments of different edges closer than `collinearDistancePx` overlap along their length. | overlap segment, screen length + separation |
| `label-clearance` | A label rect is within `labelClearancePx` of another edge's route, or of any node (its own endpoint cards included, as in the compiler's placement obstacles). One finding per label × edge / label × node, at the minimum distance. | label rect (+ node rect) |
| `container-border-run` | An axis-aligned segment runs parallel to a node border within `borderRunDistancePx` for at least `borderRunMinLengthPx`. Any node border is checked; in practice this is routes hugging an owner shell. | run segment + node rect |
| `endpoint-crowding` | Endpoints of distinct edges on the same side of a node are closer than `endpointSpacingPx`. | both endpoints |
| `short-route` | A route's whole screen length is below `minRouteLengthPx`. | route points + length |

`short-route` is an addition to the ticket's five kinds: it is the CLA-68
failure mode (a side-to-side hop shorter than the renderer's arrowhead), which
none of the pairwise kinds can see.

Every finding carries sorted `edgeIds`, `nodeIds`, `labelIds` and the union of
the edges' canonical relation ids (`relations[].logicalId`), plus geometry in
world coordinates (rounded to 1e-4) and screen px measures (rounded to 1e-3).

## Exemptions

Exempt findings stay in the output with an `exemption` reason and are counted
separately (`summary.counts[kind].exempt`, `summary.exemptions`). They are not
problems.

| Reason | Applies to |
|---|---|
| `bundle` | Edges with the same `bundleKey` — intentional parallel lanes. The C4 adapter keys by the unordered node pair, exactly the router's lane groups. Crossing, corridor, crowding and label-vs-route. |
| `shared-endpoint` | Edges sharing an endpoint node: a crossing within `sharedEndpointRadiusPx` of it, or a collinear overlap that starts/ends within that radius (fan-out/fan-in trunk). Far crossings and re-merges are still reported. |
| `containment` | A label inside a node that contains both of its edge's endpoints (mirrors compile-c4's label obstacles); the first/last segment of a route running along an ancestor of its own endpoint (the exit stub of a card flush with its owner's padding). |
| `own-endpoint` | Border runs along the edge's own endpoint card. |

Crossings are not invalid semantics: the gate only records them.

## Hidden vs visible

Tolerances are CSS px and are converted to world units by `zoom`, so the same
routes are judged at a band's **entry** zoom (smallest scale the band is drawn
at, clamped to `C4_CAMERA_LIMITS.minZoom`) and its **focus** zoom. A finding
is `hidden` when the geometry carrying it is below `hiddenLengthPx` on screen:

- crossing: the shorter segment; corridor: the overlap length; border run: the run length;
- label: the label's smaller side;
- crowding: the separation — coincident ports (a merged fan-in/out) hide one
  endpoint under the other;
- short route: the route itself.

`visibleGeometryProblems(result)` returns visible, non-exempt findings — the
report-only "problems" view.

## Tolerances (`GEOMETRY_DIAGNOSTIC_TOLERANCES`, screen px)

| Name | Default | Why |
|---|---:|---|
| `hiddenLengthPx` | 2 | below this, strokes are not separately perceptible |
| `collinearDistancePx` | 2 | parallel strokes this close read as one |
| `labelClearancePx` | 4 | half of the compiler's 8px label padding |
| `borderRunDistancePx` | 4 | half the 8px routing clearance |
| `borderRunMinLengthPx` | 48 | long enough to read as tracing the border, not turning near it |
| `endpointSpacingPx` | 8 | the arrowhead radius |
| `sharedEndpointRadiusPx` | 16 | two arrowhead radii around a shared card |
| `minRouteLengthPx` | 16 | the renderer's arrowhead radius is `min(8px, half the terminal segment)` (`primitives.wgsl`), so below 16px the head itself shrinks |

Override per call with `input.tolerances`.

## Determinism and broad phase

Inputs are sorted by id (duplicate ids throw), zero-length steps are dropped,
each pair is evaluated in a fixed orientation, and findings are sorted by
(kind, ids, geometry). Output is byte-identical under shuffled node/edge/label
order (unit + QA tests, including reversed real fixtures).

Pairs come from a uniform grid (≤256 cells per axis, cell ≥ the largest
tolerance) over route segments, node border lines, label rects and node rects.
Only wanted category pairs are generated (segment×segment of different edges,
segment×border, label×segment, label×node); items spanning more than 1024
cells (whole-diagram owners) are tested only against their partner categories.
Endpoint crowding is a per-node-side 1-D sweep. `broadPhase: 'all-pairs'` is
the brute-force oracle: the unit tests (seeded random layouts × zooms, all six
kinds exercised) and the QA test (every real fixture) assert identical
findings.

## Baseline (committed; recomputed by the QA gate)

Counts are `visible/hidden/exempt`. Entry / focus zooms: context 0.32/0.75,
container 1.16/1.99, component 3.35/5.27, code 7.1/13.96.

| Fixture | Band | Zoom | Edges | Crossing | Corridor | Label | Border | Crowding | Short |
|---|---|---|---:|---|---|---|---|---|---|
| golden-okie | context | enter/focus | 3 | 0/0/0 | 0/0/1 | 0/0/0 | 0/0/0 | 0/1/0 | 0/0/0 |
| golden-okie | container | enter | 5 | 1/0/0 | 0/0/5 | 0/0/1 | 0/0/0 | 0/4/0 | 2/0/0 |
| golden-okie | container | focus | 5 | 1/0/0 | 0/0/5 | 0/0/1 | 0/0/0 | 0/4/0 | 0/0/0 |
| golden-okie | component | enter | 23 | 0/0/1 | 1/0/17 | 0/0/0 | 0/0/0 | 8/4/13 | 5/0/0 |
| golden-okie | component | focus | 23 | 0/0/1 | 1/0/17 | 0/0/0 | 0/0/0 | 6/4/0 | 0/0/0 |
| golden-okie | code | enter | 12 | 1/0/0 | 0/0/4 | 0/0/0 | 0/0/0 | 0/3/0 | 2/0/0 |
| golden-okie | code | focus | 12 | 1/0/0 | 0/0/4 | 0/0/0 | 0/0/0 | 0/3/0 | 0/0/0 |
| dense-default-40 | component | enter | 41 | 24/0/2 | 0/0/3 | 0/0/0 | 0/0/0 | 0/2/0 | 26/0/0 |
| dense-default-40 | component | focus | 41 | 24/0/2 | 0/0/3 | 0/0/0 | 0/0/0 | 0/2/0 | 0/0/0 |
| dense-container-25 | container | enter | 26 | 14/0/1 | 0/0/5 | 0/0/1 | 0/0/0 | 0/4/0 | 16/0/0 |
| dense-container-25 | container | focus | 26 | 14/0/1 | 0/0/5 | 0/0/1 | 0/0/0 | 0/4/0 | 0/0/0 |
| dense-component-50 | component | enter | 24 | 0/0/0 | 0/0/2 | 0/0/0 | 0/0/0 | 0/1/0 | 16/0/0 |
| dense-component-50 | component | focus | 24 | 0/0/0 | 0/0/2 | 0/0/0 | 0/0/0 | 0/1/0 | 0/0/0 |
| dense-code-25 | code | enter | 26 | 7/0/0 | 7/0/21 | 0/0/0 | 0/0/0 | 0/21/0 | 16/0/0 |
| dense-code-25 | code | focus | 26 | 7/0/0 | 7/0/21 | 0/0/0 | 0/0/0 | 0/21/0 | 0/0/0 |
| cla68-before | code | enter | 1 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | **1/0/0** |
| cla68-before | code | focus | 1 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 |
| cla68-after-tight | code | enter/focus | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| cla68-after-scan | code | enter/focus | 1 | 0 | 0 | 0 | 0 | 0 | 0 |

Readings:

- **Short routes are an entry-zoom problem.** Packed siblings sit two routing
  clearances (16px at focus) apart, so every facing hop is exactly 16px at
  focus and ~10px at entry. All `short-route` findings disappear at focus.
- **CLA-68.** `cla68-before` reconstructs the pre-fix route (the duplicates
  edge routed as an ordinary edge on the tight default packing): an 8.1px hop
  at code entry (16.0px at focus). The shipped U-loop is 381px/749px on the
  tight packing and 430px/845px on the scan packing, with zero findings.
- **Crossings** concentrate where a 5-copy hub pair cuts a packed chain
  (`dense-*`); the golden self-map has one crossing at container and code.
- **Border runs** are zero on every real fixture: the router's LCA domain
  keeps routes more than `borderRunDistancePx` from owner shells.
- **Unexempted corridors** in the golden component band are two unrelated
  edges sharing a trunk between `compiler-*` cards.

## Benchmark (machine-dependent; not gated)

`node --expose-gc scripts/measure-geometry-diagnostics.mjs` on an Apple M1
Pro, Node 22.23. Seeded synthetic layout (four owners of packed cards,
neighbour-heavy orthogonal routes, 30% labelled). The layout is denser than
real bands (~13 findings per edge at 5000 edges), so it is a worst case.

| Edges | Segments | Grid ms | Grid heap MB | Candidate pairs | Naive pairs | All-pairs ms | Same findings |
|---:|---:|---:|---:|---:|---:|---:|:---:|
| 50 | 145 | 2.7 | 3.9 | 2,350 | 36,045 | 8.0 | yes |
| 500 | 1,449 | 45.8 | 16.7 | 45,129 | 3,028,187 | 361.6 | yes |
| 5,000 | 14,459 | 537.3 | 172.8 | 560,299 | 281,677,713 | 33,691 | yes |

The grid examines ~0.2% of the naive pairs at 5,000 edges and scales roughly
linearly. What remains is dominated by output (66k findings at 5,000 edges).
Every real fixture diagnoses in single-digit milliseconds.

## Regenerate

```sh
pnpm --filter @okie/scene-compiler build
node --expose-gc scripts/measure-geometry-diagnostics.mjs   # --no-bench skips timing
```

This rewrites the baseline JSON and the SVG renders. A routing/layout change
that moves counts fails `geometry-diagnostics.qa.test.ts` until the baseline is
regenerated. Review the renders and explain the delta in the PR.

## Limits

- Structural only. It does not see anti-aliasing, corner rounding, label
  glyphs, z-order, LOD fades, or occlusion by cards, so the browser pass is
  still required (CLAUDE.md browser-QA notes).
- Two zooms per band. Continuous zoom between them is interpolated by eye, not
  measured.
- `fixtures/enrichment/thiss-okie` is not included: it needs a local scan
  (`fixtures/scan/`, gitignored) to materialize relations.

## For CLA-141

Use `diagnoseC4Scene(compiled)` or `c4BandGeometryInput` + `diagnoseGeometry`
as the before/after oracle for routing changes. Gate on
`visibleGeometryProblems` deltas per band at **entry** zoom, which is where
problems surface first. Start with `short-route` and unexempted
`shared-corridor`/`edge-crossing`, which are the actionable ones today. Treat
counts as calibrated regressions, not targets: a lower crossing count that
reads worse in the browser is still a regression.
