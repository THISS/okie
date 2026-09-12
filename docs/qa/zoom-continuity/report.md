# Zoom continuity QA inventory

Status: **not verified; 0 of 21,847 cases passed**. This inventory is not a completion claim. All cases and UI reachability checks start untested. Earlier narrow passes are historical only. The user reports that even L1 → L2 has regressed; it is explicitly included in the full retest.

## Verified inventory

Read the running server's `/scan/thiss__okie/snapshot.json` and matching `view.json` on port 4180 on 2026-09-09T13:36:09.607736+00:00. Both identify `snapshot:okie:722ea2862304` and repository `repo:okie`. All 3,121 snapshot entities occur in the served view. This proves data membership, not successful browser navigation to each entity. File hashes and the complete parent/child inventory are in `coverage.json`.

| Level | Entities | Meaning |
| --- | ---: | --- |
| L1 | 2 | Okie system and external Anthropic SDK system |
| L2 | 10 | Containers |
| L3 | 167 | File components |
| L4 | 2,942 | Code entities |

There are 2,947 leaves: 2,942 code entities, the external system, and four file components with no extracted children. No deeper transition exists for these entities in this snapshot. They still require inward/outward zoom stability, partial/reversal, restore, and minimap checks. The four leaf components are:

- `component:apps-web-src-inspector-inspector-support-ts`
- `component:packages-architecture-src-index-ts`
- `component:packages-scan-src-index-ts`
- `component:packages-scene-compiler-src-index-ts`

## Matrix and execution order

Every entity has seven separately tracked cases: zoom in, zoom out, partial zoom, reversal, restored URL, minimap indicators, and minimap navigation. Each case needs its own outcome and evidence, even if one recording supports multiple cases. Execute L1 first, then each of the ten container branches, each file, and every code entity. A data leaf is not a pass or an unreachable node. Record a UI reachability failure instead of quietly excluding it.

For each branch, establish the source level, select the target, confirm a nonblank inspector, record continuous inward input across the boundary, pause, and record uninterrupted outward input. Repeat with partial stops and explicit reversal, then restore the actual captured URL in a separate tab and repeat. Keep minimap and level indicators visible. Exercise minimap click and viewport drag before resuming zoom. Record adjacent routes `/`, `/new`, and `?fixture=scan` separately because they share state; the root scan fixture has a different snapshot and must not be counted as target-snapshot coverage.

## Acceptance and evidence

The requested standard is Figma-like smoothness: stable pointer anchoring, continuously transformed geometry, no frame jump at L1/L2/L3/L4 handoffs, no unintended backward motion, no outgoing-level edge overlay across incoming files, and an aligned minimap viewport and level indicator during motion as well as after settling. L1 → L2 is not a trusted baseline.

Use a full-frame-rate recording that includes canvas, cursor, minimap, and level indicator. Preserve original recording timestamps. Pair it with a monotonic input trace recording actual wheel event time, deltaX/deltaY, deltaMode, cursor coordinates, modifier keys, and viewport size/devicePixelRatio. Record camera x/y/zoom, semantic level, active lens/root, scene revision and observed render-frame time if a diagnostic mechanism is available. Record actual events; commanded scroll amounts alone are insufficient to prove what the browser received.

First capture a single uninterrupted inward gesture, then a single outward gesture. Perform the reversal test separately and mark the direction-change timestamp. Compare tracked node corners against the camera transform in consecutive frames; detect a discontinuity rather than judging expected scale change as jitter. Treat a large unexplained residual, opposite movement during uninterrupted same-direction input, a geometry jump at handoff, a stationary-input post-settle shift, or a minimap mismatch as failure evidence. Establish measurement tolerance from pixel rounding and capture noise rather than inventing a generous pass threshold. A low-rate contact sheet can locate an issue but cannot establish smoothness. Duplicated/dropped capture frames must be distinguished from application stutter using frame timestamps.

Each pass requires case ID/entity, final code revision and dirty-state identity, snapshot ID, active renderer backend, viewport, initial/restored URL, input trace, video path and reviewed time range, and explicit outcomes for camera anchoring, geometry/edges, inspector and minimap. A fix invalidates affected earlier evidence; retain it as historical and rerun the affected matrix. Tests do not replace browser exploration. Full completion requires every applicable case to have current evidence and no unresolved failures or untested cases.

