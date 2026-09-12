# 02. Visual & Spatial Canvas Audit

## 1. The Skyscraper Problem: 0.58 vs. 3.07 Aspect Ratio

### Observed Metrics
- **Golden Scene (`demo-scene.json`)**:
  - `worldBounds`: `{ x: -40, y: 0, width: 2300, height: 750 }`
  - Aspect Ratio: **3.07 : 1** (Landscape widescreen)
  - Result: Fills desktop displays (16:9 / 16:10) naturally. Containers are laid out horizontally in 2 balanced rows.
- **Scanned Scene (`thiss__okie/scene.json`)**:
  - `worldBounds`: `{ x: -40, y: -1719.88, width: 2300, height: 3929.76 }`
  - Aspect Ratio: **0.58 : 1** (Extremely tall vertical column)
  - Result: 5.2× taller than the golden scene!

### Why this breaks the experience
1. **Fit-to-View Emptiness**: When the user clicks "Fit architecture to view" (or presses `f`), the camera fits the 3,930px height into the ~700px viewport height. This forces zoom down to `z ≈ 0.17–0.5`. At this zoom level:
   - Text is completely illegible.
   - All containers occupy a narrow ~500px strip in the center (`x: 791` to `x: 1294`).
   - The left 800px and right 1000px of the canvas are vast, pitch-black voids.
2. **Container Height Imbalance**:
   - `container:apps-web`: Height = **2,728.77px** (stretching from `y: -1563` to `y: 1165`).
   - `container:apps-server`: Height = **653.27px**.
   - `container:crates-atlas-engine`: Height = **45.64px**.
   `apps-web` is 60× taller than `atlas-engine` because `apps-web` packs hundreds of TypeScript files vertically, while Rust crates have no extracted child components.

### Root Cause in Code
While the compiler has an aspect-aware packing engine (see `packages/scene-compiler/src/aspect-compile.qa.test.ts`), the scan backend (`apps/server` / `packages/scan`) compiles `scene.json` statically at publish time **without passing `targetAspect`**, falling back to single-column stacking.

---

## 2. Watermark & Title Collisions

### Observed Bug
In `http://localhost:4173/r/THISS/okie`:
- The `.map-heading` overlay renders at:
  - `top: 131px`, `left: 27px`, text: `"okie scan \n okie"`
- The canvas visual node `visual-node:external:anthropic-ai-sdk` renders at:
  - `bounds: { x: 40, y: 180, width: 200, height: 190 }`
- At the initial default camera position (`cx: -320.23, cy: -420.44, z: 0.536`), the canvas node is projected directly underneath `.map-heading`.
- The user sees `"okie scan okie"` and `"EXTERNAL SYSTEM @anthropic-ai/sdk"` smashed together into an unreadable mess of overlapping text.

### Recommendation
1. Enforce a safe canvas boundary margin: scene nodes must never be positioned in the top-left 250px × 150px zone.
2. Integrate a collision-aware camera framing policy that ensures no rendered node overlaps HTML overlay anchors (`.map-heading`, `.semantic-breadcrumb`, `.level-rail`).

---

## 3. The 3-Tier Floating Story Launcher Pileup

### Observed Bug
In the golden demo, the bottom floating controls consist of two tidy buttons:
1. `[Ask Atlas | Explain this codebase spatially ⌘↵]`
2. `[From Okie to selectScopedView() 13 sec]`

In `/r/THISS/okie`, five buttons are generated:
- `Ask Atlas` (width: 264px)
- `okie overview 16 sec` (width: 160px)
- `okie: Paste a repository 13 sec` (width: 207px)
- `okie: Ask the atlas 7 sec` (width: 176px)
- `okie: Embed the atlas 10 sec` (width: 199px)

Because `.story-launcher` has CSS `display: flex; flex-wrap: wrap; position: absolute; bottom: 62px;`:
- The 5 buttons wrap into **3 jagged vertical rows** extending from `y: 491px` to `y: 658px` (height: 167px).
- They completely cover:
  - The canvas cards behind them.
  - The minimap in the lower right.
  - The zoom controls.
  - The gesture help hint (`Scroll to zoom · drag to pan...`).

### Recommendation
- Convert `.story-launcher` to a **single-row horizontal pill container** with a maximum of two primary actions:
  1. `[✨ Ask Atlas ⌘↵]`
  2. `[▶ Stories (4) ▾]` — A clean popover menu listing all available guided tours with their durations, or a horizontal scroll tray.
- Strip the redundant `"okie: "` prefix from story titles (`"Paste a repository"`, `"Ask the atlas"`, `"Embed the atlas"`).

---

## 4. "Open Inside" Camera Disorientation

### Observed Behavior
1. User is on L1 Context view.
2. User selects `okie` and clicks `"Open inside →"`.
3. The camera animates to:
   `cx: 287.77, cy: -366.76, z: 1.54, lens: system:okie`
4. **The Screen Goes Almost Entirely Blank**:
   - The user sees a black screen.
   - In the top-left corner, one small card (`@okie/web`) is visible.
   - The other 9 containers are completely off-screen.
   - The inspector panel does not change to show the containers inside; it remains locked to L1 `okie`.

### Why this happens
Because `system:okie` spans from `y: -1599` to `y: 2089` (3,689px), the camera centers on `(cx: 287, cy: -366)` which sits in the empty top padding between `apps-web` and `apps-server`. The user loses all spatial orientation and feels like the application crashed or failed to render.

### Recommendation
- Camera target for `Open inside` must be calculated from the **bounding box of the visible child nodes**, not the abstract system boundary.
- When opening inside a system, default the camera to fit all container nodes in a compact, padded bounding box with minimum 48px padding.
- Automatically select the primary entry container (e.g. `@okie/web` or `@okie/server`) in the inspector upon entering L2.
