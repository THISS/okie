# Final static browser QA

2026-09-13. Chrome, desktop viewport 1671 × 977, separate QA tab. Explored `http://127.0.0.1:50927/portable-atlas/`, served by the parent task's static Python server with no application backend. No product files changed.

## Results

- Packaged Okie loads: architecture brief reports 10 containers and 3121 entities; local revision `722ea2862304`.
- Search `is_valid_color` returns the matching Rust source entity. Selecting it populates Overview, Source, and Details.
- Details shows **Called by 4**: `Primitive::validate`, `SceneSnapshot::validate`, `Stroke::is_valid`, `Timeline::validate_for`. The UI counts distinct callers; the parent task separately verified 7 evidence callsites in the final JSON. No aggregate seven-callsite UI badge was assumed.
- Frozen source shows `geometry.rs` lines 49–53 at `722ea2862304`. **View full bundled file** loads lines 1–54 without a hosted source fetch. Opening the source workspace creates a source tab. Returning to Main preserves the selected validator and nonblank inspector. Dependency tab and return to Main also work.
- Zoom in/out, canvas drag, minimap drag, and Fit respond. Camera position changes are reflected in the navigation URL. Minimap and zoom controls remain unobstructed.
- Played the packaged overview guided tour. Jumped to steps 3 and 5 and explicitly awaited `[data-playback-state="paused"]`. Final step renders `WEBMCP_HOST_HEADERS`, a highlighted source node, and frozen source lines 48–51. A concurrent browser focus change initially interrupted step 5 with the truthful “tab was hidden” message; repeating the jump recovered to Paused.
- No hosted account or Ask action is present in the shell. The packaged story list retains a story titled “okie: Ask the atlas”; that is captured architecture content, not an active hosted Ask control.
- Repository icon links to `https://github.com/THISS/okie/tree/722ea2862304eae579a7b354bc7cfa0697f4e997`; source link is similarly commit-pinned. Bundled source actions are available without enabling an external source fetch.

## Layout finding

**Resolved and browser-rechecked after the footer rebuild.** Portable controls now occupy a reserved footer row outside the application. At 1671 × 977 and 1000 × 800, collapsed and expanded Analysis coverage no longer overlays source actions, minimap, or zoom controls. Clicked Copy symbol and Copy relative and observed success feedback; View full bundled file again loaded lines 1–54; zoom responded in the narrow expanded state. Expanded coverage consumes substantial vertical space but leaves the application controls usable. Restored the default viewport after responsive QA.

Recheck evidence: [desktop footer](final-static-footer-desktop.png), [desktop expanded coverage](final-static-footer-coverage-desktop.png), [narrow expanded coverage](final-static-footer-coverage-narrow.png), [narrow collapsed footer](final-static-footer-narrow.png).

Original finding below is retained as before-fix evidence:

The lower-right portable-controls card overlaps the inspector footer at this desktop size. In the source view it obscures the right side of **View full bundled file**, the right part of the commit link, and the lower source-action area (Copy actions/frozen label). The full-file action remained clickable via its exposed left portion during this exploration. The card does **not** overlap minimap or zoom controls. No claim that every obscured action is wholly inaccessible: keyboard accessibility was not tested. Parent task notified for review.

## Evidence

- [Paused final source story and footer overlap](final-static-story.png)
- [Four incoming callers, Main restoration, minimap/zoom placement](final-static-callers.png)

File-picker and A/B persistence flows belong to separate QA and were not duplicated. No video capability was used. Automated build/test gates were handled by the parent task, not rerun by this browser-only pass.