## Implementation checkpoint — not motion approval

- Suppressed obsolete source-level routes touching the expanding owner while retaining valid next-level paths. The regression inspects intermediate projection contracts.
- App now reconciles the root live camera only when a new React camera is published, preserving the reached wheel position during semantic-state rerenders and asynchronous neighborhood arrival.
- Minimap receives the just-rendered scene, projection and camera. Its geometry follows the representation morph at all four levels; its drag uses the live camera. Extents interpolate between primary semantic ownership envelopes; dim ancestors and sibling ghosts no longer dominate the fitted scope.
- Historical generated evidence pin `5da5b2a0` predates the latest App changes and must be regenerated again. Latest web suite: 955 tests passed and one source-string assertion failed because the bridge now accepts frame metadata; the corrected assertion passes its 57-test focused suite. Current minimap-focused tests: 29 passed; web typecheck passed.
- Added opt-in local wheel/frame traces in diagnostics. Before/after evidence and independent Astra review are in `l1-inward-trace-review.md`. The publisher echo guard removed the observed backward zoom frame in repeat L1/L2 runs, but protocol video still shows geometry shaking. Full matrix execution and final full repository gates remain outstanding. Current changes are not a Figma-like smoothness approval.

## Historical motion review

The earlier `/tmp/okie-active-zoom-before.mp4` (20.07 seconds) showed a substantial L2 → L3 geometry/view change around 16.5–17.0 seconds, back-and-forth positions around 17–18 seconds, and a sparse central viewport by about 18 seconds. The input alternated wheel directions, so those frames alone do not prove unintended jitter. They also do not establish the provenance of visible thin lines as stale outgoing-level edges. This is historical diagnostic evidence, not passing coverage.

## Tool capability

CUA `getState()` succeeded and exposed the Chrome browser surface, including the target atlas URL. No parent browser tab was driven. Independent browser QA is available after coordinating an isolated tab and any shared recording/input ownership. Sandbox localhost reads initially failed; read-only escalated curl retrieved the actual served snapshot and view successfully. No production files or user audit documents were changed for this inventory.

## Active defect checkpoint — 2026-09-10

The Figma-like target supersedes the original L1→L2 baseline. A monotonic zoom value is insufficient to pass motion QA. Protocol full-entry recording (`/tmp/okie-goal-protocol-full-after.mov`, paired JSON) reaches settled L3 but visibly alternates geometry positions. Trace sequence 332 uses camera y=581.88455/zoom=5.55653 with prior projection progress .876609; sequence 333 uses the same camera with progress .949659. Sequences 341–343 repeat the pattern at settlement. This supports investigating camera/projection frame pairing; exact video-to-trace synchronization remains unverified.

Minimap scope scale is improved in the latest protocol and web endpoint captures. The tour launcher overlaps its lower-left area on a 623px-wide canvas; a container-width CSS adjustment was visually checked on the 623px canvas, and DOM bounds confirm no overlap (minimap y=624..743, launcher y=756..807). These observations do not constitute per-node matrix passes.

## Checked candidate — atomic frame update

Terra implemented a pending semantic frame packet. Camera, scene, projection, minimap publication and trace consume that packet until React acknowledges the same scene and session identities. Projection topology is cached between input samples. Astra low independently reviewed these repeat captures:

| Capture | Inputs / frames | Contrary zoom pairs | Camera-before-projection candidates | Result |
| --- | --- | --- | --- | --- |
| Protocol atomic inward | 45 / 380 | 0 | 0 | Settled L3; prior large excursions absent in inspected video samples |
| Web atomic inward | 30 / 226 | 0 | 0 | Settled L3; no new concrete visual defect found |
| Web atomic outward | 30 / 327 | 0 | 0 | Settled L2; no repeated large excursion found |

Original video/trace paths use `/tmp/okie-goal-protocol-atomic-after`, `/tmp/okie-goal-web-atomic-after`, and `/tmp/okie-goal-web-outward-atomic` with `.mov` / `.json` extensions. Detailed independent review and limits remain in `l1-inward-trace-review.md`. Inputs are separated controlled wheel bursts, not a verified uninterrupted physical trackpad gesture. Quantitative pixel anchoring and minimap alignment remain outstanding; these are targeted improvements, not full case passes.

