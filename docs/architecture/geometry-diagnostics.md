# Geometry diagnostics (CLA-140)

Report-only, screen-space diagnostics for routed C4 bands. They measure what
the router and label placer produce; they never feed back into routing or
layout, and compiled scene bytes are unchanged. Structural checks are a
regression signal, **not a substitute for browser visual QA**.

- Engine: `packages/architecture/src/geometry-diagnostics.ts`
  (`diagnoseGeometry`, `visibleGeometryProblems`, `GEOMETRY_DIAGNOSTIC_TOLERANCES`) —
  pure and renderer-agnostic: node rects, polylines and label rects in world
  coordinates plus a world→screen `zoom`.
- C4 adapter: `packages/scene-compiler/src/geometry-diagnostics-c4.ts`.
  `c4BandGeometryInput`, `c4DiagnosticZoom` and `diagnoseC4Scene` are exported
  from `@okie/scene-compiler`. Fixtures, the CLA-68 reconstruction, the baseline
  builder and the SVG renderer stay module-internal (tests + script only).
- Gate: `packages/scene-compiler/src/geometry-diagnostics.qa.test.ts` against
  `fixtures/architecture/geometry-diagnostics-baseline.json`.
- Renders: `docs/qa/geometry-diagnostics/*.svg`.

## Kinds

| Kind | Reported when | Geometry |
|---|---|---|
| `edge-crossing` | Two routes of different edges pass through each other: an interior–interior segment intersection, or a vertex lying exactly on the other route whose neighbouring rays interleave (the route really passes to the other side). Touch-and-return, T-junctions at route ends and collinear merges are not crossings. | crossing point, both segments |
| `shared-corridor` | Parallel segments of different edges closer than `collinearDistancePx` overlap along their length. | overlap/trunk segment, screen length + separation |
| `label-clearance` | A label rect is within `labelClearancePx` of another edge's route, or of any node (its own endpoint cards included, as in the compiler's placement obstacles). One finding per label × edge / label × node, at the minimum distance. | label rect (+ node rect) |
| `container-border-run` | An axis-aligned segment runs parallel to a node border within `borderRunDistancePx` for at least `borderRunMinLengthPx`. Any node border is checked; in practice this is routes hugging an owner shell. | run segment + node rect |
| `endpoint-crowding` | Ports of distinct edges on the same node are closer than `endpointSpacingPx` (Euclidean, so ports either side of a corner are compared). | both ports |
| `short-route` | A route's whole screen length is below `minRouteLengthPx`. | route points + length |
| `short-leg` | A leg (bend-to-bend or terminal segment) of a multi-segment route is below `minLegLengthPx`. Not reported for routes already flagged `short-route`. | leg + length |

`short-route` and `short-leg` go beyond the ticket's five kinds. Both are
CLA-68 failure modes: a facing hop shorter than the arrowhead, and a U whose
legs are shorter than the renderer's corner rounding (commit `ff673a2`). I
added `short-leg` as a separate kind, not as an extension of `short-route`,
because the route as a whole is long; only its legs collapse.

Every finding carries sorted `edgeIds`, `nodeIds`, `labelIds` and the union of
the edges' canonical relation ids (`relations[].logicalId`), plus geometry in
world coordinates (rounded to 1e-4) and screen px measures (rounded to 1e-3).
Threshold comparisons use the same rounded screen values that are reported.

## Canonicalization

Inputs are sorted by id (duplicate ids throw). Non-finite coordinates and
invalid tolerance overrides throw, and `undefined` overrides keep the
defaults. Zero-length steps are dropped and consecutive collinear
same-direction steps are merged. Without that merge, a redundant vertex at a
crossing or along a border split the geometry, and crossings or runs were
missed.

## Exemptions

Exempt findings stay in the output with an `exemption` reason and are counted
separately (`summary.counts[kind].exempt`, `summary.exemptions`). They are not
problems.

| Reason | Applies to |
|---|---|
| `bundle` | Edges with the same `bundleKey`, i.e. intentional parallel lanes. The C4 adapter keys by the unordered node pair, exactly the router's lane groups. Applies to crossings, corridors, crowding and label-vs-route. |
| `shared-endpoint` | Edges sharing an endpoint node: a crossing within `sharedEndpointRadiusPx` of either edge's **port** on that node, or a collinear overlap that starts/ends within that radius of a port (fan-out/fan-in trunk; `screenLength` is the trunk length). Distance is measured to the route's actual start/end point, not the node rect, so a big owner endpoint no longer exempts crossings far from its ports. |
| `shared-port` | Endpoint crowding where two ports coincide: one shared port, not two crowded ones. |
| `containment` | A label inside a node that contains both of its edge's endpoints (mirrors compile-c4's label obstacles). For border runs, only the part of a **first/last** segment that lies within its own endpoint card's extent, where the card sits flush with its owner. The rest of the run is still reported. |
| `own-endpoint` | Border runs of a **first/last** segment along its own endpoint card. A middle leg wrapping its own card is reported. |

