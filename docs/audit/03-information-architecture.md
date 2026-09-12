# 03. Information Architecture & Semantic Model Audit

## 1. L1 Context Pollution: npm Packages as External Systems

### The Problem
In the C4 architecture model, an **External System** represents external software services, third-party platforms, or external databases with which the system interacts (e.g. *Stripe API*, *GitHub OAuth*, *PostgreSQL Cluster*, *AWS S3*).

In `/r/THISS/okie`, the scanner (`packages/scan/src/extract.ts`) inspects the `dependencies` block of `package.json` and automatically elevates every runtime dependency into a C4 L1 External System:
- `@anthropic-ai/sdk`
- `@fontsource/ibm-plex-mono`
- `@fontsource/ibm-plex-sans`
- `dompurify`
- `mermaid`
- `react`
- `react-dom`
- `typescript`

### Consequences
1. **Severe Architectural Noise**: An engineer trying to understand what Okie is and how it works is forced to look at 8 large cards on the main canvas for font packages (`@fontsource/ibm-plex-mono`) and utility packages (`dompurify`).
2. **Missing High-Level Semantics**: Genuine external boundaries (e.g., the browser's WebGPU / WebAssembly execution environment, GitHub's API, Anthropic's Claude API) are drowned out by font assets.
3. **Empty Summaries**: All 8 cards display:
   ```
   EXTERNAL SYSTEM
   @fontsource/ibm-plex-mono
   No summary supplied.
   ```
4. **Trivial Relationships**: All 8 relationships are identical:
   ```
   okie → @fontsource/ibm-plex-mono (dependsOn)
   ```
   No protocol, no interaction semantics, no purpose.

### Recommended Fix
- **Classify Dependencies vs. Systems**: Introduce a clear taxonomy in `@okie/scan`:
  - `externalSystem`: True external services (e.g. `anthropic` -> "Anthropic Claude API", `github` -> "GitHub API").
  - `libraryDependency`: Internal npm/cargo packages. Do NOT project them as top-level L1 External Systems on the main canvas.
  - Render library dependencies only in container inspection or a dedicated "Dependencies" tab in the inspector.

---

## 2. Multi-Language Ingestion Blindspot: Rust Crates

### The Problem
Okie is a hybrid TypeScript and Rust codebase:
- Frontend: TypeScript / React (`apps/web`, `packages/*`).
- Core Engine & Renderer: Rust / WASM (`crates/atlas-engine`, `crates/atlas-gpu`, `crates/atlas-protocol`, `crates/atlas-wasm`).

When the scanner processes the repository:
1. It parses TypeScript files down to L3 components and L4 code entities.
2. For Rust crates, it only reads `Cargo.toml` dependencies (`cargoPathDependencies`), creating an L2 container card with zero children.
3. As a result:
   - `crates/atlas-engine` contains **0 components** and **0 code symbols**.
   - Clicking `"Open inside →"` on `atlas-engine` is **disabled** (`<button disabled class="primary-detail-action">`).
   - The user cannot explore the Rust engine, the WebGPU pipeline, or the protocol parser at all.

### Recommended Fix (Tree-sitter WASM Ingestion)
As outlined in `docs/roadmap/scan-static-analysis-and-agent-swarm.md`:
- Integrate `tree-sitter-rust` into `@okie/scan`.
- Extract Rust modules (`mod`), structs (`struct`), traits (`trait`), impl blocks, and functions as L3 components and L4 code entities.
- Enable full zoom drill-down into Rust crates with code outlines.

---

## 3. Technology Metadata & Badging

### The Problem
In the golden demo, every entity displays crisp, informative technology tags:
- `Okie`: `TypeScript · Rust · WebAssembly · wgpu`
- `Atlas web app`: `React · TypeScript`
- `Rust / WASM renderer`: `Rust · WebAssembly · wgpu`

In `/r/THISS/okie`, almost every container displays:
```
[ Technology not specified ]
```
in an unstyled grey outlined pill. This occurs even though `packages/scan` knows the language, file extensions, and manifest types (`package.json`, `Cargo.toml`).

### Recommended Fix
In `packages/scan/src/extract.ts`:
- Automatically infer technology tags from manifests and file extensions:
  - `package.json` with `react` → `React · TypeScript`
  - `Cargo.toml` with `wgpu` → `Rust · wgpu · WebAssembly`
  - Node HTTP servers → `Node.js · TypeScript`

---

## 4. Leaked Pipeline Diagnostics in User Copy

### The Problem
When exploring `/r/THISS/okie`, internal backend gate errors and pipeline states are leaked directly into user-visible badges and cards:

1. **Top Badge in Details Panel**:
   ```
   Enrichment partial — 4 accepted (gate rejected)
   ```
   This looks like an unhandled software bug or system error.
2. **Entity Description Field**:
   For entities that did not pass enrichment, the description string literally contains:
   ```
   Enrichment partial — 4 accepted (gate rejected). Other scopes stayed deterministic.
   ```
3. **C4 Advisory Alarms**:
   Under the diagrams section, an alarming red/orange banner displays:
   ```
   56 C4 ADVISORIES
   Container container:apps-server should name its technology on a container diagram.
   ```
4. **Console 404 Error**:
   The web shell logs an error on every load:
   ```
   [ERROR] Failed to load resource: the server responded with a status of 404
   @ http://localhost:4173/scan/thiss__okie/enrichment-status.json:0
   ```

### Recommended Fix
- **Honesty without Leakage**: The user should see clean, confident architecture claims. If an enrichment pass was partial, simply display the deterministic summary without leaking internal validation messages (`gate rejected`).
- **Hide Developer Advisories**: Move "56 C4 ADVISORIES" into Dev Mode (`Shift+Alt+D`); never show raw C4 modeling linter warnings to an end user exploring a codebase.
- **Clean 404s**: Handle `enrichment-status.json` gracefully without emitting top-level browser console errors.
