# September 12 user recording review

Bounded visual review of the three original 3330×2032 recordings in `/Users/brenton/Pictures/Screenshots/`. Durations: 3.30.53 PM = 4.473 s; 3.33.49 PM = 3.268 s; 3.35.32 PM = 9.788 s. Times below are elapsed video time, approximate to sampled frames. All show Canvas 2D preview/software fallback. This is evidence from the supplied recordings, not a new application acceptance run.

Method: ffprobe metadata; whole-recording contact sheets sampled at 4 fps; individual frames at 0.2–0.25 s spacing around the transitions. Temporary evidence is in `/private/tmp/sept12-video-qa/` (`clip1.jpg`–`clip3.jpg`, individual `cN-time.png` frames). Contact sheet cells read left-to-right, top-to-bottom, every 0.25 s; black unused cells are padding, not app failures.

## Strongest geometry-relocation evidence

**3.33.49 PM, approximately 0.00–1.20 s, L2 revealing @okie/web components.** At 0.00 s the highlighted `atlas-gpu` container is beneath `@okie/server`, left of the central `@okie/web` container. At 0.40 s it is beneath the middle of `@okie/web`; at 1.20 s it is beneath its right side. In the half-resolution evidence its center moves approximately x=161 → 689 → 967, while the web center remains around x=657 → 672 → 675. This relative side change cannot be explained by uniform camera scale or translation. The cursor stays near the web interior. `atlas-protocol` and surrounding relationship elbows also change position. Dense frames: `c2-0.png`, `c2-0.4.png`, `c2-0.6.png`, `c2-1.2.png`. The contact sheet shows the layout reversing during the subsequent zoom-out and recurring near 2.5–3.0 s. The L2 pill is still active during the early component reveal.

## Deeper-layer distraction

**3.30.53 PM, approximately 0.75–1.25 s, L4 inside atlas-wasm / src/browser.rs.** `WasmAtlasRenderer::pointer_down` remains near the cursor while its source grid scales down. `src/lib.rs` remains below the grid. A very large dim teal container outline and container label emerge across the right side of the source grid at 1.25 s (label is clipped; do not infer its complete entity name). This is visible competing background geometry/label exposure. The source-grid size change itself is ordinary coherent scaling, not evidence that its individual source nodes reorder. Dense frames: `c1-0.75.png`, `c1-1.png`, `c1-1.25.png`. The broad contact sheet shows repeated L3/L4 reveal/hide during this short zoom reversal.

**3.35.32 PM, approximately 0.50–3.10 s, L3→L4 in @okie/web / src/renderer/cameraBounds.ts.** `src/openGraph.ts` sits above the focus component. Source children reveal in a stable three-column arrangement: `ATLAS_CAMERA_BOUNDS`, `ATLAS_SEMANTIC_ZOOM_BANDS`, `clampAtlasCameraZoom`; `semanticDominantZoomIntervals`, `semanticFocusZooms`, `semanticLevelAtZoom`; `SemanticZoomBand` below. At 0.50→1.10 s the component title changes from a large heading to the small parent heading as source details become readable. At 2.50–3.10 s a thick dim rounded background boundary runs horizontally through the middle source row. The source children retain their ordering, and much of their movement is consistent with camera scaling around the cursor. This clip supports the complaint about competing background geometry, but is weaker evidence of an independent source-node relocation than clip 2. Dense evidence: `c3-0.5.png`, `c3-0.7.png`, `c3-0.9.png`, `c3-1.1.png`, `c3-2.5.png` through `c3-3.1.png`.

## Edges and limits

Clip 2's thin container relationships visibly move with their relocating endpoints; that is route geometry movement, not merely an outgoing edge fading. The sampled images alone do not establish whether it is rerouted every frame versus interpolation between two routes. In clips 1 and 3, the largest distracting curved strokes are **node/container boundaries**, not safely identifiable edges. Do not diagnose every thick crossing stroke as a rerouted relationship. Thin source relationships in clip 3 remain recognizable between their source cards; no source-edge topology change is established by this review.

The minimap stays present and legible in the samples, updates its viewport and level context, and is not the defect supported here. Preserve its behavior. The actionable target is background placement/boundaries across semantic transitions; the strongest reproducible example is `atlas-gpu` crossing beneath `@okie/web` while the camera focuses web. These recordings do not establish a current-fix pass or complete the overall goal.

## Bounded after-fix screenshot comparison

Reviewed `/tmp/okie-sept12-after/final-web-start.png`, `final-web-in-0.png` through `final-web-in-3.png`, `final-web-out-1.png`, and `final-web-out-3.png`, with the associated `final-web-trace.json`. This is a sampled screenshot review of a real wheel gesture, not video-level motion verification. The trace has 16 inward and 16 outward inputs at canvas-local (633, 434), corresponding to browser-page (633, 540); zoom returns to approximately 1.99.

The specific original **atlas-gpu left-to-right relocation is absent in these samples**. It begins left of web, clips off the left during inward zoom, and returns to the original left position after zoom-out. The central expanded component region is clear in `final-web-in-3.png`; the Details inspector stays populated for `@okie/web`. The minimap stays present with a recognizable viewport rectangle.

