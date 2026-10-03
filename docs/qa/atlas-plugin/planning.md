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

## Evidence coverage baseline experiment

A deterministic quick self-scan of commit `43bcaaaf17cc60d669e4489571620d2594f79516` produced 6,785 entities and 6,479 recorded call-site evidence locations inside their caller declarations. The experimental scanner retained the entry excerpt plus up to three additional bounded windows around recorded outgoing calls. The baseline below uses the same graph with only each entity's entry excerpt, so graph changes do not confound the comparison.

| Measure | Entry excerpt only | Four-window prototype |
| --- | --- | --- |
| Recorded call-site locations inside a captured caller excerpt | 4,787 / 6,479 | 5,813 / 6,479 |
| Serialized snapshot bytes | 17,008,164 | 17,985,299 |
| `createHandler` → `answerAskQuestion` call at line 347 | Not captured | Captured |
| `App` → `submitAskQuestion` call at line 5234 | Not captured | Still not captured |

These are static evidence-location counts, not runtime/test coverage, completeness of the scan, or installed-host results. The quick scan does not establish full language-analysis coverage. The extra serialized size is 977,135 bytes (about 0.93 MiB); it is below the current 64 MiB edge snapshot-read limit for this repository, not proof that every repository fits.

The prototype demonstrates a useful improvement but is not ready to claim the planning-evidence goal complete: its first-call-site selection spends the window budget near the start of a large caller. The next iteration must support useful late-call-site evidence under explicit capture and response budgets, with deterministic selection and a way for an agent to reach the relevant captured window. Public reads must continue to use frozen captured data rather than silently fetch uncaptured source. File-level aggregation and omitted windows must remain explicit. Do not open a PR for this slice until the corrected behavior passes the required gates and running-app exploration.


### Bounded call-window iteration

Using the same committed input and quick-scan graph as the baseline, capture of recorded call-site locations rises to **6,363 / 6,479**. The snapshot is **18,649,175 bytes**, an increase of 1,641,011 bytes (about 1.56 MiB) over entry-only capture. `App` has 88 captured windows; selecting its recorded Ask call at line 5234 returns **5226–5273**. Selecting the server `createHandler` call at line 347 returns **325–372**. Default public evidence responses still return at most eight windows; optional repository-relative `sourcePath` and positive `sourceLine` select later stored windows.

Capture is limited to 128 windows / 512 KiB of serialized excerpt records per code entity, plus an 8 MiB snapshot-wide budget for additional windows. Entry windows are preserved even after budget exhaustion. The tests cover late-window retrieval, omitted lines, invalid selectors, token redaction, deterministic relation ordering, UTF8 budgets, normalization and pinned public excerpt packs. Remaining missing locations and file-level aggregation are unresolved; this slice does not complete the overall evidence-coverage or planning-evaluation goal. No existing publication is rescanned or changed automatically.


Validation for this iteration (2026-10-03): `pnpm check`, `pnpm test`, `cargo test --workspace` and `pnpm build` passed using Homebrew Git. Focused scanner/query tests passed 31/31; edge public-read/MCP/HTTP tests passed 24/24. Owned local ports 4316/4317 were used for running-app exploration: agent-reference inputs and production endpoint, guided story jumped to step four and awaited `data-playback-state="paused"`, populated inspector and source tab, explicit Architecture model selection, relationship inspection, and `/new`. No scan fixture was present for the conditional `?fixture=scan` check. The plain-text reference navigation was blocked by Chrome; its updated contents were checked on disk. Late-window behavior is verified through deterministic scanner and R2-backed edge tests, not an installed-host claim. Screenshot artifacts are `/tmp/atlas-evidence-browser-qa.png` and `/tmp/atlas-evidence-tool-reference.png`. Production and the installed plugin were unchanged.

## PR 174 section-profile review correction

Section profiles now sample one valid captured window per original source reference, preserving the scanner's entry-first ordering. Supplemental call-site captures no longer weight a busy declaration more heavily than other declarations; legacy entities with distinct source references still retain separate candidates. A regression with ten members and sixty extra captures on one member preserves the original six-member sample. All sixteen section-profile tests passed.

`scopeDigest` deliberately still includes all captured evidence, including omitted windows: this preserves conservative cache invalidation, as required by the existing omitted-evidence regression. Extra capture data can therefore invalidate a profile even when its bounded semantic evidence sample is unchanged. No live Jev request is needed for the regression.

## Publication freshness iteration

The agent read service now returns recorded snapshot and operator publication timestamps separately, with an observation timestamp, numeric publication age and readable context. Missing/invalid dates remain unknown; a future recorded publication date does not become a zero-age claim. Pinned reads compare the requested publication version with the valid public store latest pointer. Listing results leave that comparison unknown rather than infer it from the mutable index. Every result states `currentRepositoryRevision: not-checked`: no upstream HEAD, live source or commit-time fetch is introduced.

The comparison is between publications, not evidence that upstream code matches. Directory cursor hashes retain recorded identity/time changes but exclude clock-dependent ages, so pagination survives time passing. Deterministic tests cover matching/differing/unknown latest versions, recorded/missing/malformed/future times, scan/publication separation, timezone normalization, every read type, and cursor behavior. This is implementation progress on priority 3, with installed-host validation still required after the reviewed rollout; the production hold remains in force.


