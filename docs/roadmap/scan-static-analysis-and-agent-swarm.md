# Scan: static analysis and the code-ownership agent swarm

Status: proposed roadmap.

Two capabilities layered onto the shipped scan (`@okie/scan`, see [`scan-runner.md`](./scan-runner.md) R1–R3): first a **multi-language static-analysis layer** — a SourceGraph-style AST pass that emits the cross-file reference graph and per-file **code outlines** (functions, methods, classes, their nesting and signatures); then a **hierarchical code-ownership agent swarm** that fans out along the containment tree and writes evidence-grounded reports that bubble up the hierarchy. Both obey the two accepted boundaries — [`../architecture/deterministic-first-ingestion.md`](../architecture/deterministic-first-ingestion.md) (observed facts before any model; agents propose, validators dispose) and [`../architecture/ingestion-golden-tests.md`](../architecture/ingestion-golden-tests.md) (byte-reproducibility, stable identity, hash/cache domains, release gates). Every recommendation ties to a current file or symbol.

This doc gap-analyses, it does not restate: read the two boundaries, then [`scraper-pipeline.md`](./scraper-pipeline.md) (the extractor/enrichment seam), [`structured-data-schema.md`](./structured-data-schema.md) (`Claim`/`Explanation`/`SpecDocument`), and [`mcp-surface.md`](./mcp-surface.md) (`get_file_outline`, `get_spec`) first.

## Where today's scan stops

The shipped scan (`packages/scan/src/extract.ts`) is a TypeScript-only, single-parser reader:

- **One language, one parser.** `extract.ts` imports `typescript` and walks the compiler AST; Rust is covered only as far as `cargoPathDependencies` (crate wiring from `Cargo.toml`), and no Python/Go/Java exists. `SourceLanguage` in `model.ts` is `"typescript" | "tsx" | "javascript" | "rust"`.
- **Flat, top-level code entities.** `topLevelDeclarations` emits a `code` entity per **top-level** declaration (function, class, interface, type alias, enum, module, variable). Nothing below the top level is captured: a class's methods, a function's nested closures, a struct's fields are invisible. `code` entities carry no `codeKind` discriminator and no signature. Coverage is the module's *declared surface* (`codeSurface: 'all' | 'public'`), not its full structure.
- **Containment is one level deep.** The extraction gate (`extraction.ts` `allowedParentKinds`) permits `code` only under `component`. A `code` entity cannot own another `code` entity, so nesting is unrepresentable.
- **Enrichment is flat and per-container.** R2 fans one agent per **container** (`scope.ts` `containerScopes`, `enrich.ts`), each proposing logical-component regrouping plus judgement prose. There is no hierarchy: no leaf→component→container→system synthesis, no bubble-up.

The founder's target: (1) outlines and a reference graph across TS/JS/Python/Rust/Go/Java so a user can *see how a file's symbols fit together*, and (2) a management-style agent hierarchy that owns and explains each region of the tree. Both extend coverage; neither is allowed to invent evidence.

---

# Part 1 — Static analysis first

## Deliverables

1. **Reference graph** — cross-file/cross-module symbol references (`calls`, `references`, `extends`, `implements`, `dependsOn`) with `path`+`symbol`+line evidence, extending today's import-level graph down to symbol granularity.
2. **Per-file code outlines** — every function, method, class, struct, enum, field and their **nesting** and **signatures**, so `get_file_outline` ([`mcp-surface.md`](./mcp-surface.md)) returns a grouped, `startLine`-sorted structure and the inspector/SourceViewer renders "what is in this file."

Outlines are the headline feature and are *inherently syntactic*: showing how symbols nest needs no type resolution. The reference graph is where precision (symbol resolution) earns its cost.

## Approach evaluation

| Approach | Precision | Determinism / hermeticity | Per-language cost | Fit |
|---|---|---|---|---|
| **tree-sitter** (per-language grammars, WASM) | Syntactic — name-based reference resolution, exact outlines | **Pure function of source bytes**: no build, no network, no absolute paths | **Low** — load a grammar + write `.scm` queries | Outlines: excellent. Reference graph: approximate. |
| **LSP indexing (SCIP / LSIF)** — the Sourcegraph model (`scip-typescript`, `scip-python`, `scip-go`, `scip-java`, rust-analyzer) | Reference-grade cross-repo symbol resolution | **Poor**: each indexer needs a *built* project (`node_modules`, `cargo build`, `go build`) — network, lockfiles, toolchains; indexers leak absolute paths / timestamps | **High** — one bespoke, build-dependent indexer per language | Reference graph: excellent. Hostile to the R1 install-free, byte-reproducible checkout. |
| **Native per-language tooling** (TS compiler API, rust-analyzer, `go/packages`, jedi) | Best per language | Heterogeneous; most require builds | **Highest** — N bespoke integrations, N determinism-hardening efforts, N output shapes | Precision without uniformity; already partly paid for TS. |

