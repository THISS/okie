# Section capability profiles — CLA-146

Status: independent Fable review and Grok recheck completed; final contract fixes
awaiting Grok recheck. **Experimental,
unexposed, not integrated, published, or Done**. No Start here / Ask UI or
authorization changes. Semantic usefulness is not established.

## Contract

`OperatorRunner.profile({runId, draftRevisionId, scopeId}, signal)` is an optional,
explicit scan-enrichment/scoped-retry operation. It uses the existing server-only
`createJevProvider` → `runOperatorJudgments` boundary. Ordinary scans make no new
calls. Missing source/commit returns `insufficient-evidence` without inference.

`readSectionProfile(store, {repositoryId, draftRevisionId | publicationVersionId},
scopeId)` reads an immutable pin, never a mutable current publication. Results are
`missing`, `stale`, `ready`, `invalid-scope`, or explicit `corrupt` / `unavailable` artifact failures.
Only an absent optional profile is clean `missing`; a missing snapshot is not.
An absent/invalid/non-section scope on a valid snapshot is a caller error
(`invalid-scope`), not snapshot corruption, on both read and run.
Unknown/cross-repository pins deliberately throw. Readiness uses the profile's
validated pinned model, not the process's default model. Authorization must happen before this server API;
a profile never grants access or establishes question-specific answerability.
Old/portable atlases without sidecars need no provider and remain unchanged.

Profiles are optional `section-profiles.json` artifact sidecars. Scanner facts and
portable atlas bytes are preserved. A successful judgment produces a new draft,
followed by a compare-and-swap profile draft; an interruption between them leaves
an accepted reusable judgment, not a fabricated completed profile. Retry reuses it.
Frozen publications retain their bytes. Explanation coverage is preserved.
Cancellation at profile promotion returns `cancelled`, not `conflict`; the
already accepted judgment may remain reusable. Missing manifest-listed bytes or
draft records return typed `unavailable`, and an inconsistent draft returns
`corrupt`, without writing an incomplete profile artifact.

**Accepted experimental fail-closed policy:** one malformed sibling row makes the
entire immutable profile sidecar `corrupt`, including reads/retries of otherwise
valid scopes. There is no row salvage or automatic repair. Recovery requires an
explicit new validated artifact/draft without the malformed data; original pins
are retained, never rewritten. This policy is deliberately not expanded here.

**Serial-per-draft caller contract:** await a result before profiling the next
section and use its returned draft revision. There is no scheduler. Concurrent
callers can spend a request and lose the draft compare-and-swap; they receive
`conflict` and must explicitly retry against the new draft. Winners and previously
accepted siblings are never overwritten. This is not a parallel scan API.

The versioned state contains identity/parent, captured commit-pinned source ranges,
observed relation kinds, candidate/selected/omitted/invalid/missing counts and
explicit limitations. Each range must match its entity's source ref and commit;
its line count and text must agree. No files are fetched by inference. At most six
source windows, 3,200 bytes each and 9,000 combined, enter the role candidate set.
Leading type declarations are deprioritized; remaining windows are sampled across
the scope rather than taking only its header. This is a bounded heuristic, **not
a guarantee of behavioral coverage**. Preflight conservatively sizes the full
foundation request, including inherited entity/relation/explanation inputs.
An oversized hub returns `oversized` with byte counts and a coverage limitation
before a provider call. The inherited 24KB cap remains unchanged and enforced;
there is no batch-name bypass. Preflight does not make large hubs supported.

Descendant profile identities are cache metadata, not semantic evidence; they and
the opaque scope digest are omitted from model inputs. Full scope/descendant input digests invalidate affected ancestors even when
changed evidence was omitted by the cap. Staleness is derived from immutable
inputs at read time, not by mutating ancestor records. An unchanged retry reuses
the existing profile without a provider. Accepted siblings are copied unchanged.

Six independent Choice judgments select a supporting candidate, `no_match`, or
`unknown`: dispatch, persistence, external interaction, validation, orchestration,
presentation. Independent selection permits overlapping roles; a single exclusive
taxonomy would not. Every distribution is retained. `inferred` currently requires
a selected candidate probability ≥0.8; this is a **provisional presentation policy**,
not calibrated accuracy. A no-match applies to captured evidence, not the whole
repository. Missing/failed provider results remain separate from semantic unknowns.

