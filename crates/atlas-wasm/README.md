# atlas-wasm

Stable browser boundary for the Rust atlas renderer: a wasm-bindgen facade
exposing `WasmAtlasRenderer` + `create_atlas_renderer` (wasm32 only). Built into
`pkg/` by `scripts/build-wasm.mjs`; imported by `apps/web`'s `WasmRendererAdapter`.

- **Surface:** `lib.rs` re-exports `browser::{WasmAtlasRenderer,
  create_atlas_renderer}` on wasm32, plus `DiagnosticsPayload`, `PickPayload`,
  and `PickKind` on all targets.
- **Test:** `cargo test -p atlas-wasm` (native unit tests; the browser facade is
  `#[cfg(target_arch = "wasm32")]`).
- **Pins:** `browser.rs` is dogfooding-pinned; the crate name +
  `create_atlas_renderer` export are the frozen WASM boundary — see root
  `CLAUDE.md` gotchas.
