# Comprehensive Re-Review Report: Okie Dogfooding Experience (`/r/THISS/okie`) Post-CLA-104

**Evaluation Date**: 2026-09-07\
**Evaluator**: Antigravity Experience Reviewer\
**Commit Range Evaluated**: CLA-99 through CLA-104 on `main` (`4b60bda`)\
**Target Route**: `http://localhost:4173/r/THISS/okie`\
**Reference Routes**: `http://localhost:4173/` (Golden Demo), `http://localhost:4173/new`, `http://localhost:4173/r/colinhacks/zod`\
**Entity Count**: 3,098 entities (freshly scanned with Rust AST parser)\

---

## 1. Executive Summary & Scorecard Update

Following the integration of PRs **CLA-99 through CLA-104**, the Okie dogfooding repository experience underwent deep interactive testing across mousewheel zooming, canvas panning, guided story playback, and inspector exploration.

The overall dogfooding experience rating rose from **7.3 / 10** to **8.8 / 10 (+1.5)**. The former major deficiency—where Rust crates (`atlas-engine`, `atlas-gpu`, etc.) lacked AST symbols and had disabled "Open inside" buttons—has been completely eliminated by **CLA-103**. With tree-sitter integration, Rust crates outline down to L3 modules (`src/camera.rs`, `src/geometry.rs`, `src/scene.rs`) and L4 code entities (`Camera`, `Camera::fit_rect`), complete with syntax-highlighted source code in the inspector.

In addition, **CLA-104** delivers continuous zoom handoff from L2 to L3 without camera-tile dead zones, **CLA-102** equips containers with honest technology tags, **CLA-100** cleanly anchors the Ask Atlas popover without obstructing the Guided tours launcher, and **CLA-99** hides raw C4 completeness advisory dumps from default Details.

### Comparative Scorecard

| Evaluation Area | Baseline Audit | Post-CLA-98 | Post-CLA-104 (Now) | Total Delta | Status & Key Impact |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **First 10-Second Impression** | **3 / 10** | **8 / 10** | **9 / 10** | 🟢 **+6.0** | Instant render into Overview Architecture Brief; clean landscape canvas; zero watermark collision; elegant launcher pill. |
| **Spatial Layout & Aspect Ratio (CLA-96)** | **2 / 10** | **8 / 10** | **8.5 / 10** | 🟢 **+6.5** | Widescreen ~2.46:1 aspect ratio; neat 3-column container grid; camera zoom floor clamped above readable threshold. |
| **Architectural Signal-to-Noise (CLA-97, 102)** | **4 / 10** | **8 / 10** | **9 / 10** | 🟢 **+5.0** | L1 external systems limited strictly to service boundaries (`@anthropic-ai/sdk`); containers carry honest tech tags (`Rust`, `tree-sitter-rust`, `TypeScript`). |
| **Multi-Language AST Parity (CLA-103)** | **3 / 10** | **3 / 10** | **9 / 10** | 🟢 **+6.0** | **MAJOR BREAKTHROUGH**: Rust crates now outline to L3 components and L4 code symbols via tree-sitter; "Open inside" fully enabled; 288 entities in `atlas-engine`. |
| **Continuous Zoom & Framing (CLA-104)** | **3 / 10** | **7 / 10** | **8.5 / 10** | 🟢 **+5.5** | Seamless L2→L3 zoom handoff; camera smoothly transitions onto container's file-component cluster without falling into reserved shell voids. |
| **Details & Inspector Clarity (CLA-99, 87)** | **4 / 10** | **8 / 10** | **9 / 10** | 🟢 **+5.0** | C4 advisory IDs hidden from user Details; clean evidence links, deterministic Mermaid flows, and source code viewer. |
| **Guided Stories & Launcher (CLA-98, 84, 89)** | **4 / 10** | **8 / 10** | **8.5 / 10** | 🟢 **+4.5** | Guided tours menu (4 tours); camera flight controller smoothly animates across hierarchy levels down to code lines (`apps/web/src/webmcp.ts`). |
| **Agentic Experience / Ask Atlas (CLA-100)** | **2 / 10** | **5 / 10** | **7 / 10** | 🟢 **+5.0** | Popover anchored to Ask-only button; does not occlude Guided tours; honest login prompt with local test sign-in flow. |
| **Technical Integrity & Stability** | **5 / 10** | **7.5 / 10** | **8.5 / 10** | 🟢 **+3.5** | 86/86 web test suites pass (844 tests); smooth 60fps canvas rendering; zero WebGL crashes. Minor non-fatal 404 on `enrichment-status.json`. |
| **OVERALL EXPERIENCE RATING** | **3.9 / 10** | **7.3 / 10** | **8.8 / 10** | 🟢 **+4.9** | **Exceptional milestone: Dogfooding atlas is now a first-class, multi-language architectural explorer.** |