Crossings are not invalid semantics: the gate only records them.

## Hidden vs visible

Tolerances are CSS px and are converted to world units by `zoom`, so the same
routes are judged at a band's **entry** zoom (smallest scale the band is drawn
at, clamped to `C4_CAMERA_LIMITS.minZoom`) and its **focus** zoom. A non-exempt
finding is `hidden` when the geometry carrying it is below `hiddenLengthPx` on
screen:

- crossing: the shorter segment; corridor: the overlap; border run: the run;
- label: the label's smaller side;
- crowding: the port separation (0 < d < 2px);
- short route / short leg: the route / leg itself.

`visibleGeometryProblems(result)` returns visible, non-exempt findings — the
report-only "problems" view.

## Tolerances (`GEOMETRY_DIAGNOSTIC_TOLERANCES`, screen px)

| Name | Default | Why / coupling |
|---|---:|---|
| `hiddenLengthPx` | 2 | below this, strokes are not separately perceptible |
| `collinearDistancePx` | 2 | parallel strokes this close read as one |
| `labelClearancePx` | 4 | half of the compiler's 8px `labelPaddingScreenPx` |
| `borderRunDistancePx` | 3 | **Deliberately below** the smallest routing clearance any band reaches: 8px at focus scales to 3.41px at context entry, 4.07px at code entry and 4.66px at container entry. Routes the router kept at clearance are never flagged; only hugging below clearance is. |
| `borderRunMinLengthPx` | 48 | long enough to read as tracing the border, not turning near it |
| `endpointSpacingPx` | 8 | the arrowhead radius |
| `sharedEndpointRadiusPx` | 16 | two arrowhead radii around a shared port |
| `minRouteLengthPx` | 16 | Strict `<`. The renderer's arrowhead radius is `min(8px, half the terminal segment)` (`primitives.wgsl`), so below 16px the head itself shrinks. **Coupled** to the packing gap: packed sibling hops are exactly 16.000px at focus (two 8px clearances) and are deliberately *not* flagged there. They are flagged at entry. |
| `minLegLengthPx` | 6 | Strict `<`. **Coupled** to `PATH_CORNER_RADIUS_PX = 6` (`crates/atlas-gpu/src/mesh.rs`) and the arrowhead's `min(8, half terminal)`. A shorter leg is consumed by corner rounding. The router's 8px clearance stub scales below 6px at every band entry, so entry-zoom `short-leg` findings are systematic today. |

Override per call with `input.tolerances`. If the renderer's corner radius,
arrowhead or the router's clearance/packing gap change, revisit the coupled
rows.

## Broad phase and determinism

Pairs come from a hashed uniform grid over route segments, node border lines,
label rects and node rects. The cell edge is the 75th-percentile padded item
span, so one far outlier cannot stretch cells. A pair is emitted only from the
cell holding the min corner of the two padded boxes' intersection, so there is
no global dedupe set. Only wanted category pairs are examined:
segment×segment of different edges, segment×border, label×segment and
label×node. Items spanning more than 4096 cells (whole-diagram owners) are
paired by scanning their partner types. Endpoint crowding is a per-node
x-sorted sweep. Each vertex contact is examined once, from the segment it
starts.

`broadPhase: 'all-pairs'` is the brute-force oracle. The unit tests assert it
matches the grid on seeded random layouts × zooms (all seven kinds
exercised), on the large-item path (whole-diagram owners), and with a far
outlier node. The QA test asserts the same on every real fixture. A
400-layout adversarial fuzz (mixed scales 1e-3…1e7, outliers, diagonal and
border-snapped routes, giant labels) matched the oracle in all 1,380 runs.
Output is byte-identical under seeded shuffles of nodes/edges/labels (unit +
QA). Vertex contacts (a vertex of one route on the other route) are examined
once per (edge, vertex-or-segment) pair whatever the segments' parallelism, so
a shared vertex whose outgoing legs are collinear-opposite is still tested.
`magnitude` (the epsilon scale) includes node far corners and label rects, and
items whose cell range is not safe-integer steppable take the large-item path.
Grid and oracle must agree on `candidatePairs` as well as findings, which
guards pair ownership and large×large dedupe.

`summary.broadPhase` reports `naivePairs` (every wanted category pair),
`examinedPairs` (pair tests the grid actually ran, counted once per shared
cell), `candidatePairs` (unique box-overlapping pairs handed to the narrow
phase, identical in both modes) and `largeItems`.

## What the gate checks

`geometry-diagnostics.qa.test.ts` recomputes the baseline and deep-equals it.
Per fixture × band × zoom level it compares:

