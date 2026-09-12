# 05. Actionable Roadmap & Implementation Plan

A prioritized engineering plan to bring `/r/THISS/okie` up to and beyond the golden demo reference experience.

---

## Phase 1: Immediate Experience & Visual Polish (P0 — Days 1–3)

### 1.1 Fix the Skyscraper Aspect-Ratio Bug
- **Files**: `packages/scene-compiler/src/compile-c4.ts`, `packages/scan/src/scan.ts`, `apps/server/src/scanService.ts`
- **Action**:
  - Ensure `targetAspect: ASPECT_PRESET_TARGET.landscape` (1.6) is passed when compiling scanned scenes during publish.
  - Repack container grids horizontally rather than stacking vertically.
- **Acceptance Gate**:
  - `worldBounds.width / worldBounds.height` must be $\ge 1.4$.
  - "Fit architecture to view" (`f`) fills the canvas horizontally with balanced vertical margins.

### 1.2 Prevent Watermark & Card Collisions
- **Files**: `packages/scene-compiler/src/compile-c4.ts`, `apps/web/src/App.tsx`
- **Action**:
  - Add top-left safe area padding in layout compilation (`y_min \ge 240px` when `x < 400px`).
  - Update `measureCurrentMapSafeArea()` so camera framing never allows nodes to enter the `.map-heading` bounding box.
- **Acceptance Gate**:
  - On initial load, no canvas node or edge overlaps `.map-heading` or `.semantic-breadcrumb`.

### 1.3 Fix Floating Story Launcher Pileup & Modals
- **Files**: `apps/web/src/App.tsx`, `apps/web/src/app.css`
- **Action**:
  - Set `.story-launcher` to `flex-wrap: nowrap; overflow-x: auto; max-width: 600px;`.
  - Group multiple guided stories into a single dropdown trigger: `[✨ Ask Atlas ⌘↵] [▶ Guided Tours (4) ▾]`.
  - Add solid backdrop background with `backdrop-filter: blur(12px)` to the Ask Atlas login and question popovers.
  - Strip redundant `"okie: "` prefixes from story titles.
- **Acceptance Gate**:
  - Launcher never stacks beyond a single neat horizontal row.
  - Popovers have zero background text bleeding through.

### 1.4 Sanitize Leaked Pipeline Diagnostics & Advisories
- **Files**: `packages/scan/src/enrich.ts`, `apps/web/src/App.tsx`, `apps/web/src/inspector/`
- **Action**:
  - Remove strings like `"Enrichment partial — 4 accepted (gate rejected)"` from user-visible description fields; fall back to deterministic summaries cleanly.
  - Hide "56 C4 ADVISORIES" behind Dev Mode (`Shift+Alt+D`).
  - Fix 404 handler for `enrichment-status.json`.
- **Acceptance Gate**:
  - Zero internal engine diagnostics appear in the inspector.
  - Zero 404 errors in browser console.

---

## Phase 2: Information Architecture & Multi-Language Ingestion (P1 — Weeks 1–2)

### 2.1 Filter npm Utility Packages out of L1 External Systems
- **Files**: `packages/scan/src/extract.ts`, `packages/scan/src/externals.test.ts`
- **Action**:
  - Distinguish between runtime service boundaries (APIs, platforms) and standard library dependencies.
  - Suppress font packages (`@fontsource/*`), UI utility packages (`dompurify`, `clsx`), and framework internals (`react`, `react-dom`) from C4 L1 External Systems.
  - Elevate only meaningful external systems (Anthropic API, GitHub API, WebGPU Platform).
- **Acceptance Gate**:
  - L1 Context view contains $\le 3$ relevant external systems with meaningful descriptions and active verbs.

### 2.2 Auto-Detect Container Technologies
- **Files**: `packages/scan/src/extract.ts`
- **Action**:
  - Scan container manifests (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`) and file extensions to infer technology stacks.
  - Replace `[ Technology not specified ]` with accurate tags (e.g. `React · TypeScript`, `Rust · WebAssembly · wgpu`).
- **Acceptance Gate**:
  - Every container displays valid technology tags in the inspector.

### 2.3 Rust Crate Tree-Sitter Outline Ingestion
- **Files**: `packages/scan/src/extract.ts`, `docs/roadmap/scan-static-analysis-and-agent-swarm.md`
- **Action**:
  - Integrate `tree-sitter-rust` into the extraction pipeline.
  - Extract Rust modules (`mod`), structs (`struct`), enums, and functions as L3 components and L4 code entities.
  - Enable "Open inside" on `crates/atlas-engine`, `atlas-gpu`, `atlas-protocol`, and `atlas-wasm`.
- **Acceptance Gate**:
  - Clicking "Open inside" on `atlas-engine` successfully drills into its internal module layout with code outlines.

---

## Phase 3: True Agentic Codebase Onboarding (P2 — Weeks 3–4)

### 3.1 Live Ask Atlas with Spatial Narrative Routing
- **Files**: `apps/server/src/ask.ts`, `apps/web/src/ask/`, `apps/server/src/llmGateway.ts`
- **Action**:
  - Connect `submitQuestion` to the `@okie/server` ask endpoint.
  - Ground LLM answers in the extracted C4 entity graph and source excerpts.
  - Return dynamic, query-driven 3-step spatial camera flights (System → Component → Code) that visually show the answer on the map.
- **Acceptance Gate**:
  - Asking *"How does Okie render scenes?"* flies the camera to `atlas-engine`, highlights `protocol_runtime.rs`, and opens the relevant source excerpt with a concise narrative answer.

### 3.2 High-Quality Contextual Story Narrations
- **Files**: `packages/scan/src/enrich.ts`, `apps/server/src/enrichment.ts`
- **Action**:
  - Upgrade enrichment prompts to generate human-grade explanations of **flow and purpose** rather than syntactic file-path repetitions.
  - Clamp camera flights to `z \le 3.5` so context is never lost to black-screen voids.
- **Acceptance Gate**:
  - All guided story steps provide clear architectural insights with visible surrounding spatial context.
