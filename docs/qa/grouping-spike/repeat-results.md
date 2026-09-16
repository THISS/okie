# Repeated live probes

The user authorized further probes as needed after the initial seven-request
allowance. All results remain local and unpublished. No production code changed.

| Run directory suffix | Prompt | Fresh calls | Result |
| --- | --- | ---: | --- |
| `2026-09-13T22-39-50.897Z-live` | v4 web | 7 | Both parents chose four singleton components; structurally valid, insufficient abstraction |
| `2026-09-13T22-41-58.593Z-live` | v5 web | 7 | Still file-oriented; lead rejected for out-of-packet App entity citation |
| `2026-09-13T22-42-57.276Z-live` | v5 Rust | 7 | Both parents chose geometry, scene, patch, timeline; valid mapping |
| `2026-09-13T22-44-56.972Z-live` | v6 web | 3 | Reused v5 leaves; parents disagreed: three vs four components |
| `2026-09-13T22-46-39.051Z-live` | v7 web | 2 | Reused v5 leaves; two vs four components; stopped before lead |
| `2026-09-13T22-48-33.215Z-live` | v8 web, temperature 0 | 2 | Same two-vs-four disagreement; stopped before lead |

Directories are under `.okie-review/grouping-spike-runs/`. The v6 comparison has
pairwise agreement 5/6, but this conceals the only meaningful candidate merge
changing between repetitions. It is not sufficient acceptance evidence.

## Manual semantic findings

- v4's lead said sourceContextIsLoading delegates to the controller factory.
  Its cited `uses` edge is a ReturnType reference; actual code calls isPending.
  v5 explicitly distinguishes type references from invocation evidence.
- v4 returned one leaf in Chinese; v5 explicitly requests English prose.
- v5 conflated grouping with dependency inference: it argued merging helpers
  would assert an unobserved relationship. v6 explicitly separates the two.
- v6 used a test consumer mentioned in a comment to justify a separate component.
  Tests do not by themselves establish an architectural boundary. Its repeat
  admitted the helper could instead be internal, but still chose a singleton.
- Existing scanner `kind=component` records represent files. That legacy naming
  may anchor proposals to files; v7 explicitly distinguishes evidence IDs from
  accepted architecture and disallows test use as independent-consumer evidence.
- Rust boundaries are more credible: scene validation, patch application, and
  timeline validation expose different entry points to the engine, with shared
  geometry types/helpers. This is a positive cross-language observation, not
  evidence of multi-file discovery. Some prose still loosely says consumers
  “call” types, despite later qualifications that type uses are not calls.

The v5 web lead's rejected ID was `code:apps-web-src-app-tsx:app`: a real external
entity mentioned through relation endpoints, but absent from its allowed facts.
The gate correctly rejected an out-of-packet citation. A future packet builder
should deliberately include bounded external endpoint descriptions when needed;
it must not silently accept arbitrary IDs merely because they look familiar.

## Expansion decision

No full scan yet. Stable all-singleton proposals do not meet the user's goal of
coherent architecture above file granularity. The current prompt also allows
global caveats to coexist with overconfident individual claims. Production
integration should wait for credible, repeatable groupings and claim grounding.

v7 adds a harness gate: disagreeing parent boundaries retain their proposals and
stop before lead synthesis. v6 did call a lead using the first proposal despite
the disagreement; that output is retained as experimental evidence, not accepted
architecture. v7 produced the desired three-file source-viewing capability once,
then four singletons on repeat. It stopped before lead synthesis as intended.
An offline replay with intentionally differing parent proposals also stopped
without a seventh request, exercising this gate end to end.

Across these five runs, 26 new requests reported $0.0744187456. Including the
earlier allowance, known reported cost was $0.08772882605, with one earlier HTTP
400 still carrying unknown cost. These are measured values, not budget estimates.

A final v8 parent-only comparison used temperature zero with the same prompt and
reused leaf evidence. Both requests had 23,049 reported input tokens and identical
payload hashes. It again produced two versus four components. The provider was
sent temperature zero; this does not prove the endpoint's execution deterministic.
These two requests reported $0.00323210, bringing this phase to 28 requests and
$0.0776508456, and all probe phases to 35 requests with $0.09096092605 known cost
(plus the earlier HTTP 400's unknown cost).

## Remaining work toward the active goal

The interpretation stage needs an explicit review/adjudication contract for
ambiguous boundaries, not repeated attempts until one desired answer appears.
Candidate alternatives should retain evidence and explain the architectural
level of each boundary. A parent needs the container's intended responsibility
and consumer context to choose between implementation layers and capabilities;
testability alone is not a sufficient criterion. The next experiment should
evaluate that decision process against both retained alternatives, then repeat
it on another area before any production integration or full scan.

The broader goal remains incomplete. Terra delegation was attempted but the
agent thread limit prevented dispatch; no independent agent review or browser
QA is claimed. There were no production or user-flow changes requiring browser
acceptance in this phase. All probe processes recorded above are terminal.
