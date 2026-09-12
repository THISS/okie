# Inspector browser acceptance — 2026-09-12

Actual Chrome interactions through CUA at http://127.0.0.1:4175, staging implementation with server 4182. No paid scan, application edits, or Playwright CLI. Screenshots demonstrate settled states; no documented video recording API was available and smooth camera animation is not certified.

## Defects found

- **P1 named flow crash (fixed and retested):** published `/r/THISS/okie`, select `@okie/web` → `src/App.tsx`, Details → `Okie: Paste a repository`. Entire application becomes blank. Console: `Cannot compile invalid dynamic flow: steps[0].authoredHoldMs is not allowed` (same for steps 1–3), at `compileC4DynamicFlowArtifact` called by App useMemo. `browser-named-flow-failure.png`.
- **Fixed and retested:** Overview child navigation changed canvas/URL selection but retained system Overview. Following correction, published package → file → App symbol each displays own identity and immediate parent, preserving Overview.
- **Fixed and retested:** count headings ran together; screenshot now separates counts. Earlier Show on map action wrapped one word per line; builder reported correction (final visual recheck not performed).
- Scoped Parent name/type spacing was corrected in the final version. Mermaid toggle similarly native gray outside diagram content alignment. Screenshot evidence retained.

## Exercised successfully

- `/`: system Overview; missing source explanation on Atlas web app; search `selectScopedView` while Source active preserves tab and shows frozen golden excerpt lines 600–605. Details distinguishes one Calls and one Uses relationship.
- Golden aggregate reveal retains original `selectScopedView()` and Details, moves to component representation and changes concrete call to known-not-shown without removing inventory. Revealing that hidden call restores two code endpoints and visible connecting edge. Minimap representation follows final camera. Aggregate feedback explicitly says aggregate representation.
- Guided story: clicked tour, jumped step 4, waited on DOM `[data-playback-state="paused"]`; selected symbol inspector nonblank. Isolate retains both inventory rows; hidden call row opens endpoint/evidence context with frozen revision.
- Dependency action opens separate named tab, 3 participants and 2 interactions. Mermaid rendered corresponding edges. Main returns same selection, Details, and camera.
- Information action: click/tap opens visible explanation; keyboard Tab/Shift+Tab reaches information control. Hover not tested.
- `/new`: public unauthenticated page with disabled Scan and published atlas link. Followed link to `/r/THISS/okie` successfully.
- Published system children initially 5 of 10; Show all expands in place, order survives Zoom in. Package children 5 of 79, file children 5 of 22 and dependencies 5 of 49, App dependencies 5 of 214. Expanding App 214 then selecting parent file resets file dependencies to first 5 of 49.
- Published App source: frozen `722ea2862304`, full-file link contains exact `722ea2862304eae579a7b354bc7cfa0697f4e997`; Load more expands 1201–1212 to 1171–1242 retaining frozen revision. Initial request was interrupted by development hot reload; retry completed successfully.
- Code structure correction: App.tsx opens separate named tab with 23 participants (scope plus all 22 direct symbols), 27 interactions. Main return preserves file selection/Details/camera.
- `/?fixture=scan`: 112c snapshot loads, package Overview scoped correctly; map drag and minimap drag update camera while list and selected package remain stable.

## Limits

No browser certification of new extraction/exposure metadata: these older scans do not contain it. No induced historical-source failure, adversarial delayed-response selection race, cache-boundary test, exhaustive 0/5/6 coverage for every list, or video timing/smoothness measurement. Backend determinism/extraction/revision validation and repository gates belong to code/tests review. Named flow crash was fixed and retested; no remaining functional blocker was found in the exercised browser paths.

## Screenshots

- `browser-scoped-overview-fixed.png` — corrected package overview and separated counts.
- `browser-source-context.png` — expanded source with frozen revision.
- `browser-code-structure.png` — all direct code participants.
- `browser-dependency-mermaid.png` — rendered dependency diagram.
- `browser-tooltip.png` — tapped explanation.
- `browser-reveal-aggregate.png` — aggregate reveal and pre-fix action styling.
- `browser-stale-overview.png` — pre-fix selection defect.
- `browser-named-flow-failure.png` — blank named flow failure.

## Final retest and user-port smoke

Named flow fixed at 4175: same App.tsx → Paste a repository path opens named tab with 42 participants, 38 interactions and 4 ordered steps; Main returns selected App.tsx. Evidence: `browser-named-flow-fixed.png`.

User-facing http://localhost:4173/r/THISS/okie smoke also passed package/file contextual Overview, same named flow opening and Main return, App Source selection, and Load more context to 1171–1242 frozen at 722ea2862304. The active backend on this port was Canvas 2D preview/software fallback (existing dev settings), so this is not GPU or smoothness verification.

## Final keyboard-tooltip verification

After sanctioned CUA availability check returned no errors, tested current main localhost:4173 (ordinary span/button implementation). Fresh Details → Tab four times reached About dependencies without clicking it. The collapsed button had keyboard focus and the explanation was visibly rendered (browser-tooltip-keyboard-focus.png). Escape hid the explanation while retaining trigger focus, selected Okie entity, and Details inspector. Clicking the trigger then reopened it; a second Escape again hid only the tooltip and retained inspector/focus. Hover remains unverified; no documented hover action was available. Existing dev/backend state was unchanged.

## New deterministic extraction fixture and hover

