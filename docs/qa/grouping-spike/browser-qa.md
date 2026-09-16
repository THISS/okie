# Grouping spike browser QA

2026-09-14. Real Chrome interaction through CUA in a separate QA tab. Local Vite server on port 4175. No production edits, publication, or merge.

Artifact: `.okie-review/grouping-full-scan/atlas.okie.json`, temporarily copied to `apps/web/public/atlas.okie.json` and opened at `http://localhost:4175/?portable=1`. The UI reports 3,580 entities and commit `6a65b895f8a6f23c3da7f254734933ef64e72a71`. This is the deterministic artifact before the separate enrichment run. Analysis coverage reports limited.

## Passing behavior

- Search for **Source Viewer** returns the mapped component `component:probe-source-viewer`. Overview shows its authored membership note and responsibility summary.
- Implementing files contains all three expected files: `SourceViewer.tsx` (16 declarations), `sourceFetch.ts` (5), and `sourceRequest.ts` (2). All expand. Show all 16 exposes `SourceViewer` beyond the five-declaration preview.
- Opening `createSourceRequestController` populates its code inspector, including two direct dependents. Source displays `sourceRequest.ts` lines 4–15, pinned to the artifact commit. Open source in a tab creates a dedicated source tab; View full bundled file successfully expands to lines 1–34 without a backend fetch. Returning to Main preserves the inspector.
- Opening `fetchSourceRange` from its implementing file displays `sourceFetch.ts` line 24. Opening `SourceViewer` from Show all displays `SourceViewer.tsx` lines 142–153. No missing implementation data or missing source errors occurred for these samples.
- Double-clicking the Source Viewer component on the map opens its canonical interior: `root=component:probe-source-viewer`, lenses system/web/component, zoom 13.96. Named cards from all three files are visible together, including `createSourceFetcher`, `fetchSourceRange`, `createSourceRequestController`, `sourceContextIsLoading`, and `SourceViewer`. Clicking the visible `fetchSourceRange` card highlights it and displays its source.
- Played the overview tour, jumped to step 5 **Read WEBMCP_HOST_HEADERS**, and waited for `[data-playback-state="paused"]`. Source inspector populated with pinned `apps/web/src/webmcp.ts` lines 48–51. This tour targets the artifact's default story, not the mapped Source Viewer specifically.

## Navigation/reveal inconsistency

Reproduction:

1. Fresh portable URL, search Source Viewer, choose its component result while the root is `system:okie`.
2. Expand an implementing file and click its declaration (tested request controller, fetch range, and SourceViewer).
3. The inspector and Source are correct, and the announcement says the declaration “opened at its code level.” Camera moves to approximately `cx=458.795&cy=338.359&z=8.50474&detail=code`, but the canvas shows only one broad Source Viewer component rectangle with no code cards visible inside. Root remains system and no canonical lens path is present.
4. Double-click that rectangle. Canonical component root/lenses appear and the implementation cards become visible.

This does not establish missing mapped entities: canonical Open inside proves they exist. It also differs from expected selection-only camera behavior. Read-only inspection of `App.tsx` shows implementing-file links call `openInspectorChild`, then `navigateInspectorHierarchy`, which explicitly starts an inspector camera flight and announces an opening. Ordinary entity selection uses a separate preservation path; Show on map is another explicit framing action. This QA did not independently retest Show on map.

Screenshots were inspected in the CUA session at the full bundled source tab, the broad parent-only code frame, and the canonical component interior with selected fetch card. The tool session did not return persistent screenshot paths; this report records their observed content rather than claiming saved image artifacts. No video or smoothness claim is made.

The temporary public artifact was removed after QA. The QA-owned port 4175 server was stopped.

## Final implementation-drill retest

After the canonical drill and resident-code bypass fixes, the earlier parent-only canvas reproduction passes. Started from this explicit portable system-root URL:

`http://localhost:4175/?portable=1&nav=1&repo=repo%3Aokie&snap=snapshot%3Aokie%3A6a65b895f8a6&view=view%3Aokie%3Ahierarchy&root=system%3Aokie&sel=component%3Aprobe-source-viewer&cx=452.872&cy=397.636&z=1.24&detail=context`

- Clicking `createSourceRequestController` installs the component root and system/web/component lens path at zoom 13.96. Its selected card is visibly present among named implementation cards and Source opens automatically at lines 4–15.
- Following inspector Back, repeated with `fetchSourceRange`, then with `SourceViewer` through Show all 16. Both show the selected named code card, canonical component root/lenses, and automatic pinned Source excerpts (line 24 and lines 142–153 respectively). These latter two checks start from the context restored by inspector Back, rather than a separately reloaded system-root URL.
- Back restores Source Viewer Overview and the three implementing-file groups, collapsed, with the prior camera. It does **not** fully restore the original navigation root: the root remains `component:probe-source-viewer`, the selection query disappears, and lenses clear. This is inspector-context restoration, not a claim of full navigation restoration.
- The declaration-over-cap retention case was covered by the implementation's automated tests; this browser sample has 23 declarations and does not exercise that cap.

## Final enriched artifact smoke

Replaced the temporary packaged artifact with `.okie-review/grouping-full-enrichment/2026-09-13T23-24-19.346Z/atlas.okie.json` and opened the explicit portable URL above. Initial browser automation observations timed out, then recovered without another reload.

The visibly updated Source Viewer summary describes `SourceViewer.tsx`, `sourceFetch.ts`, and `sourceRequest.ts`, and explicitly acknowledges omitted source lines and truncation. All three implementing groups remain, with 16/5/2 declarations. The UI still reports limited analysis coverage.

From system root, opening `createSourceRequestController` again produces canonical component root/lenses, automatic Source lines 4–15 pinned to `6a65b895f8a6`, and a visibly selected named canvas card. The screenshot also shows named cards from the other implementing files. This bounded enriched smoke passes; it does not repeat the full deterministic tour and dedicated-source-tab exploration above.

Final retest screenshots were inspected inline; no persistent media files were saved. The temporary public artifact was removed and the QA-owned port 4175 server stopped after the final smoke.