Required gates passed: `pnpm check`, all TypeScript suites (1,518 passed, one skipped), `cargo test --workspace` (81 passed, one ignored), and `pnpm build`. Golden fixture evidence was regenerated; deliberate hash pin is `1e83e085`. `source-state.json` records the checked dirty source identity. No commit or PR was created.

Browser exploration: `/` renders and clicking Atlas web app populates its inspector; `/new` renders the signed-out scan form and its public atlas link works. On the target atlas, the overview story was played, jumped to step 3, and explicitly awaited `[data-playback-state="paused"]`; selecting @okie/web kept a populated inspector and paused playback. `/?fixture=scan` separately loads snapshot112c25f764e4 with857 entities, not the target snapshot.

Remaining goal work includes L3→L4 continuous handoffs (the existing code still contains deliberate arrival reframing), every other branch/node, partial/repeated reversals, restored URL motion, minimap navigation and quantitative alignment, and continuous input/backend coverage. Goal remains active.

## Subsequent candidate — retained L4 morph and canonical restoration

The checked candidate above is historical: subsequent App/bootstrap edits require fresh fixture generation and full gates. Its source identity and hash pin do not identify the current working tree.

L3→L4 now retains the source representation and uses the same authored detail morph contract in both directions. The previous hostedAtlas capture (`/tmp/okie-goal-web-l4-before.mov` and `.json`) contains an 80.757% zoom increase between adjacent frames at arrival. A valid fixtureBundle inward capture (`/tmp/okie-goal-fixturebundle-l4-after.mov` and `.json`) has 40 wheel inputs and 371 frames, reaches settled L4, and has a maximum zoom increment of 3.726%, matching its wheel steps. Its outward capture (`/tmp/okie-goal-fixturebundle-l4-outward.mov` and `.json`) has 40 inputs and 387 frames and returns to the starting L3 camera `(446.959, -241.815, 3.71572)` within floating-point precision. Neither trace contains contrary zoom pairs or camera-before-projection candidates. These are different files from the original defect, so they are not a matched hostedAtlas before/after comparison. Astra's independent review is recorded separately; continuous physical input and quantitative geometry/minimap alignment remain unverified.

Restored URLs now bootstrap the canonical root packet before loading lens/root/selection neighborhoods. Previously the web neighborhood boot contained 81 entities compared with the canonical packet's 3,121, and the restored view differed from the traversed endpoint. With canonical boot, the same restored web URL visually matches the original wheel endpoint. Thirty focused bootstrap tests and web typecheck passed. No speculative App restoration bridge was added.

A separate failure remains under repair: selecting hostedAtlas at L3 and clicking **Show on map** leaves an L3 semantic session at generic framing zoom `1.24`. Inward wheel input then replays a parent-level transition and ends on a blank L3 canvas at zoom `16.052`. The capture named `/tmp/okie-goal-web-l4-morph-after.mov` (and `.json`) records this failed setup, not successful L4 entry. The proposed correction frames using the current semantic detail's authored bounds and zoom interval. It must be validated before claiming the route is fixed.

### Show on map correction and reverse failure

The semantic-aware frame correction is now implemented. Actual hostedAtlas Show on map frames at zoom `5.27` while retaining L3. The following 35 inward inputs reach visible L4 code: `/tmp/okie-goal-hostedatlas-semantic-frame-inward.mov` and `.json`, 364 frames, maximum zoom step 3.726%, no contrary or split candidates. The former blank-L3 result did not recur. Fifteen focused tests and web typecheck passed.

The matching 35-input outward run (`/tmp/okie-goal-hostedatlas-semantic-frame-outward.mov` and `.json`, 369 frames) returns the selected card to its original bounds but **loses the surrounding L3 files and minimap grid**. No code entity or Source tab was opened between these gestures. Astra independently found the same visual failure in the earlier fixtureBundle reverse video. Both numeric camera round trips therefore fail scene restoration; zero contrary/split candidates must not be mistaken for successful visual QA. Repair is in progress.

### Runtime residency diagnosis

The first source-session correction did not resolve the browser failure (`/tmp/okie-goal-hostedatlas-neighbors-roundtrip.mov` and `.json`). An entity-metadata hypothesis was disproved by the actual scanned data and reverted. Astra's isolated source/bridge comparison matches all 64 visible object contracts; see `hosted-atlas-metadata.json` and the branch audit artifacts.

