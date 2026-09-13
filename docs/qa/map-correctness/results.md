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
- `pnpm test`: passed: architecture125, scene compiler123, scanner204, web1037, server194.
- `cargo test --workspace`: passed.
- `pnpm build`: passed; existing Vite chunk-size advisory remains.
- No pinned source file changed. Builder fixture regeneration reported no tracked drift.
- Full committed scan comparison and Astra low browser QA: pending.
- Independent Astra medium review: pending, after scan and browser evidence.

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
