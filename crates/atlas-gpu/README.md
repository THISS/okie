# atlas-gpu

WebGPU-first rendering for the atlas protocol, constrained to WebGL2-safe
vertex/index/uniform capabilities (no compute or storage buffers). Owns the
glyph atlas, mesh building, and the GPU surface/backend selection.

- **Surface:** `lib.rs` re-exports `GlyphAtlas`/`GlyphQuad`, `mesh::{build_mesh,
  GpuMesh, Vertex, …}`, and `BackendPreference`/`GpuError`/`GpuRenderReport`/
  `GpuRenderer`.
- **Test:** `cargo test -p atlas-gpu` (unit + `tests/font_roles_qa.rs`,
  `tests/projection_morph_qa.rs`).
- **Pins:** `surface.rs`, `mesh.rs`, `glyph.rs` are dogfooding-pinned in the
  golden fixture — see root `CLAUDE.md` gotchas.
