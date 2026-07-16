# Deterministic scraper and ingestion pipeline

Status: proposed roadmap.

The mechanism that turns a pinned repository into an immutable, evidence-backed snapshot, and the workflow by which AI agents contribute without being trusted. Constraints are set by [`../architecture/deterministic-first-ingestion.md`](../architecture/deterministic-first-ingestion.md) ("Pipeline and LLM constraints"); every guardrail below maps to a gate in [`../architecture/ingestion-golden-tests.md`](../architecture/ingestion-golden-tests.md). Principle, in one line: deterministic facts are produced before any model runs; **agents propose, validators dispose**.

## The gate already exists

`packages/architecture/src/extraction.ts` is the structured boundary the ingestion doc calls for — it is not new work, it is the seam everything plugs into:

- `ArchitectureExtraction` — "LLM-facing facts only" (`schemaVersion`, `entities`, `relations`). Snapshot identity, revisions, frozen source content, and view geometry are deliberately absent and supplied by the host.
- `validateArchitectureExtraction(value: unknown): ValidationIssue[]` — strict: rejects unknown keys (`additionalProperties:false` equivalent), enforces typed stable IDs (`stableIdPattern` + `prefixesByKind`), safe repository-relative paths (`isRepositoryRelativePath` rejects absolute, drive-letter, URI-scheme, and `..` paths), containment kind rules (`allowedParentKinds`), confidence in `[0,1]`, and length/count caps (`ARCHITECTURE_EXTRACTION_LIMITS`).
- `ArchitectureExtractionReconciliation` + `adaptArchitectureExtraction(extraction, metadata) → ArchitectureSnapshot` — the **host** maps each extraction id to `{ lineageId, fingerprint }` and stamps volatile metadata. A model cannot choose canonical identity.

A deterministic extractor and an LLM agent emit the **same** `ArchitectureExtraction` document and pass through the **same** gate. That is what makes untrusted proposals safe.

## Pipeline stages

| Stage | Produces | Today | Gap |
|---|---|---|---|
| 1. Pin | repo + commit/tree + dependency revisions | `snapshot.commitSha` (a synthetic golden revision) | real commit/tree pinning; dependency/submodule revisions |
| 2. Discover | candidate source set under include/exclude + redaction | — | deterministic, order-independent file discovery |
| 3. Extract | `ArchitectureExtraction` per scope | schema only | the language extractors |
| 4. Validate | `ValidationIssue[]` (atomic) | `validateArchitectureExtraction` ✅ | — |
| 5. Materialize | `ArchitectureSnapshot` + observed `Claim`s | `adaptArchitectureExtraction` ✅ (claims per schema doc M1) | claim emission |
| 6. Normalize | `NormalizedArchitecture` (snapshot-qualified rows) | `normalizeArchitecture` ✅ | persistence |
| 7. Enrich (optional) | bounded redacted packet → validated model output | — | packet builder, model call, replay/cache |
| 8. Publish | immutable snapshot + hashes + lineage | — | hash domains, `SnapshotLineage` |

Stages 4–6 exist. The scraper is mostly stages 1–3, 7–8 around a gate that is already built.

## Language extractor architecture

An extractor is a pure, versioned function:

```
extract(sourceBytes, config) -> ArchitectureExtraction   // deterministic, no I/O beyond given bytes
```

- **Contract, not implementation.** Extractors only need to emit documents that pass `validateArchitectureExtraction`. The validator already pins the target shape — typed stable IDs, allowed kinds (`Exclude<EntityKind,'boundary'>`; boundaries are synthetic), containment, repo-relative anchors — so extractor authors have an exact spec.
- **TypeScript** — the TypeScript compiler API (`ts.createProgram`, symbol and reference resolution) yields containers/components/code and `calls`/`reads`/`dependsOn` relations with `path`+`symbol`+line anchors.
- **Rust** — `syn` for file/crate-local structure first; `rust-analyzer` when cross-crate symbol resolution is needed. Recommendation, not mandate: start with `syn` because it is deterministic and dependency-light.
- **Identity is deterministic and versioned.** Entity IDs derive from `{extractor-namespace, version, language/kind/symbol}` (ingestion-golden-tests.md "Stable identity contract"); the same bytes always yield the same typed ID. Extractor name/version is recorded on every observed claim.

## Determinism guardrails → golden-test gates

