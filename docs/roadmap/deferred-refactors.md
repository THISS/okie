# Deferred refactors

Status: proposed roadmap (deferred maintainability work).

Catalogued out of the agent-friendly refactor because each item either perturbs the dogfooding pin / determinism contract or trades churn for marginal structural gain. Each entry states its precondition and verification gate so it can be picked up safely and attributably. Background: the refactor kept a hard invariant — **it touches none of the 29 dogfooding-pinned files, so it needs no fixture regeneration**. The items below are the work that invariant deferred.

Reminder that de-risks all of them: **entity IDs in the golden fixture are authored string literals, not path-derived** (`scene-compiler/golden-fixture.ts` `anchorDefinitions`). Moving or splitting a pinned file changes only its source-excerpt path/line anchors, never an ID or fingerprint. So every "pinned" item below is a *regenerate the excerpt*, not a *break the graph*.

## 1. Split `apps/web/src/App.tsx` (~4500 lines)

Pinned anchors: `App`, `CanvasViewport`; relations also cite `commitNavigation` and `setStep` in this file. Read `golden-source-excerpts.ts` for current line numbers — they are regenerated data, not stable constants. Anchor gotcha for the split: the `CanvasViewport` excerpt is anchored at a short-lined **usage site** near the end of `App()`, not at the declaration — the declaration's destructured-props line exceeds the excerpt max-line-length, so the generator's `safeAnchorLine` falls back to a later occurrence. Moving the declaration alone therefore does not move that excerpt, but relocating the JSX usage (e.g. into an extracted subcomponent) does.
- **Precondition.** Keep those symbols defined in `App.tsx`, or update `golden-fixture.ts` `anchorDefinitions` + `golden-source-excerpts.ts` and regenerate. Extract non-pinned subtrees (inspector wiring, story wiring, authoring overlay glue) into co-located modules; do not shift the anchor windows if avoiding regeneration.
- **Handshake.** Backend owns the pin/regeneration; run only after the golden-34 source-excerpt fix is stable.
- **Verify.** `pnpm --filter @okie/web check && test`; then `generate:source-excerpts` + `git diff --exit-code golden-source-excerpts.ts` (expect clean if anchors unmoved), else `pnpm generate:fixtures` + full suite.

## 2. Split `apps/web/src/semanticLens.ts` (1397 lines)

Not pinned. Safe.
- **Precondition.** None beyond its own coverage (`semanticLens.test.ts`, `semanticLens.qa.test.ts`). Do it inside `apps/web/src/semantic/`.
- **Verify.** `pnpm --filter @okie/web check && test`.

## 3. Split `compile-c4.ts` (898) and `c4.ts` (896)

Not pinned. Safe.
- **Precondition.** Split into **flat sibling modules at `src/` root** to preserve the flat package test glob (`node --test dist/*.test.js`). Keep `index.ts` barrel exports stable — the freeze list (`refactor-plan.md` §c C2/C3) must not change.
- **Verify.** `pnpm --filter @okie/architecture test` and `--filter @okie/scene-compiler test` (proves the glob still finds every test); `pnpm check`.

## 4. Split the oversized Rust files (all pinned)

`protocol_runtime.rs` (3378, `ProtocolEngine`), `mesh.rs` (1564, `build_mesh`), `surface.rs` (1158, `GpuRenderer`), `glyph.rs` (`GlyphAtlas`), `hit_test.rs` (`hit_test`), `lod.rs` (`LodController`), `scene.rs`/`patch.rs`, `browser.rs` (`WasmAtlasRenderer`, `create_atlas_renderer`).
- **Precondition.** A split moves a pinned symbol to a new file path ⇒ update the golden pins + `pnpm generate:fixtures`. Backend owns both the crate and the pin sources (within-team, no cross-team handshake), but it is still fixture churn — defer past the structural pass. `lib.rs pub use` keeps the cross-crate API stable regardless of internal file layout (freeze list C5), so consumers never see the split.
- **Verify.** `cargo test --workspace`; `generate:fixtures`; `pnpm test` (golden fixtures).

## 5. Relocate the story trio into `apps/web/src/stories/`

