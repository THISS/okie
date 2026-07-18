# @okie/scan

Deterministic local-path repository scanner — R1 of the [scan runner](../../docs/roadmap/scan-runner.md).
Turns a pinned git working tree into an evidence-backed `ArchitectureSnapshot` (plus a
renderable view/story/scene/timeline) by walking TypeScript **syntax only** — no type
checker, no `node_modules`, no network.

```
okie-scan --source <path> [--out <dir>] [--system-name <name>] [--repo <slug>]
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
5. **View + compile** — synthesize a validator-satisfying view, a one-step overview story,
   then `buildC4ProjectionBundle` → `compileC4Scene`/`compileC4Timeline`.

## Structure mapping (R1 — deterministic truth layer)

| C4 level | Derived from |
|---|---|
| `softwareSystem` | the repository (one) |
| `container` | each workspace member with source, a synthetic **tooling** container for non-member scripts, and each Rust crate |
| `component` | **one per source file** |
| `code` | **one per top-level named declaration** (exported or not), anchored `path`+`symbol`+line range |

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

## Enrichment (R2a — agents propose, validators dispose)

R1 produces file-components (deterministic structural truth). R2 lets bounded-scope agents
regroup a container's files into **logical components** without ever touching observed facts.

- `okie-scan --emit-packets <dir>` writes one bounded, **redacted** packet per code-bearing
  container (`container__<id>.json`) plus a content-addressed `manifest.json`. A packet contains
  only that container's scope — its file-components, code entities (id/name/symbol/line ranges),
  touching relations, and capped file headers. Never a byte from outside the scope.
- `okie-scan --enrich-from <dir>` reads one `ArchitectureExtraction` per container and merges the
  accepted ones, emitting `enrichment-report.json`. See [`enrichment-prompt.md`](./enrichment-prompt.md)
  for the agent contract (`okie-enrichment/v1`).

Each document is validated **atomically** — any failure leaves that scope on the deterministic
file-component base (deterministic always publishes):

1. **Gate** — `validateArchitectureExtraction` must return `[]`.
2. **Scope** — every cited path is inside the packet's scope.
3. **Observed-facts immutability** — every code entity must exist in the base with byte-identical
   `name` + `sourceRefs` (path/symbol/lines). Only `parentId` may change; components may carry new
   prose. Any observed-value diff rejects the whole document.
4. **Coverage** — the document must re-parent exactly the container's code entities (total partition).

### Chosen representations (documented per the extraction-gate contract)

- **Full-subtree restatement.** The gate resolves parents within the document, so a proposal
  restates `{system, container, proposed components, re-parented code}`. System/container are
  structural anchors (id-matched, content ignored — the base wins).
- **File cohesion.** All code entities of one path must share a proposed parent (group whole files,
  never split a file's symbols). This is the natural logical granularity **and** makes the
  file→logical mapping a function, so the merge can remap the deterministic intra-container
  file→file import edges to **logical→logical** (dedup + drop self-loops), preserving the dependency
  graph. `container→container` edges pass through unchanged.
- **Empty components** (files with no top-level declaration, e.g. `vite.config.ts`) are not
  enrichment targets; they remain deterministic file-components.

Merging is order-independent (accepted proposals apply in canonical container-id order; entities
and relations re-sort by id) and reads no wall-clock/randomness, so the same base + documents
always yield byte-identical output (recorded-replay class).
