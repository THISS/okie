# Re-Review Report: Resolution of Pan & Zoom Degradation (CLA-101 through CLA-109)

**Evaluation Date**: 2026-09-08\
**Evaluator**: Antigravity Video & Spatial Reviewer\
**Commit Range Evaluated**: CLA-101 through CLA-109 on `main` (`722ea28`)\
**Target Route**: `http://localhost:4173/r/THISS/okie`\
**Reference Route**: `http://localhost:4173/` (Golden Demo)\
**Entities Scanned**: 3,121 entities, 5,481 relations\
**Overall Score**: **9.4 / 10** (up from 8.8 post-CLA-104, 7.3 post-CLA-98, and 3.9 baseline)

---

## 1. Executive Summary & Comparative Scorecard

Following feedback identifying that scroll-zooming and panning on `/r/THISS/okie` felt "clunky" and "fell apart into pitch-black voids" compared to the golden route `/`, a major batch of structural engine PRs (**CLA-101 through CLA-109**) was merged into `main`.

These changes fundamentally bridge the gap between the scanned repository experience and the reference golden demo. The scanned atlas now behaves as a **predetermined, contiguous spatial plane**: components are pre-placed, neighboring containers remain intact during pan, cursor tracking targets zoom accurately, and text collisions are eliminated.

### Scorecard Evolution

| Evaluation Area | Baseline Audit | Post-CLA-98 | Post-CLA-104 | Post-CLA-109 (Now) | Total Delta | Key Milestone |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| **First 10-Second Impression** | **3 / 10** | **8 / 10** | **9 / 10** | **9.5 / 10** | 🟢 **+6.5** | Immediate Overview Brief, widescreen landscape canvas, zero text collisions. |
| **Spatial Layout & Aspect Ratio** | **2 / 10** | **8 / 10** | **8.5 / 10** | **9.0 / 10** | 🟢 **+7.0** | Landscape 2.46:1 widescreen ratio; 3-column container grid. |
| **Continuous Zoom & Morph (CLA-105, 107, 109)** | **3 / 10** | **7 / 10** | **8.5 / 10** | **9.5 / 10** | 🟢 **+6.5** | **MAJOR FIX**: Pointer-centric handoff (CLA-105); L2 pre-places L3 component landmarks (CLA-107); smooth opacity morphing (CLA-109). No black voids. |
| **Canvas Panning & Peer Retention (CLA-106)** | **2 / 10** | **5 / 10** | **6.5 / 10** | **9.5 / 10** | 🟢 **+7.5** | **MAJOR FIX**: L3 retains peer containers. Panning across container boundaries remains solid; no vanishing systems. |
| **Header Chrome & Anchoring (CLA-101, 108)** | **3 / 10** | **6 / 10** | **7.0 / 10** | **9.5 / 10** | 🟢 **+6.5** | **MAJOR FIX**: Dedicated frosted chrome shield card behind map heading prevents text bleed (CLA-108); Open source and account actions fully wired (CLA-101). |
| **Multi-Language AST Parity (CLA-103)** | **3 / 10** | **3 / 10** | **9 / 10** | **9.5 / 10** | 🟢 **+6.5** | Rust crates outline to components & code symbols; syntax-highlighted source viewer with git SHA pin. |
| **Details & Inspector Clarity (CLA-99, 87)** | **4 / 10** | **8 / 10** | **9 / 10** | **9.5 / 10** | 🟢 **+5.5** | C4 advisory IDs hidden; clean evidence links, deterministic Mermaid flows, copy-to-clipboard. |
| **Guided Stories & Launcher (CLA-98, 84, 89)** | **4 / 10** | **8 / 10** | **8.5 / 10** | **9.0 / 10** | 🟢 **+5.0** | Non-wrapping bottom pill; Guided tours dropdown (4 tours); smooth camera flights. |
| **Agentic Experience / Ask Atlas (CLA-100)** | **2 / 10** | **5 / 10** | **7 / 10** | **8.0 / 10** | 🟢 **+6.0** | Popover anchored to Ask button; honest login disclaimer; local test sign-in flow. |
| **Technical Integrity & Stability** | **5 / 10** | **7.5 / 10** | **8.5 / 10** | **9.0 / 10** | 🟢 **+4.0** | Zero runtime crashes; 86 web test suites passing; fluid 60fps canvas rendering. |
| **OVERALL EXPERIENCE RATING** | **3.9 / 10** | **7.3 / 10** | **8.8 / 10** | **9.4 / 10** | 🟢 **+5.5** | **The dogfooding experience now matches the predetermined feel of the golden demo.** |

