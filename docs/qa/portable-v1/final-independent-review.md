# Portable v1 independent final review

Reviewed locally on 2026-09-13 against `CLAUDE.md`, the portable roadmap, and the current working tree. This review covers portable import validation, accepted offline enrichment, CLI/static distribution, browser replacement/forget state, and portable backend guards. It excludes the preserved earlier zoom/inspector baseline. No implementation files, commits, pushes, PRs, deployments, or public artifacts were changed.

Three concrete defects were found and reported during this review. The integration owners fixed all three, and independent runtime rechecks below confirm the original reproductions are resolved. The descriptions preserve the original triggers and severity; they are not outstanding findings. Full browser and integrated build gates remain the integration owner’s responsibility.

## Resolved P1 — Remembered atlas overrides a different packaged site

Locations: `apps/web/src/main.tsx`, `bootPortableAtlas` (restore before fetch, around lines 164–183); `apps/web/src/portable/storage.ts`, constants at lines 3–5.

All portable viewers on one origin use database `okie-portable-atlas`, store `bundles`, key `active-v1`. Boot returns immediately when that slot contains a compilable atlas, before attempting the site's own `./atlas.okie.json`. Opening exported `/atlas-a/` saves A; subsequently visiting exported `/atlas-b/` on the same origin displays A and never fetches B. A redeployed scan at the same URL is likewise hidden by the remembered older packaged copy. This violates the agreed exported-folder behavior of opening directly into its bundled atlas and can show a previously imported private local scan while navigating an unrelated public packaged atlas.

Reproduction: an executable harness extracts the actual `bootPortableAtlas` function from `main.tsx`, removes its two TypeScript annotations, and supplies controlled storage, compilation, mounting, and fetch functions. A is named `Acme`; B is named `Different packaged repository`. Visiting A then B yields:

```text
first-site Acme
second-site Acme
packaged-fetches ["/atlas-a/./atlas.okie.json"]
```

The persistence mock represents the shared slot defined by the actual storage constants. This is a runtime boot-branch reproduction, not a real-browser IndexedDB test. Scope remembered imports to the viewer, and distinguish intentional user imports from cached packaged defaults so fresh exports/redeployments are not silently superseded.

## Resolved P2 — Accepted actor enrichment destroys unrelated observed relation fields

Locations: `packages/scan/src/portable-enrich.ts`, `refreshedSnapshot` relation reconstruction around lines 86–91; `packages/scan/src/enrich.ts`, structural merge/collapse path around lines 755–785.

Adding one valid system-scope person with no new relations takes the structural merge path and rebuilds every existing non-duplicate relation. The portable wrapper matches previous lineage only by the newly generated relation ID and does not restore other observed fields. An unrelated existing code-to-code call loses its ID, lineage, label, technology, optional flag, and confidence, although its endpoints and evidence are unchanged. This happens even when no regrouping was proposed.

Reproduction: a valid committed bundle contains `relation:observed-call`, from `code:acme-run` to `code:acme-work`, with label `run invokes work`, technology `TypeScript`, `optional: true`, confidence `0.9`, and one resolved-call evidence reference. An accepted system document adds `person:user`. The resulting relation is `relation:acme-run:acme-work`; `label`, `technology`, `optional`, and `confidence` are absent and lineage also changes. The report says `systemScope.accepted: true`, `persons: 1`, `relations: 0`. Both the input and output pass portable validation.

Preserve identity and observed relation metadata for unaffected edges. Where grouping truly changes an endpoint, apply an explicit merge policy for metadata and retain provenance rather than silently discarding it.

## Resolved P2 — Accepted summary enrichment silently deletes boundary entities

Location: `packages/scan/src/portable-enrich.ts`, `extractionFromPortable` line 17 and `refreshedSnapshot`.

Portable import explicitly supports `boundary` entities, but conversion to the enrichment gate filters them out and snapshot reconstruction never restores them. A summary-only accepted container document therefore removes an unrelated valid boundary from the portable snapshot and rebuilt view. There is no rejection or loss report. Boundaries referenced by other entities/relations can instead cause a later validation failure.

