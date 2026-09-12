# Okie Dogfooding Experience Audit

An exhaustive product, architectural, and visual audit comparing the production dogfooding experience (`http://localhost:4173/r/THISS/okie`) against the reference golden demo (`http://localhost:4173/`).

## Context & Purpose

Okie is designed to be a **spatial explanation system for software** — an evidence-backed architecture atlas that moves intuitively from system context (C4 L1) down to source code (L4), with deterministic guided stories and agentic digestion. The core mission is to give engineers **a faster, clearer way to understand a software system than reading raw code**.

When exploring the scanned repository at `http://localhost:4173/r/THISS/okie`, the experience falls significantly short of the reference feel at `http://localhost:4173/`.

This audit details exactly where, why, and how the experience breaks down, and provides a concrete blueprint to elevate the dogfooding experience to product-grade excellence.

---

## Audit Suite Structure

| Document | Focus Areas |
|---|---|
| [**01. Executive Summary & Scorecard**](./01-executive-summary.md) | High-level comparison, core friction points, experience scorecard, and key takeaways. |
| [**02. Visual & Spatial Canvas Audit**](./02-visual-spatial-canvas.md) | Skyscraper aspect-ratio bug, canvas element overlaps, bottom story-button pileup, camera framing disorientation, and fit-to-view failures. |
| [**03. Information Architecture & Semantic Model**](./03-information-architecture.md) | L1 context pollution (npm dependencies as external systems), Rust ingestion blindspots, missing technology metadata, leaked pipeline diagnostics (`gate rejected`), and advisory warnings. |
| [**04. Agentic Interaction & Guided Stories**](./04-agents-and-stories.md) | Ask Atlas placeholder status, login modal backdrop visual bug, tautological story narrations, camera flight over-zoom, and inspector tab ergonomics. |
| [**05. Actionable Roadmap & Implementation Plan**](./05-actionable-roadmap.md) | Prioritized, step-by-step implementation tasks (P0 quick wins, P1 structural fixes, P2 strategic agent-swarm integration). |
| [**06. Site-Wide Feature & Surface Audit**](./06-site-wide-feature-audit.md) | The `/new` landing page, single-package monochrome monoliths (`zod`, `clsx`), header dead clicks (`Open source repo`, `avatar`), empty dynamic flows, and missing shortcut modals. |
| [**07. Post-PR Re-Review (CLA-80 to CLA-98)**](./07-post-pr-re-review.md) | Verification of recent PRs on `main`, updated scorecard (3.9 → 7.3/10), verified visual fixes, and remaining roadmap gaps. |
| [**08. Post-CLA-104 Re-Review (CLA-99 to CLA-104)**](./08-cla104-re-review.md) | Verification of Rust tree-sitter outlining (CLA-103), continuous zoom handoff (CLA-104), container tech tags (CLA-102), Ask Atlas positioning (CLA-100), and Details cleanup (CLA-99). Scorecard updated to 8.8/10. |
| [**09. Resolution of Pan & Zoom Degradation (CLA-101 to CLA-109)**](./09-cla109-pan-zoom-resolution.md) | Verification of pre-placed L3 components (CLA-107), peer container retention on pan (CLA-106), pointer-centric zoom target (CLA-105), smooth morphing (CLA-109), chrome shield (CLA-108), and wired header actions (CLA-101). Scorecard updated to 9.4/10. |
| [**10. Deep-Zoom Experience, Typography & Node Design**](./10-web-container-typography-nodes.md) | Deep inspection of `@okie/web` down to L3/L4, text scaling floor bug (`titleFloor`), left-stem truncation (`...ics.rs`), missing hover tooltips, redundant code card copy, and critical zoom handoff reset defect. |
| [**11. Verification of CLA-110 through CLA-116**](./11-cla116-re-review-results.md) | Full re-review verifying L4 code-band zoom landing (CLA-110), hover HUD chips (CLA-113), stem-preserving truncation (CLA-112), line-number kickers (CLA-114), and bottom frosted shield (CLA-115). Scorecard: 9.8/10. |
| [**12. Spatial & Visual Review (CLA-117 to CLA-122)**](./12-cla122-proportional-l2-l3-spatial-review.md) | Comprehensive spatial review: proportional L2 footprints ($\sqrt{N_\text{children}}$), capped preview pills, landscape 7-column L3 grid, collapsed hollow voids, removed placeholder strings, and stable L3/L4 zoom handoffs. Scorecard: 9.9/10. |

---

## Key Metrics Comparison

| Dimension | Golden Reference (`/`) | Scanned Repo (`/r/THISS/okie`) | Experience Impact |
|---|---|---|---|
| **Scene Aspect Ratio** | ~3.07:1 (2300 × 750) — Landscape | 0.58:1 (2300 × 3930) — Ultra-tall column | Canvas feels empty; fit-view leaves 85% blank void |
| **L1 External Systems** | 2 meaningful systems (`Source repo`, `Graphics platform`) | 8 raw npm packages (`@fontsource/ibm-plex-mono`, `dompurify`, etc.) | Extreme clutter; high-level context obscured by utility libraries |
| **Container Layout** | Balanced grid (5 containers, ~700px box) | Monolithic vertical strip (500px wide × 3640px high) | Drill-down zooms into empty padding; only 1 container visible |
| **Rust Multi-language** | Fully modeled (4 crates, components, symbols) | Crate boundaries only; 0 components, 0 symbols | "Open inside" disabled on crates; half the codebase is undrillable |
| **Story Launcher** | 2 neat, compact floating pills | 5 wrapped buttons in a 3-tier pyramid | Occludes canvas, zoom controls, and minimap |
| **Inspector Default** | Details tab (selected system context & inside layers) | Overview tab (unreadable microscopic SVG wireframe) | Users see a tangled diagram instead of actionable system info |
| **User-Facing Copy** | Curated, intentional, evidence-grounded | Leaked engine diagnostics (`Enrichment partial — 4 accepted (gate rejected)`) | Appears broken or unmaintained; erodes user trust |
| **Ask Atlas (Agents)** | Interactive trigger with spatial preview | Placeholder form; submissions replay canned demo; login modal visual overlap | Agentic digestion is completely non-functional |
