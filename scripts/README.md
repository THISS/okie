# scripts/

Repo-level generators run by root `package.json` before `check`/`build`/`dev`.
Outputs are gitignored and rebuilt on demand — never hand-edit them.

- **`build-wasm.mjs`** — wraps `wasm-pack build crates/atlas-wasm --target web
  --out-dir pkg`. Profiles: default `--profiling`, `--release`, `--debug`.
  Needs wasm-pack 0.13+. Run via `pnpm generate:wasm[:debug|:release]`.
- **`generate-stress.mjs`** — writes a deterministic seeded stress scene
  (`--nodes`, `--edges`, `--seed`, `--output`) under `fixtures/renderer/`.
  Run via `pnpm generate:stress`.
- **`measure-band-cost.mjs`** — CLA-67 per-band compile/payload/CPU-frame curve
  into `fixtures/architecture/band-cost-curve.json`. Does not change the 2000
  hang-guard. Run after building `@okie/scene-compiler`.
- **`measure-geometry-diagnostics.mjs`** — CLA-140 report-only route geometry
  diagnostics: rewrites `fixtures/architecture/geometry-diagnostics-baseline.json`
  and `docs/qa/geometry-diagnostics/*.svg`, then prints the grid-vs-all-pairs
  benchmark (`--no-bench` skips it). Run with `node --expose-gc` after building
  `@okie/scene-compiler`.
- **`evaluate-block-planner.mjs`**: CLA-149 Jev block planner vs the default Overview order on the
  thiss/okie system and containers (build `@okie/server` first).
  - `--capture --artifact=<scratch dir with copies of snapshot.json + operator-explanations.json> [--version=<publication id>]`
    rebuilds `fixtures/judgments/block-planner/nodes.json`: the real web composer (bundled by esbuild)
    picks the blocks and the server derivation supplies size and previews.
  - `--live --output=<path> [--max-dollars=≤0.10]` makes one Jev request per node (needs `JEV_API`).
    Each request reserves $0.003 against the cap, so a cap admits `cap / 0.003` nodes.
    `--write-replay` records the raw answers into `replay.json`.
  - `--replay --output=<path>` runs offline (CI asserts it in `apps/server/src/blockPlans.test.ts`).
- **`evaluate-claim-checks.mjs`**: CLA-145 held-out claim-check evaluation over
  `fixtures/judgments/cla145/heldout.json`, using the real server pipeline (build `@okie/server` first).
  - `--live --output=<path>` calls Jev (needs `JEV_API`). `--write-replay` records the raw answers
    into `replay.json`.
  - `--replay` runs offline against the recorded live answers in `replay.json` (CI asserts the same
    numbers in `apps/server/src/claimCheckEvaluation.test.ts`).
  - Reports per-category false acceptance and false alarms, review load, p50/p95 latency, cost and
    accuracy at several confidence thresholds.
- **`generate-claim-check-heldout.mjs`** re-extracts the held-out excerpt text from the pinned
  commit (`git show`). The labels live in the script and were fixed before any live run.
- **Pins:** both script paths are dogfooding-pinned in the golden fixture; keep
  `build-wasm.mjs`'s wasm-pack args + crate name frozen (the WASM import
  boundary). See the dogfooding-pin gotcha in root `CLAUDE.md` before editing.
