# @okie/scan

Deterministic local-path repository scanner — R1 of the [scan runner](../../docs/roadmap/scan-runner.md).
Turns a pinned git working tree into an evidence-backed `ArchitectureSnapshot` (plus a
renderable view/story/scene/timeline) by walking TypeScript **syntax only** — no type
checker, no `node_modules`, no network.

```
okie-scan --source <path> [--out <dir>] [--system-name <name>] [--repo <slug>]
okie-scan --source <path> --emit-packets <dir>
okie-scan --source <path> --emit-prompt <dir>
okie-scan --source <path> --enrich-from <dir>
```

Defaults: `--source` = cwd, `--out` = `<source>/fixtures/scan` (gitignored). Outputs
`extraction.json`, `snapshot.json`, `view.json`, `story.json`, `scene.json`, `timeline.json`.

## Pipeline

1. **Pin** — `git rev-parse HEAD` + `HEAD^{tree}`; `generatedAt` is the commit's own
   committer date (`git show -s --format=%cI`), never wall-clock, so a re-scan of a commit
   is byte-identical.
2. **Discover** — `git ls-files` (deterministic, gitignore-aware) filtered to
   `.ts/.tsx/.mjs`, excluding `dist/`, `*.test.*`, `*.d.ts`; canonical sort.
3. **Extract** — one `ts.createSourceFile` per file; map to the C4 hierarchy (below);
   static `import`/`export … from` specifiers become `dependsOn` relations.
4. **Gate** — build one `ArchitectureExtraction` → `validateArchitectureExtraction` →
   `adaptArchitectureExtraction` → `ArchitectureSnapshot` (identity defaults: lineageId =
   stable ID, fingerprint = content hash).
5. **View + compile** — synthesize a validator-satisfying view, a deterministic multi-step
   C4 overview story (system → containers → a representative component/code descent;
   `overview-story.ts` `buildOverviewStory`). After a gated enrichment pass, step
   narration may mention accepted section summaries; step count and reveals stay
   the C4 tour. Then `buildC4ProjectionBundle` → `compileC4Scene`/`compileC4Timeline`.

## Structure mapping (R1 — deterministic truth layer)

| C4 level | Derived from |
|---|---|
| `softwareSystem` | the repository (one) |
| `externalSystem` | the **top-N most-imported third-party runtime dependencies** (system context / L1) |
| `container` | each workspace member with source, a synthetic **tooling** container for non-member scripts, and each Rust crate |
| `component` | **one per source file** |
| `code` | **one per top-level named declaration** (exported or not), anchored `path`+`symbol`+line range |

### System context (L1) — external dependencies

The top level must show how the system meets the world. The scan derives `externalSystem` entities
deterministically from **third-party runtime dependencies**:

- **Allowlist = runtime `dependencies`** (never `devDependencies`) declared by the root and every
  workspace member. Local protocols (`workspace:`/`file:`/`link:`) are first-party and excluded — so a
  CSS-only member like `@okie/theme` never appears. A bare import counts only if its package is on
  the allowlist, which also drops node builtins and type-only/dev tooling.
- **Selection** is the top `MAX_EXTERNAL_SYSTEMS` (8) by `(import-site count desc, package name asc)` —
  a documented, deterministic constant. Evidence is a capped canonical selection of the real import
  statements (`path`+line) plus the `package.json` declaration line.
- **Relations** are `container → externalSystem` (`dependsOn`), so at **L1** they collapse to
  `system → externalSystem` interactions and at **L2** they attribute the dependency to the importing
  container. Persons/externalSystems are laid out in the context band by the C4 projection automatically.
- Scanning Okie yields e.g. `react`, `@fontsource/ibm-plex-sans`, `mermaid`, `react-dom`, `typescript`.
- **Rust crate dependencies** (`Cargo.toml`, e.g. `wgpu`) are a documented follow-up: R1 does not parse
  `.rs`, so there is no import-frequency evidence to rank or anchor them.

### Deliberate calls (do not "fix" without reading this)