---

## 2. Verification of PRs CLA-99 Through CLA-104

### 1. CLA-103: Rust Crate Outlining to L3/L4 via Tree-Sitter
- **Previous State**: All Rust crates (`atlas-engine`, `atlas-gpu`, `atlas-protocol`, `atlas-wasm`) were opaque black boxes with 0 components and 0 code symbols. The "Open inside" action was permanently disabled.
- **Verified Fix**:
  - `packages/scan/src/extract-rust.ts` parses Rust source files with `tree-sitter` and `tree-sitter-rust`.
  - Top-level modules, structs, enums, functions, and impl methods are extracted into file-components and code cards.
  - `atlas-engine` now contains **10 components** (`src/camera.rs`, `src/geometry.rs`, `src/hit_test.rs`, `src/lib.rs`, `src/lod.rs`, `src/protocol_runtime.rs`, `src/scene.rs`, `src/spatial.rs`, `src/story.rs`, `src/diagnostics.rs`) and **288 total entities**.
  - Drilling into `src/camera.rs` reveals **22 code symbols** (`Camera`, `Camera::fit_rect`, `CameraLimits`, `Camera::pan_screen`, `Viewport`, etc.).
  - Selecting any symbol opens the read-only source code viewer with line numbers and exact git SHA pin (`4b60bda43c3f`).
  - **Evidence Capture**:
    - Screenshot: `cla103-rust-l3.png` (L3 components view)
    - Screenshot: `cla103-rust-l4-code.png` (L4 code view with `Camera::fit_rect` syntax preview)
    - Video: `video-zoom-levels.webm` (Continuous zooming into Rust crate)

### 2. CLA-104: Scan Continuous Zoom L2→L3 Handoff
- **Previous State**: Continuous mousewheel zooming from L2 into L3 would hit a compile seam where the camera stayed centered on the reserved owner-shell interior, leaving the canvas hollow or causing cards to page out.
- **Verified Fix**:
  - `applyScanZoomHandoff` and `scanZoomHandoffCamera` in `App.tsx` and `semanticLensEngine.ts` detect when the camera crosses into the component band (`getLevel(z) === 2`).
  - Camera retargets dynamically onto the peer cluster at live zoom without dropping cards or stalling the burst gesture.
  - Raw camera state is stashed on `scanZoomAdoptRawRef` and consumed seamlessly into subsequent wheel events.
  - Tested on both TypeScript (`@okie/web`) and Rust (`atlas-engine`): scrolling smoothly transitions root scope and pans directly onto readable cards.
  - **Evidence Capture**:
    - Screenshot: `cla104-zoom-transition.png`
    - Video: `video-zoom-levels.webm`

### 3. CLA-102: Honest Container Technology Tags
- **Previous State**: Containers without explicit curated metadata showed generic or blank technology, or were categorized as "Technology not specified".
- **Verified Fix**:
  - Observed languages (`TypeScript`, `JavaScript`, `Rust`) are extracted directly from source files and attached to containers.
  - `atlas-engine`, `atlas-gpu`, `atlas-protocol`, `atlas-wasm` proudly display `Technology: Rust`.
  - `@okie/web` displays: `@fontsource/ibm-plex-mono · @fontsource/ibm-plex-sans · TypeScript · dompurify · mermaid · react · react-dom`.
  - `@okie/scan` displays: `TypeScript · tree-sitter · tree-sitter-rust · typescript`.
  - Technology tags appear consistently across the Overview Architecture Brief, the Details tab badge, and canvas card metadata.
  - **Evidence Capture**:
    - Screenshot: `cla102-tech-tags-overview.png`

