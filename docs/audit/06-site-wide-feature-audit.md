# 06. Site-Wide Feature & Surface Audit

An audit of all secondary pages, header actions, diagram surfaces, and alternate scanned repositories across Okie.

---

## 1. The Landing Page: `/new` (Map a Repository)

### Observed State
- **URL**: `http://localhost:4173/new`
- **Visual Presentation**:
  - The entire page is an unstyled, isolated form floating in a vast black void.
  - The global app header, brand logo ("Atlas"), and topbar navigation are completely absent.
- **The "Already Mapped" Section**:
  - Lists:
    - `colinhacks/zod` · 2,307 entities
    - `lukeed/clsx` · 7 entities
    - `sindresorhus/p-limit` · 3 entities
  - **Critical Omission**: `THISS/okie` (the flagship dogfooding repository) is **missing** from this list!
- **Feedback & UX Friction**:
  - No visual cues explaining the scan duration or stages.
  - No interactive preview cards or screenshots of what an atlas looks like.
  - No direct links to documentation or setup instructions.

### Recommendations
1. Integrate `/new` into the standard application shell with the global header, brand mark, and back navigation.
2. Feature `THISS/okie` prominently at the top of "Already Mapped" as the flagship interactive showcase.
3. Add a mini-preview card showing a live thumbnail of what an atlas looks like (the golden demo).

---

## 2. Alternate Scanned Repositories: Zod, Clsx, & P-Limit

Exploring the other pre-scanned fixtures revealed critical architectural weaknesses in the scanner’s single-package ingestion:

### 1. `colinhacks/zod` (`/r/colinhacks/zod`)
- **Visual Failure**: The entire viewport renders as **one enormous, featureless solid brown rectangle** (`#8b6f64`) covering the canvas.
- **Title Collision**: `"SOFTWARE SYSTEM zod scan zod"` overlaps heavily in the top-left corner.
- **Drill-down Failure**: Clicking `"Open inside →"` animates into a **solid blue monolith** with zero visible containers, zero component cards, and zero labels.
- **Linter Alarm**: The inspector displays an alarming warning:
  ```
  3221 C4 ADVISORIES
  Title, scope, descriptions, technology, and relationship labels
  ```
- **Experience**: The user is trapped in a giant colored box with no spatial landmarks or comprehension aids.

### 2. `lukeed/clsx` (`/r/lukeed/clsx`)
- Small utility library (7 entities).
- Renders as a single empty box: `clsx · No summary supplied · Technology not specified · 7 C4 ADVISORIES`.
- Does not convey how `clsx` actually works (no function signatures, no exports shown).

### Why this happens across all scans
When a repository is a single library (not a multi-package monorepo), the scanner treats the entire package as one monolithic software system without breaking down internal modules into visual containers or components. Single-package repositories must be decomposed by directory/module (e.g. `src/types.ts`, `src/helpers.ts`, `src/index.ts`).

---

## 3. Header Action Buttons & Dead Clicks

Inspecting `.top-actions` in the application header revealed several completely inert buttons:

### 1. "Open source repository" (`<button aria-label="Open source repository"><CodeIcon/></button>`)
- **Code**: `apps/web/src/App.tsx#L3951`
- **Defect**: **Zero `onClick` handler**. Clicking the button does absolutely nothing.
- **Fix**: Wire `onClick` to `window.open(repositoryUrl, '_blank')` using the commit-pinned GitHub URL.

### 2. "Open account menu" (`<button aria-label="Open account menu" className="avatar-button">BC</button>`)
- **Code**: `apps/web/src/App.tsx#L3952`
- **Defect**: **Zero `onClick` handler**. The button renders user initials ("BC") but clicking it yields no dropdown, profile details, or sign-out option.
- **Fix**: Open an account popover showing the active GitHub username, current scan quota, and sign-out button.

### 3. "Copy current view link" (`button.share-view-button`)
- **Code**: `apps/web/src/App.tsx#L3940`
- **Defect**: On click, the button silently copies the URL to the clipboard without rendering any toast, tooltip, or visible feedback.
- **Fix**: Display an explicit animated checkmark pill or snackbar: `"Link copied to clipboard!"`.

---

## 4. Alternate Diagram Surfaces: Dynamic Flow & Mermaid Export

Under the inspector's "DIAGRAMS" section:

### 1. "Open dynamic flow"
- Opens a new tab `F okie flow`.
- Displays:
  ```
  DYNAMIC FLOW: okie flow
  1 participants · 0 interactions
  "No explicit interactions connect the selected participants."
  ```
- **Defect**: Dynamic flow compilation requires sequence-ordered interactions. The scan emits only static `dependsOn` edges, rendering the dynamic flow diagram completely empty and useless.

### 2. "Open Mermaid view"
- Opens a new tab `MR okie Mermaid`.
- Displays a single centered box:
  ```
  [ okie · SOFTWARE SYSTEM ]
  ```
- **Defect**: The Mermaid exporter only exports the isolated root node rather than the active C4 scope or visible container relationships.

### Recommendation
1. For scanned repositories without trace evidence, disable or hide the "Open dynamic flow" button rather than opening an empty, embarrassing tab.
2. Fix Mermaid view compilation to generate a complete C4 Container diagram:
   ```mermaid
   C4Container
   Container(web, "@okie/web", "React, TypeScript", "Atlas shell")
   Container(engine, "atlas-engine", "Rust", "Canvas engine")
   Rel(web, engine, "Renders through")
   ```

---

## 5. Keyboard Navigation & Discoverability

- **No Shortcuts Help Modal**: Pressing `?` does nothing. Users have no way to discover critical navigation shortcuts (`f` to fit, `Shift+Alt+D` for dev mode, `Cmd+Enter` for Ask Atlas).
- **Entity List Accessibility**: The "Entity list" trigger is rendered as a `<summary>` element rather than a standard `<button>`, causing inconsistent tab navigation and accessibility reader warnings.
- **Fix**: Add a clean keyboard shortcuts modal toggled by `?` or clicking a help icon in the header.