The trace now includes exact rendered scene roots and resident entry counts. `/tmp/okie-goal-hostedatlas-residency.json` establishes the live failure: sequence 1 has 62 component entries; sequence 8 has only 13 at the **same camera**, before L4 entry. Both use the same web root and settled L3 projection. The L4 handoff at sequence 100 retains those 13 entries; the return to the web root at sequence 634 still has 13. The viewport refresh therefore prunes the source peer set before the retained transition captures it. This is runtime evidence, distinct from the isolated helper audit. A correction is pending browser verification.

The minimap minimum-size viewport marker now preserves its projected center instead of drifting when its width/height reach 2px. The 29 focused minimap tests pass. The current Rust workspace tests also pass; current full TypeScript/check/build gates remain pending final source stabilization.

### Verified targeted correction

The L3 wheel path now avoids replacing its component peer layout during a zoom-only residency refresh. Explicit pan can still refresh the resident window. The repeat `/tmp/okie-goal-hostedatlas-residency-fixed.mov` and `.json` contains 70 wheel inputs and 660 rendered frames: component residency remains 62 throughout, with 26 code entries added on L4 entry. Astra independently verified no contrary zoom within either direction and confirmed that neighboring files and the dense minimap return at L3. A shareable excerpt is `/tmp/okie-hostedatlas-neighbors-restored.mp4`. The missing-peer defect is resolved in this targeted setup; intermediate geometry overlap is still under review, and the Figma-like smoothness goal is not approved.

The branch machine audit covers all ten containers and 167 files (`branch-contracts-report.md`): 144 have adjacent contracts, 29 files are absent from the current source projection and need UI residency/navigation coverage, and four files have no children. These are compiler observations, not browser passes. Additional read-only review found a separate lazy-source scene-clone/bridge-identity risk and an isolate-mode minimap visibility mismatch; both require actual reproduction before correction. Cold L4 URL reversal, remaining branches, continuous physical input, and full per-node visual coverage remain open.

Historical residency-fix candidate gates passed (before the later coarse-band, alignment, paging, and cold-reverse changes): `pnpm check`; 1,524 TypeScript tests (964 web, 115 architecture, 119 scene compiler, 172 scan, 154 server; one skipped); Rust workspace tests; and `pnpm build`. Regenerated golden evidence pin: `f92a5d51`. That earlier candidate source identity is in `source-state.json`; the earlier checked atomic candidate identity is preserved in `source-state-atomic.json`.

Current browser regression checks: target overview tour played, step 3 explicitly awaited paused, and selecting @okie/web populated Details without resuming playback. Root fixture entity selection populated its inspector; `/new` showed the signed-out form and its public atlas link was clicked; `/?fixture=scan` displayed a canvas and overview on its separate snapshot112c25f764e4. A minimap click at `(505.78676, 700.49274)` centered the viewport marker at `(505.78673, 700.49277)` and centered fixtureBundle in the main canvas, retaining zoom5.27. This is a single at-rest click alignment check; drag and continuous-motion alignment remain unverified.

Residual motion issue: Astra's consecutive video frames at35.141667→35.166667 show a neighboring component border shifting approximately110CSSpx relative to the nearly fixed code grid. The border's actual component representation does not change to code, disproving that hypothesis. Camera/progress changes during reverse structural compensation may explain the relative displacement; exact expected-geometry comparison is pending. Endpoint restoration passes the targeted observation, but smoothness remains open.

The exact trace calculation now identifies that remaining movement. One outward input changes progress from .511355 to .438304 and camera y from -296.565 to -308.093 at zoom10.1808→9.8151. With unchanged scanOnePager component bounds, its top moves134.12CSSpx; the selected code grid moves only about7px. The morph compensates for the selected file's component/code center offset of approximately159world units. Thus the relative movement follows the implemented camera compensation; it is not a stale projection or representation-threshold defect. The next implementation work must preserve normal zoom motion for surrounding geometry while keeping the selected transition coherent, with corresponding minimap and restored-URL checks. No arbitrary ghost-detail change was made.

## Coordinate consistency candidate — in progress

The previous goal turn made verified progress; completion remains unproven. New compiler work invalidates the preceding candidate's current-source identity and gate claim until rerun.