### Recommendation: tree-sitter as the primary substrate, native resolvers as an opt-in second tier

**Tier 1 — tree-sitter for outlines and intra-file structure across every language.** One WASM-loadable engine; per-language grammars for TS, JS, Python, Rust, Go, Java all exist and all compile to WASM the same way. Adding a language is *load a grammar + author an outline query*, not build an indexer — the only per-language model that scales to "more over time."

Rationale, each tied to a repo invariant:

- **The toolchain is already here.** The repo ships Rust + `wasm32-unknown-unknown` + wasm-pack and a WASM import boundary (`crates/atlas-wasm/pkg`, `WasmRendererAdapter.ts`). tree-sitter grammars build through the identical path; no new toolchain class enters the build.
- **Determinism is free.** tree-sitter parses bytes → CST with no I/O, no install, no lockfile — exactly the R1 checkout contract ("syntax-level: deterministic, install-free, and enough for entities/relations/anchors", `scan-runner.md`). SCIP/LSIF indexers need built projects and emit absolute paths/timestamps, which fights the `ingestion-golden-tests.md` "Platform" and byte-reproducibility rows head-on.
- **Outlines are syntactic by nature.** Code folding / outline panes in every editor are tree-sitter-class queries. Type resolution buys nothing for "these methods nest in this class."
- **Uniform output.** One CST shape and one `.scm` query dialect across six languages means one extractor contract feeding one gate, versus six divergent native shapes.

**Tier 2 — language-native resolvers, opt-in, only for reference-graph precision.** Keep the shipped TS compiler-API extractor (`extract.ts`) as the reference-grade **TS** resolver — it is tested, dogfooded (31/31 golden anchors), and already type-aware-capable; do not discard it. For other languages, add a native resolver (a SCIP indexer, rust-analyzer, `go/packages`) **only** where approximate edges prove insufficient and the build cost is acceptable, behind the same `validateArchitectureExtraction` gate. This keeps the precise path optional and per-language, never on the critical outline path.

**Honesty marker for approximate edges.** A tree-sitter reference edge is name-matched, not symbol-resolved — still *observed at the pin*, just approximate. Mark it: add `resolution?: 'resolved' | 'syntactic'` to `ArchitectureRelation`. `syntactic` edges are observed (no confidence percentage — they are supported-at-snapshot, per the provenance rules), but flagged so the reference graph never claims resolver precision it does not have. This is the deterministic-first move: label the approximation, do not hide it and do not upgrade it to `inferred`.

**Division of labour, so two parsers never conflict:** tree-sitter owns **outline** claims for *all* languages including TS; the TS compiler API owns **resolved reference** claims for TS. They land as disjoint predicates (`outline` vs `references`), so a rescan can regenerate one without touching the other and they cannot disagree on a shared value.

## Semantic model changes (`packages/architecture/src/model.ts`)

All additive and optional — a v1 document without them stays valid (the `structured-data-schema.md` discipline). The extraction gate (`extraction.ts`) changes in lockstep.

