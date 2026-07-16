# atlas-engine

Deterministic, renderer-independent canvas state: camera math, semantic-zoom
LOD, hit testing, story/timeline compilation, the protocol runtime, and frame
diagnostics. No browser or GPU deps — unit-testable on every target incl. wasm32.

- **Surface:** `lib.rs` re-exports `Camera`/`Viewport`, `LodController`,
  `hit_test`, `ProtocolEngine`, `Scene`/`Node`/`Edge`, `Story…`, `Vec2`/`Rect`,
  plus `AtlasEngine` and `PreparedFrame`.
- **Test:** `cargo test -p atlas-engine` (unit + `tests/timeline_qa.rs`,
  `tests/visibility_lod_qa.rs`).
- **Pins:** `protocol_runtime.rs`, `lod.rs`, `hit_test.rs` are dogfooding-pinned
  in the golden fixture — see root `CLAUDE.md` gotchas.
