# Integration assessment

This is an implementation assessment, not a claim that the live spike is accepted.

## Existing paths

`apps/server/src/enrichment.ts` has the older extraction-envelope prompt. It
explicitly forbids regrouping files and requires scanner component IDs unchanged.
It is unsuitable for accepting ownership proposals directly.

`apps/server/src/operatorEnrichment.ts` is the hierarchical runtime. Its
`coordinatorBody` assigns existing direct descendants; `bodyFor` explains a scope
after its children finish. Neither can propose component membership. Its owner
validator checks evidence references, but diagram edges only need known endpoint
IDs, which does not establish captured relationship evidence. Missing child
results are supplied with their state, while uncertainty has no dedicated output
field. The default 4,096 output-token ceiling also reproduced a failure in the
live spike with this reasoning model; model execution settings need separate
consideration from semantic prompt changes.

`apps/server/src/operatorRunner.ts` builds scopes from the scan snapshot, with
each entity's own source references as allowed evidence. Parents receive child
explanations but cannot directly cite child entity references through that narrow
allowlist. Relation facts contain IDs/endpoints/kinds; source evidence on those
relations is not carried into the scope packet. A grouping owner will require a
bounded packet containing child identities, interfaces, paths and observed
relationship evidence rather than this existing packet unchanged.

`packages/scan/src/component-map.ts::applyComponentMembership` is the existing
deterministic application seam. It validates explicit ownership, reparents code
without changing code IDs or source facts, and aggregates file-level edges.
Internal file-level edges disappear in the projection; the original extraction
must remain available as evidence. Symbol-level relations remain intact. The
CLI already supports `--component-map` with provenance reporting.

## Smallest viable sequence, subject to live results

1. Preserve the original deterministic extraction as immutable evidence.
2. Explain bounded file/symbol areas; supply parents with accepted explanations
   plus explicit failed/omitted areas and the corresponding deterministic facts.
3. Treat membership as a separate proposed document with prompt/input/output
   provenance. Validate exact coverage of the proposed scope, unique ownership,
   evidence references, and the existing map gate. Keep uncertain files explicit.
4. Apply the accepted mapping to a derived extraction, then rebuild enrichment
   scope ownership from that derived structure before parent synthesis. Do not
   mutate scopes mid-traversal or reuse explanations under silently changed parents.
5. Keep original facts, derived map, explanations and gaps in an unpublished
   review artifact. Invalid proposals retain the original graph and a failure.

The diagram-evidence gate and richer parent allowlist are separate correctness
requirements; accepting a membership map must not implicitly authorize invented
calls or turn inferred prose into deterministic facts. Stable grouping across a
repeat and another area is still required before selecting the production change.
