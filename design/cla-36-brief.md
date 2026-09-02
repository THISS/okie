# CLA-36 — Design brief: making the Okie atlas easier to consume

Design exploration, not a product PR. Evidence is the twelve screenshots in
[`design/cla-36-pack/`](./cla-36-pack/README.md); the argument is drawn in
[`design/cla-36-mocks/`](./cla-36-mocks/index.html) (open `index.html` directly
in a browser — no build, no server).

---

## The one-sentence read

Okie already computes far more truth than it can show, and it currently shows all
of it at the same volume — so the reader has to do the ranking the product should
be doing for them.

Every finding below is a variation on that.

---

## 1. Making the map easier to consume

### Hierarchy: rank the canvas into three tiers

Today a node is drawn identically whether it is the thing you selected, its
direct neighbour, or an npm package four hops away: same card size, same border
weight, same corner radius, same three-line text block. Selection is signalled by
a lime outline and nothing else. In `01-l1-atlas-and-chrome.png` the person, the
system, and two external systems all read as peers, so nothing tells you which
one the view is about.

Proposal — one ramp, driven by graph distance from the selection:

| Rank | Treatment | Carries |
|---|---|---|
| **Focus** | Full card, accent border, accent glow. **Exactly one per frame.** | Kind, name, summary |
| **Context** | Full card, neutral border at higher contrast than today | Kind, name, link count |
| **Periphery** | Pill, ~24 px tall | Name only |

Edges inherit their rank from their endpoints, and periphery-to-periphery edges
do not draw at all. That single rule removes most of the grey haze in
`08a-dense-graph-stress-5k.png` without touching the layout engine.

### Contrast: raise the floor, then spend the accent on one thing

Two separate problems get conflated as "it's too dark".

The first is a real contrast bug. `--atlas-line` is `rgba(223, 239, 232, 0.1)` on
`#070a0b`. That is why the nested containers in `08b-dense-graph-self-scan.png`
are effectively invisible and why `10-code-level-lod-dropout.png` shows sibling
components as ghost outlines. Resting borders need more contrast than they have,
independent of any theming decision.

The second is that the accent is over-spent. `--atlas-accent` currently marks the
brand glyph, the fixture label, the breadcrumb root, the selected node, the
primary button, the story progress bar, the Ask sparkle, the minimap viewport,
and the active level. When lime means nine things it means none of them. Give it
one job — *the node you are on* — and it becomes the fastest thing on screen.

### What to hide

In rough order of how much each buys:

- **Relationship verb labels below a zoom threshold.** They are unreadable and
  still consume edge-label space.
- **Periphery-to-periphery edges.** Entirely. See above.
- **Package dependencies at L1.** Eight npm packages render as full external-system
  cards in the golden fixture. They are provenance, not architecture; demote them
  to periphery pills behind a `+ 5 more` chip.
- **The C4 advisory counter.** `9236 C4 ADVISORIES` in
  `08b-dense-graph-self-scan.png` is an authoring diagnostic pointed at a reader.
  It belongs behind `Shift+Alt+D` with the rest of the diagnostics.
- **Repeated "No summary supplied."** Nineteen identical placeholders read as
  breakage. Say it once, in the panel, as a state rather than an error.
- **The canvas hint strip**, after the first session.
- **Nodes past a legibility budget.** Around 30–40 cards per viewport at current
  card size. Past that, group into counted pucks (`14 Rust crates · 1,204
  symbols`) rather than shrinking everything toward illegibility. Shrinking is
  exactly how both dense shots fail.

### Two things to keep and promote

The product already has the two best consumption tools in the category and hides
both of them.

**Isolate focus** — `07a-isolate-focus.png` reduces 70 entities to 1 and says
`Showing 1 of 70 · Restore full view`. It is the single most effective control in
the app and it lives inside the guided-story player, so you cannot reach it
without starting a story. It should be a first-class map control, and the first
thing offered when a scope exceeds the legibility budget.

**Truthful omission** — `07b-relationships-inspector.png` says *"Hiding 7
relationships between parts of Rust / WASM renderer — both ends land on this
card."* That is the voice the whole product should use about everything it
declines to draw. Right now only the relationships list talks that way; the map
itself never admits to hiding anything.

### One bug found while shooting