Actual cold/live audits found a second coordinate discrepancy: hostedAtlas, fixtureBundle, and scanOnePager component centers moved exactly52world units between container-focus and file-focus compilation. `ancestors()` includes the focused entity itself; unconditional ancestor inclusion inserted a file into the context band. It increased its container height from180 to284 and the system height from314 to418. Intrinsic layout used that system center, shifting all deeper coordinates by52. See `root-baseline-audit.json` and `component-anchor-audit.json`.

The architecture builder now includes ancestors only at their native or finer C4 bands. A new regression first reproduced the coarse-level leak and now passes; all116architecture tests pass. The scene compiler candidate centers a scoped code layout on its component representation after intrinsic placement and before routing, translating nodes, reserved shells, and remainder badges together. Live/cold equality, paging, motion video, minimap, and final repository gates are still being checked. This candidate is not a smoothness approval.

The aligned candidate was recorded in `/tmp/okie-goal-hostedatlas-aligned-roundtrip.mov` and `.json`. It retains the L3 endpoint neighbors and minimap. Its captured L4 URL also restores the same visible code grid at `(654.887,-410.223,18.96131)`; restored selection was absent from that captured URL, and the overview inspector remained populated. Astra's three-file audit confirms source/live/cold component centers now agree with code centers (`component-anchor-audit-after.json`).

Paging is a confirmed outstanding defect: a40×40window at the aligned code owner omits in-window children, and pinning one child retains it at changed bounds (`component-anchor-audit-after-pinned.json`). Selection occurs before final layout alignment, while final code placement currently derives slots from the surviving residents. The next correction must use canonical slot coordinates for selection and full sibling order for placement without materializing all code meshes or routing the full repository. Include a late, unpinned child beyond the initial resident cap in regression coverage.

### Shallow-band audit and cold L4 follow-up

Astra measured existing compiled owner-center displacement across L1→L2 (130.066 world units) and L2→full L3 (@okie/web 600.024; atlas-protocol 914.596; atlas-gpu 2652.103). Resident preview alignment alone does not cover these expanded endpoints. See `shallow-owner-centers-report.md` and its hashed measurements. Translation-only alignment before routing is being evaluated; no shallow-level motion pass.

The bounded paging candidate passed a 96-child late-symbol direct test but independent actual `ScanFixture.createScene` audits found the file-focus path did not enable `pageCodeLandmarks`. Terra is correcting this integration gap before further alignment work. Stable child geometry alone does not prove residency selection.

Cold restored L4 outward capture: `/tmp/okie-goal-cold-l4-outward.mov` and `.json`, 35 real outward inputs, 406 frames, no contrary zoom or camera/projection split candidates. At sequence 311 (zoom 7.32482), root changes from hostedAtlas file to @okie/web and component residency grows 10→62. This uses generic reverse handling because cold L4 does not install the retained reverse bridge. Astra visual review pending. Input gaps 168–1696 ms: separated actual wheel bursts, not continuous physical-trackpad proof. Endpoint public get_atlas_context confirms hostedAtlas selection; Overview content alone must not be mistaken for lost selection.

Astra confirmed the cold L4 capture has a visible discrete representation replacement near 15 seconds despite an unchanged camera at sequences310→311. The new local reverse installer reconstructs a full parent L3 endpoint and retains both levels before contracting from cold L4. Fourteen morph tests pass, including cold endpoint ownership and gradual midpoint; current-candidate video and full gates are pending. File-focus paging is now enabled through the actual scan fixture integration and its 96-child integration regression passes; independent actual-snapshot retest remains required.

### Combined alignment candidate: machine audit and gates in progress

Astra independent audit now finds L1→L2 owner-center delta0 and all ten L2→L3 owner-center deltas below2.85e-13. Three files have identical cold/live code membership and coordinates, zero missing window residents or shared-bound changes; late webmcp child is selected. All385 checked protocol representation bounds match the projection. Hashed artifacts: `final-shallow-owner-centers.json`, `final-component-anchor-audit.json`, `final-late-code-paging-audit.json`. The `final-` filenames name this bounded audit run, not final goal approval.

Full check and Rust gates pass. Full web suite initially had969passes and one obsolete assertion forbidding file code paging; that assertion now reflects enabled code paging and its four-test focused suite passes. Compiler full suite found three failures: committed cost payload bytes, persistent context-peer coordinates, and duplicate-route gutter readability. Terra is resolving them; these are not waived. Server tests passed154 after rerunning with permission to bind loopback fake gateways. Final combined gate rerun/build and browser motion are pending.

