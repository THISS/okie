# @okie/architecture

Canonical, renderer-independent architecture model: entity/relation snapshots,
versioned extraction schema, C4 projection, completeness scoring, orthogonal
routing, normalized selectors, and validation. Pure TS, no browser/GPU deps.

- **Entry:** `src/index.ts` re-exports `model`, `authoring`, `extraction`, `c4`,
  `c4-completeness`, `normalized`, `orthogonal-router`, `validation`. Import from
  `@okie/architecture`; never deep-import.
- **Test:** `pnpm --filter @okie/architecture test` → `node --test dist/*.test.js`
  (flat glob — keep `src/` flat).
- **Pins:** `model.ts`, `normalized.ts`, `validation.ts` are dogfooding-pinned in
  the golden fixture (see root `CLAUDE.md` gotchas); edits near a pinned symbol
  need `pnpm generate:fixtures`.
