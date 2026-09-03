# Per-band compile and render cost (CLA-67)

Status: measured curve. This is **not** a product target and **not** a new folklore cap.

The ~2000-entity band-depth gate in `SCAN_BAND_DEPTH_MIN_ENTITIES` is a last-resort hang-guard for unbounded full-graph compiles. CLA-66 already compiles the current C4 band plus one layer down. CLA-67 measures what that neighborhood actually costs as node and edge counts grow, then names a healthy count and a fall-over from the table.

**The hang-guard stays 2000.** Replacing it with a per-band number would mix two axes: this curve is sibling nodes in one band (dense ring + hub); the hang-guard counts every descendant in a focus scope. A skinny 400-entity code tree is not the same compile as 400 fully connected components. The table is not solid enough to retarget that guard.

Committed artifact: [`fixtures/architecture/band-cost-curve.json`](../../fixtures/architecture/band-cost-curve.json). Regenerators: `node scripts/measure-band-cost.mjs` (compile / payload / CPU cull) and `crates/atlas-engine/tests/band_cost_curve_qa.rs` (ProtocolEngine first-frame / pan / zoom). Defaults remain byte-identical (`scoped-compile.qa.test.ts`).

## How to read the numbers

- **Scoped** is the CLA-66 product path for a container drill: `maxBand: component`, 24 routed edges, 1500 router-grid nodes. Omitted edges stay enumerable (`+N more`).
- **Unbounded** is `maxBand` only — every visual edge in the band is routed. That is the hang the 2000-guard still exists to stop.
- **Prefetch** is Open inside one layer down: one file-component neighborhood of 25 code children. It does not grow with the parent band.
- **CPU frame** is a viewport cull of the compiled protocol scene (the work ProtocolEngine always does before GPU submit). Rasterization is measured live in the browser diagnostics pill (`Shift+Alt+D`).
- Wall-clock samples are one measurement host. CI locks **structure** (node/edge/object/path/payload bytes) and generous ceilings, not these milliseconds.
- Thresholds used to name healthy / fall-over: compile healthy `< 120ms`, fall-over `≥ 200ms`; payload healthy `< 500KB`, fall-over `≥ 1.5MB`; CPU frame healthy `< 8ms`, fall-over `≥ 16.7ms`; prefetch healthy `< 80ms`.

## Component-band curve (the expensive neighborhood)

Dense snapshot: one container, N sibling components, a cycle of `dependsOn` plus a hub pair (count 5). Same shape as the existing scoped-compile harness.

| N (band children) | Band nodes | Routed / omitted edges | Objects / paths | Payload | Scoped compile | Unbounded compile | CPU first frame | Prefetch compile (25 code) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 25 | 27 | 24 / 2 | 27 / 24 | 48 KB | 53 ms | 55 ms | < 0.1 ms | 57 ms |
| **50 (healthy)** | 52 | 24 / 27 | 52 / 24 | 77 KB | **100 ms** | **217 ms** | < 0.1 ms | 55 ms |
| **100 (scoped fall-over)** | 102 | 24 / 77 | 102 / 24 | 132 KB | **266 ms** | 1.15 s | < 0.1 ms | 54 ms |
| 200 | 202 | 24 / 177 | 202 / 24 | 248 KB | 837 ms | **7.2 s** | < 0.1 ms | 54 ms |
| 400 | 402 | 24 / 377 | 402 / 24 | 476 KB | 925 ms | — | < 0.1 ms | 55 ms |
| 800 | 802 | 24 / 777 | 802 / 24 | 942 KB | 268 ms | — | < 0.1 ms | 54 ms |

800 scoped came in faster than 400 on this host (not a new cap). Compile time is not monotonic past 200; routing grid vs obstacle density moves the work. Payload stays under 1 MB through 800. Direct-fallback count was 0 on every row.

ProtocolEngine first-frame / pan / zoom on a matching N-node N-edge grid (not C4 layout — the GPU CPU path):

| Objects | Load | First frame | Pan | Zoom |
|---:|---:|---:|---:|---:|
| 25 | 0.13 ms | 0.02 ms | 0.02 ms | 0.03 ms |
| 50 | 0.23 ms | 0.05 ms | 0.05 ms | 0.06 ms |
| 200 | 0.91 ms | 0.24 ms | 0.24 ms | 0.23 ms |
| 800 | 3.6 ms | 0.57 ms | 0.57 ms | 0.48 ms |

Container-band and code-band handfuls (25 children, product `maxBand` only):

| Band | Nodes | Compile | Payload |
|---|---:|---:|---:|
| container | 26 | 55 ms | 46 KB |
| code | 28 | 54 ms | 53 KB |

## Named healthy count and fall-over