Freshness iteration validation (2026-10-03): all required gates passed (`pnpm check`, `pnpm test`, `cargo test --workspace`, `pnpm build`); focused edge freshness/read/MCP/HTTP tests passed 30/30. Running-app exploration on owned ports 4316/4317 read the freshness reference, followed its directory link, jumped the guided story to step four and awaited paused state, opened the frozen source tab, selected Architecture model and confirmed a populated inspector, and navigated `/new`. No scan fixture was available. Screenshot: `/tmp/atlas-freshness-browser-qa.png`. API semantics were verified using deterministic public R2 fixtures; no installed-host freshness claim or production deployment is made. Existing stack PR #173 and #174 CI are green; #174 is position 2 in GitHub stack #175.


Timestamp semantics correction: the deterministic scanner intentionally derives `generatedAt` from the pinned commit’s committer date. Results now include `generatedAtContext` rather than label it a verified scan instant. Publication age still depends exclusively on recorded `publishedAt`. Historical forward-test prose that called `generatedAt` a scan time must be read with this correction; no current repository timestamp was checked.

Freshness review follow-up: publication manifests and index rows now record optional `snapshotGeneratedAt` explicitly from the snapshot, preserving the legacy landing reader’s `generatedAt` fallback separately. Agent listings trust only that explicit provenance; old rows and snapshots without a timestamp remain unknown. Pinned reads still take their timestamp directly from the snapshot. An existing but malformed, oversized, truncated or unreadable latest pointer leaves comparison unknown while intact pinned reads remain available; a missing pointer still disables those reads. Focused freshness/read/MCP/HTTP tests passed 32/32, publisher tests passed 29/29, and edge/server typechecking passed.
## Focused retrieval / plugin 0.1.3 iteration

The package now recommends finding an entry point before expanding a large owner, interpreting incoming/outgoing calls from their endpoints, discovering module/container scopes before using their IDs, and requesting captured call-site windows when schemas support source selectors. It explicitly investigates HTTP dispatch between a client POST and a worker. Older schemas retain ordinary evidence reads and explicit gaps. Freshness guidance treats `generatedAt` as a recorded snapshot timestamp, not proof of scan/commit time; publication age uses only `publishedAt`.

A controlled discovery comparison on the same quick-scan graph at `43bcaaaf17cc60d669e4489571620d2594f79516` found two known entry points (`submitAskQuestion`, `answerAskQuestion`). Broad `Ask` pagination took 9 reads and returned 180 rows (178 non-target rows); precise-name searches took 2 reads and returned 2 rows. Both incoming-call relation lists fit one page, identifying App at line 5234 and createHandler at line 347; targeted evidence returned 5226–5273 and 325–372 respectively. This comparison assumes the symbol names are already known, excludes their discovery cost, and counts non-target rows rather than judging every other row useless. It is not a whole-plan or installed-host speed claim.

Three independent evaluations used an isolated offline five-tool public projection, without reading current code, underlying snapshots, prior reports or live endpoints:

- First cancellation plan: 21 successful reads (8 searches), 7/7 source citations fit retrieved windows. It reached the late App call but missed HTTP dispatch and admitted a guessed scope ID. Those gaps motivated module discovery and intervening-boundary guidance.
- Fresh rerun of the same request: 34 successful reads (14 searches), 12/12 citations fit retrieved windows. Captured contracts included App, transport, panel props, map reset predicate, HTTP dispatch, answer orchestration, worker admission/run/release and the gateway factory. It kept actual map handlers and gateway signal support unresolved, distinguished existing guards from proposals, and proposed fake race/disconnect/accounting checks. Broader coverage required more reads; no whole-plan tool-effort reduction is claimed.
- Timestamp/readiness check after the metadata correction: distinguished snapshot timestamp from verified scan/commit time, kept publication age/latest comparison unknown and current revision unchecked, and refused exact-edit readiness from the historical evidence. Its single captured citation fits the returned App close-callback window. The earlier two reports called generatedAt a scan time; that interpretation is a recorded evaluation issue, corrected in #176 and the final skill.

The measured results and citation audits are retained in [focused-results.json](./focused-results.json). Full traces/reports remain at `/tmp/atlas-plugin-focused-eval/`; they are fixture evidence, not host invocation traces. Portable and personal 0.1.3 archives retain the four-file allowlist, unchanged public read transport and no embedded authentication; schema and skill validators passed. The installed ChatGPT package remains 0.1.2. Target-host update and post-rollout validation remain pending; this iteration does not complete the whole CLA-339 goal.


0.1.3 validation after rebasing the timestamp correction: `pnpm check`, `pnpm test`, `cargo test --workspace` and `pnpm build` passed. Local browser exploration on owned ports 4316/4317 jumped the guided story to step four and awaited paused state, followed a caller-to-target relationship, explicitly selected the target with a populated inspector, opened its frozen source, checked `/new`, and read the corrected timestamp reference. No scan fixture was present. Screenshot: `/tmp/atlas-focused-browser-qa.png`. These browser checks exercise the local application; the final skill was evaluated independently against the offline projections, and the installed target-host update remains pending.
