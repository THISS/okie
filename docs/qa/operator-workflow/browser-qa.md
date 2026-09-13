# Operator workflow browser QA

Date: 2026-09-13 (Australia/Brisbane). Real Chrome UI via supported CUA/Playwright browser APIs. Isolated web `localhost:4174`, server `127.0.0.1:4181`; all publications in temporary `.okie-review/operator-qa/data`. No paid model calls or real publication. No code edits by QA.

## Scope and fixture

Real local Okie static scan at commit `6adb56cde14d88457cfc2bad2e66fcc39735124e`: 3,574 entities, 10 containers, four tours. Authentication and model responses were deterministic test doubles. Root owns server lifecycle and full automated gates. Initial fake budget was exhausted; root increased the fake-only budget and restarted with the cached same-commit scan and local git-backed full-source fixture.

Run: `run-f8a81cf9-d33e-49be-81d1-bc777b6c51bd`.

## Verified through UI

- Anonymous `/operator` denies workspace access; `/new` provides request-only guidance and public atlas link. Fixture sign-in opens operator review; sign-out denies it again.
- Submitted `https://github.com/THISS/okie` using input and Start scan. Run reached `awaiting_review`; rev2 showed 1 accepted, 3,573 failed, named scopes, progress and token/cost ledger.
- Pinned draft preview opens the real atlas. Web, App component/symbol and atlas-protocol selection have nonblank inspectors. App symbol source excerpt shows lines 1330–1341 at the frozen scan commit.
- Overview tour played; jumped to web step3 and waited for `[data-playback-state="paused"]`. Public tour step5 similarly paused, with `WEBMCP_HOST_HEADERS` evidence and source lines48–51.
- Map zoom in/out, fit, canvas drag and minimap drag worked; camera URL coordinates changed after both pans. Architecture brief Mermaid expanded to a modal; diagram zoom worked.
- Initial failed-scope retry reported `operator enrichment budget reached`; a newer immutable rev3 appeared while rev2 stayed selected until Review newer revision. Rev3 retained one accepted scope and marked three ancestors stale.
- Incomplete Publish is disabled until acknowledgement. Acknowledged rev3 published as `publication-7e77f539-42f7-473f-9858-1c0b93b89024`; anonymous public atlas rendered matching brief, source and story.
- After fake-budget restart, durable run remained available. Retrying App accepted rev4 with explanation, role, source evidence and Mermaid. Retrying atlas-protocol accepted rev5. Reopening App confirmed its accepted explanation/evidence survived the other scope retry.
- Refresh5 stale ancestors completed at rev10: 8 accepted, 3,566 failed, zero stale. UI kept the earlier revision pinned until Review newer revision.
- Public page reloaded before second publication still showed the original deterministic brief. Rev10 published as `publication-40ff5bff-5258-4769-8f71-6ea5827a0a7b`; the already-open public page stayed unchanged until reload. After reload, App Details showed the exact accepted operator explanation, role, evidence and Mermaid from review.
- Public App Source Load more context expanded1330–1341 to1300–1371. Open source in a tab opened the source workspace with the frozen commit. Final sign-out denied operator review.

## Findings and limits

**Resolved after targeted browser recheck of `4857bb6`:** accepted operator explanations now appear in **Overview**. Public App and atlas-protocol each displayed the accepted summary, role, source evidence and expandable Mermaid; both diagrams opened successfully. Details retained metadata/relationships and no duplicate accepted explanation. Unenriched atlas-engine retained a useful nonblank fallback summary, parent, dependencies, dependents and children. No remaining blocker in the exercised workflow. Container/component Source unavailable messages are expected where no excerpt was captured; symbol excerpts worked. Initial sign-in before backend readiness produced Chrome ERR_BLOCKED_BY_CLIENT; normal reload after ready succeeded. Large-atlas loads intermittently exceeded the browser tool's three-second CDP/selector deadline; subsequent state reads succeeded.

The UI refresh action exercised was **Refresh5 stale ancestors** (all currently stale ancestors); no per-ancestor subset control was exposed in the tested view. This is fixture/browser QA, not live GitHub OAuth/model integration. Source full-context checks used same-commit local git fixture because the scanned local commit is unpublished. Auth denial was verified through the workspace UI; root's server tests cover direct API authorization. No recording capability was advertised by the connected browser, so screenshots were saved instead.

## Screenshots

- `draft-story.png`: paused web tour and inspector.
- `protocol-map.png`: protocol selection and map after pan.
- `expanded-mermaid.png`: expanded deterministic architecture diagram.
- `partial-publication.png`: first publication confirmation.
- `public-anonymous.png`: anonymous atlas.
- `public-story-source.png`: paused public story and source evidence.
- `refreshed-draft.png`: rev10 accepted App and zero stale coverage.
- `published-app-details.png`: published accepted explanation.
- `published-source-tab.png`: public source workspace.

- `published-app-overview.png`: corrected accepted App explanation in Overview.
- `published-protocol-overview.png`: corrected protocol explanation in Overview.

## Final review-fix QA (30796f9, in progress)

Existing run rev10 was reused. First AskAtlasIdentity retry accepted its fake enrichment but run then displayed `QA job failed`; no newer revision became reviewable. Root identified legacy/canonical repository identity mismatch and assigned a migration fix. Mutations paused pending restart. Existing public App Overview explanation and frozen source1330–1341 remained readable after that failure. Evidence: `final-retry-job-failure.png`, `final-preserved-public-source.png`. Conflict flow and newer-preview recheck remain pending.

After migration correction `c44a82d`, retry recovered the same run to awaiting_review and created rev11 while rev10 stayed pinned. Retrying again from rev10 visibly alerted `draft is no longer current`. Review newer revision opened rev11 with AskAtlasIdentity accepted summary, role, evidence19–23 and Mermaid. App sibling accepted explanation and source1330–1341 remained intact. Preview `draft-a0c94815-bc50-4d8e-8d83-40ab0d0176ac` displayed the retried server AskAtlasIdentity in Overview. No publication was performed. Screenshots: `final-stale-revision-conflict.png`, `final-newer-preview.png`.

Two residual status messages were reported: prior `QA job failed` stayed visible after successful recovery, and conflict alert stayed after Review newer. Root assigned status clearing fixes; final targeted recheck pending.

Final status cleanup recheck passed on backend `8ae120a` and web `0942e4b`: successful retry created rev12 while rev11 stayed pinned and removed the obsolete `QA job failed` message. Retrying from stale rev11 showed `draft is no longer current`; Review newer revision opened rev12 and cleared that alert (zero alert elements). Screenshot `final-clean-revision-review.png`. No remaining blocker in the final exercised flow; no new scan, publication, or deployment during this final review pass.