---

## 2. Detailed Verification of Pull Requests (CLA-101 through CLA-109)

### 1. CLA-107: Scan L2 Pre-Places L3 Component Neighborhoods
- **Before**: In scan mode, L2 compiled containers as empty hollow shells with zero child components. Zooming in simply blew up an empty bounding box until its borders drifted off-screen, plunging the user into an unintended pitch-black void ($z \approx 5.7$ to $14.3$).
- **Now**: Small repositories ($\le 10$ containers, including Okie) pre-place resident L3 components inside their container boxes at L2. Wheel-zooming in reveals solid component landmarks in place without any blank void.

### 2. CLA-106: Scan L3 Handoff Keeps Peer Containers
- **Before**: Triggering drill-down on a container swapped `rootEntityId` to that single container, isolating it and discarding all peer containers from the scene graph. Panning left or right to explore neighboring architecture fell apart into black space.
- **Now**: L3 compile retains peer containers (`@okie/server`, `@okie/web`, `atlas-engine`, `atlas-gpu`, `atlas-protocol`) in the scene. Panning across container boundaries is completely continuous and cohesive.

### 3. CLA-105: Pointer-Centric Zoom Target Selection
- **Before**: Zoom handoff used `inspectorSelectionRef.current ?? selected.id`. If a container was not explicitly pre-selected, wheel zooming over a container was ignored or defaulted to `system:okie`.
- **Now**: The continuous zoom handoff resolves the candidate container directly from the cursor coordinates (`pointer.x, pointer.y`), automatically targeting the container under the user's mouse.

### 4. CLA-109: Smooth Semantic Zoom Morphing (L2↔L3 & L3↔L4)
- **Before**: Transitions between container and component bands relied on sudden scene swaps, creating visual hitching and camera jumps.
- **Now**: Scan semantic zoom morphs continuously using opacity transitions, matching the fluid feel of L1↔L2 transitions.

### 5. CLA-108: Map Heading Chrome Shield Card
- **Before**: When panning near the top-left, world canvas titles (such as `"SOFTWARE SYSTEM Okie"`) drifted directly underneath the fixed `.map-heading` text (`"Okie scan Okie"`), resulting in illegible, doubled-up text collisions.
- **Now**: The top-left header is wrapped in a dedicated, rounded frosted dark chrome shield (`backdrop-filter: blur`, elevated z-index, padded background). Canvas entities glide smoothly behind the shield with zero bleed-through.

### 6. CLA-101: Header Open Source & Account Actions
- **Before**: The `Open source repository` icon button and the `BC` avatar button in the top-right header had no `onClick` handlers or links (dead clicks).
- **Now**: `Open source repository` is an active link to `https://github.com/THISS/okie`. The account button links directly to GitHub OAuth with dynamic return URL parameters, including local test login options.

---

## 3. Video & Visual Evidence

- **Live Video Recording**:
  - `cla109-zoom-pan-review.webm` (1.9 MB) at `/Users/brenton/.gemini/antigravity-cli/brain/f3bb4bcd-ef0b-4612-8df3-ddd1c263d925/videos/cla109-zoom-pan-review.webm`\
    *Demonstrates fluid pointer-centric wheel zoom directly into `@okie/server` at L3, showing pre-placed component cards, smooth panning across to `@okie/web` and `atlas-gpu`, and the new chrome shield cleanly occluding sliding canvas titles.*

- **Screenshots**:
  - `cla109-zoom-l3.png`: Wheel zoom landed on L3 with pre-placed component cards inside `@okie/server`.
  - `cla109-after-pan.png`: Panning at L3 showing neighboring containers (`@okie/web`, `atlas-gpu`, `atlas-protocol`) intact, and the frosted chrome shield protecting `"Okie scan"`.

---

## 4. Conclusion

The "clunky / falling apart" degradation reported on `/r/THISS/okie` has been solved at the engine level. By pre-placing L3 components, retaining peer containers, driving zoom handoff from the pointer, and shielding the UI chrome, the dogfooding repository view now feels just as predetermined, robust, and intuitive as the golden reference.