Cold reverse review found a lower-zoom saved endpoint could jump into the middle of a fixed interval. Reverse reconstruction now uses the pre-input rendered zoom as the full endpoint when below the usual full zoom. At arrivals10and7, new tests keep pre-input progress1 and the first outward wheel above0.9. Fourteen morph tests pass; no current-candidate visual pass yet.

### Checked alignment checkpoint and actual motion review

Alignment checkpoint source identity: `source-state-alignment.json`, SHA256895372cec280bb8c6c8c16e61f36e9d6cbcceff004c12ada4df61a70588b96eb (47dirty source/artifact files). All1534TypeScript tests pass (970web,116architecture,122compiler,172scan,154server; one scan skip), Rust workspace passes, check/build pass. Context-peer and duplicate-gutter failures are corrected, not waived. Golden evidence pin913693bd.

Astra repeat machine audit after those corrections: `verified-shallow-owner-centers.json`, `verified-component-anchor-audit.json`, `verified-late-code-paging-audit.json`; zero385protocol/projection mismatches, aligned owners, stable paging, and unchanged external peer bounds.

Actual L1 roundtrip `/tmp/okie-goal-l1-centered-roundtrip.mov`+`.json`:44inputs/396frames. Astra split both directions (22each), zero contrary zoom, no repeated large shake, usable minimap/inspector. A concrete title/type overlap is visible across12consecutiveframes at20.771667–20.963333s. The Canvas context boundary title baseline mistakenly used36 instead of68; Terra has corrected precedence and19typography tests pass. This label correction is AFTER the checkpoint identity/gates and awaits regeneration/finalvideo.

Actual restored L4 `/tmp/okie-goal-cold-l4-retained-outward.mov`+`.json`:35outward/443frames; all62components/26code remain resident fromfirstframe through rootreturn atseq318. Astra confirms gradual sampled return without previous discrete residency replacement and dense endpoint minimap. Restored zoom10 `/tmp/okie-goal-cold-l4-zoom10-outward.mov`+`.json`:20outward/196frames, firstprogress0.92695, unchanged residency through rootreturnseq126. This resolves the lower-zoom first-input discontinuity in the sampled case. All captures remain separated realwheelbursts, not continuous physical-trackpad proof or fullmatrix approval.

Related-flow exploration at this checkpoint: target story step3 explicitly awaited paused; selecting @okie/web populatedDetails and stayedpaused. Root fixture select_entity(web-app) populated its inspector. /new public atlas link clicked. /?fixture=scan displayed canvas/populatedoverview on separate snapshot112c25f764e4 (857entities at currentloadedstate).

### L1 label retest failed; further correction pending

The first label correction did not solve every morph representation. After regenerated pinb3dee893, compiler122/web968/build passed (temporary diagnostic tests removed, so web suite is99files). Source identity `source-state-label.json` e644d54393beaa862635057d77fb4bda181ca83ff74b92bbd1f4a7fd993ced56. Recording `/tmp/okie-goal-l1-label-fixed-roundtrip.mov`+`.json` has44inputs/388frames and per-direction monotonic camera; Astra still sees title/type overlap at10.0s inward and17.5s outward (`final-l1-label-review.md`). Coverage now explicitly fails system zoomIn/zoomOut/partialZoom for this defect; other21844cases remain untested, zeroformalpasses.

The remaining state uses the container boundary representation, whose title/kicker baselines36/24 are too close at the12px title floor. Terra is fixing spacing based on the actual font floor; do not accept a passing kicker-only spacing assertion as visual proof.

Web L2↔L3 actual capture `/tmp/okie-goal-web-centered-roundtrip.mov`+`.json` has70inputs/749frames. Root handoff into web occurs seq84z2.21925, outward rootreturnseq648z2.13954, no camera/projection split candidates. Astra review pending; do not equate mixed-direction analyzer empty contrary list with proof. ColdL4 before/after excerpt `/tmp/okie-cold-l4-before-after.mp4` uses old10–17s and new11–18s at original speed, comparable phases but not frame-synchronized.


Final L1 font-floor review — bounded improvement, coverage unchanged

