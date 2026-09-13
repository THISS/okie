# Responsibility components browser QA

Date: 2026-09-13. Chrome through CUA, running local application. No live LLM calls or file uploads. These observations cover interactive browser behavior, not a video or Figma-like smoothness assessment.

## Published snapshot rendering

Exact reproduction URL:

```text
http://localhost:4173/r/THISS/okie?nav=1&repo=repo%3Aokie&snap=snapshot%3Aokie%3A722ea2862304&view=view%3Aokie%3Ahierarchy&root=container%3Aapps-web&sel=system%3Aokie&cx=-465.689&cy=-675.531&z=4.48649&detail=context&lens=system%3Aokie&lens=container%3Aapps-web
```

- Baseline and first root-only compiler fix: cold WebGPU frame at 449% contained blank navy rounded rectangles. Clicking one selected parent `@okie/web` (79 children). Canvas pan and minimap drag worked, but blanks persisted after panning. One zoom-out to 374%, then back to 449%, removed the rectangles.
- Retest after focused-container reserved-component primitive fix was rebuilt: a fresh tab at the exact URL had no blank component rectangles. Zoom-out/in kept them absent. Clicking visible `api/share.ts` opened a populated inspector with two dependencies and three implementing declarations.
- Remaining presentation difference: cold frame has a broad navy parent interior; after zoom reversal, a compact labeled parent card appears with black background. The targeted blank-component-grid defect passed; full cold/warm parent presentation equivalence was not established.

## Authored component and source navigation

Test artifact: temporary quick deterministic portable atlas pinned to `6a65b895f8a6f23c3da7f254734933ef64e72a71`, opened with:

```text
http://localhost:4173/?portable=1&nav=1&repo=repo%3Aokie&snap=snapshot%3Aokie%3A6a65b895f8a6&view=view%3Aokie%3Ahierarchy&root=container%3Aapps-web&sel=component%3Aapps-web-semantic-navigation
```

- `Semantic navigation` Overview shows its responsibility summary and explicit authored-component membership note.
- Implementing files shows two files: `apps/web/src/semantic/semanticLens.ts` (88 declarations) and `apps/web/src/semantic/semanticLensEngine.ts` (65), totaling 153. Both expand, showing five declarations and a Show all action. Show all 88 revealed the remaining declarations. Source tab also presents the two expandable files.
- Initial negative test: clicking either `validateRestoredSemanticLensPath` beyond the preview or the first declaration `advanceSemanticLensFocusTransfer` failed with “is not available in its canonical C4 level.” Selection stayed on the component.
- Retest after targeted child-scene compilation fix: the same `validateRestoredSemanticLensPath` click opened its code inspector, with parent Semantic navigation, one dependency, and one dependent. Source showed its saved excerpt at lines 574–585, frozen at the pinned commit. Open source in a tab created and selected `semanticLens.ts source` with the same excerpt.
- Search for `Semantic navigation` returned one matching component. Selecting it returned to Main and populated its inspector.

## Guided story and related routes

- Played the mapped overview tour, jumped to step 4 (`Open Semantic navigation`), and waited for `[data-playback-state="paused"]`. Inspector Source showed both implementing files.
- Jumped to step 5 (`Read SEMANTIC_LENS_POLICY`) and waited for the same paused state. Source showed pinned `semanticLens.ts` lines 6–17 and an Open source in a tab action. Renderer reported Canvas 2D fallback during these guided steps; this is not a WebGPU-specific playback claim.
- `/new` rendered the repository request screen and existing mapped repository links. Its THISS/okie link opened the published snapshot with a populated system Overview. `/` opened the golden atlas with a populated Details inspector.

## Limits

The quick portable artifact reported limited analysis coverage. During development HMR, the portable query flag was removed by navigation and a reload returned to the golden atlas; tests resumed by reopening the explicit portable URL. The declaration and dedicated-source retests completed successfully afterward. No persisted screenshot/video artifact was produced; screenshots and accessibility observations were inspected in the browser tool session.

## Final full semantic artifact smoke

After the full semantic artifact replaced the temporary packaged file, a fresh tab opened the same explicit portable URL. Browser evidence distinguishes this from the quick artifact: Semantic navigation now has 11 direct dependencies (previously six), and expanded Analysis coverage says full analysis was requested with TypeScript, JavaScript, and Rust resolved symbols. The badge still says limited: it records inferred compiler configuration, TypeScript import diagnostics, reused dependency types, and ambiguous Rust SCIP symbols. Full analysis requested does not mean complete coverage.

The authored summary and two files totaling 153 declarations remained populated. Show all 88 followed by `validateRestoredSemanticLensPath` again opened its code inspector, now with six direct dependencies and one dependent. Source displayed the same pinned lines 574–585.

A small L4 sample at 795%, including a minimap pan across several code rows, showed named declaration cards (for example `bandDominantIntervals`, `CODE_CARD_FACE`, and `codeCardFaceBounds`) and no unnamed rectangles in that sampled viewport. Large empty space below the code rows remained; target framing was not established as ideal. This limited sample is not a claim that all legacy L4 reservation behavior is fixed.

## Async navigation review retest

The first stale-load guard implementation regressed the ordinary browser flow: clicking `validateRestoredSemanticLensPath` left component selection unchanged without an announcement. After the guard compared stable navigation values instead of navigation object identity, a fresh full-artifact run passed: the declaration opened at code level with six dependencies and one dependent; Source displayed pinned lines 574–585. The race involving deliberately delayed completion and changed intent was covered by the implementation's deferred unit tests, not simulated in this browser session.
