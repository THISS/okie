# First live grouping probe

Pinned commit: `6a65b895f8a6f23c3da7f254734933ef64e72a71`.
Provider/model: OpenRouter / `z-ai/glm-5.3-flash`.
Decision: promising, but **not ready for production integration or a full scan**.

## Request accounting

Seven requests were authorized and dispatched. No additional requests were made.

| Run | Requests | Result | Reported USD |
| --- | ---: | --- | ---: |
| Default reasoning, 4,096 output tokens | 1 | Length limit; no JSON content | 0.00248465 |
| Reasoning disabled | 1 | HTTP 400: endpoint requires reasoning | Unknown |
| Low reasoning, 16,384 output tokens | 5 | Three leaves, parent, container lead passed structural gates | 0.01082543045 |

Known reported cost totals **$0.01331008045**, excluding any unreported cost for
the HTTP 400. These figures are observations, not a full-scan cost estimate.
Raw local evidence remains in `.okie-review/grouping-spike/`, with failed runs in
the sibling `grouping-spike-default-reasoning` and
`grouping-spike-reasoning-disabled` directories. They are ignored, not published.

## Architectural findings

The successful run combined sourceFetch.ts and sourceRequest.ts into one leaf,
then evaluated SourceViewer.tsx and minimap.tsx separately. The parent proposed:

- **Source Excerpt Viewer:** SourceViewer.tsx.
- **Source Data Access & Fetch Lifecycle:** sourceFetch.ts and sourceRequest.ts.
- **Scene Minimap:** minimap.tsx.

All four paths were assigned exactly once; IDs and cited relations passed the
deterministic gates. The parent correctly kept the minimap separate and noted
that the fetching/lifecycle files cooperate through SourceViewer rather than
calling each other. The lead preserved the partial-slice scope and uncertainty.

The source-viewing split is plausible but may be finer than the intended C4
feature boundary. A repeated parent was omitted to remain within the approved
request count, so stability is unknown. The prompt needs an explicit abstraction
criterion: user-facing responsibility and boundary, rather than merely grouping
implementation layers. We must not hard-code the expected grouping by filename.

Structural citation checks did not catch a leaf describing private clipboard
code as an exported helper. Public-interface claims still need deterministic
exposure facts and semantic review; known entity IDs do not prove prose truth.

## Source fidelity defect

`redactTokenizedUrls` normalized a GitHub URL template in the supplied
SourceViewer source, percent-encoding interpolation syntax and removing trailing
code. The model flagged the damaged template, and both parent and lead repeated
the uncertainty. Comparison with `git show` confirmed the repository source was
intact. The source-fetch endpoint description also suffered from transformed input.

The v4 standalone probe conservatively omits complete URL-bearing or sanitized
lines and records their original line numbers. Prompts explicitly prohibit
interpreting omissions as code defects. Secret scrubbing remains enabled. This
workaround sacrifices some URL behavior evidence; production source-aware
sanitization remains unresolved. The next run must retain that limitation.

## Next bounded experiment

Seven requests on the same four pinned files: four independent leaves, two
identical parent requests, one lead. Use low reasoning and the revised omission
metadata. Compare normalized boundaries separately from names and prose, review
export/interface claims, and ensure sanitized-source uncertainties do not become
repository findings. This requires renewed authorization because the original
seven-request allowance has been consumed.

Only after this slice is accepted should we expand to another language/area,
implement the minimal production path, and evaluate a full unpublished scan.
The broader active goal remains unfinished.

## Local verification

Six standalone tests cover membership validation, evidence packet boundaries,
stability comparison, source omission, and preservation of unaffected code.
The mapping gate additionally verifies that symbol facts and anchors are unchanged
apart from parent ownership, and that every observed symbol-to-symbol relation is
preserved exactly, including its evidence. This does not claim file-level edges
retain their old IDs: those are intentionally aggregated by the existing mapper.
The revised harness also passes the seven-stage authored-response replay. This
checks plumbing only; replay does not establish model quality. No production code
was changed, no new PR was opened, and no scan was published.