- **Component = file, not directory.** This is the deterministic *structural* truth. Collapsing
  files into logical/conceptual components (e.g. the hand-authored golden fixture's "Application
  shell") requires semantic judgement — that is **R2 agent enrichment's** job, not R1's. `apps/web`
  therefore renders ~50 file-components; that is honest, not a bug.
- **All top-level declarations, not just `export`ed ones.** Some pinned anchors (e.g.
  `CanvasViewport` in `App.tsx`) are non-exported top-level functions.
- **`packages/theme` is skipped** — it ships CSS tokens only, zero `.ts`, so it yields no
  container (the golden fixture has no theme container either).
- **Rust crates are opaque containers** — path-only evidence, no `.rs` parsing in R1.
- Derived structure legitimately differs from the golden fixture's *conceptual* grouping and IDs.
  The dogfooding gate is about **evidence coverage** (every golden `.ts/.tsx/.mjs` `path`+`symbol`
  anchor appears among scan `code` entities), not ID equality. Rust anchors are excluded.

## Coverage & repository shapes

Discovery generalizes beyond Okie's own layout (validated against third-party clones):

- **Single-package repos** (no pnpm workspace) become **one root container**, named and
  evidenced from the root `package.json` (falling back to the directory name). The synthetic
  `tooling` container only appears when non-member scripts sit beside real workspace members.
- **Extensions:** `.ts/.tsx/.mts/.cts/.mjs/.cjs/.jsx` are always scanned. `.js` is scanned
  **only for a genuinely pure-JS repo** (no root tsconfig *and* no TypeScript source) — otherwise
  `.js` files are skipped and **counted in the scan summary**, never dropped silently.
- **Excluded** (a named, tested list): `*.d.ts`, `dist/`, `*.test.*`, `*.spec.*`, `*.bench.*`,
  `__tests__/`, `__mocks__/`.
- **Fixture members** whose path matches `playground/example/e2e/fixtures/demo/sandbox` are skipped
  by default (with a summary count); pass `--include-members` to scan them.
- **System name** comes from the root `package.json` `name` (fallback: directory basename).

The scan prints a summary of everything it left out (skipped `.js` count, skipped members) so
omissions are always visible. Large repos currently stress the *scene compile* (edge routing),
not the deterministic extraction — scoped compilation is tracked separately.

## Determinism

Output is byte-identical across shuffled discovery order: IDs derive from canonical source
identity (path/symbol) with collision suffixes assigned by canonical sort, and
`adaptArchitectureExtraction` + `compileC4Scene` re-sort everything by ID. `git ls-files`
order, filesystem order, and iteration order cannot affect the bytes.

## GitHub acquisition (R3 — paste a repo, get an atlas)

`okie-scan --source gh:owner/repo[@ref]` scans a public repository with no local clone:

1. **Resolve** the ref to an immutable commit via the GitHub REST API (unauthenticated).
   No ref → the repo's `default_branch`. Falls back to the `gh` CLI transparently on a
   rate-limit/403/private-404 (uses the operator's stored auth). **No tokens are read from
   env or embedded, and messages are scrubbed before logging.**
2. **Fetch** the codeload `tar.gz` at that SHA into a temp dir (capped — default 150 MB,
   `--max-tarball-mb`), extract, scan, **discard**. Nothing long-lived; the commit/tree SHA
   is the identity (the [scan-runner](../../docs/roadmap/scan-runner.md) checkout strategy).
3. **Pin** `commitSha` + `treeSha` from the API; `generatedAt` = the commit's **committer
   date** (never wall-clock), so two scans of the same source at the same SHA are
   **byte-identical** across all six artifacts.

A tarball has no `.git`, so discovery walks the extracted tree (`discoverExtractedTree`)
through the **same** filter/assembly core as the `git ls-files` path (`discoverFromFiles`).
A GitHub archive already contains exactly the committed tree at the SHA (untracked/gitignored
content was never archived), so a plain walk reproduces gitignore-aware discovery without
parsing `.gitignore`. **Divergence to note:** `git archive` honors `.gitattributes
export-ignore`, so a rare export-ignored-but-tracked path is present under a local scan yet
absent from a tarball. Failure modes are explicit and non-fatal to the CLI: repo/ref not
found, rate-limited (with the `gh`-fallback hint), tarball over cap, and a non-TS/JS repo
(0 candidate files → a message naming the extension policy).

## Multi-repo output + serving

A local scan still writes to `fixtures/scan/` (the Okie self-scan — unchanged, back-compat).
A `gh:` scan writes to **`fixtures/scan/<owner>__<repo>/`** and (re)writes a deterministic
**`fixtures/scan/index.json`** manifest — a slug-sorted list of
`{slug, repositoryId, commitSha, generatedAt, entityCount}` over every per-repo slot, so
multiple scanned repos coexist.

The web app selects a scanned repo on the already-preserved `fixture` query param:
`?fixture=scan` loads the root self-scan; **`?fixture=scan:<slug>`** loads
`fixtures/scan/<slug>/`. Riding the `fixture` param (rather than a new `repo=` key, which
would collide with the reserved navigation `repo` = repositoryId) keeps the selector in the
URL across reload/share **without touching the pinned navigation machinery**. An unknown slug
fails closed to the full-page scan error listing the available slugs. This per-repo
storage/URL shape is what a future hosted embed (a static app build + per-repo trio assets +
manifest picker) builds on.

## Enrichment (R2a — agents propose, validators dispose)

R1 produces file-components (deterministic structural truth). Live packet enrichment
asks for **section summaries** of scanner-scoped containers/components (and optionally
one code entity). Those documents merge only if the existing enrichment gate accepts
them; hallucinated ids and out-of-scope entities reject that scope and it stays
deterministic. Recorded regrouping / actor documents still merge when they satisfy
the gate.

- `okie-scan --emit-packets <dir>` writes one bounded, **redacted** packet per code-bearing
  container (`container__<id>.json`) plus a content-addressed `manifest.json`. A packet contains
  only that container's scope — its file-components, code entities (id/name/symbol/line ranges),
  touching relations, and capped file headers. Never a byte from outside the scope. It also writes
  one repo-wide **system packet** (`system__<id>.json`, see below). A container whose code-bearing
  file-components exceed `MAX_COMPONENTS_PER_PACKET` (`maxListItems − 3` = 61) emits additional
  remainder packets (`container__<id>.2.json`, …) covering the leftover scanner ids. The cap
  does not drop files. Empty components (no top-level declaration) still have no packet rows.
- `okie-scan --emit-prompt <dir>` is concat sugar on that same loop (local working tree only). It
  writes the **same packet files** as `--emit-packets`, plus one `<packet>.prompt.md` per packet.
  Each prompt is the frozen [`enrichment-prompt.md`](./enrichment-prompt.md) bytes, then the packet
  JSON, then an appendix (scanned `commitSha` / `treeHash`, packet filename, file tree, ownership
  tree). The appendix is data, not new instructions. Same scan SHA → byte-identical prompt+packet
  files. See [`.cursor/skills/okie-enrich/SKILL.md`](../../.cursor/skills/okie-enrich/SKILL.md).
- `okie-scan --enrich-from <dir>` reads one `ArchitectureExtraction` per packet (and, optionally,
  one keyed by the **system id**) and merges the accepted ones, emitting `enrichment-report.json`.
  Write each document with the **same filename as the packet**, including remainder
  `container__<id>.2.json`. Multiple accepted summary docs for one container **union** their
  `responsibility` prose. See [`enrichment-prompt.md`](./enrichment-prompt.md) for the agent
  contract (`okie-enrichment/v2`).

### System-scope enrichment (R2b — top-level actors)

Track A derives external *systems* deterministically, but the **persons** at the edge (User,
Developer, AI Agent (MCP), CI…) are judgement, not parsing. The **system packet** carries the
top-level shape — the container list, the deterministic external systems, and short README
teasers — with a `scopePaths` allowlist (the READMEs + container evidence anchors). A
system-scope document (keyed by the system id) may attach section summaries (`responsibility`)
on the restated system/containers, and may still ADD `person` entities plus person-touching
relations. It may **not** add or mutate a component, code, or unknown container, and it may
not author non-person (structural) edges. Any violation rejects the **whole** document
atomically (the deterministic base still publishes).

Each document is validated **atomically** — any failure leaves that scope on the deterministic
file-component base (deterministic always publishes):

1. **Gate** — `validateArchitectureExtraction` must return `[]`.
2. **Scope** — every cited path is inside the packet's scope. Hallucinated ids reject the document.
3. **Observed-facts immutability** — restated code must exist in the base with byte-identical
   `name` + `sourceRefs` (path/symbol/lines). Summaries may add `responsibility` only.
4. **Summaries vs regrouping** — a summary document restates scanner-scoped container/component
   ids (code optional, no re-parent). A regrouping document must still re-parent exactly the
   container's code entities (total partition) into new logical components.

### Chosen representations (documented per the extraction-gate contract)

- **Full-subtree restatement.** The gate resolves parents within the document, so a proposal
  restates `{system, container, proposed components, re-parented code}`. System/container are
  structural anchors (id-matched, content ignored — the base wins).
- **File cohesion.** All code entities of one path must share a proposed parent (group whole files,
  never split a file's symbols). This is the natural logical granularity **and** makes the
  file→logical mapping a function, so the merge can remap the deterministic intra-container
  file→file import edges to **logical→logical** (dedup + drop self-loops), preserving the dependency
  graph. `container→container` edges pass through unchanged.
- **Empty components** (files with no top-level declaration, e.g. a re-export barrel) are not
  enrichment targets; they remain deterministic file-components. On this repo that is
  `apps/web/src/inspector/inspectorSupport.ts`, not `vite.config.ts` (which is code-bearing).

Merging is order-independent (accepted proposals apply in canonical container-id order; entities
and relations re-sort by id) and reads no wall-clock/randomness, so the same base + documents
always yield byte-identical output (recorded-replay class).
