# Atlas plugin planning evaluation

Use an installed package in a fresh host session. Record the package version, host, publication pin, current-code availability and actual outcome. Repository edits do not update a host's cached installation.

## Scenarios

| Request | Observable behavior to review |
| --- | --- |
| Plan cancellable Ask requests when closing the panel or changing maps. | Traces browser submission and server/retrieval boundaries; distinguishes cancelling fetch, ignoring stale responses and stopping server/model work; proposes observable race and cancellation checks. |
| Plan the same change with only the published Atlas available. | Calls the plan provisional, retains the immutable publication pin, and names current-code checks without claiming it inspected the current checkout. |
| Explain Ask with a diagram. | Clear prose remains useful without the diagram; diagram fits chat width; captured links are commit-pinned and contained within individual retrieved excerpts. |
| Plan work on an unpublished repository. | Reports unavailable publication instead of substituting another project or starting a scan. |

For planning, inspect whether the agent actually retrieved contracts on affected boundaries, followed relevant consumers, and distinguished observed implementation from proposals. Review prerequisite order and user-visible validation, rather than scoring for headings or particular wording. Lack of captured tests is not proof that tests are absent. Record blind spots rather than claiming exhaustive impact analysis.

## Version 0.1.2 validation

The skill and published manifest schema validators passed, and portable/personal archives were inspected against the four-file allowlist. The package adds planning guidance and a planning starter prompt, plus compact top-to-bottom diagram guidance.

An independent agent completed the cancellable-Ask scenario using the updated skill, all five public read-only MCP tools and the authorized checkout at `a06c78d0e22f3cfd1af23815093639fa99e03bc4`. It reused publication `publication-fd362d5c-bc5e-4a21-92ca-ca93462dc940`, frozen commit `9831775f5bbed310b771900225501be42b6d159e`. No scans, paid Ask, model gateway calls or repository mutations occurred during that evaluation.

Result: pass with publication-coverage limitations. The plan identified existing browser abandonment on close/account/Atlas identity changes, separated that behavior from proposed server/retrieval/model cancellation, and accounted for the readiness probe absent from the older publication. It proposed contract-first implementation order and controlled race/disconnect tests rather than reimplementing already-present UI aborts. It explicitly kept selection/Isolate behavior separate from repository/revision switching. These observations came from current-checkout inspection, not a claim that the published snapshot was current.

The two cited published client/server links matched their retrieved captured ranges (askAtlas.ts 818–865 and ask.ts 245–292). Component-level App/HTTP/gateway evidence was unavailable; the agent did not treat missing evidence as absent implementation or tests. This is not exhaustive evidence coverage or a guarantee that the proposed design is complete.

One usability issue emerged: broad subsystem searches were dominated by unrelated symbols. The skill now suggests narrowing to a returned container with rootEntityId or using a precise symbol. The existing metadata fix for missing atlasUrl remains undeployed. The existing personal ChatGPT plugin was updated to 0.1.2 through Upload new version on 2026-10-03, retaining one connected app and one skill. Its planning starter launched a fresh published-evidence-only chat: [Plan Ask cancellation](https://chatgpt.com/c/6ac08e79-1438-83ec-9fd1-562a9d27e6d8).

The host plan explicitly stayed provisional, named current-code checks, separated fetch abort from stale-result suppression and proposed backend cancellation, and addressed provider cost and shared-worker limitations. Its affected-contract table, implementation order and deferred-fake validation were actionable without claiming current-checkout access. All nine GitHub links matched an individual retrieved captured excerpt at the frozen commit. The proposed-boundaries Mermaid diagram rendered with readable top-to-bottom labels after it entered the viewport. Integration activity exposed retrieval summaries, not raw invocation arguments or an explicit skill-load trace. The response correctly reported no live atlasUrl. This validates the 0.1.2 host update and planning workflow; it does not establish deployment of the metadata fix or exhaustive coverage.

## Remaining work in the current CLA-339 goal

Brenton added these improvements to the current goal on 2026-10-03. Keep them tracked here and in CLA-339; the successful 0.1.2 planning test does not complete this remaining scope. Work in the following priority order, retaining read-only public access, immutable evidence pins, no embedded secrets, the existing merge/deploy flow and the five-open-PR cap. Documenting this scope does not authorize a production deployment.

| Priority | Improvement | Work and completion evidence |
| --- | --- | --- |
| 1 | Clickable visual Atlas links | Finish the metadata change already in PR #173. Verify configured-origin URLs across all five reads, then have the installed target-host workflow return a working visual Atlas link separately from frozen source links. Open that link and inspect the relevant published Atlas. Clearly retain `latest` versus the evidence publication pin. Local/unit validation exists; the live metadata and host-link check remain incomplete. |
| 2 | Better evidence coverage | Investigate why relevant caller and lifecycle paths were uncaptured or truncated in the planning test, including App, HTTP dispatch and gateway boundaries. Improve capture or bounded retrieval of the relevant contracts without treating larger excerpts as automatically better. Re-run a representative cross-boundary plan and verify its implementation claims against captured excerpts; retain explicit gaps and avoid claiming exhaustive coverage. |
| 3 | Freshness visibility | Expose the publication revision and publication time when recorded, with readable age/context in agent results. Distinguish a newer visual page from pinned evidence. Compare with an authoritative current revision only when available and authorized; otherwise state that current code has not been checked. Verify matching, differing and unknown revision/time cases without confusing publication time with commit time. |
| 4 | Focused retrieval | Improve discovery of subsystem entry points, callers and consumers using existing container scope and relationship reads before adding capabilities. Measure broad-query noise, relevant boundary coverage and tool calls on the same planning scenarios. Demonstrate fewer irrelevant results/searches without losing affected contracts; keep pagination, direction and incomplete relation coverage explicit. |
| 5 | Repeatable planning evaluations | Expand the scenarios above into a maintained evaluation corpus covering frontend lifecycle changes, server/retrieval boundaries, historical publications, missing evidence and unpublished repositories. Record unsupported claims, missed dependencies, citation validity, tool effort, current-code assumptions and whether proposed validation catches the intended failure. Establish a baseline before tuning and compare subsequent versions against it. Keep deterministic fixtures/checks in CI and perform installed ChatGPT/Codex host checks separately; no live OpenRouter in CI. |

Each item needs observable evidence and an updated result, not only more skill instructions or a green schema check. Keep CLA-339 In Progress until the remaining items are implemented and validated, or Brenton explicitly changes their scope. The host's activity summaries are not raw invocation traces. A reviewed PR and a live deployment are separate states; do not mark the visual-link rollout complete merely because its code is tested.
