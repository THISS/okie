# CLA-36 — Okie screenshot pack

Twelve PNGs of Okie as it ships on `main` today, shot to give design a real
picture of the product before proposing consumption changes. **Design reference
only** — nothing here changes app behaviour.

## How these were shot

| | |
|---|---|
| Commit | `3e2cf70` (`main`) |
| Web | `pnpm --filter @okie/web dev` on `http://localhost:4173` |
| Scan server | `node apps/server/dist/main.js` on `http://127.0.0.1:4180` (needed for `/new`) |
| Browser | Headless Chromium (Playwright), 1600×1000 CSS px at DPR 2 → 3200×2000 PNGs |
| Renderer | `backend=canvas2d` — deterministic, no GPU dependence in CI |
| Theme | Dark only; `Shift+Alt+D` dev mode is **off**, so no diagnostics pill, no View/Edit toolbar, no `+ Diagram` |

Two fixtures are used:

- **`?fixture=okie`** — the hand-authored golden self-map in
  `fixtures/architecture/demo-snapshot.json`, the same fixture the golden tests
  pin. 70 entities, curated summaries, the guided story
  *"From Okie to selectScopedView()"*. This is the pack's default because it is
  the only surface with real product copy.
- **`?fixture=scan`** — a deterministic local self-scan of this repo
  (1,778 entities / 3,724 relations), regenerated with
  `node packages/scan/dist/cli.js --source . --out fixtures/scan`.
  `fixtures/scan/` is gitignored, so this is **not** checked in; regenerate it
  before reshooting.
- **`?fixture=stress`** — the seeded 5,000-node / 15,000-path renderer stress
  scene from `pnpm generate:stress`. Also gitignored.

The task brief suggested `/?fixture=scan&backend=canvas2d` as "the golden
fixture". Both routes are real and both are shot here, but note the difference:
the local scan runs **un-enriched** (no LLM in CI), so every card reads
"No summary supplied." The golden fixture is what a well-described atlas looks
like; the scan fixture is what a fresh repo looks like on day zero. Both are
useful design input, for opposite reasons.

## Files

| File | Screen | What to look at |
|---|---|---|
| `01-l1-atlas-and-chrome.png` | L1 context, inspector closed | Full chrome in one frame: topbar + search, `Main` diagram tab, L1–L4 level rail, zoom/fit cluster, minimap, Ask Atlas + guided-story launcher, canvas hint strip. Note the map sits in the lower third with a large dead zone above it. |
| `02-inspector-details.png` | L2 containers, `Atlas web app` selected, Details tab | The default inspector: title, summary, tech chips, `Open inside` / `Show on map`, provenance strip, Diagrams, Parent layer, Inside this layer. Five stacked sections, all the same weight. |
| `03-inspector-source.png` | L4 code, `ArchitectureSnapshot` selected, Source tab | Real source excerpt (`packages/architecture/src/model.ts`, lines 101–106) with `Copy symbol` / `Copy relative`. Line 102 is clipped at the panel edge — no wrap and no horizontal scroll affordance. |
| `04-guided-tour-playing.png` | Golden story, step 3 of 4, paused | The tour: `GUIDED EXPLANATION` header, step title + narration, progress ticks, `Dim others` / `Isolate focus` / `Restore full view`, Previous/Next. Off-focus containers are dimmed but still occupy full-size real estate. |
| `05-ask-atlas-open.png` | Ask Atlas popover with a typed question | Q&A entry point, plus the honest disconnected-state copy ("Live Q&A is not connected in this renderer slice…") and the `Preview explanation` primary. |
| `06-scan-landing-new.png` | `/new` paste-a-repo landing | The whole acquisition funnel: headline, GitHub sign-in, URL field, `Scan`, and the public `THISS/okie` escape hatch. Content is a narrow column pinned to the top of an otherwise empty black page. |
| `07a-isolate-focus.png` | Story step 4 with `Isolate focus` engaged | The strongest consumption tool in the product: `Showing 1 of 70 · Restore full view`. Everything except the focused symbol is gone. |
| `07b-relationships-inspector.png` | L2, `Rust / WASM renderer`, scrolled to Relationships | Relationship rows with verb labels, and the truthful omission notice: *"Hiding 7 relationships between parts of Rust / WASM renderer — both ends land on this card."* Followed by Source evidence with `Frozen at golden-workt…` provenance. |
| `08a-dense-graph-stress-5k.png` | `?fixture=stress&seed=42` | The density ceiling: 5,000 nodes, 15,000 paths. Nodes degrade to identical rounded rectangles and edges become a uniform grey haze. Nothing here tells you where to look. |
| `08b-dense-graph-self-scan.png` | `?fixture=scan` at L2, fit to view | Real dense data, 1,778 entities. Nested containers render as near-invisible dark-on-dark rectangles with sub-pixel labels; the C4 advisory counter reads `9236 C4 ADVISORIES`. |
| `09a-mermaid-import-dialog.png` | Import Mermaid dialog with a 3-node flowchart pasted | Paste/`Open file` → `Import onto atlas`. The clearest, most conventional dialog in the product. |
| `09b-sparse-graph-imported.png` | The imported flowchart on the atlas | The empty-ish graph: Client → API → Store as three L2 containers. Three cards occupy the whole canvas at a fixed layout scale, and the inspector still runs the full section stack for a node with one relationship. |
| `10-code-level-lod-dropout.png` | L4 code, inspector closed, no fit | Bonus. Only the component under focus renders its code cards; sibling components (`Semantic schema`, `Architecture validation`) draw as empty outlined shells. Worth deciding whether that is a feature or a bug. |

## Known gaps

- **No light theme exists.** Every frame is lime-on-black because that is the
  only theme in `packages/theme/src/tokens.css`.
- **`?fixture=scan` shows no summaries.** The local scanner is deterministic-only;
  enrichment requires a gateway that is deliberately not run in CI.
- **`Fit architecture to view` frames the root scope, not the visible graph.**
  At L1 the context peers sit outside the fitted camera, so `01` needed one
  manual zoom-out notch to show the whole L1 graph. That is a real bug-shaped
  finding, not a capture artefact.
- **No secrets appear in any frame.** No `.env`, no tokens, no `/healthz`
  payload; the account control renders as unauthenticated initials only.