### 4. CLA-100: Ask Atlas Popover Anchoring & Disconnected Honesty
- **Previous State**: Opening the Ask Atlas popover wrapped horizontally across the entire story launcher, completely blocking the "Guided tours" button and showing misleading previews.
- **Verified Fix**:
  - `.ask-anchor` keeps the popover anchored strictly to the Ask Atlas button (`width: 264px`, `left: 333px`).
  - The "Guided tours 4" button (`left: 604px`) remains completely visible, clickable, and accessible at all times.
  - The popover copy is completely honest: *"Sign in with GitHub to ask live questions. Viewing this atlas stays public — there is no login wall on the map."*
  - Local developers can click "Use the local test sign-in" to bypass OAuth in dev mode without confusing user states.
  - **Evidence Capture**:
    - Screenshot: `cla100-ask-popover.png`
    - Video: `video-inspector-ask.webm`

### 5. CLA-99: Hide C4 Completeness Advisory Dump from Details
- **Previous State**: Selecting an entity in Details displayed an unsightly wall of advisory IDs (`container:apps-server`, `component:...`, `+8 more completeness notes`) from CLA-59 completeness sampling.
- **Verified Fix**:
  - In `inspectorPanel.ts`, user Details suppresses advisory notes unless in Dev Mode (`?dev=1`).
  - True notation errors remain visible, while the default inspector presents clean, evidence-backed architectural facts.
  - Details tab now shows: Inferred source reference count, deterministic diagram shortcuts (Dynamic Flow, Mermaid View), Parent Layer, and frozen source links.
  - **Evidence Capture**:
    - Screenshot: `cla99-clean-details.png`
    - Video: `video-inspector-ask.webm`

---

## 3. Deep Interactive Testing: Zooming & Panning

### Canvas Panning Analysis
- **L1 Context**: Panning across the 1440x900 viewport feels smooth and responsive. With `packScanContextPeerMap` enforcing aspect ratio ~2.46:1, containers are laid out in an intuitive landscape matrix with ample whitespace. Dragging the canvas from the left edge (external `@anthropic-ai/sdk`) across to the core system containers maintains consistent 60fps frame rates.
- **L2 Containers**: Panning across the 10 containers shows clear column grouping:
  - Column 1: `@okie/server`, `atlas-gpu`, `@okie/architecture`, `tooling`
  - Column 2: `@okie/web`, `atlas-protocol`, `@okie/scan`
  - Column 3: `atlas-engine`, `atlas-wasm`, `@okie/scene-compiler`
  - Card titles, badges, and technology pills remain legible throughout pan operations.
- **L3 & L4 Panning**: Inside `atlas-engine`, panning between `src/camera.rs`, `src/geometry.rs`, and `src/scene.rs` allows rapid spatial exploration. Boundary clamping prevents disorienting out-of-bounds drifts.

### Mousewheel Zooming Analysis
- **Zoom Curve**: Wheel zoom feels proportional across `z = 0.52` (L1 floor) up to `z = 13.96` (L4 code view).
- **Seam Handoff**: CLA-104 eliminates the sudden void jump. When scrolling over a container, the canvas smoothly crossfades from the container card outline into its child component graph.
- **Observations on Wheel Friction**: Rapid high-velocity wheeling can occasionally trigger an assist settle frame where the camera re-centers slightly to preserve readability. This is a deliberate UX safety guard to prevent users from losing their spatial orientation.

---

## 4. Video Evidence Index

All recorded video artifacts are saved at:\
`/Users/brenton/.gemini/antigravity-cli/brain/f3bb4bcd-ef0b-4612-8df3-ddd1c263d925/videos/`

| Filename | File Size | Description & Key Demonstrations |
| :--- | :---: | :--- |
| **`video-zoom-levels.webm`** | **3.3 MB** | Continuous mousewheel scrolling in and out across L1, L2, L3, and L4. Demonstrates zoom into `@okie/web` (TypeScript) and `atlas-engine` (Rust), showcasing CLA-104 handoff and CLA-103 AST extraction. |
| **`video-panning-canvas.webm`** | **2.1 MB** | Panning across the widescreen canvas at L1, L2, and L3. Explores container neighborhoods from server/web to Rust crates, showing boundary behavior and text legibility. |
| **`video-guided-stories.webm`** | **2.5 MB** | Opening the Guided tours dropdown (4 tours), launching "Okie overview", and flying through Steps 1 to 5. Demonstrates camera flight animations, source code highlighting (`apps/web/src/webmcp.ts`), and focus isolation controls. |
| **`video-inspector-ask.webm`** | **1.6 MB** | Exploring the Architecture Brief in Overview, testing "Copy markdown", inspecting Details tab (verifying CLA-99 advisory cleanup), and opening Ask Atlas popover (verifying CLA-100 anchoring and local test sign-in). |

