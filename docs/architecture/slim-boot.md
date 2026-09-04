# Slim boot trio (CLA-73)

Status: fetch scoping. Compile stays CLA-66 (current C4 band + one layer down). The hang-guard stays 2000 (CLA-67). This is not viewport tiles (CLA-74) and not a SceneSnapshot/protobuf rewrite.

After CLA-66, `/r/THISS/okie` still **downloaded** the full semantic trio (`snapshot` + `view` + `story`) on first paint, then compiled only the current band. THISS/okie self-scan is ~4.3 MB snapshot (~1 MB `sourceExcerpts`) plus ~622 KB view. Route/zoom changes compile scope; they did not change what was fetched.

## Packet

`GET /scan/<slug>/neighborhood.json?focus=<id>` returns an `okie-neighborhood/v1` packet:

- `snapshot` / `view` closed under ancestors of the focus, the current C4 band, and **one band down**
- `sourceExcerpts` omitted (`?excerpts=1` is debug-only)
- relations only when both endpoints are in the packet (L1 does not ship the L4 import graph)
- `childCounts` so Open inside stays enabled when children are not resident yet
- `truncated` when the published snapshot has omitted entities

`GET /scan/<slug>/excerpt.json?entity=<id>` returns that entity’s portable excerpts. `story.json` stays a small third fetch. Full `snapshot.json` / `view.json` remain published for tools; the atlas boot path must not GET them.

Deep links (`sel` / `lens` / `root`) fetch **that** neighborhood first, not the whole tree. Open inside merges the container subgraph into the resident snapshot. Source tab lazy-fetches excerpts.

## Out of slice

Raising 2000; protobuf for `SceneSnapshot`; CLA-66 compile strategy; map-reduce; CLA-74 camera tiles.
