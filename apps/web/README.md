# @okie/web

Browser shell for the Okie atlas: the interactive canvas rendering the
deterministic C4 scene, guided stories, semantic-lens navigation, and
inspector/authoring surfaces.

## Commands — all `pnpm --filter @okie/web …`
`dev` (Vite; not for agents/CI) · `check` (`tsc -b`) · `test` (`vitest run`).

## Layout (`src/`)
Feature folders: `semantic/` (lens policy) · `diagram/` (surfaces, Mermaid,
source viewer, workspace) · `inspector/` · `relations/` (projection/focus/flow/
framing) · `navigation/` · `renderer/` · `editor/` · `provenance/`. Root = app
shell (`App.tsx`, `main.tsx`) + guided-story runtime
(`story{Playback,Framing,Focus}.ts`) + cross-cutting acceptance tests.
`vitest` discovers recursively; `*.qa.test.ts` = acceptance/determinism
contracts, `*.test.ts` = unit.

## ⚠️ Dogfooding-pinned — never move or line-shift near their symbols
`App.tsx`; `navigation/{navigationState,historyController}.ts`;
`provenance/presentation.ts`; `renderer/{Canvas2DRenderer,createRenderer,
WasmRendererAdapter}.ts`; `story{Playback,Framing,Focus}.ts`. Their path+line
windows are frozen in the golden fixture; edits near a pinned symbol require
`pnpm generate:fixtures` + review. See root `CLAUDE.md` and
`scratchpad/refactor-plan.md`.
