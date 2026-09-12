# Contextual inspector and symbol relationships

Status: complete locally, September 12, 2026. Repository gates, independent Astra high review and Astra low browser acceptance passed. See [final integration and evidence](../qa/inspector-team/final-integration.md).

## Follow-up discussion decisions

- Preserve the active inspector tab when selecting another entity. Overview follows explicit selection, then falls back to current zoom scope. If the active tab has no content for the new entity, explain unavailable evidence rather than invent content or silently present the previous entity.
- Cap every sidebar item list at five initially, including child nodes and each relationship group. Show total counts, “Show all N” and “Show fewer.” Expanding happens in place. Ordering must remain stable during zoom and pan.
- Relationship “Show on map” smoothly reveals both endpoints and their connecting edge, retaining the original entity selection and sidebar context. It may adjust the camera to fit; it must not merely center the minimap or jump to the counterpart. The current behavior is reported buggy and needs browser reproduction before changes.
- Useful diagram actions open separate in-app diagram tabs, preserving the main atlas. Use concrete outcome labels; offer Mermaid as a viewing option. Add short information tooltips explaining what each unfamiliar action shows, accessible on hover, keyboard focus and tap.
- Source shows the selected symbol at the exact scanned commit, with more-context and full-file actions bound to that same revision. Additional source may be fetched and cached on demand; preserve the existing bounded excerpt fallback.
- Builder model preference: GPT-5.3-Codex-Spark; after its limit was reached, user explicitly authorized Terra or Astra low builders. Reserve GPT-6 Astra with medium/high reasoning for independent code review and low reasoning for browser QA. Do not silently substitute an Astra builder when Spark cannot be dispatched.

## Delegation boundaries

1. Inspector builder: canonical relationship inventory versus painted membership, contextual Overview, five-item lists, tab continuity, useful diagram actions and accessible explanations. Include relationship reveal/camera behavior while preserving selection. Keep source revisions immutable.
2. Extraction/source builder: broaden deterministic symbol resolution and call evidence; derive exported/public-API/entry-point distinctions; implement exact-revision additional source retrieval and caching. Coordinate any schema additions with inspector integration. Do not infer a call from a generic reference.
3. Astra medium/high code review and low browser QA: inspect implementation and evidence, then exercise the running app with real selection, sidebar expansion, relationship reveal, diagram tab navigation and source context loading. Record failures and actual coverage; do not claim exhaustive QA from snapshots or unit tests.

Builders must start from the current local changes, preserve unrelated work, follow CLAUDE.md, and report changes/tests/limits. No deployment, merge, PR or commit is requested. Separate checkout integration must not lose the existing zoom or Mermaid fixes.

## Product contract

Overview explains the selected entity and its role within its immediate parent. When there is no explicit selection, use the current navigation scope. It must not repeat the system brief inside every package, file, or symbol. Source provides evidence pinned to the snapshot revision. Details contains secondary metadata.

The relationship inventory is a query over captured semantic facts, independent of canvas layout, level, culling, isolation, or edge budgets. The map draws a readable subset of those facts. Label membership as “Shown on map,” not “Important.” A hidden edge is not an unimportant dependency.

Group actual call evidence into Calls and Called by. Group other symbol references into Uses and Used by, retaining more specific supported kinds such as reads and writes. Do not relabel existing generic uses relations as calls. Incoming and outgoing relationships remain distinct; recursive calls must be represented without double-counting.

Distinguish known and shown, known but hidden, and unresolved/not captured. Empty extraction is not proof of a disconnected symbol: use “No relationships captured.” Only claim extraction completeness when supported by recorded coverage. Known hidden relationships remain inspectable with endpoint names and evidence even if their endpoints are absent from the current rendered neighborhood.

Public-facing labels distinguish:

- Exported symbol: visible outside its declaring module.
- Public API: reachable through the package's supported public entry points.
- Entry point: recognized executable or framework registration.

Each label requires source evidence and a supported extraction rule. No inbound reference is not evidence of an entry point. A file export is not automatically public package API. These labels may coexist.

