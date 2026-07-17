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

## Determinism

Output is byte-identical across shuffled discovery order: IDs derive from canonical source
identity (path/symbol) with collision suffixes assigned by canonical sort, and
`adaptArchitectureExtraction` + `compileC4Scene` re-sort everything by ID. `git ls-files`
order, filesystem order, and iteration order cannot affect the bytes.
