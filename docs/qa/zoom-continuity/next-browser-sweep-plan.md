# Next browser sweep plan

This plan separates exhaustive state coverage from visual-motion evidence. It
does not turn a representative recording into a per-entity browser pass.

The served inventory has 3,121 entities and 21,847 tracked entity-case rows.
Only 174 entities own a deeper semantic boundary: one system, ten containers,
and 163 code-bearing components. The other 2,947 leaves (2,942 code entities,
four component leaves, and one external system) have no deeper level to enter.
There are twelve files with more than the 50-symbol resident cap and 51 with
more than 20 symbols; the largest contains 134 symbols.

## Sweep order

1. Start an isolated browser tab on the canonical served snapshot and record
   revision, snapshot ID, backend, viewport, device pixel ratio, and dirty
   source identity. Do not drive the tab currently used for a human recording.
2. Use the public page/WebMCP context contract to enumerate all 3,121 IDs.
   For every entity, select it through the supported UI/tool path and record
   reachability, selected ID, nonblank inspector, and parent chain. This is an
   exhaustive UI-state sweep, not a motion pass.
3. Run one automated boundary smoke for all 174 owners. For each owner, enter
   its next applicable detail, reverse through the same boundary, and assert
   the published root/detail/selection, scene revision, and minimap indicator
   agree with the page context. Store one compact trace row per direction;
   retain video only on failure.
4. For each of the 163 code-bearing files, perform a code residency smoke.
   Check one first and one late child when present. For the twelve files above
   the resident cap, also pan/select a child beyond index 50 and verify it is
   resident, pickable, and keeps its canonical slot after pinning a sibling.
   This detects paging omissions without compiling or visually reviewing every
   code card.
5. Exercise the four component leaves and the external-system leaf as leaf
   cases: inward/outward wheel input must not invent a child level, selection
   and minimap must remain coherent, and restored URLs must retain the leaf.
6. Capture high-frame-rate video plus input/frame trace for each semantic
   equivalence class, in both directions and for partial/reversal/restored URL:
   system L1↔L2; each of the ten container L2↔L3 branches; adjacent-file L3↔L4;
   the 29 source-residency file cases; component leaves; and the twelve
   over-cap paging files. Include one minimap click and one drag before a
   resumed zoom in every class.

## Reporting

Record automated state results separately from visual evidence. A green
all-ID reachability or boundary-smoke row means that the named contract held
for that run. It does not establish Figma-like motion for every entity. Mark a
visual class as passed only when its synchronized video and trace are reviewed
for pointer anchoring, frame discontinuities, outgoing geometry/edge lifetime,
and minimap correspondence. Failures retain the entity ID, case, URL, trace,
and video; no unsupported entity should be silently sampled away.
