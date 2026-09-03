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
- **Pins:** both script paths are dogfooding-pinned in the golden fixture; keep
  `build-wasm.mjs`'s wasm-pack args + crate name frozen (the WASM import
  boundary). See the dogfooding-pin gotcha in root `CLAUDE.md` before editing.