Reproduction: add a top-level `boundary:observed` entity and matching view layout to a valid bundle; `serializePortableAtlas` succeeds. Apply an accepted summary document describing its existing container. `enrichedContainers` contains that container, while boundary existence changes from `true` to `false`. Keep unsupported gate entity kinds outside the transformation and restore them with their relationships, or reject an unsupported transformation explicitly before producing a modified artifact.

## Independent fix recheck

The updated boot code fetches the site’s package first and scopes remembered replacement imports by directory plus SHA-256 of the complete package text. The same controlled harness now mounts `Acme` at A, `Different packaged repository` at B, and the newly deployed repository when A’s package changes. All three package fetches occur. Real-browser IndexedDB/cross-path behavior is still delegated to browser QA.

The updated enrichment wrapper retains snapshot-only boundaries and restores original observed relations verbatim by unchanged endpoints, kind, and canonical evidence. Repeating the actor-only reproduction now preserves the exact original relation ID, lineage, fingerprint, label, technology, optional flag, confidence, and evidence; the boundary reproduction returns `true → true`. The independent focused rerun passes 12 tests, including the added accepted-summary/boundary and actor-only regressions.

A transient integration issue was also caught and corrected: the outer persistence declaration is now mutable and initializes the empty viewer with a directory-scoped key. Source reinspection confirmed that wiring change. No additional outstanding defect was established in the reviewed scope.

## Checks and limits

- Executed `node --test packages/architecture/dist/portable.test.js packages/scan/dist/portable-enrich.test.js packages/scan/dist/package-viewer.test.js`: 10 passed, 0 failed. These use existing compiled outputs; source inspection confirms the relevant reproduced branches. They do not replace fresh integrated repository gates.
- Reproduction harness: `/tmp/okie-portable-final-repro.mjs`. It constructs a small committed bundle, validates it, exercises accepted actor and summary enrichment, and executes the real browser boot branch with controlled dependencies. This temporary file is local review evidence, not a shipped artifact.
- Inspected strict runtime entity/relation/source/exposure/excerpt/view shapes and the separately defensive story validator. No additional concrete type-safety defect was established. Snapshot/view runtime field checks reject malformed deferred-inspector data before persistence; source revision and range checks are enforced.
- Inspected `scripts/package-scan.mjs` and `package-viewer.ts`: bundled workspace aliases, external native/parser dependencies, executable output, prompt placement relative to `bin/cli.mjs`, copied skills, relative-asset requirement, fresh output protection, and semantic bundle validation. The focused export test passed. This review did not repeat the separate install/full-scan smoke or certify clean-machine native installation.
- Replacement validates and compiles before persistence/mounting; the old App unmounts before shared fixture replacement. Forget clears shared runtime state and surfaces storage failure honestly. Portable auth/Ask handlers are guarded; source display branches to bundled content and opt-in exact-revision remote retrieval. No additional backend request defect was established by source inspection.
- No running-application browser exploration or full `pnpm check`, `pnpm test`, `cargo test --workspace`, or `pnpm build` was performed by this independent reviewer. The integration/browser owner must complete and report those gates. No PR was opened or closed.

## Stale-navigation follow-up recheck

Independently reviewed the final small navigation fix on 2026-09-13: `mountPortableAtlas` resets the URL before rendering App when replacement explicitly requests it or when `portableNavigationDiffers` finds an explicit repository/snapshot mismatch. Ordinary boot of the same repository and snapshot leaves the URL untouched, preserving its camera, selection, and story parameters; identity-free URLs continue through the existing navigation defaults. Duplicate `repo`/`snap` parameters use the last value, matching `navigationStateFromUrl` rather than introducing a conflicting decoding rule. App reads URL-dependent state during the subsequent render, so the reset occurs before that state is captured.

Focused independent verification: `pnpm --filter @okie/web exec vitest run src/portable/runtime.test.ts src/portable/bootstrap.test.ts` passed both files, six tests. No new correctness concern was established in this limited follow-up. The integration owner's broader web tests/typecheck are separately attributed; this reviewer did not repeat full gates or modify the user's exported folder.