- node / edge / label / segment counts;
- counts per kind as visible/hidden/exempt, plus exemption totals;
- the visible-problem list (`kind edgeIds [nodeIds] [labelIds]`);
- `geometryFingerprint`: FNV-1a of the rounded (1e-3 world) node rects, route
  points and label rects that row judged.

A geometry change that leaves counts unchanged, such as lane spacing
10→10.5, still fails on the fingerprint. The gate does not compare timing,
broad-phase pair counts, or pixels. Separately, it asserts the CLA-68 evidence
below, grid == oracle, shuffle invariance on real fixtures, and that
diagnosing does not mutate the compiled scene.

## Baseline (committed; recomputed by the QA gate)

Counts are `visible/hidden/exempt`. Entry / focus zooms: context 0.32/0.75,
container 1.16/1.99, component 3.35/5.27, code 7.1/13.96.

| Fixture | Band | Zoom | Edges | Crossing | Corridor | Label | Border | Crowding | Short route | Short leg |
|---|---|---|---:|---|---|---|---|---|---|---|
| golden-okie | context | enter | 3 | 0/0/0 | 0/0/1 | 0/0/0 | 0/0/0 | 0/0/1 | 0/0/0 | 3/0/0 |
| golden-okie | context | focus | 3 | 0/0/0 | 0/0/1 | 0/0/0 | 0/0/0 | 0/0/1 | 0/0/0 | 0/0/0 |
| golden-okie | container | enter | 5 | 1/0/0 | 0/0/5 | 0/0/1 | 0/0/0 | 0/0/4 | 2/0/0 | 6/0/0 |
| golden-okie | container | focus | 5 | 1/0/0 | 0/0/5 | 0/0/1 | 0/0/0 | 0/0/4 | 0/0/0 | 0/0/0 |
| golden-okie | component | enter | 23 | 0/0/1 | 1/0/17 | 0/0/0 | 0/0/0 | 8/0/17 | 5/0/0 | 32/0/0 |
| golden-okie | component | focus | 23 | 0/0/1 | 1/0/17 | 0/0/0 | 0/0/0 | 6/0/4 | 0/0/0 | 0/0/0 |
| golden-okie | code | enter | 12 | 1/0/0 | 0/0/4 | 0/0/0 | 0/0/0 | 0/0/3 | 2/0/0 | 14/0/0 |
| golden-okie | code | focus | 12 | 1/0/0 | 0/0/4 | 0/0/0 | 0/0/0 | 0/0/3 | 0/0/0 | 0/0/0 |
| dense-default-40 | component | enter | 41 | 26/0/0 | 0/0/3 | 0/0/0 | 0/0/0 | 0/0/2 | 26/0/0 | 30/0/0 |
| dense-default-40 | component | focus | 41 | 26/0/0 | 0/0/3 | 0/0/0 | 0/0/0 | 0/0/2 | 0/0/0 | 0/0/0 |
| dense-container-25 | container | enter | 26 | 15/0/0 | 0/0/5 | 0/0/1 | 0/0/0 | 0/0/4 | 16/0/0 | 19/0/0 |
| dense-container-25 | container | focus | 26 | 15/0/0 | 0/0/5 | 0/0/1 | 0/0/0 | 0/0/4 | 0/0/0 | 0/0/0 |
| dense-component-50 | component | enter | 24 | 0/0/0 | 0/0/2 | 0/0/0 | 0/0/0 | 0/0/1 | 16/0/0 | 16/0/0 |
| dense-component-50 | component | focus | 24 | 0/0/0 | 0/0/2 | 0/0/0 | 0/0/0 | 0/0/1 | 0/0/0 | 0/0/0 |
| dense-code-25 | code | enter | 26 | 7/0/0 | 7/0/21 | 0/0/0 | 0/0/0 | 0/0/21 | 16/0/0 | 19/0/0 |
| dense-code-25 | code | focus | 26 | 7/0/0 | 7/0/21 | 0/0/0 | 0/0/0 | 0/0/21 | 0/0/0 | 0/0/0 |
| cla68-before | code | enter | 1 | 0 | 0 | 0 | 0 | 0 | **1/0/0** | 0 |
| cla68-before | code | focus | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| cla68-after-tight | code | enter | 1 | 0 | 0 | 0 | 0 | 0 | 0 | **2/0/0** |
| cla68-after-tight | code | focus | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| cla68-after-scan | code | enter/focus | 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

Readings:

- **Entry zoom is where problems show.** Every `short-route` and `short-leg`
  finding disappears at focus. The 8px clearance stubs and 16px packed hops
  scale to ~4–10px at band entry.
