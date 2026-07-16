# Architecture canvas renderer

Status: accepted foundation for the first renderer milestone. The semantic model, scene compiler, protocol crate, and deterministic fixtures described here are implemented. GPU and browser modules may initially implement a subset of the protocol while preserving this boundary.

## Product boundary

Okie is not a general vector editor. It is a spatial explanation system for software. The renderer must support architecture maps, semantic zoom, animated flows, saved stories, deterministic capture, and source selection without learning what C4, a repository, or an LLM is.

The system is split into three layers:

```text
ArchitectureSnapshot + View + Story
        packages/architecture
                  |
                  v
Deterministic scene/story compiler
        packages/scene-compiler
                  |
          protocol v1 JSON
                  v
CPU scene engine -> wgpu renderer -> WebGPU/WebGL2
 crates/atlas-engine  crates/atlas-gpu  crates/atlas-wasm
```

The architecture model contains claims and evidence. A view selects entities and owns layout. The compiler turns semantic intent into renderer objects, paths, LOD representations, and timeline cues. The renderer owns interpolation but never invents layout or architecture.

## Canonical semantic model

`packages/architecture/src/model.ts` is the TypeScript source of truth for repository-derived information:

- `ArchitectureSnapshot` is immutable and pinned to a commit SHA.
- `ArchitectureEntity` represents people, systems, containers, components, code, data stores, queues, and boundaries.
- `ArchitectureRelation` exists independently of a C4 level and carries evidence.
- `ArchitectureView` selects a bounded subgraph and owns node and edge layout.
- `ArchitectureStory` contains narration plus semantic focus and trace directives.
- `ArchitectureOverrides` is separate from generated snapshots so rescans cannot erase user corrections.

Every local source reference is repository-relative and commit-pinned. Confidence belongs to generated claims, not visual objects.

IDs must be stable across scans. Deterministic entities should use namespaced IDs derived from durable repository facts, while conceptual AI groupings should retain reconciled UUIDs. Array order is not identity; the compiler sorts objects and paths by ID.

## Renderer protocol

`crates/atlas-protocol` is the Rust source of truth for the renderer boundary. `packages/scene-compiler/src/protocol.ts` is its TypeScript mirror. Both are version 1 and use camel-case JSON. Checked fixtures are parsed by Rust and compared byte-for-structure by TypeScript tests to expose drift.

All protocol documents are untrusted at the WASM boundary. Browser entrypoints must call `SceneSnapshot::validate`, `ScenePatch::validate_against`/`apply_to`, and `Timeline::validate_for` before changing engine or GPU state. Validation rejects non-finite geometry and animation values, invalid dimensions/ranges/colors, duplicate identities, and inconsistent references; renderer code must not silently clamp malformed input.

### Scene

`SceneSnapshot` contains:

- `protocolVersion`, `sceneId`, and monotonically increasing `revision`.
- World-space bounds.
- Stable `SceneObject` records with parent, z-index, bounds, pickability, and representations.
- Stable `ScenePath` records with endpoint object IDs, pre-routed points, style, arrow, and LOD range.

Each representation owns an interval with `minZoom`, optional `maxZoom`, `fadeWidth`, and `hysteresis`. `maxZoom: null` means unbounded. The engine remembers the previously active representation so small camera oscillations around a threshold do not flicker.

World-space bounds drive culling, routing, camera fitting, and spatial lookup. Screen-space bounds drive readable labels, strokes, and minimum hit targets. They must not be conflated.

### Patches

`ScenePatch` carries `sceneId`, `baseRevision`, a greater target `revision`, batched upserts/removals, and an optional transition. The engine rejects a patch when its base revision is not the active revision and asks the host for a full snapshot. This makes asynchronous scans and view compilation safe.

Retained stable IDs interpolate from existing state. New objects enter and removed objects exit according to the transition; no full scene teardown should occur during drill-down.

### Stories and timelines

An AI or author produces `ArchitectureStory` steps such as “focus these entities” and “trace these relations.” `compileStory` deterministically fits bounds and emits a `Timeline` of camera, object-emphasis, and path-flow cues. Narration and source evidence remain in the application UI.

The renderer accepts explicit time through `seek(t)`/`tick(t)`. It never uses hidden wall-clock state for animation. This supports playback scrubbing, reduced motion, screenshots, server capture, and reproducible QA.

## Browser contract

The TypeScript host should expose one coarse controller:

```ts
const renderer = await AtlasRenderer.create(canvas, options);
renderer.setScene(scene);
renderer.applyPatch(patch);
renderer.resize(cssWidth, cssHeight, devicePixelRatio);
renderer.pointer(input);
renderer.wheel(input);
renderer.playTimeline(timeline);
renderer.seek(milliseconds);
renderer.tick(timestamp);
renderer.destroy();
```

One JavaScript-to-WASM call per animation frame is acceptable. Simulation, animation, culling, hit testing, text caches, batching, and drawing remain inside Rust. Snapshots and patches cross only in batches; typed-array geometry is a later optimization if profiling shows JSON/serde overhead is material.

