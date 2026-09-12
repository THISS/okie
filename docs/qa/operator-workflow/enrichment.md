# Hierarchical enrichment QA

`operatorEnrichment.ts` receives a deterministic containment tree and never mutates its facts. Each accepted explanation is persisted as an immutable version with an input hash, evidence references, attempt and model provenance. The draft may point at the current accepted version; a frozen publication must copy the version IDs it selected and must not follow that mutable pointer.

The runtime visits children before their parent synthesis. A parent prompt contains each child’s accepted explanation or its terminal failed/missing state, so a partial parent can explain a gap without inventing coverage. Gateway calls are bounded by node, task, depth, concurrency, token and measured-cost limits. Usage is reported before parsing, including malformed billed replies.

Targeted retry passes `retryScopeId`. It records a new attempt only for that scope, preserves any previous accepted explanation when the retry fails, and marks all ancestors stale. A caller passes `refreshStale: true` to deliberately resynthesize those ancestors. Optional diagrams are structured entity references (`nodes` and `edges`), validated against deterministic entity evidence; the UI renders Mermaid later. Invalid diagrams retain the accepted prose with a diagnostic.

The focused fake-gateway check is:

```sh
node node_modules/typescript/bin/tsc -p apps/server/tsconfig.json
node --test apps/server/dist/operatorEnrichment.test.js
```

It covers nested dependency ordering, concurrent sibling completion, failed retry/stale handling, malformed output with captured usage, invalid delegation, evidence rejection, large-inventory task-limit gaps, configured request model/output cap, unavailable gateways, UUID attempt IDs, and invalid diagram references. It makes no live LLM request.

## Durable binding required from CLA-132

Implement `OperatorEnrichmentStore` with transactional writes for attempts and explanation versions. `putAcceptedExplanation` writes an immutable version and only then updates the draft-local current pointer. `markStale` must survive restart. Bind `onUsage` to the global spend ledger, `admitRequest` to an atomic global/per-run reservation, and `cancelled` to the durable run cancellation state. The gateway is the existing OpenRouter-compatible client/configuration, including its locally resolved model ID; every request carries that model and a 4096-token output cap; role prompts never select a vendor/model.
