# Viewport neighborhood (CLA-74)

Status: camera-resident compiled tiles. Fetch stays CLA-73 (slim neighborhood packet). Compile stays CLA-66 (current C4 band + one layer down). The hang-guard stays 2000 (CLA-67). This is not a slim-boot rewrite and not a SceneSnapshot/protobuf rewrite.

CLA-66 compiles the current C4 band plus one layer down. GPU culls off-screen. A fat L4 file could still dump 100+ code cards into the compiled scene. Pan did not fetch a sibling tile; zoom did not swap tile resolution.

## Resident set

The **compiled and resident** set is:

- the focused entity
- its siblings
- one C4 band down
- plus a ring around the camera keyed off the existing 512-world-unit spatial index

L1/L2 stay a handful (unpaged). L3/L4 pack the full neighborhood so parent bounds stay stable, then keep only nodes that intersect the camera world rect expanded by one 512-unit cell. A CLA-67 healthy cap of 50 sibling nodes is the compiled-scene window when the camera still covers a dump. Omitted cards stay enumerable in the inspector as `+N more`.

Panning toward a sibling neighborhood recompiles that tile window for the same focus. It does not compile the full graph.

Open inside, the level rail, story steps, and prefetch compile the **new** focus with the 50-node cap only. They do not inherit the previous band’s camera rect (L3 world space is not the L4 packed layout). After the new camera settles, pan/zoom applies the 512-unit ring.

Prefetch stays on the committed box’s child neighborhood (~55 ms / 25 code children from CLA-66), not the sibling dump.

## Out of slice

Raising 2000; protobuf for `SceneSnapshot`; CLA-73 slim-boot fetch; CLA-63 / CLA-58 / CLA-75–77.