- **CLA-68:**
  - `cla68-before` reconstructs the pre-fix route: the duplicates edge routed
    as an ordinary edge on the tight default packing. It is a single 8.1px
    hop at code entry (16.0px at focus), flagged as a short route.
  - `cla68-after-tight`, the shipped U on the default packing, is flagged at
    code entry. Its two legs are 4.07px, under the 6px corner radius, so the
    U collapses exactly as commit `ff673a2` describes. It is 8px, and clean,
    at focus. This is known-degraded, not clean. `short-leg` confirms the
    degradation but does not single the U out: the same ~4.07px entry-zoom
    stub (the router's 8px clearance at code entry) fires on ordinary
    routes too (see the short-leg column).
  - `cla68-after-scan`, the U on the widened scan gutter, has 20.3px legs at
    entry (40px at focus) and zero findings.
- **Crossings** concentrate where a 5-copy hub pair cuts a packed chain
  (`dense-*`). The golden self-map has one crossing at container and one at
  code.
- **Border runs** are zero on every real fixture: the router's LCA domain
  keeps routes outside `borderRunDistancePx` of owner shells.

## Benchmark (machine-dependent; not gated)

`node --expose-gc scripts/measure-geometry-diagnostics.mjs` on an Apple M1
Pro, Node 22.23. The layout is seeded and synthetic: four owners of packed
cards, neighbour-heavy orthogonal routes, 30% labelled. It is denser than real
bands, so treat it as a worst case.

| Layout | Edges | Segments | Grid ms | Grid heap MB | Examined pairs | Candidate pairs | Naive pairs | All-pairs ms | Same findings |
|---|---:|---:|---:|---:|---:|---:|---:|---:|:---:|
| local | 50 | 143 | 3.2 | 4.2 | 4,246 | 1,100 | 35,412 | 9.0 | yes |
| local | 500 | 1,418 | 47.1 | 15.0 | 83,187 | 17,059 | 2,942,379 | 436.0 | yes |
| local | 5,000 | 14,084 | 572.3 | 130.0 | 908,267 | 197,480 | 271,835,838 | 38,191 | yes |
| local + node at 1e6 | 5,000 | 14,084 | 557.6 | 123.4 | 908,267 | 197,480 | 271,893,716 | 37,872 | yes |

Outlier regression (the reviewer's `probe7`, same host). The previous
extent-sized grid degraded to all-pairs when one node sat far away:

| Edges, outlier | Before (extent grid) | After (item-sized hashed grid) |
|---|---|---|
| 1,000, none | 101 ms, 85k candidates | 120 ms, 35k candidates |
| 1,000, node at 1e6 | 8,333 ms, 12.0M candidates | 89 ms, 35k candidates |
| 5,000, node at 1e5 / 1e6 | `RangeError: Set maximum size exceeded` | 514 / 633 ms, 197k candidates |

Examined pairs grow roughly linearly with edges at fixed local density
(10.9× from 500 to 5,000 edges). Random long-range routes, whose true overlaps
grow superlinearly, cost more. Every real fixture diagnoses in under 2 ms.

## Regenerate

```sh
pnpm --filter @okie/scene-compiler build
node --expose-gc scripts/measure-geometry-diagnostics.mjs   # --no-bench skips timing
```

The script resolves paths from its own location. It rewrites the baseline
JSON and the SVG renders, and both are byte-stable across runs. Each render
frames the visible findings plus their edges' endpoint cards (all routes and
endpoint cards when there are no findings), with 32px padding. Everything else
is clipped to that frame. Renders are scaled down to at most 1600px wide; the
title states the scale. Title and legend sit in their own strips. A
routing/layout change that moves counts or geometry fails
`geometry-diagnostics.qa.test.ts` until the baseline is regenerated. Review
the renders and explain the delta in the PR.

## Limits

- Structural only. It does not see anti-aliasing, label glyphs, z-order, LOD
  fades, or occlusion by cards, so the browser pass is still required
  (CLAUDE.md browser-QA notes). Corner rounding and arrowhead shrink are
  approximated by the two coupled length thresholds.
- Two zooms per band. Continuous zoom between them is not measured.
- `fixtures/enrichment/thiss-okie` is not included: it needs a local scan
  (`fixtures/scan/`, gitignored) to materialize relations.

## For CLA-141

Use `diagnoseC4Scene(compiled)` (or `c4BandGeometryInput` + `diagnoseGeometry`)
as the before/after oracle for routing changes. Gate on `visibleGeometryProblems`
deltas per band at **entry** zoom. The actionable kinds today are:

- `short-leg`: at entry zoom this mostly measures the router's
  clearance/stub policy, not specific shapes. Split terminal stubs
  (first/last legs) from bend-to-bend legs to get a U-specific signal such as
  `cla68-after-tight`;
- `short-route`: packed hops;
- unexempted `shared-corridor` and `edge-crossing`.

Treat counts as calibrated regressions, not targets: a lower crossing count
that reads worse in the browser is still a regression.