An isolated synthetic scanner fixture at 4176 (`scan:qa__inspector`, fake immutable pin of forty 1s; not a real repository or paid scan) was exercised. publicApi shows Exported symbol and Public API; expanded evidence identifies src/api.ts line 1 and package entrypoint export in package.json. internalHelper shows only Exported symbol; Called by 8 initially displays extra0–extra4 and Show all 8 reveals extra5, extra6, publicApi. neverCalled shows only Exported symbol and No relationships captured, with no inferred entrypoint. Its parent src/cli.ts shows Entry point with package bin evidence. recurse has no exposure and exactly one Recursive relationships call. Screenshots: browser-exposure-public.png, browser-exposure-cli.png.

A false C4 error was found for valid recursive calls (distinct endpoints diagnostic), also shown in unrelated inspectors; fixed and retested: recurse retains exactly one recursive call with no C4 error, and unrelated publicApi inspector is clean (browser-recursion-fixed.png).

Hover independently verified with normal clicks then Tab: clicked dependency info open, clicked again to close tap state, then Tab moved focus to code structure while pointer stayed over info. Read-only DOM observed hover=true, focusWithin=false, data-open=false, dismissed=false, tooltip display=block; screenshot browser-tooltip-hover.png shows visible explanation. No synthetic events or CDP used.

Updated SourceViewer normal-transport smoke at 4173: App Load more → select activeSnapshot → Source → back history → App Source. Correct App excerpt 1201–1212 returns with enabled Load more; no stale B or stuck loading observed. Tool/network timing does not certify an adversarial pending A→B→A schedule; controlled tests remain the evidence for that race.

Final coverage supersedes earlier chronological limits: hover and synthetic new extraction exposure are now browser-verified. Adversarial source timing and animation smoothness remain limited as described.

## Built-in rendered-frame reveal traces

Used existing app diagnostics on main localhost:4173: Start zoom trace → selected symbol relationship Show on map → Save zoom trace → Last zoom trace JSON textarea. Saved individual hidden-call reveal as relationship-reveal-trace.json (38 samples, initial zoom 1.24 to 13.96) and aggregate reveal as relationship-reveal-aggregate-trace.json (13.96 to 5.27). Original selectScopedView and Details were retained. Diagnostics was closed afterward; existing dev/backend preferences unchanged. Traces contain actual rendered camera samples for independent continuity analysis; this is not a video or a GPU performance certification. Active Canvas2D fallback diagnostics reported GPU fragment binding-visibility validation failure. One input timeout after starting the first trace was recovered by checking recording state before executing reveal.

### Rebuilt GPU renderer and repeat relationship flights

Reloaded current main on localhost:4173 after WASM regeneration. Diagnostics now reports `webgpu`, hardware accelerated, and GPU renderer active; the previous fragment binding visibility failures are absent. Both actual Show on map actions retained selectScopedView() and Details. Individual reveal moved zoom 1.24 → 13.96; aggregate reveal moved 13.96 → 5.27 with truthful aggregate feedback and aligned minimap. Diagnostics was closed afterward; backend preference was not changed.

Saved built-in UI trace textarea exports: `relationship-reveal-trace_gpu.json` (37 samples) and `relationship-reveal-aggregate-trace_gpu.json` (38). Both headers/frames identify webgpu. Screenshots: `browser-webgpu-diagnostics.png`, `browser-webgpu-reveal.png`.

The GPU initialization fix does **not** establish smooth motion: consecutive changed-camera intervals remain individual median 65.75ms/max 67.1ms (10), aggregate median 66.4ms/max 75.7ms (8). Render execution diagnostics (~0.3ms median) are distinct from frame cadence. Thus smoothness remains unresolved pending investigation, despite functional camera framing and active GPU. The sanctioned DOM evaluation facade did not expose document.hasFocus; no unsupported focus workaround was attempted.

### Native foreground control follow-up

Sanctioned native Chrome AX initially showed the published user tab selected and the QA GPU tab unselected. Raised the Chrome window using its exposed Raise secondary action and clicked the QA tab; native AX confirmed QA selected. Repeated one individual flight while selected, z5.27 → 13.96, saved `relationship-reveal-trace_foreground.json` (31 samples). Native window afterward still showed the QA golden URL. Cadence remained poor: 8 changed-camera intervals, median70.9ms/max99.9ms. Foreground selection alone did not resolve the slowdown. Diagnostics closed afterward; inspector still selectScopedView()/Details.

### Final stable motion acceptance

After final ownership/diagnostics-deferral changes and rebuilt assets, actual localhost:4173 WebGPU traces now show individual 71 samples/52 changed-camera intervals (median8.3ms, maximum17.7ms), aggregate59 samples/47 changed-camera intervals (median8.3ms, maximum17.0ms). Saved `relationship-reveal-trace_final.json` and `relationship-reveal-aggregate-trace_final.json` through the visible built-in trace textarea using normal select/copy. These final traces supersede the earlier slow-flight measurements for current implementation. Individual settles5.27→13.96, aggregate13.96→5.27; selectScopedView()/Details retained, individual endpoints and edge visible, minimap aligned (`browser-final-reveal.png`). Backend remains automatic/WebGPU; diagnostics closed.

Final published route smoke navigated Okie→@okie/web→src/App.tsx using Overview children; final camera zoom5.27, selected App file, scoped Overview dependencies49/children22, firstfive+Showall, nonblank map and aligned minimap (`browser-final-published-hierarchy.png`). No paid scans or backend preference changes. Sub120ms wheel/reveal overlap was not claimed browser-tested; parent reports controlled fake-timer coverage for that ownership edge case.