The compact title/type collision is absent at inspected 10.0s and outward 19.0–19.5s frames. Expanded label states at 19.75–20.75s are also separated. No new title/description collision was observed; boundary description text is absent in these samples. Evidence: /tmp/floor10.png and /tmp/floor-out-labels.jpg.

The recording starts with the container layout already visible. Its first inward trace frame uses semantic-path:context:system:okie:settled, whereas its endpoint uses semantic-path:context:base:settled at the original camera (-393.525,-452.338,0.8037). This demonstrates a starting/ending scene discrepancy and prevents treating this as an equivalent complete inward L1 morph retest.

44 inputs / 409 frames, no truncation or dropped samples. Split at reversal: 176 inward and 233 outward frames, zero opposite zoom steps in each. This does not prove absence of all geometry jitter. Sampled minimap stays populated; exact alignment is unverified.

The prior three failed matrix cases remain unchanged pending equivalent inward/partial coverage. This records the observed label improvement without erasing failed history or claiming a global pass. Hashes and trace metrics are in final-l1-floor-review.json.


### Latest frozen validation and minimap checkpoint

The font-floor correction passed Canvas19, compiler122, web968 and production build. Logs: `/tmp/okie-goal-label-floor-compiler.log`, `/tmp/okie-goal-label-floor-web.log`, `/tmp/okie-goal-label-floor-build.log`. Evidence pin is a9dd7425; source identity is `source-state-label-floor.json`, SHA256 92f3b379020a1c2e19d660abc7803fcc841e62602f5e5b02f2c0b1373e90b627. Earlier complete check, architecture116, scan172+1skip, server154 and Rust gates apply to unchanged code outside the label correction.

Astra completed the centered web review: zero contrary zoom steps in each direction, zero serialized world-pointer drift across749frames; sampled movie has no large shake or blank endpoint. See `l1-inward-trace-review.md` for limits. Main-camera/minimap coordinate formulas agree to3.41e-13CSSpx across those cameras. A real CUA minimap drag of20px on each axis moved the SVG viewport20px exactly, kept its dimensions and zoom constant, and moved the main camera80.3036world units per axis as predicted. These are bounded checks, not a per-frame rendered-SVG or full-matrix pass.

The next browser sweep plan identifies174 deeper-boundary owners and2947leaves, with12files exceeding50code children. See `next-browser-sweep-plan.md`; all-node UI reachability must remain distinct from actual motion acceptance. The user superseded the original L1 happy-path baseline with Figma-like feel at every level, including L1. The goal remains active.


Normal-control L1 roundtrip review

This recording exercises base L1 → fractional morph → settled containers and the reverse back to base L1. Dense samples at 17–20s inward and 28–31s outward show separated compact and expanded title/type labels. No new title/description collision was observed. Evidence: /tmp/l1-control-in-label.jpg and /tmp/l1-control-out-label.jpg. The previously observed label collision is resolved on this tested path.

Trace contains 80 inputs and 819 frames, no drops or truncation. Inward: 346 frames, zoom 0.466767→1.944048. Outward: 473 frames, zoom 1.874216→0.45. Each segment has zero contrary zoom steps. The trace endpoint is 0.45, not the intermediate URL value 0.69801. No assertion is made that the fit flight had settled before input.

The sampled scene returns to its two L1 cards and minimap representation. No repeated large excursion is observed in the sampled sequence; exact per-frame geometry/pointer/minimap alignment remains unverified. The inspector remains populated with selected atlas-protocol, independently of the active L1/L2 canvas level.

The label defect is resolved in this bounded normal-control path. Full matrix case passes still require broader criteria, so coverage is not promoted to full passes here. Prior failed history remains available. Hashes and per-direction projection counts are in l1-control-roundtrip-review.json.


Coverage reconciliation on source-state-label-floor.json (pin a9dd7425): the three obsolete label failures now return to untested full-case status, with their exact failed evidence retained in history and the targeted resolution evidence attached. system:okie/restoredUrl is currently failed for restored-versus-live scene disagreement in final-l1-floor-review.md. Totals: 21,846 untested, 1 failed, 0 passed. These statuses apply to the recorded source version, before the upcoming restoration fix.


### Restored lens correction awaiting browser verification

