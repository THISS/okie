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

`GET /scan/<slug>/excerpt.json?entity=<id>` returns that entity’s portable excerpts. `story.json` stays a small third fetch (the default overview). `stories.json` is an optional catalog (overview first, then user-flow stories). Full `snapshot.json` / `view.json` remain published for tools; the atlas boot path must not GET them.

Deep links (`sel` / `lens` / `root`) fetch **that** neighborhood first, not the whole tree. Open inside merges the container subgraph into the resident snapshot. Source tab lazy-fetches excerpts.

## Source-to-evidence capture (CLA-175)

New scans preserve the original declaration `sourceRef` instead of replacing it
with a shortened excerpt range. When capture is partial, an additional reference
pins the exact captured window to the same file, symbol and commit. Portable
validation checks both ranges; navigation can retain the declaration identity
without claiming that all its lines were captured.

Captured excerpts allow up to 48 contiguous lines, still limited to 512 Unicode
characters per line and 4096 characters of text. No line is silently shortened.
`sourceStartLine` / `sourceEndLine` record the original observed range; differences
from `startLine` / `endLine` explicitly indicate partial capture (including skipped
wide lines or EOF). Absence of these fields in older snapshots means capture
completeness is unknown. Text remains token-scrubbed, not a byte-exact source archive.
Old snapshots remain readable; older viewers with the 12-line validator may reject
new longer captures and should be upgraded.

This does not add method extraction where a scanner only identifies the containing
class, guarantee complete bodies for large declarations, or remove the profile
sampler's byte limits. Bounded hub selection and independently labelled semantic
evaluation remain follow-on work. No model calls or inferred-role consumers are
enabled by this capture change.

## Out of slice

Raising 2000; protobuf for `SceneSnapshot`; CLA-66 compile strategy; map-reduce; CLA-74 camera tiles.
