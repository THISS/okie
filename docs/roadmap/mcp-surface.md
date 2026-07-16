# MCP surface

Status: proposed roadmap.

An MCP server that exposes the structured, evidence-backed graph to agents — read-first, with a single guarded write. It shares one query layer with the viewing platform and never becomes a second, divergent path into the data. Provenance honesty and redaction follow [`../architecture/deterministic-first-ingestion.md`](../architecture/deterministic-first-ingestion.md) and [`../architecture/ingestion-golden-tests.md`](../architecture/ingestion-golden-tests.md) (release gate 8: no raw prompts, secrets, absolute paths, or private excerpts in any public surface).

## The query primitives already exist

MCP tools are thin transport over functions that ship today in `packages/architecture` and `packages/scene-compiler`:

- `normalizeArchitecture({ snapshot, views, stories }) → NormalizedArchitecture` — the 14-table, snapshot-qualified store.
- `selectArchitectureSnapshot(state, snapshotId) → ArchitectureSnapshot`
- `selectArchitectureView(state, viewId) → ArchitectureView`
- `selectScopedView(state, viewId, rootEntityId) → ArchitectureView` — root-scoped subgraph.
- `selectArchitectureStory(state, storyId)`
- `serializeDynamicFlowMermaid(...)` / `compileC4DynamicFlowArtifact(...)` — deterministic, escaped diagram export.

The server is a transport + auth + pagination shell around these. It introduces no new query logic.

## Read surface

Resources (addressable, cacheable):

- **snapshot list** — `{ repositoryId, snapshotId, commitSha, generatedAt }`, newest first.
- **source excerpt** — a `SourceExcerpt` (immutable, commit-pinned, redacted), fetched by claim/anchor id.

Tools (parameterized queries):

- `get_entity(snapshotId, entityId)` / `get_relation(snapshotId, relationId)` — the record plus its provenance: `Claim.origin`, `sourceRefs`, linked evidence, and a confidence *qualifier* (observed → none; inferred → `Inference confidence N%`; explanation → `Supporting-claim confidence N%`). Never a bare "AI confidence".
- `get_scoped_view(snapshotId, viewId, rootEntityId)` — wraps `selectScopedView`.
- `diff_snapshots(a, b)` — fingerprint-based `SnapshotLineage` (schema doc): `unchanged|changed|new|no-longer-observed`.
- `export_diagram(snapshotId, { viewId | storyId }, format='mermaid')` — wraps `serializeDynamicFlowMermaid`; deterministic under randomized input, escapes labels/identifiers, honours active story/Isolate masks, and excludes prompts, secrets, absolute paths, and private excerpts.

Every read is deterministic: identical `(query, snapshot)` yields byte-identical output. Sets are sorted by stable ID; cursors are snapshot-qualified.

## Write posture — one gate only

The **only** write is extraction submission. There is no direct graph mutation, no confidence override, no caller-chosen IDs.

- `submit_extraction(document, scope)` runs exactly the scraper gate: `validateArchitectureExtraction` → reconciliation → `adaptArchitectureExtraction`. A rejected document applies **zero** records and returns its `ValidationIssue[]`.
- The caller supplies facts scoped to `scope` and citing only in-scope paths; the **host** assigns identity and stamps metadata. A model cannot create an observed claim, change an observed value, choose canonical IDs, or cite arbitrary paths.

This makes the MCP write path identical to the AI fan-out proposal path in [`scraper-pipeline.md`](./scraper-pipeline.md): humans, agents, and extractors all converge on one validator. Corrections that must persist across rescans go through `authoring.ts` overrides, not through observed claims.

## Cross-cutting concerns

- **Versioning.** Echo `ARCHITECTURE_SCHEMA_VERSION` / `NORMALIZED_ARCHITECTURE_VERSION` and a capability handshake; refuse documents whose `schemaVersion` the server cannot materialize.
- **Pagination.** Snapshot-qualified, stable-ID-ordered cursors so paging is deterministic and cross-snapshot references are rejected (identity contract).
- **Auth / scopes.** Separate `read` and `submit` scopes. Redaction is mandatory on every response (gate 8). Raw prompts/responses are access-controlled audit artifacts, never returned through inspector-facing tools.
- **Provenance honesty.** Observed facts never carry a percentage. Empty evidence is an explicit warning state, not a zero-confidence success.

## Shared query layer

The viewing platform (`apps/web`) and the MCP server consume the **same** selectors via the `@okie/architecture` barrel. MCP must not fork a second query implementation; a divergence between what a user sees and what an agent reads is a correctness bug. If a query is worth exposing over MCP, it belongs in `packages/architecture`/`packages/scene-compiler` as a reusable selector first.

## Milestones

- **M1 — read-only over an in-memory snapshot.** `snapshot list`, `get_entity/get_relation`, `get_scoped_view`, `export_diagram`. *Acceptance:* byte-identical responses for identical `(query, snapshot)`; the redaction gate holds on every field; no server-side query logic that isn't a `packages/*` selector.
- **M2 — provenance and diff.** `diff_snapshots` + full provenance/evidence resolution. *Requires* schema-doc M1 (stored claims). *Acceptance:* diff matches `SnapshotLineage`; provenance qualifiers obey the observed/inferred/explanation rules.
- **M3 — guarded write.** `submit_extraction`. *Requires* scraper-doc validate/reconcile. *Acceptance:* invalid documents apply zero records and the deterministic snapshot stays publishable; identical to the fan-out gate; no path bypasses `validateArchitectureExtraction`.
