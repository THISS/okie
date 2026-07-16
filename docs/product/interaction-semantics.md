# Atlas interaction acceptance semantics

Status: active acceptance contract for semantic zoom, drill-down, focus modes, and stories.

## Diagram workspace

- The architecture atlas is the pinned `Main` diagram. It is always first and cannot be closed or replaced by a generated diagram.
- Flow, code, Mermaid, deployment, and other derived diagrams open in application tabs. Opening an artifact that is already present activates its existing tab. Closing an active derived tab selects its nearest left neighbour, falling back to Main.
- A desktop diagram strip is a distinct accessible tablist from the inspector tabs. On mobile, a labelled `Views` switcher lists Main and generated diagrams without requiring horizontal scrolling.
- Each diagram retains its own viewport, selection, filter/focus state, relation selection, and inspector subject. Returning to Main restores its exact atlas state without replaying camera or story transitions.
- Selecting a diagram tab pushes browser history. Pan, zoom, selection, and inspector changes inside the active diagram replace the current entry. Closing a tab replaces history so Back does not resurrect a deliberately closed workspace surface.
- The inspector may show a compact diagram preview and a `Diagrams` group scoped to the selected item. Activating a preview opens or focuses the full diagram tab; the narrow details pane does not become the primary interactive canvas.
- `Open in browser tab` is secondary to the in-app workspace and uses the same canonical artifact URL. The product does not imply live synchronization between windows.
- Only the active heavy renderer is mounted. A tab becomes interactive only after its scene, viewport, selection, inspector, and accessible outline have committed together; content from the previously active surface must never be pickable or announced.

## Spatial continuity and drill-down

- Wheel and pinch zoom preserve the world point beneath the pointer. Keyboard and button zoom preserve the viewport centre. Crossing a semantic zoom band never changes that anchor.
- Selecting an item in the current scope changes selection and the inspector, not the camera. If the item is off-screen, offer an explicit `Show on map` action instead of moving the map implicitly.
- A deliberate drill into a child scope or a search jump may frame its destination. The destination must land inside the canvas safe area, outside open inspector and story overlays.
- Back and Forward restore the exact selected entity, scope, camera, focus mode, and paused story frame. A restore snaps to its settled state; it does not replay the transition that originally produced it.
- Camera gestures and refinements replace the current history entry. Scope changes, explicit drill-down, search jumps, and story launches push entries.

## Semantic zoom crossfade

- A zoom-band change retains stable object identities and geometry. It swaps representations; it does not tear down and rebuild the whole scene.
- Use 6-10% hysteresis around each threshold. The old and new representations may overlap for 160-220 ms, with complementary opacity. Neither representation may remain fully opaque while its replacement is also readable.
- During overlap, render one readable primary label per object. Secondary copy belongs to the incoming representation only after it becomes dominant, preventing doubled or visually bold text.
- Selection, focus, and hit targets remain stable across the swap. Once the incoming representation is dominant, the outgoing representation is no longer pickable.
- Reduced motion applies the target representation immediately or with an opacity-only crossfade no longer than 100 ms. It never scales or flies labels between levels.

## Story camera flights

`Story transition` means a cinematic camera flight from the current keyframe screen to the next keyframe screen. It is distinct from the 160-220 ms semantic-zoom representation crossfade above. A story step has ordered `flight`, `arrival`, and `hold` phases; narration time never runs during the flight.

- Previous, Next, progress-seek, and automatic advance sample the current live camera and compute the destination from the target entities and the current safe area. They never teleport through a React state update before the flight begins.
- A manual Previous, Next, or progress-seek pauses playback first, flies to the requested step, and arrives paused. Automatic advance flies to the next step and enters its playing hold after arrival. Repeated navigation does not queue flights: the newest target retargets from the currently sampled camera.
- Cameras equal within 0.5 CSS px at the destination anchor and 0.001 zoom have a zero-duration flight. Otherwise let `d` be centre travel in viewport diagonals and `s = abs(log2(targetZoom / startZoom))`; use `clamp(480 ms, 1,100 ms, round(520 + 180 * min(2, d) + 140 * min(2, s)))`.
- Interpolate the camera with cubic ease-in-out. Interpolate zoom logarithmically so zoom-in and zoom-out feel symmetric. When `d > 1` or `s > 1`, use a widened fly-to route: ease toward an overview zoom that can contain the union of source and destination bounds, cross the middle of the route at that overview, then ease into the destination. Never sweep linearly across a long route at destination zoom.
- The destination title and step number may appear at departure with a visible `Moving to…` state. Announce `Moving to step N: title` once. Arrival occurs only after a rendered frame contains the exact target camera and destination visual state; then allow a 150 ms visual settle before announcing `Arrived at step N, paused/playing` and starting narration when playing.
- Focus, context, and trace changes are one transition transaction. Stop and fade the outgoing flowing trace during the first 120 ms. Keep non-target context available but dimmed during travel. Crossfade destination focus, Dim, and the static incoming trace over the final 200 ms. An Isolate filter must not remove orientation context mid-flight: commit its render, hit-test, keyboard, inspector, and export masks atomically on the arrival frame. Flow animation starts only with the narration hold.
- While a story keyframe owns presentation, its target entities and relations exclusively define canvas focus and Isolate, hit-test, keyboard, and export membership. Preserve the reader's pre-story selection logically for inspector state and history, but suppress any off-target selection or picked relation from visual emphasis and story masks. An explicit entity or relation selection interrupts the story and gives the reader's selection presentation authority; Resume or Return to story frame reasserts keyframe ownership, and closing the story restores normal selection styling.
- The target camera is fitted before departure. It must not change because a semantic representation crosses a LOD threshold during the flight; LOD changes preserve the flight's screen anchor and use their separate opacity crossfade.