Hide empty optional sections and actions that cannot produce useful content. Retain short explanations for missing extraction/source evidence where silence could mislead. Mermaid is a rendering option. A dependency graph must not be described as an execution sequence unless ordering is supported by evidence.

## Stage one: presentation over current facts

1. Add a canonical relationship selector using the active snapshot, with deterministic ordering and a separate mapping to visible projected edges. Preserve existing canvas-pick semantics for aggregated edges. A canonical relation can be included in an aggregated visible edge without its individual endpoints being drawn; describe this distinction accurately.
2. Keep canonical inventory stable across camera movement, semantic zoom and isolate mode. Inspecting a row opens its evidence; revealing it must locate its endpoint/scope and either reveal a supported edge or explain why it cannot currently be drawn. Never silently discard off-neighborhood relationships.
3. Build scoped overviews: identity, accepted responsibility, immediate parent role, direct dependencies/dependents, and available children. Use evidence-backed structural fallback when responsibility is missing; do not invent intent from filenames. Keep wider context in breadcrumbs rather than repeating the full system description.
4. Gate diagram actions on actual content. Unordered dependencies are described as dependencies. Named flows require a meaningful supported sequence. Code structure is offered when the scope has meaningful source structure to explore.
5. Preserve commit-pinned source display and the expanded inline Mermaid viewer.

Acceptance: selecting a symbol with a captured but unpainted relation still lists it; map visibility changes only its presentation status, not inventory membership. A symbol with no captured relations has the truthful empty state. Package/file/symbol overviews describe their own scope. Relationship direction and kinds remain accurate. Missing artifacts produce no dead diagram actions. System overview remains available at system scope.

## Stage two: deterministic extraction

Extend symbol resolution using language-aware binding information. Cover direct calls, import aliases, default and namespace imports, re-export chains, package entry points, and resolvable method/property references in bounded slices. Respect lexical shadowing, type-only references, visibility, aliases and cycles. Do not guess targets for dynamic property access, ambiguous dispatch or unsupported registration patterns.

Record calls separately from generic references, with precise source sites. Specify supported languages and unresolved cases; do not imply TypeScript improvements provide Rust call-graph coverage. Preserve stable entity/relation identity and deterministic scan output.

Add evidence-backed exported/public-API/entry-point metadata. Package API resolution must use package entry-point configuration and re-export reachability, not merely export syntax. Framework entry-point detection should use explicit supported registrations rather than name heuristics.

Acceptance fixtures include aliasing, shadowing, re-exports and cycles, default/namespace imports, direct versus callback references, recursive calls, static versus ambiguous method dispatch, exported-but-private-to-package helpers, public entry points, and unresolved dynamic behavior. Repeat scans must be identical. UI labels must cite the corresponding evidence and preserve uncertainty.

## Source storage direction

Retain repository identity, immutable commit, relative file path, symbol identity, line range and a content digest. Resolve source at that exact revision and cache by immutable identity. Keep bounded excerpts needed to substantiate explanations so existing evidence remains readable when a repository is inaccessible. Do not silently substitute a current branch for missing historical source. A permanent full repository copy is not required for the Source UI; retrieval may still require downloading a file before slicing its requested range.

## Initial implementation findings (historical)

- App's architecture brief is built from the snapshot without selection scope.
- The existing inspector relationship contract intentionally mirrors drawn/projected edges; retain that helper for canvas behavior and add a separate semantic inventory.
- TypeScript extraction already captures some same-file and named-relative-import symbol uses; other references remain at broader granularity. This is a useful starting point, not complete call resolution.
- Derived dynamic diagrams synthesize a story from adjacent relations; adjacency alone is not execution-order evidence.
- Scanned code entities already receive portable source excerpts pinned to the snapshot commit.

This completed inspector goal does not certify every node at every zoom level; the broader zoom-continuity investigation has a separate scope. Relationship reveals and the exercised published hierarchy path are verified here.
