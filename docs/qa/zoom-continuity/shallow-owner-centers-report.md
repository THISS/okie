# Shallow owner-center audit

Machine geometry only, not a visual pass. Used saved served snapshot `snapshot:okie:722ea2862304`, target aspect 1.6, existing built compiler and architecture modules; no rebuild or product edits. Exact dist SHA-256 identities are in `shallow-owner-centers.json`.

L1 → L2: the system rectangle retains its top-left while growing from 480 × 250 to 660.149 × 437.656. Its center moves (+90.074, +93.828), or 130.066 world units. This is authored size growth rather than a changed top-left, but center-based camera compensation still moves the view.

For all ten containers, root-scene L2 and resident L3 preview centers match exactly. Root-scene L2 and independently compiled container-focus L2 centers also match. The independently compiled full L3 endpoint has the following center displacement from the root L2 owner:

| Container | Δx world | Δy world | Distance world |
| --- | ---: | ---: | ---: |
| `container:crates-atlas-gpu` | 2643.785 | 209.877 | 2652.103 |
| `container:packages-scan` | 2376.198 | 745.336 | 2490.350 |
| `container:packages-architecture` | 1989.461 | 770.587 | 2133.485 |
| `container:tooling` | 1149.670 | 1067.897 | 1569.122 |
| `container:crates-atlas-engine` | 1514.134 | 319.443 | 1547.464 |
| `container:packages-scene-compiler` | -351.285 | 1105.479 | 1159.951 |
| `container:crates-atlas-wasm` | 651.036 | 877.946 | 1092.995 |
| `container:crates-atlas-protocol` | -66.469 | 912.178 | 914.596 |
| `container:apps-web` | 580.572 | 151.541 | 600.024 |
| `container:apps-server` | 103.326 | 315.489 | 331.978 |

These values identify substantial coordinate changes at the full-neighborhood handoff; they do not alone establish a frame jump. Under center compensation, the structural screen-motion term scales with owner-center displacement × zoom × change in morph progress. Consequently, geometrically correct endpoint restoration can still generate large intermediate camera motion. Validate pointer anchoring and surrounding peer motion in continuous recordings, including L1 → L2; do not treat the equal resident-preview centers as evidence that the full transition is smooth.
