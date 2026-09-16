# Hierarchical grouping prompt spike

Status: the reviewed Source Viewer mapping passed repeated complete-evidence
adjudication and a full unpublished enrichment run. Unconstrained parent proposals
remain unstable; this is a viable reviewed pilot, not universal automatic grouping.
See [full-scan-results.md](./full-scan-results.md),
[adjudication-results.md](./adjudication-results.md), and
[browser-qa.md](./browser-qa.md) for final coverage, limitations and UI findings.
Earlier experiments remain in [repeat-results.md](./repeat-results.md).

The standalone harness is `scripts/spikes/grouping-probe.mjs`. It consumes the
pinned full scan in `.okie-review/responsibility-components/` and reads source
from that exact commit with `git show`; it never substitutes working-tree code.

The sample contains sourceFetch.ts, sourceRequest.ts, SourceViewer.tsx, and
minimap.tsx. The minimap gives the owner a plausible separate responsibility;
there is no instruction forcing all four files into a component.

## Experiment

1. Four leaf calls identify each file's responsibility and evidence.
2. A parent proposes component membership, explicitly leaving unrelated paths
   unassigned. Every sample path must occur exactly once across assignments and
   unassigned paths; unknown/duplicate ownership rejects the proposal.
3. Repeat the same parent request to assess output stability. Exact JSON equality
   is a coarse metric; compare boundaries separately from names/prose manually.
4. Only after both mappings pass deterministic validation, ask the container lead
   to synthesize the partial slice while retaining uncertainty.

Calls are sequential, limited to seven with 16,384 output tokens each,
low reasoning effort, and a 120-second request timeout. Evidence is bounded to 100 relations, prioritizing
in-slice relationships, and two evidence references per supplied relation.
Omission counts are visible. Source is capped at 32,000 characters per file with
an explicit truncation flag. This is not a complete dependency inventory.

The current production owner prompt asks for summaries/diagrams, not component
membership. Its diagram gate verifies known endpoint IDs but does not establish
that every proposed edge has captured relationship evidence. This spike asks for
observed relation IDs instead. ID validation still cannot establish that every
sentence is entailed by its citation: that remains part of manual review.

## Execution and evidence

```sh
node scripts/spikes/grouping-probe.mjs
node scripts/spikes/grouping-probe.mjs --live
node scripts/spikes/grouping-probe.mjs --rust-slice --live
node scripts/spikes/grouping-probe.mjs --live --reuse-leaves .okie-review/grouping-spike-runs/<prior-web-run>
```

Build the existing scan/server packages first if their compiled APIs are absent.
The first command prepares inputs only. The second requires configured gateway
credentials and explicit authorization for the external payload. Outputs go to
ignored `.okie-review/grouping-spike-runs/<timestamp>-<mode>/`, including prompts, response JSON, usage,
input hashes, elapsed time, validation results, and candidate maps.
Reusing leaves validates identical input packets and records their source run and
original usage separately; only two parent requests and, if they agree, one lead
request are dispatched. The original leaf prompt version remains in its source
run. A disagreement stops before the lead. Rust selects four atlas-protocol files
instead of the default web sample and uses the same generic prompts and gates.

An offline replay plumbing check passed all seven stages with authored fixture
responses, including the component-map gate. Those fixture responses are NOT
model results and do not establish prompt viability. Replay output is separately
marked `replay-validation-only` under `.okie-review/grouping-spike-replay/`.

Two preparation issues were caught offline: unbounded analyzer diagnostics made
leaf packets too large, and snapshot-derived relationship kinds do not fit the
extraction gate. The harness now supplies a bounded coverage summary and validates
membership against the original extraction rather than reverse-converting the
snapshot.

## Full-scan decision

Before a full enriched scan, manually check every proposed boundary and cited
interaction, compare the repeated parent memberships, and assess whether the lead
preserves scope/uncertainty without inventing system-wide conclusions. Rejecting
everything or repeating the same vague grouping is not success. Report observed
usage/cost when returned; missing provider cost must not be represented as zero.
A full scan is not automatically launched by the harness.

## Offline guard verification

`node --test scripts/spikes/grouping-validation.test.mjs` passes three tests:
malformed/duplicate/invented membership and missing rationale; membership stability
independent of wording, IDs and ordering; and rejection of citations outside the
specific leaf packet. Explanations must explicitly carry uncertainties (which may
be an empty array), and leaves must provide a responsibility.

The seven-stage fixture replay passes these strengthened guards. Its summary now
reports normalized membership and pairwise grouping agreement, separately from
exact output equality. These are stability metrics, not architectural correctness
scores. The first live results do not yet establish stable architectural boundaries.
The v4 probe omits URL-bearing or otherwise sanitized source lines explicitly,
preserving line positions, rather than supplying syntactically corrupted code.
This is a conservative probe workaround, not a production sanitizer fix.