| Guardrail | Maps to `ingestion-golden-tests.md` | State |
|---|---|---|
| Typed stable IDs; snapshot-qualified rows | Stable identity contract | validator ✅ / normalized ✅ / collision-suffix-after-canonical-sort ✗ |
| Canonical serialization (RFC 8785, NFC, LF, sorted sets, finite numbers, `-0`→`0`) | Canonical serialization | ✗ (today: `JSON.stringify` with stable key order in generators) |
| 8 hash domains (`inputManifestHash` … `semanticSnapshotHash`) | Hash and cache domains | ✗ |
| Discovery-order invariance over ≥100 shuffles | Golden fixture matrix (Discovery order) | ✗ |
| Platform / Unicode-NFC / identity-collision fixtures | Golden fixture matrix | ✗ |
| Evidence path-traversal / stale-commit / out-of-range | Evidence and derivation provenance | partial (path safety ✅ in validator; commit/line resolution ✗) |
| LLM replay / live / invalid corpus; cache one-field hit/miss | Structured LLM boundary; Cache | ✗ |
| Release gates 1–8 | Release gates | ✗ |

These become a dedicated ingestion test package. Today only the renderer/compiler path has golden tests (scene/excerpt drift); the ingestion matrix is unimplemented and is the release contract for credit-bearing scans.

## AI fan-out workflow

Multiple agents sweep one codebase in bounded scopes; the host merges deterministically.

1. **Scope.** Each agent owns a bounded region (a directory, a crate, a container subtree) and receives only that region's redacted claims/excerpts — no secrets, ignored files, or unrelated content (ingestion-golden-tests.md packet rules).
2. **Propose.** Each agent returns one `ArchitectureExtraction` citing only paths inside its scope.
3. **Dispose.** The host validates each document with `validateArchitectureExtraction` **atomically** — an invalid document contributes zero records and never blocks the deterministic base (deterministic-first-ingestion.md: an LLM failure must not block the snapshot).
4. **Reconcile + merge.** The host reconciles ids to `{lineageId, fingerprint}` and merges by typed stable ID. Collisions resolve by sorting on canonical source identity, so **agent completion order cannot change output bytes** — this is exactly the "Discovery order" golden row.
5. **Deterministic wins.** Where a deterministic extractor and an agent disagree on an observed value, the deterministic fact wins; an agent may add `inferred` claims or `Explanation`s but can never overwrite an observed value or invent evidence.

The MCP write path ([`mcp-surface.md`](./mcp-surface.md)) is the same submission gate, so human tools, agents, and extractors all converge on one validator.

## Milestones

- **M1 — deterministic TS extractor, dogfooded.** Run a TS extractor over Okie itself and adapt it through `adaptArchitectureExtraction`. *Acceptance:* the produced snapshot's entity/relation IDs are a superset of the hand-authored golden anchors in `golden-fixture.ts`; output is byte-identical across ≥100 shuffled discovery orders (Discovery-order + Platform + Unicode rows); per-file outline completeness — every exported/top-level symbol of a scanned file appears as a `code` entity with `path`+`symbol`+line anchors, so "what is in this file" is a grouped, `startLine`-sorted query (`get_file_outline` in [`mcp-surface.md`](./mcp-surface.md)), not new extraction. *Stretch:* the machine snapshot replaces the hand-authored fixture, folding source-excerpt regeneration into the scan and retiring the manual dogfooding pin (see [`deferred-refactors.md`](./deferred-refactors.md)).
- **M2 — rescan and diff.** Second scan at a new commit yields `SnapshotLineage` (schema doc). *Acceptance:* the "Rescan unchanged" and "Rescan change" rows — unchanged facts keep fingerprints (only audit time differs); a changed source/value/rule flips only dependent fingerprints and stales dependents; unrelated claims untouched. Overrides from `materializeArchitectureAuthoring` survive and conflicts surface.
- **M3 — bounded enrichment.** Add the redacted packet builder, the model call, and replay/cache keyed by the hash domains. *Acceptance:* "LLM replay" (identical accepted bytes under randomized citation order), "LLM live" (distinct hashes, no cache overwrite), the full "LLM invalid" corpus (atomic rejection, deterministic snapshot still publishable), and every cache key's one-field hit/miss test. Release gates 1, 5, 6, 7 satisfied before any credit-bearing scan.
