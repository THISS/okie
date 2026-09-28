# Overview blocks (CLA-149) browser QA

Date: 2026-09-28. Playwright (Chromium) against an isolated Vite dev server on `localhost:4195`, built from the uncommitted `okie-work-3` tree. No QA edits to source. No server, LLM or Jev calls; spend $0.

## Data setup

- The atlas is the golden demo snapshot (`?fixture=okie`): 1 software system and 5 containers.
- Vite ran from a scratch config that imports `apps/web/vite.config.ts` and overrides only the port (4195) and the `/api` + `/scan` proxy target (dead port 4196), so the user's 4173/4174/4180 servers were never touched.
- Explanations were seeded through the real operator seam. `page.evaluate` ran `await import('/src/operator/previewContext.ts')` and then called `setDraftPreviewContext('qa-cla149-rev', scopes)`. In dev, Vite serves this as the same module instance the App reads through `getDraftPreviewContext()`, which is the call `mountOperatorDraftPreview` makes after an operator opens a preview. The next App render picks the scopes up. Each scope's `scopeId` is the entity id.
  - `system:okie`: v3 (summary, keyPoints, mermaid, evidence)
  - `container:web-app`: v3 (summary, 3 keyPoints, mermaid, 3×4 table, 2 evidence items)
  - `container:architecture-model`: legacy with no `format`. It has `roleWithinParent`/`interactions` sentinels `LEGACY-*`, a `{nodes,edges}` diagram and evidence.
  - `container:scene-compiler`: v3 with a 7-column table, which is invalid
  - `container:rust-renderer`, `container:tooling`: no explanation
- Limitation: the context is in memory only, so a reload clears it. For check 7, the same scopes were seeded again after each reload. The server publication sidecar path (`/scan/<slug>/operator-explanations.json`) was not exercised.

## Results

| # | Check | Result |
|---|---|---|
| 1 | Container v3, desktop + 390×844 | **Pass.** Block order: `enrichment:summary, enrichment:keyPoints, nodeRefs:related, relations:parent, relations:dependencies, enrichment:diagram, children, enrichment:table, enrichment:evidence`. This matches the container recipe; there are no dependents. `enrichment:*` blocks have provenance `enrichment` and the rest `observed`. The Mermaid SVG rendered. Expand table opened a `<dialog aria-label="Main areas">` and Escape closed it. The evidence `App.tsx:1334–1345` opened the Source tab `App.tsx` ("App.tsx source opened."). No horizontal page scroll at 390px. |
| 2 | System, desktop + narrow | **Pass.** Order: `summary, keyPoints, children (5 containers), related, dependencies, dependents, diagram, evidence`. `.architecture-brief` still renders directly after the blocks root. |
| 3 | nodeRef navigation | **Pass.** Clicking the "Related" chip selects that node: `sel` changes, the map highlights it and the inspector shows it. Tab from the Overview tab reached the chip in one press, and Enter navigated. The inspector ← button restored the previous container. Browser Back behaves as before: inspector selections replace the history entry through `openInspectorChild`, which this change did not touch, so Back leaves the atlas state rather than stepping through selections. After Enter, focus drops to `<body>` because the Overview remounts per entity. This is existing behavior. |
| 4 | Legacy fallback | **Pass.** Blocks: summary, related, parent, dependencies, generated mermaid ("Scene compiler —reads→ Architecture model", with names rather than ids), children and evidence. `LEGACY-*` role/interactions text is absent from the page. |
| 5 | Invalid-block drop | **Pass.** `enrichment:table` is absent (no `<table>`). `data-blocks-dropped="1"`, `data-block-items-omitted="0"`, and the visible note says "1 section omitted.". |
| 6 | No explanation; component/code | **Pass (partial).** `rust-renderer` shows observed blocks only (`summary, nodeRefs:related, relations:parent, relations:dependents, children`) with the captured responsibility. Component `component:compiler-scene` keeps the classic Overview (no `data-overview-blocks`, 0 block elements). The placeholder can't be reached in the demo because every container has a `responsibility`. A `code` entity couldn't be selected in the demo because clicking it opens source; unit tests cover both. |
| 7 | Deterministic reload | **Pass.** The same URL was loaded 3 times observed-only and 2 times re-seeded, and gave the same `data-block-id` sequence each time. |
| 8 | Console | **Pass.** The only messages were `/api/auth/me` 500 (the proxy points at a dead port by design) and a Permissions-Policy `tools` warning (an existing header). There were none from blocks or Mermaid. |

## Findings

1. **Explanation/entity mismatch (latent, existing wiring in `App.tsx:5695`).** The Overview is built for `contextualOverview` (the lens tail when the selection isn't explicit), but the explanation is looked up by `selected.id`. Repro: load `?fixture=okie` with no `sel`, seed a `container:web-app` explanation, then `history.pushState` to the same URL with `sel=container:web-app` and dispatch `popstate`. The Overview is titled **Okie / Software system** but shows the Atlas web app summary and key points (`bug-system-overview-shows-selected-container-explanation.png`). A direct URL load and in-app clicks were correct. The classic CLA-260 Overview has the same wiring. **Fixed after QA:** `ContextualOverviewView` now ignores an explanation whose `entityId ?? scopeId` ≠ `overview.entity.id` (`explanationForOverview`, unit-tested for both block and classic paths), so a mismatched scope falls back to the captured summary instead of being shown under the wrong title. The screenshot shows the pre-fix behaviour.
2. **Cosmetic, existing.** In `.inspector-link-row`, a long relationship label (`small { flex: 0 0 auto }`) overflows the row and overlaps the name. This is worst at 390px (`07-…`, `14-…`). The markup and CSS are unchanged by this diff; `LinkList` only moved.
3. **Cosmetic, existing.** The Mermaid "Expand diagram" button covers the bottom node of the web-app diagram (`02-…`, `14-…`).

## Screenshots

`01-container-v3-desktop-top`, `02-container-v3-desktop-diagram-table-evidence`, `03-container-v3-desktop-table-evidence`, `04-container-v3-table-expanded`, `05-container-v3-evidence-opens-source`, `06-noderef-click-focuses-rust-renderer-no-explanation`, `07-relations-dependents-row-layout`, `08-system-desktop-top`, `09-system-desktop-architecture-brief-below`, `10-legacy-explanation-desktop`, `11-invalid-table-dropped-with-note`, `12-component-classic-overview`, `13-container-v3-narrow-top`, `14-container-v3-narrow-relations-diagram`, `15-container-v3-narrow-table-evidence`, `16-system-narrow-top`, `17-system-narrow-architecture-brief`, `bug-system-overview-shows-selected-container-explanation` (all `.png`).
