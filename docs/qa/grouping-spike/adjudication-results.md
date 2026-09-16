# Adjudication and integration

The independent Terra assessment identified a useful discriminant: a container
capability can own its fetching/lifecycle helpers, while an exported function or
test consumer alone does not establish an independent architectural boundary.
The model must compare alternatives using observed production interfaces and
retain an unresolved outcome when evidence cannot discriminate.

`grouping-adjudicate.mjs` implements a two-call experiment that reverses candidate
order, validates both retained partitions and all citations, and only emits a
candidate map if both evaluations select the same candidate. Deterministic map
validation and symbol/relationship preservation checks still apply. Emission is
not publication or automatic semantic approval.

## Observations

| Local adjudication directory | Evidence | Outcome |
| --- | --- | --- |
| `2026-09-13T22-52-26.127Z` | Original source slice, 100/110 relations | Combined source-viewing candidate once; unresolved on reversal |
| `2026-09-13T22-54-18.270Z` | All 110 captured relations plus endpoint descriptions | Combined source-viewing capability + minimap selected twice |
| `2026-09-13T23-02-32.544Z` | Story/camera slice, all captured relations plus endpoints | Four distinct components selected twice; reviewer-authored merge rejected |

Directories live under `.okie-review/grouping-adjudication/`. Complete evidence
means all **captured** relations touching the slice, not a guarantee of complete
program analysis. The first comparison's uncertainty about omitted consumers
was addressed by supplying the missing captured relations, not suppressing it.

The story alternative was explicitly reviewer-authored from Terra's suggested
partition and is recorded as `explicit-test-candidate` with its path/hash. It is
not represented as a scanner-model result. The selected four-component proposal
was model-generated. Story playback has catalog consumers; framing has
cross-feature consumers; camera animation exposes its own controller lifecycle.
Story focus remains a plausible narrower component. This is a useful negative
merge control, not universal proof of the rubric.

The story leaf experiment first rejected a misspelled relationship ID; its two
valid leaves were reused on retry. The later lead failed JSON parsing due to
trailing backticks. That failure remains recorded; no automatic repair was
treated as a valid original response.

## Production changes

Multi-file mappings already had deterministic validation, but enrichment lost
their ownership information at two boundaries:

1. Scope and packet construction kept only each component's first source path.
   They now retain all implementation paths and their bounded header excerpts,
   preserving the primary path compatibility field and code source references.
2. CLI packet emission and hosted provider packets used the unmapped base
   extraction. They now use the accepted mapped ownership. The immutable original
   extraction remains retained, and rejected maps preserve the original graph.

Regression tests apply a two-file mapping and verify both paths/excerpts and
code ownership in packets. A tarball-backed integration test checks that provider
packet IDs match final mapped extraction IDs and that rejected IDs never appear.

## Reproduction

```sh
node scripts/spikes/grouping-adjudicate.mjs --from <retained-probe-run> --complete-evidence
node scripts/spikes/grouping-adjudicate.mjs --from <retained-probe-run> --complete-evidence --live
```

The first command prepares only. Live calls require configured OpenRouter access
and authorization for the evidence payload. `--alternative <json>` explicitly
records a reviewer-authored test candidate instead of the second model proposal.
No tool credentials are included in saved payloads.

## Browser-discovered integration correction

Implementation links populated the inspector but used a generic framing route,
leaving the system-rooted parent rectangle on the canvas. Canonical Open inside
showed all 23 declarations across the three implementation files. The link now
uses canonical component-rooted code navigation, retains the requested declaration
through capped compilation and the cache key, and pushes inspector panel history
before preserving it during the drill. A 52-symbol/50-card regression covers
retention. Pinned App source fixtures were regenerated; the evidence hash is
`7a348fdd`.

Astra medium identified and verified fixes for three integration issues: CLI
packets must use the mapped pre-enrichment baseline rather than post-enrichment
regrouped output; the drill must pin the requested code node before compiling;
and it must preserve inspector Back history. No findings remained in that review. Browser QA subsequently found that resident
code targets bypassed the canonical path; that fast path now excludes code
declarations, and both resident/nonresident paths use the same retained drill.

Final stable-worktree gates passed: `pnpm check`, `pnpm test`,
`cargo test --workspace`, and `pnpm build`. An earlier full test invocation during
source edits failed the working-tree determinism tests; the stable rerun passed.
The final browser retest confirms all three implementation-file links now reveal
selected code cards and automatically display source. Inspector Back restores the
previous component overview but does not fully restore the prior map root; this
limitation remains explicit in the browser report. Full enrichment results and
semantic review gaps are recorded in [full-scan-results.md](./full-scan-results.md).
No changes are merged, and no scan is published.