The browser adapter owns `ResizeObserver`, normalized pointer/wheel/keyboard events, page visibility, and the animation-frame lifecycle. Rust emits only low-frequency events: selection, hover, settled camera, active LOD, backend selection, device loss, and fatal errors.

The initial implementation stays on the main thread for broad compatibility. Commands and events remain serializable so the renderer can move behind `OffscreenCanvas` later without changing the application API. WASM threads and cross-origin isolation are deliberately deferred.

## Rendering implementation

The GPU layer should use a deliberately narrow primitive set:

- Instanced rounded rectangles and circles.
- Polyline or cubic paths, arrowheads, and CPU-advanced flow particles.
- Icons from an atlas.
- CPU-shaped text in a GPU glyph atlas.
- Clip regions and selection/highlight overlays.

Graph layout and edge routing are compiler concerns. The renderer may clip a supplied path to object bounds and interpolate between compatible routes, but it does not run a layout engine.

Keep camera-relative `f32` geometry in GPU buffers to preserve precision in large worlds. Maintain a CPU scene and spatial index for viewport culling and hit-test candidates. Do not cross the JS/WASM boundary per object or per draw.

Text is an independent subsystem. Bundle a small licensed font set; shape and wrap deterministically in Rust; cache shaped runs and glyphs; rebuild the atlas after device loss. Emoji and broad font fallback can follow after Inter/monospace quality and WebGL2 behavior are proven.

## WebGPU and WebGL2

WebGPU is preferred. WebGL2 is a downlevel fallback through wgpu's `webgl` feature. The common rendering path must avoid required compute shaders, storage textures, and WebGPU-only limits. Features are requested only after checking the selected adapter.

Detection must attempt adapter and device creation rather than checking `navigator.gpu` alone. If WebGPU setup fails, the host replaces the canvas before explicitly starting WebGL2; a canvas whose context initialization failed may not safely switch backend. If both backends fail, the application presents a static image/Mermaid view and a clear compatibility message.

The engine retains the CPU scene so it can rebuild all GPU resources after device/context loss. DPR should be capped by policy on low-power devices rather than allowing unbounded render-target growth.

## Accessibility and motion

Canvas is not an accessibility tree. The application mirrors the selected object, currently visible focus candidates, breadcrumbs, and relationships into lightweight semantic DOM. Keyboard navigation drives the same selection and camera commands as pointer input.

Reduced-motion mode applies timeline state immediately or uses short crossfades with no moving flow particles. It does not merely speed up the normal animation.

## Deterministic fixtures

`fixtures/architecture` contains a small semantic system, view, and four-step story. `fixtures/renderer` contains their compiled scene and timeline. `pnpm generate:fixtures` regenerates them, and compiler tests detect drift.

`scripts/generate-stress.mjs` creates a seeded large scene without committing it. The milestone target is 5,000 nodes and 15,000 paths:

```sh
pnpm generate:stress -- --nodes 5000 --edges 15000 --seed 42
```

The performance harness should report CPU update, culling, command preparation, GPU submission, visible object/path/glyph counts, frame-time percentiles, backend, DPR, and viewport. A single FPS number is insufficient for diagnosis.

## First milestone acceptance

The vertical slice is complete when it can:

1. Load the checked demo scene through the versioned protocol.
2. Pan, zoom, fit, select, and hit-test without DOM objects per scene node.
3. Crossfade semantic representations with hysteresis.
4. Reconcile a revisioned patch while retaining stable objects.
5. Seek and play the checked guided timeline with a camera move and relation flow.
6. Exercise WebGPU and an explicit WebGL2 path.
7. Load the 5,000/15,000 stress scene and expose frame-time diagnostics.
8. Recover or show a controlled fallback after device loss.
9. Respect keyboard operation and reduced-motion behavior.

Repository scanning, billing, general editing, real-time collaboration, arbitrary vector primitives, and export are outside this milestone. PNG capture follows deterministic rendering; Mermaid export comes from the semantic graph rather than reverse-engineering GPU output.

## Next milestone: multi-diagram workspace

The next milestone turns the atlas from one spatial map into a workspace of evidence-backed diagram surfaces. The existing atlas remains the permanent `Main` surface. Derived diagrams open beside it in closable application tabs; they do not replace the atlas or make a browser window the primary workspace.

An `ArchitectureView` and its C4 `ViewFamily` remain the semantic scope of a diagram. L1-L4 are representations within that family, not separate tabs. A derived artifact records its renderer and source scope separately, for example `{ id, kind, sourceViewId, scopeEntityId, snapshotRevision, parameters }`. The application must not overload the existing projection `viewId` with a tab or artifact identity.

Mermaid is an initial presentation and export adapter, not the canonical model. Flow, code, deployment, and data diagrams are compiled from the same normalized entities, relationships, stories, evidence, and source references used by the atlas. Generated text is never recovered from GPU pixels or accepted as a substitute for structured semantic data.

### Notation contract