| Change | File · symbol | Why |
|---|---|---|
| **`codeKind` discriminator** on `code` entities: `'function' \| 'method' \| 'class' \| 'interface' \| 'struct' \| 'enum' \| 'typeAlias' \| 'field' \| 'constant' \| 'module' \| 'trait' \| 'impl'` | `model.ts` `ArchitectureEntity` (new optional field); gate validates the enum | Keep `EntityKind` = `code` (C4 stays "everything below component is code"); the discriminator carries outline shape. Already anticipated by `mcp-surface.md` `get_file_outline` ("name, `codeKind`, symbol, line range"). |
| **`signature?: string`** (bounded, redacted) on `code` entities | `model.ts` `ArchitectureEntity`; add `maxSignatureCharacters` to `SOURCE_EXCERPT_LIMITS`-style caps | An observed fact read from source: the outline shows `foo(a: number): void`, not just a name. |
| **`code`-under-`code` containment** | `extraction.ts` `allowedParentKinds`: `code: ["component", "code"]` | A method's parent is its class `code` entity; nesting uses the existing `contains` relation and existing `parentId`. This one line unlocks the outline tree. |
| **Extend `SourceLanguage`** with `'python' \| 'go' \| 'java'` (and any grammar added later) | `model.ts` `SourceLanguage` | Outlines and excerpts need per-language tagging. |
| **New relation kinds** `'references' \| 'extends' \| 'implements'` | `model.ts` `RelationKind`; gate's relation-kind set | `references` = generic symbol use below import granularity; `extends`/`implements` = type hierarchy the outline visualizes. Reuse existing `calls`/`reads`/`writes`/`dependsOn` where they already fit. |
| **`resolution?: 'resolved' \| 'syntactic'`** on relations | `model.ts` `ArchitectureRelation` | The approximate-edge honesty marker above. |
| **New id prefixes** as needed (e.g. `code:` already exists; outline nesting reuses it) | `extraction.ts` `prefixesByKind` | Outline entities are still `code` — no new prefix required; IDs stay authored-string-literal + collision-suffixed after canonical sort (identity contract). |

Once `structured-data-schema.md` M1 lands, each of these outline facts is also an **observed `Claim`** (predicate `outline` / `signature` / `references`) with a fingerprint over subject+predicate+canonical value — the projection story is unchanged; outlines simply add claim rows.

## Budget and legibility — outlines stay out of the way

Outlines multiply the `code` entity count by an order of magnitude (every method, every nested closure). They must never clutter L1–L3.

- **Outlines are a drill-only band.** They live strictly below `component` in the LOD hierarchy. The scene compiler's LOD/culling (`crates/atlas-engine/src/lod.rs`) shows outline entities only at the deepest (code) zoom; at container/component zoom they contribute *nothing* to the scene — they are queried via `get_file_outline` into the inspector/SourceViewer panel, not blasted as nodes. **Invariant: outlines only deepen the drill; they never widen a higher band.** (Mirrors `MAX_EXTERNAL_SYSTEMS` in `extract.ts` — "bumping this only widens the context band" — applied inversely: outline depth cannot touch the context band.)
- **Nesting depth is the LOD axis.** Top-level `code` shows first; nested `code` (methods, inner functions) reveals as you zoom, using the `parentId` chain. A per-file outline is a `startLine`-sorted grouped query, not a graph explosion.
- **Reference edges ride the existing relation-pressure gate.** The scan already gates edge density on compile ("relation-pressure gate for scan compiles", commit `3ee8431`). Symbol-level `references` edges are the densest new signal; they surface only at code LOD and are pressure-gated exactly like today's edges, so drilling into one file does not drag a hairball into the component view.

## Milestones (Part 1)

