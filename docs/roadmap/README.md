# Okie roadmap

Status: proposed roadmap.

Forward-design documents for the deterministic-first architecture atlas. Audience: maintainers and coding agents. These describe where the semantic core is going, not what ships today.

They build on — and gap-analyze against, never restate — the two accepted boundaries:

- [`../architecture/deterministic-first-ingestion.md`](../architecture/deterministic-first-ingestion.md) — provenance classes, pipeline/LLM constraints, rescan and review lifecycle.
- [`../architecture/ingestion-golden-tests.md`](../architecture/ingestion-golden-tests.md) — byte-reproducibility, stable identity, hash domains, golden fixture matrix, release gates.

Read those first. Every recommendation below is tied to a current file or symbol.

## Reading order

1. [`structured-data-schema.md`](./structured-data-schema.md) — evolve the stored model toward first-class provenance, claims, explanations, and a rescan lifecycle.
2. [`scraper-pipeline.md`](./scraper-pipeline.md) — produce snapshots deterministically; how agents propose and validators dispose.
3. [`mcp-surface.md`](./mcp-surface.md) — expose the structured data to agents over one shared query layer.
4. [`deferred-refactors.md`](./deferred-refactors.md) — maintainability work intentionally deferred out of the agent-friendly refactor, with each precondition.

Operational / distribution layer (how scans run and reach users): [`scan-runner.md`](./scan-runner.md) — source access, checkout, refresh cadence; [`embed-hosting.md`](./embed-hosting.md) — hosting the atlases and the docs-site embed growth loop.

## Status: today vs proposed

| Capability | Today (file · symbol) | Gap | Doc |
|---|---|---|---|
| Semantic model | `architecture/model.ts` · `ArchitectureSnapshot/Entity/Relation/View/Story/Overrides` (v1) | facts embed flat `sourceRefs` + `confidence?`; no `Claim`/`Explanation` | schema |
| Provenance classes | `apps/web/provenance/presentation.ts` · `ClaimOrigin` (**presentation only**) | not stored; UI re-derives `observed/inferred/ai-explanation` at render time | schema |
| Identity / lineage | `model.ts` · `lineageId?`,`fingerprint?`; `normalized.ts` · `logicalId` + snapshot-qualified row `id` | no diff-status lifecycle; no reconciliation runtime | schema |
| Extraction boundary | `architecture/extraction.ts` · `ArchitectureExtraction`, `validateArchitectureExtraction`, `adaptArchitectureExtraction`, `ArchitectureExtractionReconciliation` | producer shipped (`@okie/scan`); no dependency pinning/hash domains yet | scraper |
| Deterministic extractors (TS/Rust) | `packages/scan` · `okie-scan` — TS syntax extractor, commit-pinned, shuffle-deterministic, 31/31 golden TS anchors; loads via `?fixture=scan` | Rust extractor; type-aware depth; per-file outlines need exported+top-level coverage review | scraper |
| Self-map fixture | `scene-compiler/golden-fixture.ts` (hand-authored) + machine scan (`fixtures/scan/`, gitignored) | golden fixture still hand-authored (M1 stretch: retire it) | scraper (M1) |
| Canonical serialization + hash domains | — | RFC 8785 profile + the 8 named hashes | scraper |
| Rescan / diff | — | `unchanged\|changed\|new\|no-longer-observed` | schema + scraper |
| Incremental rescan | — | commit-diff-scoped re-extraction + incremental≡full equivalence gate | scraper |
| Tiered specs (summary → deep dive) | — | `SpecDocument` sections, claim-grounded, assistant-retrievable | schema + mcp |
| Enrichment (LLM) | `packages/scan` · `--emit-packets`/`--enrich-from` — bounded redacted packets, recorded-replay merge, atomic per-container gate; dogfooded 5/5 on Okie (34 logical components) | live-call adapter, response capture, hash-domain cache | scraper |
| Overrides / corrections | `architecture/authoring.ts` · `create/apply/materializeArchitectureAuthoring` | conflict surfacing vs new observations | schema |
| Normalized store | `architecture/normalized.ts` · 14 tables, in-memory | persistence; cross-snapshot reference rules | schema + mcp |
| Query layer | `normalized.ts` · `selectArchitectureSnapshot/View`, `selectScopedView`; `scene-compiler` · `serializeDynamicFlowMermaid` | not exposed to agents | mcp |
| MCP server | — | read resources + extraction-submission write | mcp |
| GitHub acquisition + multi-repo serving | `packages/scan` · `scanGithubRepository`, `discoverExtractedTree`, `manifest.ts`; `apps/web` · `?fixture=scan:<slug>` | webhook/cron freshness; diff-scoped incremental | scan-runner (R3) |
| Embed / hosting | `apps/web` static `vite build`; `scanFixture.ts` per-repo trios (build-time `import.meta.glob`) | runtime-fetch loader, `/r/*` + `/embed` routes, object-store hosting, commit-pinned caching | embed-hosting |
| Ingestion golden tests | renderer/compiler golden tests only | the `ingestion-golden-tests.md` matrix is unimplemented | scraper |

## Non-goals (unchanged from `renderer.md`)

Billing, real-time collaboration, arbitrary vector editing, and export beyond deterministic Mermaid/PNG remain out of scope. This roadmap concerns the semantic core (model, ingestion, query surface), not the renderer.
