# 04. Agentic Interaction & Guided Stories Audit

## 1. "Ask Atlas": Bridging the Agent Gap

### The Core Vision
The user's central requirement:
> *"We need http://localhost:4173/r/THISS/okie to feel good and be something people reach for when trying to get up to speed in a software system. A better way than reading code due to speed and that we have agents make it simpler to digest what is going on."*

### Current Reality in `/r/THISS/okie`
1. **Login Wall Friction & Visual Glitch**:
   - Clicking `"Ask Atlas"` presents a popover requiring GitHub sign-in:
     `"Sign in with GitHub to ask live questions. Viewing this atlas stays public — there is no login wall on the map."`
   - **Visual Bug**: The modal background lacks sufficient opacity or backdrop-filter. The floating launcher buttons behind it (`"Ask Atlas"`, `"Explain this codebase spatially"`) bleed directly through the modal text, rendering it messy and amateurish.
2. **Hardcoded Non-Functional Placeholder**:
   - Even when logged in (or using test login), typing a question in the textarea displays:
     ```
     Live Q&A is not connected in this renderer slice.
     Submitting plays the evidence-linked Okie explanation.
     ```
   - Submitting the question does **not** query any LLM or agent. It simply sets `step = 0` to play the pre-baked Okie presentation.
3. **No Spatial Grounding**:
   - An engineer asking *"How are renderer scenes compiled?"* or *"Where is authentication handled?"* gets zero customized spatial routing or code explanations.

### Blueprint for Real Agentic Codebase Onboarding
To make Ask Atlas something engineers reach for over reading raw code:
1. **Dynamic Spatial Routing**:
   - When a user asks a question, an agent should parse the query against the architecture model's entity graph and emit a **personalized, 3-to-4 step mini-tour**:
     - Step 1: Fly camera to the primary owning container.
     - Step 2: Highlight the entry-point component.
     - Step 3: Open the exact source excerpt that implements the logic.
2. **Context-Bounded Answers**:
   - Generate a concise, 2-paragraph conversational explanation grounded in the observed source lines, with clickable links that highlight entities on the canvas.
3. **Zero-Setup Local Dev Mode**:
   - In local development (`localhost`), bypass the GitHub login requirement entirely and use local environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or local Ollama/vLLM endpoints).

---

## 2. Guided Story Quality & Camera Choreography

### Observed Deficiencies in Scanned Stories

#### 1. Tautological, Boilerplate Narrations
In the scanned overview story, step narrations read like robotic schema dumps:
```
Read WEBMCP_HOST_HEADERS
WEBMCP_HOST_HEADERS in apps/web/src/webmcp.ts is a source-level declaration in src/webmcp.ts.
Evidence: apps/web/src/webmcp.ts · WEBMCP_HOST_HEADERS
```
Compare this to the golden demo's human narrative:
```
selectScopedView()
Normalizes the selected hierarchy down to the target container, diffing retained geometry into revisioned patches.
```
Robotic boilerplate gives the user zero architectural comprehension.

#### 2. Camera Flight Over-Zoom (The Black Screen Void)
- During step 5 of the overview story, the camera flies to:
  `cx: 981.24, cy: 448.16, z: 13.96`
- Zoom level **13.96** is so tight that the entire canvas becomes a featureless black expanse. The target symbol card is magnified beyond recognition, leaving only a thin glowing sliver at the very edge of the viewport.
- The user is left staring at an empty void while reading robotic text.

#### 3. Repetitive Naming
All 4 generated stories repeat the repository slug:
- `okie overview`
- `okie: Paste a repository`
- `okie: Ask the atlas`
- `okie: Embed the atlas`

### Recommended Fixes
- **Narrative Enrichment Prompts**: In `@okie/scan` / `apps/server/src/enrichment.ts`, instruct the LLM to explain **why this symbol matters to the broader system flow**, rather than repeating the file path.
- **Camera Zoom Clamps**: In `cameraFlightController.ts` and `storyPlayback.ts`, enforce a maximum camera zoom clamp for code-level steps (`z_max ≤ 3.5`). Ensure that surrounding sibling symbols remain visible to preserve spatial context.
- **Clean Story Titles**: Strip the `<repo>:` prefix when rendering inside that repo's atlas.

---

## 3. Inspector Panel Ergonomics: Details vs. Overview

### Observed Friction
- **Root Page (`/`)**: Opens with the **Details** tab selected. The user immediately sees:
  - System title, description, and metadata badges.
  - "Inside this layer" cards (drill-down shortcuts).
  - Outbound/inbound relationships.
  - Source evidence links.
- **Scanned Page (`/r/THISS/okie`)**: Opens with the **Overview** tab selected. The user sees:
  - An "Architecture Brief" containing a tiny, tangled, completely unreadable SVG wireframe labeled `L1 → L2 · CONTEXT → CONTAINERS` with microscopic clipped text.
  - A long list of raw `dependsOn` dependencies.

### Why this degrades the feel
When a developer arrives at a software system atlas, they want immediate, clear orientation about what the selected system is and what components live inside it. The Overview tab’s raw SVG wireframe feels like a debugging diagram rather than an executive summary.

### Recommendation
- Default the inspector to the **Details** tab on initial load.
- Redesign the Overview tab to present a clean, high-level summary cards layout rather than an unreadable, full-graph micro-SVG.
- Ensure the **Source** tab illuminates automatically whenever a symbol is selected.