## Live evaluation, 2026-09-23

All requests were serial, no retries, with server-only `JEV_API`, pinned
`jev-1.13.0`, captured public source, and no labels/rationales sent to Jev. Initial
authorization was 100 requests / $1 estimated admission budget. **33 requests**
were made, reserving a conservative **$0.099 estimate** in aggregate. Reported
usage was **97,573 input / 11,127 output tokens**. Measured dollar cost was absent
and remains **unknown**. These labels are provisional engineering annotations,
not independent human adjudication. Confidence is not counted as correctness.

Raw reports, including failures and source text/ranges, are in
[`fixtures/judgments/cla146`](../../fixtures/judgments/cla146).

| Experiment | Requests | Result | End-to-end latency |
|---|---:|---|---|
| Existing foundation smoke | 2 | Model echo, strict probability validation, usage, known support and contradiction accepted | 160–296ms |
| Existing labelled baseline live | 8 | 8/8 live labels matched; 3 missing/stale cases correctly abstained in code | 101–228ms |
| Initial capability questions v1 | 9 | Development role precision 5/7, recall 5/6; held-out precision 1/4, recall 1/2 | 109–262ms |
| Revised v2 exploratory rerun | 10 | Development 6/6 precision/recall; former held-out 1/1 precision, 1/2 recall | 131–279ms |
| Actual pinned Okie quick scan, four components | 4 | All artifacts accepted; substantive role errors remain, described below | 294–559ms |

The baseline's synthetic equal-authority conflict was excluded from live input:
it is not captured public source. Its failure simulation remains synthetic replay
in CI. The existing replay score (development 4/6, held-out 6/6) is **not** the live
score. The baseline live split is development 6/6 and held-out 5/5 including code
abstentions, with one excluded synthetic case.

The initial profile run dropped Okie's valid validation excerpt under an overly
small byte cap and overcalled orchestration. The fix increased the per-window cap
within a combined cap, narrowed orchestration, and applied the provisional 0.8
policy. Since held-out results had already been inspected, the v2 rerun is
**exploratory**, not an independent held-out win. It still misses validation in
the test assertions. The wrapper, generated-data and missing-source cases do not
establish production behavior; v2 abstains on them.

Four prewritten routing tasks compared profile role probabilities with a lexical
path/source baseline. Initial profile recall@3 was **3/4 versus lexical 4/4**;
v2 was **4/4 versus 4/4**. These isolated component fixtures have no cross-component
edges, so graph expansion does not add candidates. This is a tiny candidate-recall
probe, not an Ask evaluation. It establishes **no retrieval improvement over
code**, and does not justify replacing lexical/graph routing with model-only
routing. Curated v2 evidence ID/range validity was 7/7 inferred roles; semantic
correctness is a separate question.

## Tangible actual-scan examples

The final experiment used `scanRepository` at PR #117's exact pinned head,
quick analysis, and the scanner's real component IDs and descendant excerpts.
No publication occurred. The scan's analysis metadata is retained in the report;
profiles explicitly do not imply runtime or full-language-analysis coverage.

| Actual section | Candidate windows used | Inferred roles and selected evidence | Limitation / failure |
|---|---:|---|---|
| `operatorEnrichment.ts` | 6/25 | validation .96, orchestration .80; lines 157–168 | Validation is visible; orchestration overstates a truncated setup/containment-check window. |
| `operatorRunner.ts` | 4/7 | dispatch .87, persistence .85; lines 53–64 | Evidence review finds overclaims: a factory/delegation and method names do not prove request entry or durable writes. Visible validation only scored .62 and was withheld. |
| `operatorStore.ts` | 6/13 | persistence .84 at 61–72; validation 1.0 at line 12 | Filesystem directory creation and explicit identifier rejection are visible. Full durable state-writing body is not captured here. |
| `mesh.rs` | 6/56 | presentation .86 and validation 1.0 at 816–827 | Geometry construction is visible. Guarding degenerate geometry was not labelled validation before inference; count the extra role as a disagreement, not silently relabel it. |

