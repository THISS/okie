# Architecture index

Okie is layered: a semantic model compiles to a renderer protocol that a Rust/WASM engine draws.

```text
ArchitectureSnapshot + View + Story        packages/architecture
                 |
                 v   deterministic scene/story compiler
        packages/scene-compiler
                 |
                 v   protocol v1 JSON
CPU engine  ->  wgpu renderer  ->  WebGPU / WebGL2
crates/atlas-engine  crates/atlas-gpu  crates/atlas-wasm
```

The model holds claims + evidence; a view selects a subgraph and owns layout; the compiler turns intent into renderer objects, paths, LOD, and timeline cues; the renderer interpolates but never invents layout.

## Read this when…

**Architecture** (`docs/architecture/`)
- `renderer.md` — renderer boundary, protocol, browser contract, milestones.
- `band-cost-curve.md` — CLA-67 measured per-band compile/render cost vs node/edge count.
- `deterministic-first-ingestion.md` — provenance classes, pipeline/LLM constraints, rescan lifecycle.
- `ingestion-golden-tests.md` — byte-reproducibility, identity, hash domains, release gates.

**Product** (`docs/product/`)
- `golden-okie-hierarchy.md` — the frozen four-level self-map fixture + representation policy.
- `interaction-semantics.md` — semantic zoom, drill-down, story flights, Dim/Isolate, reduced motion.

**Roadmap — proposed** (`docs/roadmap/`)
- `README.md` — index + today-vs-proposed status table (start here).
- `structured-data-schema.md` · `scraper-pipeline.md` · `mcp-surface.md` · `deferred-refactors.md`.

## Per-member guides

- Packages: `packages/architecture/README.md`, `packages/scene-compiler/README.md`, `packages/theme/README.md`.
- Crates: `crates/atlas-protocol/README.md`, `crates/atlas-engine/README.md`, `crates/atlas-gpu/README.md`, `crates/atlas-wasm/README.md`.
- Tooling & data: `scripts/README.md`, `fixtures/README.md`.
- Agent onboarding, commands, conventions, and gotchas: `CLAUDE.md`.