Okie remains notation-independent while following the [C4 notation guidance](https://c4model.com/diagrams/notation). Every generated or exported diagram must stand alone:

- Show a title that identifies diagram type and scope.
- Generate a legend from the element, relationship, confidence, and focus encodings actually visible.
- Show explicit element types and short descriptions; include technology for containers and components.
- Draw relationships in one direction with specific labels, including protocol or technology at container level.
- Explain project-specific acronyms and never rely on colour alone. Colour and line treatments stay consistent and accessible across renderers.
- Retain evidence, provenance, and source navigation in the inspector even when the selected renderer cannot display that metadata inline.

Validation reports missing responsibilities, technology, relationship labels, and container protocols. It does not silently make an incomplete diagram look authoritative.

### Diagram families

1. **Dynamic flow.** Compile current story steps and traced relations into ordered interactions. Start with numbered collaboration edges over a scoped spatial layout, then offer sequence-diagram presentation over the same interaction data. Add sync/async, response, branch, and loop metadata only when the source model can support them. This follows the selective, story-scoped use described by [C4 dynamic diagrams](https://c4model.com/diagrams/dynamic).
2. **Code structure.** Generate a diagram on demand for exactly one component. The first slice uses curated L4 code entities and source anchors; richer class, interface, function, call, reference, inheritance, and ER views require language-aware extraction. Show only members needed to explain the chosen story or responsibility, consistent with the [C4 code-diagram guidance](https://c4model.com/diagrams/code).
3. **Deployment.** Map container instances into nested environment and infrastructure nodes once deployment evidence is available. Keep logical containers linked to their deployed instances rather than copying unrelated architecture into the deployment model.
4. **System landscape.** Add a portfolio-level view when multiple software systems exist. It is not a replacement for the scoped atlas hierarchy.

### Workspace and inspector

- Desktop has a diagram tab strip with pinned, unclosable `Main` first. Generated tabs have a type, scope, stale/current revision state, and close action. Opening an existing artifact focuses its tab instead of duplicating it.
- Mobile uses a `Views` switcher rather than depending on a horizontally scrolling tab strip. `Main` is always directly reachable.
- The inspector adds a `Diagrams` group for the selected entity or relation. It may show a small static flow/code preview and available diagram types; the full interactive diagram opens or focuses an application tab. A dense Mermaid canvas does not live permanently inside the narrow inspector.
- Each surface preserves its own viewport, selection, relation selection, focus/filter state, and inspector subject. The shared inspector width remains a workspace preference.
- Only the active heavy renderer is mounted. Inactive surfaces retain serializable session state and receive a real resize when activated.
- `Open in browser tab` is a secondary share action backed by a canonical artifact URL. Cross-window live synchronization is out of scope.

### Delivery slices

1. **Notation and validation.** Add derived type/scope titles, generated legends, glossary support, and notation completeness checks without requiring new extraction.
2. **Workspace state and tab shell.** Add the protected `Main` invariant, artifact/session reducer, desktop tablist, mobile switcher, and placeholder derived surfaces. Prove that Main camera, lens, story, entity/relation selection, filter, and inspector state survive switching.
3. **Dynamic-flow vertical slice.** Compile existing stories into ordered interactions, render numbered collaboration flow, and link every interaction back to relationship evidence in the inspector.
4. **Mermaid adapter and navigation.** Render a sanitized semantic artifact, add a textual accessible outline, pan/zoom/fit, deep links, Back/Forward, Copy View, and the secondary browser-tab action. Raw Mermaid source never appears in URLs.
5. **Curated code-diagram vertical slice.** Scope to one component, add `codeKind`, qualified name, and optional signature, then generate focused class/dependency/data presentations from evidence-backed symbols only.
6. **Language-aware extraction and later views.** Add TypeScript/Rust symbol relationships, a separate schema/ER extractor, deployment evidence, and observed runtime traces after stable semantic reconciliation exists. Clearly distinguish observed runtime data from inferred static flows.

### Acceptance

- Check at least three `ArchitectureView`s over one snapshot, including overlapping stable entities with different scopes and layouts. Reversing input order produces byte-identical normalized projections and no entity or edge leaks across views.
- `Main` always exists, is first, and cannot be closed. Closing the active derived tab selects its left neighbour and ultimately falls back to Main.
- Opening or selecting a diagram pushes one history entry; in-diagram camera and selection changes replace it. Reload, share, Back, and Forward restore the active artifact and its exact settled session. Unknown or stale artifacts fail closed.
- A surface switch commits scene, selection, story, focus/filter, authoring override, and inspector data atomically. Rapid switching is latest-wins and does not grow canvas, renderer, or listener counts.
- The desktop strip is an accessible tablist with roving focus and Arrow/Home/End navigation. At 390 CSS px the switcher has no page overflow and all controls are at least 44 CSS px.
- Mermaid output is deterministic under randomized model input, escapes labels and identifiers, honours active story and Isolate export masks, and excludes prompts, secrets, absolute paths, and private excerpts.
- Browser QA covers 1440×900, 1280×720, and 390×844 with entity, relation, source, story, and Isolate states open. Switching, reload, deep links, export, device fallback, and reduced motion produce no stale surface content or console errors.
