# Audit Report: Deep-Zoom Experience, Typography Scaling & Node Design (L3 Components & L4 Code)

**Evaluation Date**: 2026-09-08\
**Evaluator**: Antigravity Pair Programmer / Reviewing Agent\
**Context**: Deep-zoom inspection of `@okie/web` (TypeScript container) and `atlas-engine` (Rust container) on `http://localhost:4173/r/THISS/okie` down to L3 components and L4 code entities.\
**Commit Range**: CLA-101 through CLA-109 (`722ea28` on `main`)\
**Entities In Scope**: `@okie/web` (79 components, 1,253 code entities), `atlas-engine` (10 components, 277 code entities)\

---

## 1. Executive Summary & Overview

Following the successful stabilization of continuous zoom and panning (CLA-101 to CLA-109), this QA evaluation focused on the granular user experience when zooming deeply into containers—specifically `@okie/web` and `atlas-engine`—down to L3 (file components) and L4 (AST code symbols).

We investigated text legibility on small containers and components, font scaling vs. truncation, ellipsis behavior, hover responsiveness, and overall node design.

### Key Video & Screenshot Artifacts Recorded
- **Live Video Recording**: [`web-container-l3-l4-zoom.webm`](file:///Users/brenton/.gemini/antigravity-cli/brain/f3bb4bcd-ef0b-4612-8df3-ddd1c263d925/videos/web-container-l3-l4-zoom.webm) (18 MB, 6 chapters)
  - *Chapter 1*: Zooming into components in `@okie/web`
  - *Chapter 2*: Zooming into L4 code level
  - *Chapter 3*: Open inside `src/ask/askAtlas.ts` (L4 Code Level)
  - *Chapter 4*: Zooming into L4 code cards grid & capturing the zoom-out bug
  - *Chapter 5*: Open inside `atlas-engine` (Rust container)
  - *Chapter 6*: Open inside `src/diagnostics.rs` and viewing Rust code in Source tab
- **Key Screenshots Captured**:
  1. [`web-container-l3-focus.png`](file:///Users/brenton/.gemini/antigravity-cli/brain/f3bb4bcd-ef0b-4612-8df3-ddd1c263d925/images/web-container-l3-focus.png): Single giant component card anomaly (`src/ask/askAtlas.ts` occupying 85% canvas, 95% empty teal space).
  2. [`web-container-l4-code.png`](file:///Users/brenton/.gemini/antigravity-cli/brain/f3bb4bcd-ef0b-4612-8df3-ddd1c263d925/images/web-container-l4-code.png): 52 code cards packed into a dense 7x8 grid, text illegible due to $z = 2.87$ container-band zoom.
  3. [`web-container-l4-jump-defect.png`](file:///Users/brenton/.gemini/antigravity-cli/brain/f3bb4bcd-ef0b-4612-8df3-ddd1c263d925/images/web-container-l4-jump-defect.png): Camera violent reset bug upon touching mousewheel at L4.
  4. [`atlas-engine-l3.png`](file:///Users/brenton/.gemini/antigravity-cli/brain/f3bb4bcd-ef0b-4612-8df3-ddd1c263d925/images/atlas-engine-l3.png): Extreme triple truncation (`...`, `...ics.rs`, `No...`) on small component card.
  5. [`rust-diagnostics-l4.png`](file:///Users/brenton/.gemini/antigravity-cli/brain/f3bb4bcd-ef0b-4612-8df3-ddd1c263d925/images/rust-diagnostics-l4.png): Rust L4 code cards (`FrameDiagnostics`, `RendererBackend`) displaying redundant relative filepaths.
  6. [`rust-source-viewer-l4.png`](file:///Users/brenton/.gemini/antigravity-cli/brain/f3bb4bcd-ef0b-4612-8df3-ddd1c263d925/images/rust-source-viewer-l4.png): Linked source code viewer with syntax highlighting and line numbers.

---

## 2. Key Findings & Root Cause Analysis

### Finding 1: The "Open Inside" Camera Zoom Mismatch & Violent Kick-Out Defect (CRITICAL BUG)
- **Symptom**: When a user selects a component with many code symbols (e.g. `src/ask/askAtlas.ts`, with 52 code entities) and clicks "Open inside":
  1. The camera frames the component at $z = 2.87637$.
  2. The 52 code cards are rendered as microscopic $40 \times 25\text{ px}$ smudges with illegible text.
  3. The moment the user moves the mousewheel to zoom in, **the camera resets completely back to `system:okie` (L2/L1)**, losing the user's place entirely!
- **Root Cause**:
  1. In [`apps/web/src/semantic/semanticLensEngine.ts#L678-L491`](file:///Users/brenton/sites/okie/apps/web/src/semantic/semanticLensEngine.ts#L678-L491), `frameProjectionScope` lacks a dedicated handler for `detail === 'code'`. It falls through to `coverageRevealLandingZoom(rootBounds, ...)`. For wide component bounds, `fill` evaluates to $\approx 4.1$, yielding $z = 0.7 \times 4.1 = 2.87637$.
  2. $z = 2.87637$ falls inside the **container zoom band** ($1.16 \le z \le 3.75$), whereas the code band is defined as $z \ge 7.10$ (focusZoom $13.96$).
  3. When the user scrolls the wheel, `maybeScanZoomHandoff` evaluates the current zoom ($2.87$), determines `zoomDetail = 'container'`, and calls [`scanCompileFocusForBand(snapshot, preferredId, 'container', viewRootId)`](file:///Users/brenton/sites/okie/apps/web/src/renderer/lazyBandCompile.ts#L122), which returns `viewRootId` (`system:okie`). The system thinks the user is zooming out at container level, immediately evicting the component view and resetting the canvas!

---

### Finding 2: Zero Font Scaling for Components and Code Cards (`titleFloor` Bug)
- **Symptom**: When a component card is narrow or compact, its title and kicker do not scale down; they immediately get chopped off into severe ellipsis (e.g., `...`, `...ics.rs`, `No...`).
- **Root Cause**:
  - In [`packages/scene-compiler/src/compile-c4.ts#L299-L301`](file:///Users/brenton/sites/okie/packages/scene-compiler/src/compile-c4.ts#L299-L301):
    ```ts
    const titleFloor = band === 'context' || band === 'container'
      ? C4_LABEL_MIN_TITLE_PX / focusZoom
      : authoredTitleFontSize;
    ```
  - And in [`apps/web/src/renderer/Canvas2DRenderer.ts#L572-L574`](file:///Users/brenton/sites/okie/apps/web/src/renderer/Canvas2DRenderer.ts#L572-L574):
    ```ts
    const titleFloor = renderedDetail === 'context' || renderedDetail === 'container'
      ? C4_LABEL_MIN_TITLE_PX
      : metrics.titleFontSize;
    ```
  - Notice that for `band === 'component'` and `band === 'code'`, `titleFloor` is set to `authoredTitleFontSize`!
  - `fitDisplayTextAtSize` in `display-text.ts` iterates from `fontSize` down to `floor`. Because `floor == ceiling`, **it never shrinks the font for components or code cards**. If the title doesn't fit at 100% font size, it immediately executes hard character truncation.

---

### Finding 3: Destructive Left-Stem Truncation (`truncateSlashedIdentifier`)
- **Symptom**: In [`atlas-engine-l3.png`](file:///Users/brenton/.gemini/antigravity-cli/brain/f3bb4bcd-ef0b-4612-8df3-ddd1c263d925/images/atlas-engine-l3.png), `src/diagnostics.rs` is displayed as `...ics.rs`. In other views, `isolateNeighborhood.ts` appears as `...rhood.ts`.
- **Root Cause**:
  - In [`packages/scene-compiler/src/display-text.ts#L100`](file:///Users/brenton/sites/okie/packages/scene-compiler/src/display-text.ts#L100):
    ```ts
    return `…${characters(segments.at(-1)!).slice(-(maximum - 1)).join('')}`;
    ```
  - When the final filename segment exceeds the character capacity, the algorithm slices off the **front** of the filename stem.
  - The stem is the primary semantic anchor for a software engineer. Slicing off the prefix turns meaningful filenames into mystery extensions (`...ics.rs`, `...bjects.ts`, `...server.ts`).

---

### Finding 4: Complete Absence of Canvas Hover Tooltips / Popovers
- **Symptom**: Hovering over any card on the canvas produces zero interactive feedback. A user seeing `...ics.rs` or a card with `"No summary supplied."` cannot hover to see the full path or details.
- **Root Cause**:
  - In [`apps/web/src/App.tsx#L1046-L1050`](file:///Users/brenton/sites/okie/apps/web/src/App.tsx#L1046-L1050), hover state tracking (`hoveredPick`) is active only when `authoringTool === 'connect'`.
  - In normal exploration mode, `Canvas2DRenderer` does not emit hover events for non-interactive cards, nor is there any floating tooltip overlay / HUD element. The user is forced to click the card and look over at the right-hand inspector panel.

---

### Finding 5: Information Architecture & Spatial Density Issues
1. **The Single Giant Card Anomaly**:
   - In `@okie/web`, `src/ask/askAtlas.ts` occupies 85% of the canvas height, while other components are pushed to the margins.
   - 95% of the interior of `src/ask/askAtlas.ts` is empty teal canvas padding. It contains no sub-elements, preview symbols, or structural hints unless opened.
2. **Redundant Copy on L4 Code Cards**:
   - In [`rust-diagnostics-l4.png`](file:///Users/brenton/.gemini/antigravity-cli/brain/f3bb4bcd-ef0b-4612-8df3-ddd1c263d925/images/rust-diagnostics-l4.png), every code card displays `SOURCE`, the symbol name (`FrameDiagnostics`), and repeats the full relative file path (`crates/atlas-engine/src/diagnostics.rs`).
   - The user is already zoomed inside `src/diagnostics.rs`. Repeating this path wastes valuable card space that could show the symbol kind (`enum`, `struct`, `fn`), line numbers (`L7-17`), or docstring excerpt.
3. **Bottom Navigation Gesture Collision**:
   - In [`web-container-l3-focus.png`](file:///Users/brenton/.gemini/antigravity-cli/brain/f3bb4bcd-ef0b-4612-8df3-ddd1c263d925/images/web-container-l3-focus.png), the bottom instruction text (`"Scroll to zoom · drag to pan · click to inspect · double-click to open inside"`) lacks a frosted shield card (unlike the top-left header shield introduced in CLA-108) and prints directly over cards at the bottom of the canvas.

---

## 3. Recommended Architectural & UX Solutions

| Area | Current Behavior | Proposed Solution | Implementation Target |
| :--- | :--- | :--- | :--- |
| **L4 Code Band Framing** | "Open inside" on component sets $z = 2.87$ (container band) and resets on wheel. | In `frameProjectionScope`, when `detail === 'code'`, enforce `minZoom >= ATLAS_SEMANTIC_ZOOM_BANDS[3].enterZoom` ($z \ge 7.10$, ideally focusZoom $13.96$). | [`apps/web/src/semantic/semanticLensEngine.ts`](file:///Users/brenton/sites/okie/apps/web/src/semantic/semanticLensEngine.ts) |
| **Text Scaling Floor** | `titleFloor` locked to 100% font size for components and code cards. | Allow `titleFloor` to shrink up to 35% (down to 10px / 9px) before truncating. | [`packages/scene-compiler/src/compile-c4.ts`](file:///Users/brenton/sites/okie/packages/scene-compiler/src/compile-c4.ts) & [`Canvas2DRenderer.ts`](file:///Users/brenton/sites/okie/apps/web/src/renderer/Canvas2DRenderer.ts) |
| **Path Truncation** | Slices off the start of filename stem (`...ics.rs`, `...rhood.ts`). | Truncate middle of stem with ellipsis (`diag…cs.rs` or `diagnostics…`), preserving the file stem and extension. | [`packages/scene-compiler/src/display-text.ts`](file:///Users/brenton/sites/okie/packages/scene-compiler/src/display-text.ts) |
| **Hover Tooltip / HUD** | Canvas hover does nothing in exploration mode. | Lightweight floating tooltip / HUD chip on pointer hover over any truncated card or card with `"No summary supplied."`. | [`apps/web/src/App.tsx`](file:///Users/brenton/sites/okie/apps/web/src/App.tsx) |
| **L4 Code Card Metadata** | Card description repeats parent filepath. | Display symbol keyword badge (`enum`, `struct`, `fn`), line range (`L7-L17`), and docstring / signature excerpt. | [`packages/scene-compiler/src/compile-c4.ts`](file:///Users/brenton/sites/okie/packages/scene-compiler/src/compile-c4.ts) |
| **Bottom Gesture Hint Shield** | White copy rendered directly on canvas cards. | Wrap bottom gesture hints in the same frosted shield card style (`backdrop-filter: blur`, rounded corners, padded bg) as CLA-108. | [`apps/web/src/App.tsx`](file:///Users/brenton/sites/okie/apps/web/src/App.tsx) |