Independent Fable review supports **3/8 inferred roles strictly, or 5/8 with
lenient interpretations** of store filesystem setup and mesh internal guards.
The previous 4/8 assessment was the builder's retrospective interpretation.
Actual-scan recall is **not independently auditable and is not claimed**: a
contemporaneous commentary note existed, but was not an exhaustive committed
label fixture. Its exact text and provenance are preserved in
[`actual-scan-annotation-record.md`](../../fixtures/judgments/cla146/actual-scan-annotation-record.md).
All eight selected references were supplied, range-valid candidates: citation
validity does **not** imply role correctness. Only **22/101 available windows**
were selected. This is selection coverage, not useful-evidence recall. These
failures are precisely why downstream Ask must examine actual query evidence.

**Recommendation:** keep model inference experimental and unexposed. Deterministic
canonical state/coverage is useful infrastructure; semantic role usefulness is
unproven. All actual-scan windows were at most 12 lines. Bounded deeper inspection
was **not implemented**, and the windows are structurally inadequate for many
function/class responsibilities. No more live tuning was done in the review-fix pass.

Follow-on gates, **not completed by this task**:

1. Meaningful bounded function/class-body evidence capture with honest truncation.
2. Supported hub coverage/cost, not merely explicit rejection at the 24KB cap.
3. A fresh, independently labelled holdout committed before inference, with clear
   section-role definitions and genuine multi-window candidates.
4. Demonstrated benefit over lexical/graph routing before CLA-147/148 consumers
   rely on these roles. A confidence threshold cannot substitute for this evidence.

## Reproduce

Build server dependencies first: `pnpm exec tsc -b apps/server`.

```
node scripts/evaluate-jev-live.mjs --live --smoke --output=/tmp/smoke.json
node scripts/evaluate-jev-live.mjs --live --output=/tmp/baseline.json
node scripts/evaluate-section-profiles.mjs --live --output=/tmp/profiles.json
node scripts/evaluate-scan-profiles.mjs --capture --output=/tmp/capture.json
node scripts/evaluate-scan-profiles.mjs --live --output=/tmp/scan-profiles.json
```

These commands are opt-in and not ordinary tests. The source pins must exist in
the checkout for `git show` / committed-tree scanning. CI uses fake providers and
synthetic replay only. `sectionProfiles.test.ts` covers pin isolation, immutable
publication reads, ancestor staleness, replay, bounds, missing/stale/malformed
evidence, corrupt/non-array artifacts, unavailable providers/snapshots, hub limits,
runner forwarding, model identity, interrupted promotion, concurrent conflicts
without lost writes, invalid selections, and cancellation.

## Review-fix verification

- `GOMAXPROCS=1 NODE_OPTIONS=--max-old-space-size=1024 npm_config_workspace_concurrency=1 pnpm check`: passed.
- Server suite with `node --test --test-concurrency=1 apps/server/dist/*.test.js`:
  226 passed, including 14 profile tests and the runner/CAS/corruption regressions.
  The final contract pass reran both commands and added read/run invalid-scope,
  stage-two cancellation/fault interleavings, and malformed-sibling regressions.
- Unchanged package suites: architecture 125, scene compiler 125, web 1,045
  passed; serial scan suite 212 passed / one existing skip. Disposable fixture
  commits required command-local `GIT_CONFIG_COUNT=1`,
  `GIT_CONFIG_KEY_0=commit.gpgsign`, `GIT_CONFIG_VALUE_0=false` in this orb.
- `CARGO_BUILD_JOBS=1 cargo test --workspace`: 81 passed.
- Root `pnpm build` stalled at Vite chunk rendering in the 2GB orb and was
  stopped after roughly 17 minutes without progress. It is **not a passing gate**.
  The equivalent direct web build,
  `GOMAXPROCS=1 NODE_OPTIONS=--max-old-space-size=1024 node node_modules/vite/bin/vite.js build`
  from `apps/web`, passed in 22.53 seconds. No build flags or tests were weakened.

The first root test attempt failed on fixture signing and parallel Rust-analyzer
resource pressure; serial reruns above passed. These environment limitations are
separate from the unresolved semantic-quality follow-on gates.
