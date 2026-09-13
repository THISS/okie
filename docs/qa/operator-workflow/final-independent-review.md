# Final independent operator workflow review

Reviewed 2026-09-13 by Astra medium. Source baseline `2c7a7e72cd45cf514fd1450de061fa8a92259f60` through `4857bb6`; HEAD `1dd6939` adds QA documentation only. Read CLAUDE, roadmap, HTTP contract, integration/operations and browser QA evidence. Verdict: **changes requested — four confirmed P2 findings**. No P0/P1 finding. No source edits, provider calls, publication to a real environment, merge or deployment.

1. **P2 — Preserve newer sibling results when retrying a pinned revision.** `apps/server/src/operatorRunner.ts:89–96` builds the entire next sidecar from the request's old revision and installs it unconditionally as the current draft; `operatorApi.ts:24` accepts old revisions and concurrent actions without a revision guard. Repro: from pinned D1, retry A successfully to D2, then retry B from still-pinned D1. Latest D3 contains **old A, new B**, losing the accepted A result from the active draft. The UI deliberately keeps D1 selected, so this does not require an unusual API caller. Concurrent retries have the same lost-update outcome. Reject stale work using a compare-and-swap or serialize/rebase scoped changes onto the latest revision while preserving unaffected siblings.

2. **P2 — Carry stale/failed child provenance into ancestor refresh.** `apps/server/src/operatorRunner.ts:84` reports every sidecar explanation as `accepted`, ignoring its scope's stale flag and failed refresh; line 89 clears the refreshed parent's stale flag after any accepted result. Repro: root → parent → child, with root/parent stale and old explanations. Refresh root and parent together; parent returns invalid output and stays stale, then root's prompt receives parent as `state: accepted` with its old explanation. Root becomes fresh despite having synthesized stale input without that warning. Pass the actual child freshness/failure state to synthesis and retain appropriate stale provenance on the result.

3. **P2 — Canonicalize repository identity across case variants.** `apps/server/src/operatorApi.ts:23` stores case-preserving repository IDs, while `apps/server/src/scanServer.ts:69` uses the first run with the normalized slug to resolve public objects. Repro: publish `Acme/app`, then `acme/app`; they share slug `acme__app` but have different publication pointers. The public route keeps serving the first publication and the second publication's pinned reads return 404. Canonicalize the repository key consistently and resolve existing case variants safely.

4. **P2 — Keep publication pointer filenames within filesystem limits.** `apps/server/src/operatorPublication.ts:15,26` hex-encodes the full repository key and appends a PID/publication UUID for its temporary pointer filename. Repro: a valid `acme/<95-character repository name>` accepts a run/draft but publishing throws `ENAMETOOLONG` after freezing the draft. Use a fixed-length repository digest or short independent temporary filename, including a compatibility path for existing pointers.

## Verification performed

- `node --test apps/server/dist/operator{Budget,Runner,Enrichment,Workflow}.test.js`: **13/13 pass** against compiled current source.
- Fake-gateway temporary-store repro: sequential retries from the same pinned revision produced `[old a, new b]`.
- Fake-gateway temporary-store repro: failed stale parent refresh was passed to root as `accepted`; final freshness was root=false, parent=true.
- Bounded independent storage/access review reproduced the casing/public-resolution and pointer-name errors using current compiled modules and temporary stores.
- Existing full gates and real browser QA were reviewed as supplied evidence; this review did not repeat their complete sweep. Fixes need focused regressions and relevant browser rechecks before final acceptance.

## Bounded recheck at source `8ae120a`

Three findings are closed: stale revision requests now return 409 and the runner guards both admission and installation; stale children remain explicitly stale in ancestor prompts/results; pointer filenames use a fixed-width digest. New case-variant intake/publication and legacy mixed-case retry recovery also pass. Reviewed the UI conflict reload and obsolete-alert cleanup plus supplied final browser recheck through rev12.

**One residual P2 in finding 3's legacy migration remains:** `apps/server/src/operatorPublication.ts:30–31` returns the canonical legacy hex pointer before considering the other legacy case variants. With an older `repo:acme/app` publication and a newer `repo:Acme/app` publication, each retaining its pre-fix hex pointer, the public resolver still returns the older lowercase publication. Independently reproduced using two valid durable publication rows and legacy pointer files in a temporary store. Give only the new digest pointer precedence; without it, choose the newest valid pointed publication across all legacy variants, including lowercase.

Recheck verification: the 15 non-listening Store/Runner/PublicationApi tests passed. The two HTTP tests initially hit the sandbox's loopback `EPERM`; an approved loopback rerun passed both, for **17/17 focused tests passing**. Original fake repros now preserve `new a` after stale retry B, and pass `state: stale` for the failed child's retained explanation while both ancestors remain stale. No source edits or live provider calls.

## Final acceptance at `aad68c6`

**All four original P2 findings, including the legacy migration residual, are closed. No confirmed residual blocker remains in the reviewed scope.** The final correction gives only the digest pointer early precedence and selects the newest valid legacy publication across every case variant, with later durable rows breaking timestamp ties.

Re-ran the independent two-legacy-pointer reproduction: `actual` now equals the newer mixed-case publication. Re-ran `node --test apps/server/dist/operatorStore.test.js apps/server/dist/operatorPublicationApi.test.js`: **11/11 pass**, including tied timestamps, authoritative digest pointers, bounded filenames, migration, immutable publication/CAS and validation. This bounded correction changes only publication resolution and its regression test; prior source review and final browser evidence remain applicable. No source edits, paid calls, merge or deployment were performed by review.