`storyPlayback.ts`, `storyFraming.ts`, `storyFocus.ts` are pinned (`createStoryFlight`, `frameEntities`, `storyFocusPresentation`). This is the one **cross-team** handshake.
- **Sequence.** (1) frontend `git mv` the 3 files + their tests into `stories/`; (2) backend updates the 3 `anchorDefinitions` paths in `golden-fixture.ts` and runs `pnpm generate:fixtures`; (3) verify. A pure move changes only the path strings — line numbers and IDs are identical.
- **Verify.** `pnpm check && pnpm test && cargo test --workspace`. Do only after golden-34 is green and stable.

## 6. TypeScript lint/format adoption

Deferred, not skipped. `rustfmt.toml` exists; TS has no linter/formatter.
- **Why deferred.** A formatter rewrites whitespace across every file, which can shift a pinned excerpt window (silent drift), and it adds a dev dependency mid-refactor.
- **Sequencing.** Adopt in a single dedicated commit **after** the structural reorg and **after** any pinned-file work; then run `pnpm generate:fixtures` once and commit the fixture delta together; pin the tool config. Consider Biome (single fast binary) vs ESLint + Prettier.
- **Verify.** Full suite green + `git diff` on `golden-source-excerpts.ts` reviewed deliberately.

## 7. Package test-glob change (only if packages are ever nested)

The package `test` script is `pnpm build && node --test dist/*.test.js` — a **flat** depth-1 glob. Nesting package source into subfolders would silently drop the nested tests from the compiled `dist/`.
- **Precondition.** If nesting is ever wanted, change the glob to `dist/**/*.test.js` in the **same** change that introduces the nesting. Until then, keep `packages/*/src` flat.
- **Verify.** Confirm the test count before/after is unchanged (no silent drop).

## 8. `pnpm-workspace.yaml` `allowBuilds` migration — resolved by backend

`allowBuilds` is the **current** pnpm key (added in pnpm v10.26); it supersedes `onlyBuiltDependencies`/`neverBuiltDependencies`. The file carried a half-finished migration to it — an unfilled placeholder value (`esbuild: set this to true or false`) still sitting alongside the deprecated `onlyBuiltDependencies: [esbuild]`. (An earlier draft of this catalogue mislabelled `allowBuilds` as non-standard; that was inverted — it is the modern key.)
- **Resolution (backend, task #4).** Complete the migration: `allowBuilds: { esbuild: true }` and drop the deprecated `onlyBuiltDependencies`. No longer an architect-deferred item.
- **Verify.** `pnpm install` resolves; `pnpm check` green.

## 9. Reduce static-mesh corner-tessellation memory

Measured at 5k nodes / 15k edges (QA stress profile, 2026-07-17): the retained static mesh is a 96 MB single GPU buffer of which **~70% (~67 MB) is rounded-corner arc tessellation** (`ROUNDED_RECT_SAMPLES_PER_CORNER = 11` → 132 vertices/rect), amplified **2×** because both LOD representations' geometrically identical fill rings are baked for all nodes (10,000 rects for 5,000 nodes). Cost is entirely upfront memory — warm frames are 0.5–2.3 ms with one draw call — so this matters only as node counts grow (linear scaling ⇒ ~1 GB at 50k nodes).
- **Two independent ~2× wins.** (a) Lower the per-corner sample count within the documented chord-error budget (mesh.rs's 0.18 CSS px at 32× comment is the constraint to re-derive); (b) dedupe the two LOD reps' identical rounded-rect fill geometry (share vertices, differ by style/draw-range).
- **Precondition.** `mesh.rs` is dogfooding-pinned; changes follow the regen flow. Re-run the QA stress profile after to verify the win and unchanged visuals (golden scenes + z32 chord-error acceptance).
- **Verify.** `cargo test --workspace` (projection/font/mesh qa tests); stress profile shows the expected buffer reduction; no visual diff at max zoom on golden captures.

## 10. Enable `noUnusedLocals` / `noUnusedParameters` — resolved

Enabled in `tsconfig.base.json` and `apps/web/tsconfig.json` (commit `7f5523a`). The flags immediately surfaced three real unused locals in `App.tsx`, removed in the same commit with the pinned-file regen flow. No longer deferred; kept here as the record.
