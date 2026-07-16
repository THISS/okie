# Deterministic-first ingestion and provenance

Status: proposed architecture boundary for repository ingestion, enrichment, review, and inspector presentation.

The byte-level reproducibility, identity, cache-domain, invalid-output, and release gates for this boundary are defined in [`ingestion-golden-tests.md`](./ingestion-golden-tests.md).

## Principle

Repository scans produce immutable, commit-pinned facts before any LLM is invoked. Deterministic extraction, graph construction, and validation are the source of record. An LLM may propose derived claims and author explanations, but it cannot overwrite observed facts, invent evidence, or silently promote its output into the canonical graph.

## Provenance classes

Every inspector claim has exactly one origin and retains references to the inputs that produced it:

1. `observed` — read directly from repository or configuration at a pinned commit: symbols, imports, call sites, manifests, routes, schemas, deployment resources, and ownership metadata. Store extractor name/version plus exact source references. Observations do not display a probability; they are either supported at that snapshot or invalid.
2. `inferred` — derived by a named deterministic rule or approved analysis from observed claims: containment, likely service boundaries, runtime relationships, or technology classification. Store rule/version, input claim IDs, source references, and calibrated confidence when the rule is probabilistic.
3. `ai-explanation` — model-authored wording that summarises observed and inferred claims for an inspector, story, or answer. Store model/provider, prompt-template version, generation time, supporting claim IDs, and review status. Explanation text is never evidence. Any displayed confidence describes supporting claims, not the truth of the prose.

The canonical storage model should represent claims independently from their presentation:

```ts
type Claim = {
  id: string;
  snapshotId: string;
  subjectId: string;
  predicate: string;
  value: unknown;
  origin: 'observed' | 'inferred';
  sourceRefs: SourceRef[];
  derivation?: { rule: string; version: string; inputClaimIds: string[] };
  confidence?: number;
};

type Explanation = {
  id: string;
  snapshotId: string;
  text: string;
  supportingClaimIds: string[];
  generation: { provider: string; model: string; promptVersion: string; generatedAt: string };
  review: { status: 'unreviewed' | 'accepted' | 'rejected'; reviewerId?: string; reviewedAt?: string };
};
```

## Pipeline and LLM constraints

1. Pin repository and dependency inputs to immutable revisions.
2. Run deterministic extractors and validate source paths, line ranges, identifiers, and graph references.
3. Materialise observed claims and deterministic inferences. Content-address or otherwise stably identify equivalent claims so unchanged facts survive rescans.
4. Select a bounded, redacted enrichment packet containing only necessary claims and source excerpts. Record its hash. Do not send secrets, ignored files, credentials, or unrelated repository content to a model.
5. Require structured LLM output that cites existing claim IDs. Reject unknown references, malformed output, ungrounded entities, and attempts to change observed values.
6. Store accepted model output as an explanation or proposed inference with generation metadata. It remains visibly unreviewed until a person or an explicit policy approves it.

An LLM failure, timeout, budget limit, or disabled enrichment must not block the deterministic snapshot. The product should publish the evidence-backed map first and enrich it asynchronously.

## Inspector UX

- Lead with a provenance badge: `Observed`, `Inferred`, or `AI explanation`.
- Observed facts show `Observed in source`, commit, file/symbol/lines, and extractor. Do not show a confidence percentage.
- Inferred facts show `Inferred from source`, the named rule in expandable details, linked evidence count, and `Inference confidence N%` only when calibrated.
- Explanations show `AI-authored explanation` and `Verify linked claims`. If a score is useful, label it `Supporting-claim confidence N%`; never `AI confidence` or `accuracy`.
- Empty evidence is an explicit warning, not a zero-confidence green state. Users can inspect the full derivation chain and open immutable source evidence from every derived claim.
- The default inspector remains concise: provenance, claim, evidence link, confidence qualifier. Model and rule metadata belongs in `How was this produced?`.

## Rescan, overrides, and review

- A rescan creates a new immutable snapshot. It does not mutate the prior snapshot or erase user overrides.
- Match claims using stable fingerprints. Mark prior claims `unchanged`, `changed`, `new`, or `no longer observed`; do not silently delete historical evidence.
- Recompute deterministic inferences when any input claim or rule version changes. Invalidate explanations when supporting claims change, disappear, or move below a review policy threshold.
- Carry an accepted explanation forward only when all supporting claim fingerprints and the prompt policy are unchanged; record that it was carried forward rather than regenerated.
- User corrections live as separate overrides with author, reason, and target snapshot range. Conflicts between an override and a new observation are surfaced for review.
- Review actions are auditable and reversible. Rejection prevents that explanation revision from being published but does not suppress its underlying evidence.

## Credit and cost boundary

Deterministic scanning, validation, and graph diffing are measured separately from LLM enrichment. Before spending credits, show the bounded enrichment scope and estimate. Cache enrichment by the hash of supporting claims, model, and prompt version so unchanged code does not consume credits again.
