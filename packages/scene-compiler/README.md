# @okie/scene-compiler

Compiles `@okie/architecture` snapshots and stories into the renderer scene
protocol and C4 dynamic-flow artifacts. Owns the TS protocol mirror of
`crates/atlas-protocol`, display-text fitting, and the golden demo fixture.

- **Entry:** `src/index.ts` re-exports `compile-scene`, `compile-c4`,
  `compile-normalized`, `compile-story`, `protocol`, `theme`, `golden-fixture`,
  `display-text`, `dynamic-flow`.
- **Test:** `pnpm --filter @okie/scene-compiler test` → `node --test dist/*.test.js`
  — flat glob, so keep `src/` flat (nesting silently drops tests).
- **Golden fixture:** `golden-fixture.ts` is hand-authored (source of truth);
  `golden-source-excerpts.ts` is GENERATED — never hand-edit, regenerate via
  `pnpm generate:fixtures`. Pinned: `compile-normalized/-scene/-story`,
  `generate-fixtures`, `protocol`.