`Fit architecture to view` calls `frameProjectionScope(scene, rootEntityId, …)`,
which frames the **root scope** rather than the **visible projection**. At L1 the
context peers therefore sit outside the fitted camera — `01-l1-atlas-and-chrome.png`
needed a manual zoom-out notch to show the whole L1 graph. Fit should frame what
is on screen.

---

## 2. Lime-on-black: stays, but stops being the only option

**Keep it as the default.** It is the strongest brand asset here and it is
genuinely coherent across all twelve shots. Nothing in this brief proposes
replacing it.

**But dark-only is a distribution bug, not a taste question.** Three concrete
situations break today:

1. **Public share URLs and oEmbed.** `/r/<owner>/<repo>` and the oEmbed card are
   built to be embedded in other people's pages. A dark-only atlas arrives as a
   black hole in a light-mode README, doc site, or Slack unfurl.
2. **Screenshots in documents.** Every frame in this pack pasted into a light doc
   or printed will fight its surroundings.
3. **Embedded / white-labelled atlases.** A customer putting Okie inside their own
   product cannot ship lime.

The cheapest seam that solves all three is already in the tokens:

- **Light theme** — flip `--atlas-bg` / `--atlas-text` and the panel and line
  ramps; darken the kind hues (cyan / blue / purple / orange) rather than
  re-authoring them. Frame 4 shows the identical component tree under both.
- **Customer accent** — once `--atlas-accent*` means exactly one thing, swapping
  it per tenant is a one-token change with no layout consequence. Frame 4's four
  tiles differ *only* in that token.

What does **not** change: the neutral ramp, spacing, radii, type, the C4 kind
hues, and every layout decision. This is a theming seam, not a second design
system.

Out of scope for this exploration, and real follow-on work: retokenizing
`apps/web/src/app.css`, and teaching the canvas renderer about themes (it
currently resolves colours per-backend).

---

## 3. Inspector vs canvas density

The inspector has two states today — 376 px open, or gone — and neither is right
for most selections.

Open, it takes roughly a quarter of the window and runs the same five-section
stack (Diagrams, Parent layer, Inside this layer, Relationships, Source evidence)
at identical weight whether the node has one relationship or seventy. Compare
`09b-sparse-graph-imported.png`, where a three-node imported flowchart gets the
full stack, against `07b-relationships-inspector.png`, where a container with ten
relationships gets the same. Closed, you lose the evidence that makes the map
worth trusting.

And neither state suits the one job that genuinely wants width: reading source.
Line 102 is clipped at the panel edge in `03-inspector-source.png`, with no wrap
and no horizontal scroll affordance.

Proposal — **three stops on the seam that already exists** (`.details-resizer`
already drags; give it snap points):

| State | Width | Default? | Answers |
|---|---|---|---|
| **Peek** | 232 px | **Yes** | What is this, where does it sit, what is one thing I can do |
| **Detail** | 376 px | On request | Full sections, one open at a time, counts on the collapsed rows |
| **Read** | 560 px | Only with a source excerpt | The code, un-clipped |

Two supporting rules:

- **Canvas floor.** Peek and Detail keep the canvas above 70% of the window. Only
  Read may break that, and only while source is open.
- **Counts before contents.** `Relationships 3 of 10` collapsed is more useful
  than today's always-expanded list. The omission notices survive as single rows,
  so honesty costs one line instead of a paragraph.

The net effect: the default selection costs the canvas 232 px instead of 376,
the map stays the subject, and the panel earns width only when the user asks a
question that needs it.

---

## Suggested order of attack

Roughly cheapest-per-unit-of-relief first. All of it is additive to the existing
architecture; none of it requires a new layout engine.

1. Raise resting border contrast, and restrict `--atlas-accent` to focus only.
   Token-level, no structural change, fixes the worst of `08b`.
2. Fix `Fit` to frame the visible projection. Localised bug fix.
3. Promote **Isolate focus** out of the story player into the map controls.
4. Introduce the three canvas ranks and let edges inherit rank. This is the
   largest change and the one that pays for the rest.
5. Add the Peek inspector state and make it the default.
6. Add the legibility budget, cluster pucks, and the `Showing N of M` HUD.
7. Light theme plus a customer accent slot, once the accent means one thing.