---

## 5. Visual Evidence Screenshots Index

All screenshots are saved at:\
`/Users/brenton/.gemini/antigravity-cli/brain/f3bb4bcd-ef0b-4612-8df3-ddd1c263d925/images/`

1. **`cla103-rust-l3.png`**: L3 Components inside `atlas-engine`, displaying 10 newly outlined Rust components (`src/camera.rs`, `src/geometry.rs`, etc.) with `Rust` technology badge.
2. **`cla103-rust-l4-code.png`**: L4 Code view for Rust `Camera::fit_rect` symbol, featuring read-only source preview with frozen git SHA.
3. **`cla104-zoom-transition.png`**: Continuous zoom handoff between L2 and L3, verifying camera retargeting onto the file-component cluster.
4. **`cla102-tech-tags-overview.png`**: Overview tab Architecture Brief showing honest container technology tags (`Rust`, `tree-sitter`, `TypeScript`).
5. **`cla100-ask-popover.png`**: Ask Atlas popover anchored cleanly above the Ask button, leaving "Guided tours" fully accessible.
6. **`cla99-clean-details.png`**: Details tab for `atlas-engine` free of raw C4 completeness advisory dumps.
7. **`cla98-guided-tours-menu.png`**: Guided tours menu expanded, displaying all 4 curated tours with duration badges.

---

## 6. Experience Evaluation: The Delights & The Friction

### What Feels Exceptional
1. **Multi-Language Parity (Rust + TypeScript)**: Okie is now genuinely a multi-language atlas. Exploring `atlas-engine` feels identical in quality and depth to exploring `@okie/web`.
2. **Deterministic Architecture Brief**: Landing immediately on an executive summary with interactive container buttons and an inline Mermaid flow is vastly superior to an empty or diagnostic-laden panel.
3. **Continuous Zoom Fluidity**: The camera handoff in CLA-104 bridges the mental gap between high-level containers and low-level source files.
4. **Story Playback Cinematic Feel**: The camera flights between architecture levels during guided tours provide immediate spatial understanding of how components interact.

### Areas for Next Polish
1. **DevTools Console 404 on `enrichment-status.json`**:
   - *Observation*: Visiting `/r/THISS/okie` logs an HTTP 404 error in the DevTools console: `Failed to load resource: the server responded with a status of 404 (Not Found) @ http://localhost:4173/scan/thiss__okie/enrichment-status.json`.
   - *Analysis*: In `scanFixture.ts`, `fetchOptionalScanJson` handles missing status safely. However, because standard browser fetch logs 404s to console, it creates an impression of an error.
   - *Recommendation*: Have the scan server or static generator produce a minimal `{ mode: "off" }` honesty payload or serve a 204 No Content instead of letting static file serving 404.
2. **Initial Direct URL Deep-linking with Selected Symbol**:
   - *Observation*: Directly loading a URL that specifies both a deep root and a selected symbol (e.g. `root=component:...&sel=code:...`) sometimes triggers an initial hierarchy settle that resets `root` to `system:okie` if the parent neighborhood has not yet finished streaming.
   - *Recommendation*: Ensure that when deep URLs are opened, initial hydration awaits the target neighborhood before triggering unsolicited camera fits.
3. **Live Agentic Ask Atlas Execution**:
   - *Observation*: The Ask Atlas interface is visually and structurally complete with honest copy, but answering live questions currently requires local test sign-in or GitHub auth.
   - *Recommendation*: Hook up the local dev server's Anthropic endpoint so developers running locally can query the 3,098 scanned entities in real-time.

---

## 7. Conclusion & Next Priority Roadmap

The jump from **3.9** (baseline) to **7.3** (CLA-98) and now **8.8** (CLA-104) marks a triumph in product polish and technical engineering. Okie is now a stunning, high-performance spatial atlas that handles large-scale multi-language repositories with ease.

### Recommended Next Sprints
1. **Silence Optional 404s**: Write `{ mode: "off" }` to `enrichment-status.json` during scans to achieve a 0-error browser console.
2. **Deep-link Rehydration**: Polish cold-start deep linking for L4 code cards.
3. **Live LLM Agent in Ask Atlas**: Connect the local server ask endpoint for live conversational atlas querying.