| Axis | Healthy | Fall-over | Notes |
|---|---|---|---|
| Compile one C4 band (scoped, 24 edges) | **50** sibling nodes (~100 ms) | **100** sibling nodes (~266 ms, first ≥ 200 ms) | 200–400 sit near 0.8–1 s. Still finishes; it is no longer instant Open inside. |
| Compile one C4 band (unbounded routing) | **25** sibling nodes (~55 ms) | **50** sibling nodes (~217 ms) | 100 → 1.2 s. 200 → **7.2 s**. This is the hang, not 2000. |
| Scene payload | **800** still healthy (942 KB) | Not reached in this range (would be ≥ 1.5 MB) | Linear in objects + routed paths. |
| GPU CPU-frame (ProtocolEngine cull/LOD/draw-list) | **800** still healthy (0.57 ms first frame on a matching grid) | Not reached through 800 protocol objects | Raster (wgpu) is sampled live; CPU prepare is not the limiter. |
| Canvas2D first frame / pan / zoom | **200** children stays under the 50 ms test ceiling on the CPU paint path | Not reached at 200 | Stub 2D context (no GPU raster). Live pill is the raster number. |
| Open inside / one-down prefetch | **25** code children, **~55 ms**, **flat** as the parent band grows from 25→800 | Not reached | CLA-66 win: prefetch cost is the child neighborhood, not the sibling dump. |

## Why 2000 is left unchanged

The hang-guard refuses an **unbounded descendant scope** above 2000 entities. This table’s hang is **unbounded edge routing of ~50–200 siblings**. Wiring 50 or 200 into `SCAN_BAND_DEPTH_MIN_ENTITIES` would refuse skinny code trees that are cheap to compile and would not match the measured axis. CLA-66 already stops the whole-tree dump. The remaining guard stays 2000, documented, and test-locked (`SCAN_BAND_DEPTH_MIN_ENTITIES === 2000`).

A later slice may replace it only with a number taken from this table (or a follow-up curve that measures descendant-scope unbounded compiles of real shapes), with tests updated in the same change.

## Self-scan (`/?fixture=scan`, after CLA-66)

This host’s enriched self-scan: **2102 entities, 4349 relations** (above the 2000 hang-guard). Hang-guard **applies** to unbounded full-graph compiles; it does not fire on the scoped path. L1 is still a handful.

| Neighborhood | Focus | Band nodes (children) | Compile | Payload | CPU frame |
|---|---|---:|---:|---:|---:|
| L1 context + one-down containers | `system:okie` | 19 (10 containers) | 128 ms | 71 KB | < 0.1 ms |
| Open inside `@okie/server` (first container) | `container:apps-server` | 23 (13 components) | 113 ms | 68 KB | < 0.1 ms |
| Open inside that container’s first file | `component:apps-server-src-ask-ts` | 44 (code) | 253 ms | 128 KB | < 0.1 ms |
| Quiet `@okie/architecture` L3 | container | 19 (9 components) | 80 ms | — | < 0.1 ms |
| Quiet architecture first-file L4 | component | 48 (22 code) | 485 ms | — | < 0.1 ms |
| Quiet `@okie/scene-compiler` L3 | container | 23 (13 components) | 116 ms | — | < 0.1 ms |
| Quiet scene-compiler first-file L4 | component | 19 (8 code) | **22 ms** | — | < 0.1 ms |

L1 is 19 boxes, not ~1.8k L4 rows. Open inside a quiet package compiles that neighborhood only. A fat first file (architecture, 22 code children) can sit past the 200 ms compile fall-over even when the parent band is healthy — that is the L4 neighborhood curve, not a reason to dump the atlas. Prefetch of a small file (scene-compiler, 8 code) is 22 ms.

Generate `fixtures/scan/` with `okie-scan` (gitignored) and re-run `node scripts/measure-band-cost.mjs` to refresh the `selfScan` object in the committed JSON.

## Tests

| Test | What it locks |
|---|---|
| `packages/scene-compiler/src/band-cost-curve.qa.test.ts` | Structural table, hang-guard 2000, default compile byte-identical, healthy compile `< 2 s` |
| `packages/scene-compiler/src/scoped-compile.qa.test.ts` | Original scoped-compile contracts on the shared `denseSnapshot` |
| `apps/web/src/renderer/bandCostCurve.test.ts` | Canvas2D first-frame / pan / zoom / Open-inside prefetch; hang-guard 2000 |
| `apps/web/src/renderer/scopedCompile.test.ts` | `SCAN_BAND_DEPTH_MIN_ENTITIES === 2000` |
| `crates/atlas-engine/tests/band_cost_curve_qa.rs` | ProtocolEngine load / first frame / pan / zoom vs 25–800 objects |

## Out of this slice

CLA-66 lazy compile, ranking, Peek, theming, CLA-61 clones, CLA-62 lcov, CLA-57 Source excerpts, CLA-58 hover placeholder. Do not raise or lower 2000 from a guess.