- **P1a — TS/JS outlines via tree-sitter on the self-scan.** Add tree-sitter WASM + the TS/JS grammars; emit nested `code` entities with `codeKind` + `signature` for the Okie repo itself (it already dogfoods). Land the `model.ts`/`extraction.ts` additive changes. *Acceptance:* per-file **outline completeness** — every top-level *and nested* symbol of a scanned file appears as a `code` entity with `path`+`symbol`+line anchors (a superset of `M1`'s exported/top-level rule in `scraper-pipeline.md`); `get_file_outline` returns them grouped and `startLine`-sorted; byte-identical across ≥100 shuffled discovery orders; the 29 dogfooding-pinned files (CLAUDE.md GOTCHAS) gain outline goldens under the double-entry hash pin. Because tree-sitter and the TS compiler API both parse TS, an equivalence check asserts the tree-sitter outline is a superset of the existing golden anchors.
- **P1b — reference graph + more languages.** Add Python, Go, Rust, Java grammars (outlines) and symbol-level `references`/`extends`/`implements` edges marked `syntactic`; introduce Tier-2 resolved edges for TS. *Acceptance:* a small pinned repo per language in the `ingestion-golden-tests.md` matrix passes the Discovery-order, Platform, and Unicode rows; `resolution` marking is present on every reference edge; the TS resolved-vs-syntactic edge sets reconcile (resolved ⊆ syntactic candidates).

---

# Part 2 — The code-ownership agent swarm

After deterministic static analysis produces the observed base, a **hierarchical** agent pass explains it. This generalizes the shipped R2 enrichment (flat, per-container) into a management hierarchy over the full containment tree.

## Principle (unchanged from the boundary)

Agents annotate evidence-backed structure; they never invent it. A report's every assertion cites observed claim IDs — "consumed by X" must correspond to an observed inbound `calls`/`uses`/`dependsOn` edge, or the gate rejects it. This is exactly the R2 contract (`enrich.ts`: observed-facts immutability, scope, total coverage, atomic per-unit acceptance), lifted to a tree. Reports and summaries embed as `Explanation`/`SpecDocument` **on top of** claims (`structured-data-schema.md`), never as new entities/relations.

## Fan-out policy — split by size and complexity

The agent scope tree is a **deterministic function of the observed graph**, so the *shape of the swarm is replayable* even before any model runs.

1. **Score every subtree.** `complexityScore(node) = f(descendant entity count, LOC across its sourceRefs, inbound+outbound relation count)` — all observed, all deterministic.
2. **Split above a threshold `T`, absorb below it.** A node whose score exceeds `T` spawns one child agent per child scope; a node below `T` is owned directly by its parent's agent (no separate agent). Result: **a simple codebase collapses to a single agent; a complex one grows a system → container → component → leaf-code hierarchy** — the founder's "management structure" emerges automatically from the score, not from configuration.
3. **Deterministic partition.** Thresholds are fixed config (part of `inputManifestHash`); ties break by canonical stable-ID sort. Reversing traversal order cannot change which nodes spawn agents (the identity-collision rule, applied to the agent tree).
4. **Bounded fan-out.** A depth cap and a max-children-per-node cap keep a pathological tree from exploding the agent count; anything truncated is `log`-recorded, never silently dropped (the "no silent caps" rule).

## Report schema

Each agent returns one report, materialized as an `Explanation` + a tiered `SpecDocument` (`structured-data-schema.md`), grounded through `supportingClaimLogicalIds`:

```ts
interface OwnershipReport {           // materialized as Explanation + SpecDocument sections
  subjectId: EntityId;                // the owned scope (system | container | component | code)
  summary: string;                    // one-band-appropriate synopsis (length-capped)
  sections: {                         // each → a SpecSection with non-empty grounding
    responsibilities: string;         // what this code does
    usage: string;                    // how it's used + consumers — cites observed inbound edges
    constraints: string;              // limits, preconditions
    invariants: string;               // what must hold
  };
  supportingClaimLogicalIds: string[];// REQUIRED, non-empty — the grounding
  childReportFingerprints?: string[]; // present on non-leaf: the synthesized children
}
```

- **Leaf agents** cite observed claims (outline, references, calls) within their scope.
- **Parent agents synthesize, they do not re-read source.** A parent's supporting set is its **children's accepted report fingerprints plus the observed cross-child edges** — cheaper than re-reading, and it makes the bubble-up a pure function of accepted child reports. This is the "reports bubble up so each parent synthesizes its children's reports" requirement, made deterministic.
- **Zero new edges.** A report that asserts an unsupported relationship fails grounding validation and applies zero records (atomic, exactly like R2's first-round rejections).

## Summaries per zoom level

The report hierarchy maps one-to-one onto the LOD bands, so drilling reveals progressively deeper synthesis:

| Band | Zoom | Owning agent | What shows |
|---|---|---|---|
| L1 context | system | system synthesizer | `SpecDocument.summary` of the whole system |
| L2 container | container | container agent | container summary; `deepDive` on drill |
| L3 component | component | component agent | component summary |
| L4 code | leaf code | leaf agent | per-symbol responsibility, alongside the Part-1 outline |

`SpecDocument.summary` is the default at each band (length-capped for legibility); `deepDive` sections open on demand (`get_spec(snapshotId, entityId, tier)`). This *is* the "Tiered specs" product from `structured-data-schema.md`, now produced by the swarm rather than hand-authored.

## Determinism, replayability, cost

- **recorded-replay reproducibility.** Each agent's packet is bounded, redacted, content-addressed (existing `packet.ts`, `ENRICHMENT_PROMPT_VERSION`); its response is captured and keyed by `enrichmentPacketHash` + `promptTemplateHash` (the `ingestion-golden-tests.md` hash domains). Same packets + same captured responses → byte-identical accepted output. Bubble-up order is irrelevant because merge is canonical-sort by stable ID (the R2 property, `enrich.ts`).
- **Carry-forward on rescan.** A subtree whose supporting-claim fingerprints and prompt policy are unchanged reuses its accepted report — recorded as carried-forward, **zero credits spent** (`deterministic-first-ingestion.md` credit boundary; `structured-data-schema.md` M3). Only subtrees touching changed code re-run.
- **Cost controls.** Fan-out only above `T`; bounded packet size, report length, section count, tree depth; parents synthesize from reports not source; optional model-tier-by-band (cheap model for leaf outlines, stronger for system synthesis); a pre-spend bounded-scope estimate (the credit boundary requires showing scope before spending). An agent failure loses only its scope's enrichment, never the deterministic base — the R2 per-unit fallback, now per-subtree.

## Milestones (Part 2)

- **P2a — hierarchical fan-out over the shipped gate.** Compute the deterministic scope tree; run leaf agents through the existing `enrich.ts` gate (unchanged validation/scope/immutability/coverage rules). *Acceptance:* the scope tree is byte-identical under shuffled traversal; a single-agent collapse for a trivial subtree and a multi-level tree for Okie; leaf reports pass grounding (every cited consumer is an observed edge); zero observed-field drift (the R2 property across 1,084 code entities).
- **P2b — bubble-up synthesis + tiered specs.** Parent agents synthesize children's reports into `SpecDocument` summaries per band. *Acceptance:* the `ingestion-golden-tests.md` "LLM replay" (identical accepted bytes under randomized citation/child-completion order), "LLM invalid" (atomic rejection, deterministic base still publishable), and Cache (carry-forward on unchanged subtree; re-run on a changed supporting fingerprint) rows; every published spec section has non-empty claim grounding.

---

# Part 3 — Phasing and verification

Staged so each slice is verified against the repo's golden-fixture discipline before the next builds on it. The self-scan is the test bench throughout — Okie dogfoods itself, so every stage is validated on a repo whose expected structure is already pinned (CLAUDE.md GOTCHAS: 29 path+symbol+line-anchored files).

| Stage | Slice | Verified by |
|---|---|---|
| **1** | **TS/JS outlines on the self-scan** (P1a) — first, because the repo already dogfoods TS and 29 files are pinned, so outline goldens have an existing anchor set to superset-check against | Outline-completeness golden row; ≥100-shuffle discovery-order invariance; the double-entry hash pin (regenerate fixtures + update the deliberate evidence-row hash, per `ingestion-golden-tests.md` and CLAUDE.md); tree-sitter ⊇ existing golden anchors |
| **2** | **Reference graph + Python/Go/Rust/Java outlines** (P1b) | One small pinned repo per language through the golden matrix (Discovery-order, Platform, Unicode); `resolution` marking present on every reference edge; TS resolved ⊆ syntactic candidates |
| **3** | **Hierarchical swarm, leaf reports** (P2a) on the self-scan | Deterministic scope tree under shuffle; grounding validation; zero observed-field drift; per-subtree fallback |
| **4** | **Bubble-up synthesis + tiered specs** (P2b) | LLM-replay / LLM-invalid / Cache golden rows; non-empty grounding on every spec section |
| **5** | **Incremental at scale** | Diff-scoped outline re-extraction and report carry-forward pass the incremental ≡ full equivalence gate (`scraper-pipeline.md` "Incremental rescan") |

**Golden-fixture discipline applies at every stage.** New capability = new row(s) in the `ingestion-golden-tests.md` matrix with a committed canonical artifact and expected-hash manifest; tests compare **bytes**, not parsed equality. Editing within ~6 lines of a pinned symbol (which outline extraction now reads far more of) shifts excerpts, so `pnpm generate:fixtures` + the deliberate hash-pin update remain the gate — the outline pass makes the pinned surface larger, raising the value of that gate, not lowering it.

## Non-goals

Unchanged from the roadmap: billing, real-time collaboration, arbitrary vector editing, and export beyond deterministic Mermaid/PNG stay out of scope. This doc concerns the scan (static analysis + enrichment) and the semantic core it feeds, not the renderer. Full IDE-grade cross-repo "find all references" precision for every language is explicitly *not* promised at Tier 1 — it is the opt-in Tier-2 path, added per language where its build cost is justified.
