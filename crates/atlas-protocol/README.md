# atlas-protocol

Versioned wire protocol (v1, camelCase) for scenes, patches, geometry, and
timelines — the Rust source of truth mirrored by
`packages/scene-compiler/src/protocol.ts`. Pure data + validation, no rendering.

- **Surface:** `lib.rs` re-exports `geometry::*`, `patch::*`, `scene::*`,
  `timeline::*`, plus `PROTOCOL_VERSION` and `ProtocolError`.
- **Test:** `cargo test -p atlas-protocol` (unit + `tests/protocol.rs`).
- **Pins:** `scene.rs` and `patch.rs` are dogfooding-pinned in the golden
  fixture — see root `CLAUDE.md` gotchas.
