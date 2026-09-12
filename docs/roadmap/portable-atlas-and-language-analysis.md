# Portable atlas and language analysis

Status: agreed product direction, September 13, 2026. Documented in the clabrate workspace's Okie project, with CLA-123 through CLA-128 completed locally and CLA-129 retained as a fast follow. Acceptance is recorded in [the completion audit](../qa/portable-v1/completion-audit.md). Nothing has been merged or published.

Linear scope: [Portable atlas, language analysis and agent skills — v1 scope](https://linear.app/clabrate/document/portable-atlas-language-analysis-and-agent-skills-v1-scope-479d0e9d0c68).

This decision record refines the older [static analysis proposal](./scan-static-analysis-and-agent-swarm.md) and [scan runner proposal](./scan-runner.md). Their historical implementation descriptions and broader language scope should not be treated as the current v1 commitment.

## Agreed v1

### Language analysis

- Prioritize TypeScript/JavaScript, then Rust. Python and Go are subsequent adapters; they do not block v1.
- Reuse semantic language tooling through adapters rather than building every language resolver ourselves. Adopt SCIP as the shared indexing integration direction; evaluate the concrete TypeScript compiler/indexer and rust-analyzer integration before committing to packaging details.
- SCIP definitions and references feed Okie's semantic graph. Calls require call-site evidence; a reference alone is not a call. Preserve containment, evidence, resolution limits and public API distinctions.
- Full analysis may require repository dependencies and language toolchains. Provide a quick fallback with explicit reduced coverage and unresolved cases.
- A deterministic scan must produce a useful atlas without an LLM.

### Committed source

- Require a committed revision in v1; defer uncommitted working-tree snapshots.
- Analyze the actual committed contents in an isolated source tree. Do not require users to discard local edits or silently include those edits under the HEAD identity.
- Current implementation gap: `pinRepository` records HEAD while local `scanRepository` reads the working directory. Correct this provenance mismatch before shipping the portable CLI workflow.
- Keep source references, snippets, retrieval and repository links tied to the same revision.

### Portable bundle and source viewing

- One repository scan at a time, including packages/languages within a monorepo.
- Produce a versioned artifact suitable for agents and the static viewer, containing the semantic facts, evidence, necessary rendering data and optional enrichment.
- Include useful source excerpts by default; full source is optional.
- Open source in a dedicated viewer tab that preserves map state. Show the snippet immediately, with highlighted lines and a link to the full repository file at the scanned commit. Full-file display uses bundled content or available exact-revision retrieval; retain the excerpt when unavailable.
- Exact archive format, source inclusion controls and schema migration policy remain implementation design decisions.

### Static viewer

- Support a packaged viewer plus scan: a CLI export creates a self-hostable folder that opens directly into its bundled atlas.
- Support a reusable empty viewer with Open scan and a drag-and-drop zone. Read the artifact in the browser without sending it to an application server; state this beside the control.
- Support remembering the imported scan in IndexedDB, with replace/forget controls. Browser storage is convenience storage; the exported artifact is the durable copy.
- Static hosting requires no application backend. Do not assume direct `file://` opening works without verifying browser restrictions.
- Replace backend-dependent neighborhood/source requests with bundled equivalents or truthful unavailable states.

### Agent skills

1. **Scan:** understand the CLI, inspect prerequisites, scan a committed revision, report coverage, and produce the usable artifact.
2. **Enrich:** consume the artifact and matching repository, add evidence-backed explanations and supported guided flows, then validate proposed additions. Keep inferred explanations distinct from deterministic facts.
3. **Package/share:** invoke CLI packaging for local viewing or self-hosting; publication is explicit.

The Scan skill recommends optional enrichment after completion and explains that it consumes agent capacity. It does not automatically run enrichment. Users can rerun enrichment without rescanning unchanged source. The user can begin by loading the Scan skill and pointing their agent at a repository; the skill orchestrates the CLI.

## Fast follow: dependency consumers

Let a user or agent enter a dependency and find where it is consumed, through both CLI queries and map highlighting. Distinguish manifest declarations/resolved versions, direct imports and symbol references. Show source evidence and coverage limits. This is explicitly outside v1. Broader change-impact inference is not part of the initial dependency feature.

## Later, driven by demand

- Python and Go semantic adapters after TypeScript and Rust.
- Revision comparison and connected multi-repository maps when users request them.
- Uncommitted working-tree snapshots with independent content identity and honest source links.
- Hosted private repository scanning with GitHub authorization and private-by-default artifacts. Authorization must cover artifact and source access, not just sign-in.

Initially the operator's hosted catalog contains public scans the operator runs. Users can scan private repositories locally and inspect artifacts in the browser without uploading them to Okie.

## Proposed Linear breakdown

Create one scope document linked to these implementation issues, reusing existing issues where available:

1. Committed-source acquisition and distributable CLI.
2. Language adapter/SCIP integration contract with TypeScript semantic analysis.
3. Rust semantic relationships using rust-analyzer; verify `atlas-protocol` callers and file dependencies that today's outline-only extraction omits.
4. Versioned portable bundle and dedicated source tab.
5. Static viewer local import, IndexedDB persistence and packaged export.
6. Scan, optional Enrich, and Package/share agent skills.
7. Fast follow: dependency consumer queries and map highlighting.

Track later possibilities in the scope document without treating them as scheduled commitments. No owners, due dates or estimates have been agreed.

Reference: [SCIP Code Intelligence Protocol](https://github.com/scip-code/scip).
