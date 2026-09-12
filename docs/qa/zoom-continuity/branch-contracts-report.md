# Machine contract audit — not visual acceptance

The saved served snapshot `snapshot:okie:722ea2862304` and its matching view were compiled with target aspect 1.6 using the repository's `compileScanFixture` API. All 10 containers and 167 components were inspected. No product source was edited and no browser was used.

177 branches: 144 have an adjacent morph contract, 29 return no morph, and 4 are legitimate component leaves. All missing morphs are web files. Their source and target bounds exist and no compile guard refusal is returned. See `branch-contracts.json` for every ID, membership, child count, bounds, and outcome. These are machine checks only; all visual statuses remain untested.

The first missing example, `component:apps-web-api-oembed-ts`, is absent from the source L3 projection but present in the target. Retaining source projection membership then makes the requested code session fall back to `{baseDetail: "code", settled: []}`, so the adjacent morph cannot be constructed. A UI path that reveals/recompiles omitted nodes may change this outcome; the inventory does not call these 29 browser failures.

For `component:apps-web-src-hosted-atlas-ts`, the actual source and target both contain 3,121 semantic entities. The source component projection lists 62 IDs. None of those entities changes parentId/detail or is missing from the target. At morph progress zero, the source semantic session is identical to the original L3 session; all 64 originally visible object contracts are identical, including representation IDs, opacities, pickability, and priorities. No source visibility loss is reproduced by the pure helper. The recorded browser sibling-loss failure therefore still needs runtime scene/packet/ownership investigation.

Detailed hostedAtlas data is in `hosted-atlas-metadata.json` and `hosted-atlas-roundtrip-contracts.json`. Temporary Vitest harnesses are preserved as `.test.ts.txt` files here; they were executed from `apps/web` and removed from the automatic test tree afterward. Tests verified inventory completeness; their green result does not mean every morph or visual case passes.