This does **not** establish that all background overlap has disappeared: `final-web-in-0.png`, `final-web-in-1.png`, and `final-web-out-1.png` still show the `atlas-protocol` card/border superimposed on lower incoming component cards and `atlas-engine` on right incoming cards. In `final-web-in-2.png` these outer silhouettes remain faintly visible. Their placement appears retained rather than sweeping across the focused branch, which addresses the strongest original defect; however, do not describe the screenshots as proof that every background shell fades completely before intersecting any incoming card. No L3→L4 after-fix recording was inspected in this bounded follow-up.


## Implementation and validation in progress

Background sibling representation now stays at `ghost.detail`, retaining prior-level placement rather than selecting the focused branch's deeper layout. Covered background nodes, their child silhouettes, routes and route labels fade according to world-space separation from the expanding focus and its already-expanded ancestors. Reverse zoom restores them in the same positions. Explicit focus transfer interpolates both endpoint visibility contracts. Minimap pointer mapping and world-fit code were not edited; it consumes shared projection visibility.

The first browser retest found that App cached the new opacity at progress zero. Therefore the first after screenshots prove only the layout fix, not the fade fix. The final integration separates cached projection topology from `applySemanticBackgroundVisibility` evaluated with each live progress, in both React and imperative render packets. A regression compares cached-topology sampling against direct projection sampling at a mid-transition. Endpoint tests cover p=0 and hidden context on explicit focus transfer.

Original pre-fix regression failed on deeper representation substitution; the first complete suite after policy changes passed974 tests. Integration targeted suite passed58. Final validation and updated browser evidence are recorded below. The goal is not complete; L4 fresh motion and full coverage remain outstanding.

## Final integrated midpoint check

After the App integration was changed to evaluate visibility at live morph progress, independently inspected `integrated-web-start.png`, `integrated-web-mid.png`, and `integrated-web-return.png` in `/tmp/okie-sept12-after/`. Source manifest: `docs/qa/zoom-continuity/source-state-sept12-background.json`, reported SHA-256 `d5596be6bff5c7e3505c8f7ba797609046981167409e5468285ad1c92bf33468`.

The new midpoint resolves the concrete overlap seen in the earlier `final-web-in-1.png`: `atlas-protocol` no longer overlays the lower incoming component rows, and `atlas-engine` no longer overlays the right-hand cards. The focused web grid remains visible and keeps its arrangement. In the return sample, web and its container neighbors regain their original arrangement, including `atlas-gpu` on the left. This supersedes the earlier midpoint overlap finding for this integrated sample.

The minimap remains visible at all three checkpoints with a viewport rectangle; the midpoint shows the expanded grid and the return shows the original container context. The right-hand Architecture brief also remains populated. This establishes visible state at checkpoints, not minimap dragging or click accuracy.

`integrated-web-trace.json` confirms 8 inward and 8 outward wheel events, no dropped trace samples, zoom range approximately 1.99–2.763, and return to approximately 1.99. Scope is this L2/component-reveal midpoint and return only. These screenshots do not establish every intermediate frame's continuity, video smoothness, a full settled L3 passage, or L3→L4 behavior.


## Final integrated checkpoint

The final web suite passes **974/974 tests in 99 files**, including the cached-topology regression. Scene compiler passes 121/122 on the initial run; the only failure was the generated evidence hash. Fixtures were regenerated and the corrected pin `07a5b526` passes all four golden fixture tests. Production build passes. Logs: `/tmp/okie-sept12-final-web.log`, `/tmp/okie-sept12-compiler.log`, `/tmp/okie-sept12-pin.log`, `/tmp/okie-sept12-final-build.log`.

Frozen product source manifest: `source-state-sept12-background.json`, SHA-256 `d5596be6bff5c7e3505c8f7ba797609046981167409e5468285ad1c92bf33468`. The latest browser evidence is specifically `/tmp/okie-sept12-after/integrated-web-{start,mid,return}.png` and `integrated-web-trace.json`; files beginning `final-web-` predate the App integration and are intermediate evidence.

The integrated trace contains 16 real wheel inputs (8 inward, 8 outward), 167 frame samples, no truncation and no dropped samples. Zoom spans 1.99–2.7632475479 and returns to camera (-237.76, -544.925, 1.99) within floating-point precision. The midpoint screenshot shows the focused component grid without the atlas-engine and atlas-protocol outlines that crossed it in the intermediate capture. The return screenshot restores the original container arrangement and populated overview inspector. This is bounded L2→L3 reveal/reversal evidence, not a frame-rate benchmark, full transition sweep, physical trackpad test or newly captured video. Native screencast produced no usable recording and was stopped.

The provided before videos were reviewed. Fresh L3→L4 motion in web/cameraBounds.ts and atlas-wasm/browser.rs, atlas-protocol coverage, and exhaustive per-node acceptance remain outstanding; the overall goal stays active.
