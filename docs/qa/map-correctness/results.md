# Map correctness validation

Implementation branch: `codex/map-correctness`, based on main `929a4ee`. No publication or deployment has been performed.

## Changes and evidence

- Blank foreground cards: a component resident at L3 could be globally removed because another band's reserved/omitted set contained it. Scene compilation now keeps resident representations and applies shell omission per band. A regression covers an L3 resident component omitted at L4.
- Rust relationships: SCIP `local N` identifiers are scoped to one document. Treating them as global created false calls between unrelated files. Local symbols are excluded from published symbol targets; ambiguous global definitions remain excluded even after additional occurrences. Regressions exercise the actual geometry/camera case and preserve real calls.
- Rust browser coverage: source cfg mentions of wasm32 trigger an additional wasm32-unknown-unknown index. This target is explicitly reported as inferred. Cargo default features are used; optional features and other targets remain limitations.
- TypeScript: committed scans can read installed dependency declarations after matching committed manifests and lockfiles. Working-tree source and symlinks to external source are rejected. Installed contents are not verified against the lockfile, and the report explicitly says so. No dependencies are installed by this change.

The full TypeScript-only comparison reduced TS2307 diagnostics from 586 to 3, and total reported limitations from 2728 to 1923. JavaScript repeats the same diagnostic list and must not be double-counted. Remaining TS2307 entries concern undici-types, generated atlas_wasm.js and generated stress-5000.json. The baseline and current source commits differ, so these totals describe the observed scans rather than a controlled identical-source benchmark.

## Verification

- `pnpm check`: passed.
- `pnpm test`: passed: architecture125, scene compiler123, scanner203 passed/1 optional live GitHub test skipped, web1037, server194.
- `cargo test --workspace`: passed.
- `pnpm build`: passed; existing Vite chunk-size advisory remains.
- No pinned source file changed. Builder fixture regeneration reported no tracked drift.
- Full committed scan comparison: passed concrete relationship and coverage checks below.
- Astra low browser QA: passed sampled flows documented below.
- Independent Astra medium review: found one P2 isolation escape; fix independently rechecked with no remaining actionable findings.

## Live enrichment limitation

The established local gateway configuration reports OpenRouter model `z-ai/glm-5.3-flash`, keySource `none`, keyConfigured `false`. Real enrichment quality cannot be evaluated in this environment until a key is configured through the normal local mechanism. No fake output is counted as live enrichment evidence. The isolated operator QA harness uses an explicitly fake model and is suitable only for UI behavior.

## Fresh full committed scan

`okie-scan --source /Users/brenton/sites/okie --full` completed at source `f25b185505163abeecb9c826fcb1de0f073f4771`, tree `ec6e17dee294a3bc7dd0db2ca6bac42b0a3d815c`. Bundle retained locally at `.okie-review/map-current/atlas.okie.json`; detailed temporary artifacts at `/tmp/okie-map-f25b185`.

| Observed metric | Baseline | Current |
| --- | ---: | ---: |
| Entities | 3577 | 3582 |
| Relationships | 9372 | 8814 |
| Calls | 3145 | 2938 |
| Uses | 5286 | 4965 |
| Depends on | 849 | 818 |
| Duplicate declarations | 92 | 93 |
| Relationships with browser.rs evidence | 0 | 131 |
| TS2307 diagnostics | 586 | 3 |

Lower relationship totals are not a coverage score: invalid local-symbol targets and ambiguous definitions are omitted, while dependency type resolution changes dispatch attribution. The commits also differ. Concrete acceptance: both false geometry `is_valid_color` → camera Viewport calls are gone; calls from `Stroke::is_valid`, `Primitive::validate`, `SceneSnapshot::validate`, and `Timeline::validate_for` remain, with source evidence. The function still has a legitimate `uses` relationship to Color.

Rust no longer reports browser.rs as unindexed. One ambiguous SCIP symbol remains explicitly omitted. Other Rust targets and optional features are not covered by the inferred wasm/default-feature passes.

## Browser execution notes

The native file chooser and then the browser's scripted file chooser stalled/refused import. These attempts establish no artifact-import acceptance. For renderer QA only, the fresh bundle was temporarily served through the supported `atlas.okie.json` packaged-artifact path; this avoids the picker and exercises the same portable renderer.

Coordinator golden-fixture exploration: launched the guided story, jumped to step4, explicitly waited for `[data-playback-state="paused"]`, and verified the selected `selectScopedView()` code card and populated Details pane. Open source produced the dedicated normalized.ts source tab with frozen lines600–605. `/new` correctly displayed operator-only scan guidance and public-atlas navigation. Screenshot captured inline in the task; no video was recorded.

Astra low fresh-scan visual pass: web L3 showed source-path labels; clicking navigationState.ts selected the matching component and populated inspector. L4 showed named code cards; canonicalNavigationState selection showed7 dependencies and3 dependents. Reverse L3 restored component cards, with a coherent minimap viewport. Protocol L3 displayed all5 Rust source cards; src/scene.rs selected the correct component with15 children and dependency details. Inline screenshots cover these states. One CDP input timeout was checked and the action had completed; no persistent issue was observed. This is sampled visual acceptance, not a continuous60fps/Figma-feel benchmark or exhaustive verification of every entity.

Coordinator extended protocol sample: geometry.rs L4 Fit displayed all7 named code cards. Selecting is_valid_color showed1 Color use and4 real callers in Overview, matching the scan evidence. Zoom-in/out controls, reverse L4→L3→L2→L1, Fit and drag panning remained usable, with the minimap showing the corresponding context cards. No continuous frame timing was measured.

Independent Astra medium review found a P2 transitive dependency declaration escape: a declaration under node_modules could import dirty working-tree source using a relative path. Fixed in58bfd7d and independently rechecked: dirty-source imports, external relative imports and external symlink targets are unresolved; trusted compiler libraries remain available for a separate repository. Earlier direct/symlink isolation tests did not cover this transitive case.

After the isolation fix, the scanner suite reran with203 passed,0 failed and1 optional live GitHub test skipped (same intentional skip as the initial full-suite run). No live provider test was enabled.

## Final reviewed commit

Final full scan at `58bfd7d1a46c5e31a82035d8070b99869f89df63` (tree `f91d1fd95ef26fbfe3d3cc4404ca99db15addac9`) retained3582 entities,8814 relationships,131 browser.rs evidence relationships and4 real is_valid_color callers, with no false Viewport call. TS2307 is now2: only generated WASM and stress-fixture inputs remain unresolved. The earlier undici-types diagnostic is resolved. The current bundle at `.okie-review/map-current/atlas.okie.json` has been replaced with this final scan; detailed outputs are at `/tmp/okie-map-final`.

Final `pnpm check` and `pnpm build` passed after the isolation fix, alongside the scanner-suite rerun. Earlier full repository tests and Rust workspace tests passed; no renderer or Rust changes followed visual QA. The temporary public bundled artifact was removed. No push, merge, atlas publication or deployment was performed. The goal is complete with the explicitly documented live-enrichment credential limitation and sampled visual-QA limits.