## Story playback, interruption, and narration

- The narration hold begins after the flight and 150 ms arrival settle, not when the destination step is selected. An explicitly authored keyframe hold is authoritative. Otherwise derive a deterministic reading-time hold as `clamp(4.2 s, 12 s, 1.2 s + words / 3 * 1 s)`. Recorded narration uses its media duration plus a 400 ms completion pause.
- A shared or restored story always opens paused at the encoded step, phase, phase progress, and exact sampled camera. It does not replay or auto-complete a saved flight. Play is an explicit user action. When the saved phase is `flight`, Resume deterministically creates a new remaining segment from that sampled camera to the active target using the encoded remaining-duration proportion. It does not claim to reconstruct the original departure curve or velocity.
- Starting a story pushes one history entry. Automatic steps and manual Previous, Next, or progress changes replace that story entry so browser Back exits the story rather than walking every step.
- Explicit Pause during a flight freezes the exact camera, flight progress, and transition styles. Resume continues the remaining flight; it does not restart from the source. Explicit Pause during hold freezes narration elapsed and trace flow, and Resume continues the remaining hold.
- Any direct manipulation—pan, zoom, level change, selection, search jump, or Dim/Isolate change—interrupts before applying the action, releases camera ownership, preserves the sampled phase, and announces the reason. If interruption occurs during hold, Resume continues the remaining narration without moving the camera. If it occurs during flight, narration remains blocked and a separate `Return to story frame` action starts a new flight from the user's camera to the same target.
- Changing the tab to hidden pauses the current flight or hold. Returning to the tab never resumes automatically.
- Copying during a flight samples and serializes its exact camera and phase without starting narration. The recipient opens that state paused. Back and Forward restore the sampled state paused and do not replay historical flights. A viewport change recomputes the safe destination and retargets from the sampled camera without resetting narration elapsed.
- Pause, Resume flight, Resume narration, Previous, Next, Replay, and Return to story frame expose phase-specific accessible names. A transition emits at most the one departure and one arrival announcement described above; intermediate animation frames are silent.

## Story safe areas

- Fit story targets inside the visible canvas after subtracting the top bar, level rail, open inspector, story player, persistent controls, `visualViewport` offsets, and CSS safe-area insets. Use the measured overlay rectangles; a fixed bottom allowance is not sufficient when narration wraps or mobile text size changes.
- Keep at least 42 CSS px between focused bounds and the safe-area edge on desktop and 24 CSS px on screens up to 780 px wide. Story framing uses the authored representation bounds: its normal ceiling is the band's focus preset, while an explicit L4 owner action may use the shared `32` maximum runway.
- Recompute the destination immediately before every flight and on resize or orientation change. No focused object, destination label, or active trace endpoint may finish underneath the story player, inspector, level rail, notch, or home indicator.
- On a mobile resize during flight, sample the current camera and retarget to the newly safe destination using the remaining duration. Do not restart the narration clock or snap through an unsafe intermediate frame.

## Dim and Isolate

- `Dim others` is visual emphasis only. Context remains rendered, pickable, searchable, and available to keyboard navigation. De-emphasise strokes and secondary detail, but keep primary labels readable; do not communicate dimming by colour alone.
- `Isolate selection` is a reversible view filter. Non-matching entities and relations are excluded from rendering, hit testing, and the canvas keyboard candidate list. Search and breadcrumbs remain available so the user cannot become trapped.
- While isolated, show a persistent `Showing N of M · Restore full view` control outside the canvas. Its accessible status announces the isolated scope and result count.
- Restoring returns the pre-isolation camera, selection, filter, and Dim state. Escape may restore only when focus is on the canvas or isolation control; it must not override modal Escape behavior.
- Dim and Isolate are mutually explicit controls, never two interpretations of one unlabeled toggle. Share URLs encode Isolate/filter state; transient Dim is encoded only if reproducing emphasis is part of the promised shared view.

## Reduced motion

- A story camera flight has zero duration under reduced motion. On the next rendered frame, atomically apply the destination camera, focus, filter, and static trace, then use the same arrival barrier before narration. Do not announce a `Moving to…` state when no moving frame is shown.
- Snap semantic representations to their destinations. Disable animated path particles, pulses, parallax, and auto-panning.
- Preserve narration timing, content order, focus emphasis, pause/interruption behavior, and arrival status. Reduced motion removes spatial animation; it does not shorten or lengthen the hold.
- A static highlighted path and focused objects replace motion. No continuous animation frame should be requested while the reduced-motion story is otherwise idle.

## Authoring preview

- `Preview as reader` starts from the selected keyframe, paused, in a reversible preview mode. Preview uses the same safe areas, timing calculation, reduced-motion settings, and interruption rules as published playback.
- Display `Preview · not published` persistently, with `Exit preview` restoring the authoring camera and selection. Preview never mutates the saved story until the author explicitly applies edits.
