# Responsibility-based C4 components

Goal branch: codex/responsibility-components, based on main6a65b89. User authorized a new goal and delegation; no new publication, push or merge is authorized.

## Product direction

C4 already defines components as related functionality behind an interface, potentially implemented across several files. Okie's scanner currently approximates each file as a component. Replace that limitation through an explicit, validated mapping first; do not relabel arbitrary folders as architecture. Containers retain their runtime/deployment meaning. Code and source evidence stay traceable to the original immutable scan.

References: https://c4model.com/abstractions/component and https://c4model.com/diagrams/code.

## Delivery sequence and ownership

1. Terra component_contract: inspect model, extraction, portable and enrichment contracts; propose the smallest compatible mapping, code membership, shared-code handling, aggregated relation evidence and stable identity contract. Root approves the technical contract before parallel implementation.
2. Coordinator: remaining published-route blank-card regression and fix. Additional builder dispatch was refused by the agent thread limit. Avoid unbounded rendering and moving nodes on pan; cold restore must use a coherent scene/lens/camera and visible omissions must not masquerade as unnamed nodes.
3. Scanner integration: explicit mapping input, validated before applying, deterministic stable component IDs and evidence-derived relationships. Preserve old artifacts/links and a truthful no-mapping fallback. Implement after contract agreement.
4. Inspector/navigation integration: coherent component summary, implementing files/source and code navigation; source files remain evidence even when membership crosses file boundaries. Add a reviewed Okie web example grounded in actual responsibilities, not folder names alone.
5. Astra low QA: exact published snapshot722ea2862304 cold web URL, zoom reversal, pan, minimap, readable/selectable cards, plus mapped multi-file components and code/source navigation. Also guided story paused state and related routes. No file chooser automation: it previously stalled; use the packaged artifact path for new examples and the actual published URL for the regression.
6. Astra medium independent review follows implementation, required checks and browser QA. Resolve findings and rerun relevant checks. Required gates: pnpm check, pnpm test, cargo test --workspace, pnpm build and pinned fixture generation when affected.

## Known regression evidence

The current published route at localhost4173 reproduces blank card outlines; selecting one chooses the web parent. A zoom-out/back cycle removes the outlines. The merged compiler fix is served and the server supplies all79 named web children. Probe output at /tmp/okie-published-probe.json compares canonical root compilation (79 child objects but only10 component-band representations) with focused web compilation (50 component cards and29 reserved rectangles drawn by their parent). App boot initializes the visible scene from canonical root while separately validating restored lens state against a focused scene. This is a hypothesis to lock with a failing regression, not proof that one line alone fixes it.

## Boundaries

Automatic architectural clustering, live paid enrichment, revision comparison and multi-repository maps are follow-ups. Existing enrichment should gain a documented path to propose evidence-backed mappings, not silently rewrite deterministic facts. No stored published artifact will be mutated to mask a renderer defect. Large counts need stable layout and bounded visible rendering; performance claims require evidence rather than static screenshots.

## Implementation result

The explicit component slice is implemented locally. See
[contract](component-contract-proposal.md),
[reviewed example](../examples/okie-component-map.md), and
[validation](../qa/responsibility-components/results.md).

The root-only reservation change was insufficient. The successful targeted fix
filters omitted component reservations from parent-owned rendered primitives in
focused compiles as well, retaining their layout occupancy. Exact-route browser
retests passed. Cold/warm parent styling/representation equivalence remains a
separate zoom follow-up; this slice does not claim universal smoothness.