The persisted lens path was structurally accepted even when its settled detail conflicted with the restored camera. The new validation checks the authored transition floor and hysteresis (protocol LOD fallback, then C4 band policy), preserving valid cold deep links below full expansion. Bootstrap and navigation restoration use it. Semantic lens tests27/27 and web typecheck pass; regenerated evidence pin357222e2 and focused golden tests4/4 pass. Source identity `source-state-restored-lens.json` f685b812eec85a23ecc25c2e7433edb2043d891fbb940820311b06e2afda5806.

The initial complete compiler run passed120/122: its hash mismatch was corrected and the hash gate passed; CLA-67 relative wall-clock performance failed while a Codex renderer was consuming approximately683%CPU. No performance assertion was weakened. The production build and serialized performance retest are pending at this entry.

An IAB reload during fixture regeneration went blank, emitted duplicate React createRoot messages, and later timed out even during tab focus/navigation. The causal relationship to regeneration is not proven. No application processes were terminated. A replacement Chrome QA session is being prepared, and the recorded restoredUrl defect remains unverified on this latest implementation. This browser/tool disruption is separate from completed frozen-source motion recordings.


Restoration validation update: production build passed. The serialized CLA-67 timing rerun passed7/7 (`/tmp/okie-goal-restored-lens-cost-rerun.log`) with its original assertion unchanged. Combined with the corrected evidence gate4/4, the two initial compiler failures are resolved; other120compiler tests passed in the full run. Browser functional verification and a final full web-suite run are still pending.


Chrome restoration review on pin 357222e2

The original system lens URL at (-393.525,-452.338,0.8037) loads two L1 cards and removes the invalid lens from its canonical URL. Diagnostics show two visible entities before input. A single up/down wheel pair produces 19 trace samples (2 inputs, 17 frames, no drops); first and every recorded frame use base:settled. The endpoint returns exactly to the original camera within floating-point precision. The trace begins after the first input, so it does not capture the literal boot frame.

The valid hostedAtlas cold URL at z10 retains all three lens entries, selects L4, and visibly displays seven code cards within its component. No truncation announcement is present.

This is independent functional evidence that the reported L1 restoration defect is fixed while the valid L4 endpoint remains available. Chrome canvas1256×871 differs from the original IAB viewport. No video, performance, full smoothness, or full matrix pass is claimed. CUA screenshots and the complete small trace were inspected; chrome-restoration-review.json records the observations and source hash. Browser ownership released.


Final restoration checkpoint: all969web tests in99files pass with two workers (`/tmp/okie-goal-restored-lens-web.log`). Astra independently checked Chrome after production build: failingL1 URL now shows two L1 cards, strips the invalid lens, and records base:settled for all17trace frames; one inward/outward pair returns to .8037. The valid hostedAtlasL4z10 URL preserves allthree lenses, showsL4 and seven code cards, without truncation announcement. This is functional restoration evidence in a different canvas viewport1256×871, not a motion benchmark or full restoredUrl scenario pass. The in-app browser remained unavailable after its earlier stalled development reload; no app process was killed.

Known label and restored-lens defects from this pass have targeted fixes and verification. Full174owner/2947leaf sweep, intermediate/reversal cases, complete rendered-edge/minimap parity, and physical trackpad input remain outstanding. Goal remains active.

Coverage reconciliation on pin357222e2: restoredUrl returns to untested with prior failure preserved in history and targeted Chrome resolution evidence attached. Current totals:21,847 untested,0failed,0passed. Full cross-boundary restored scenario remains outstanding.


## September 12: stable background during focused zoom

User recordings demonstrate sibling containers switching to a deeper layout during @okie/web zoom and dim background boundaries crossing deeper focused content. The local fix retains each background sibling's prior-level representation and fades covered background geometry and attached routes with live focus expansion. A browser retest caught and corrected App caching visibility at progress zero. Minimap pointer mapping and world-fit behavior were not changed in this pass.

Final validation: 974 web tests pass; production build passes; compiler 121/122 initially, with its sole evidence-pin failure corrected to 07a5b526 and the four golden fixture tests passing afterward. A real 8-in/8-out wheel trace returns to the original camera, and final midpoint screenshots remove the previously crossing boundaries. See [September 12 recording review and evidence](./sept12-video-review.md) for independent review, exact provenance and limits. This is a bounded local fix, not completion of the Figma-like smoothness goal or the exhaustive matrix.
