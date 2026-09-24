# Optional server-side judgments (CLA-144)

`createOperatorRunner(...).judge(request, signal?)` is an **explicit server-only**
execution seam for a bounded batch of Choice questions. There is no automatic
scan sweep, new HTTP route, UI, semantic acceptance policy, or publication action.
The scanner still owns facts; GLM still generates explanations. This does not
implement claim review, capability profiles, or the other CLA-145–150 consumers.
Ordinary code must handle exact lookup, validity, permissions, evidence presence,
commit freshness, and known mappings before calling this seam.

## Provider and credentials

- Uses `@typesafe-ai/sdk` **0.6.0**, `TypeSafeClient.systemOne`, not chat completion.
- Only the server reads **JEV_API**, passed explicitly as `apiKey`. Absence means
  unavailable, not a negative semantic answer. `judgmentProvider: null` disables
  calls even when a key is present; tests inject a fake provider/SDK transport.
- Endpoint is fixed to `https://api.typesafe.ai`; model is pinned to
  `jev-1.13.0`. SDK environment defaults cannot redirect the key or enable logs.
  SDK retries are disabled: every actual call must have its own durable attempt
  and budget reservation. Retry by invoking `judge` again against the current
  draft, not by enabling hidden SDK retry loops.
- Credentials remain in a closure. Errors are fixed failure codes, never provider
  text, request bodies, SDK errors, or causes. Structured state redacts secret
  fields, configured credential values, GitHub tokens, and tokenized URLs. This is
  not general-purpose DLP: callers must supply only bounded public scan evidence
  and approved non-secret inputs. Do not use this API to send private payloads.

Live documentation read on 2026-09-19:
[index](https://docs.typesafe.ai/llms.txt),
[JS SDK](https://docs.typesafe.ai/sdk/javascript.md),
[HTTP API](https://docs.typesafe.ai/api.md),
[Choice](https://docs.typesafe.ai/primitives/choice.md),
[models/pricing](https://docs.typesafe.ai/models.md), and
[citation cookbook](https://docs.typesafe.ai/cookbooks/citation_check.md).
The SDK's installed declarations were also checked. No cookbook accuracy or
confidence threshold is treated as Okie's measured quality.

## Durable ownership and limits

One invocation batches 1–8 independent questions (2–8 options each) over the
same captured scope and explicit `inputs`. The scope's entity, relations,
explanation and stale metadata come from the selected immutable artifact, not
mutable store explanation pointers. Total redacted request bytes must be at most
24,000. Oversized state is rejected rather than silently dropping evidence.
A dependent stage supplies fresh `inputs`; it cannot see another question's
answer implicitly. Answer option IDs, full normalized probabilities and reported
confidence are retained. Confidence is not correctness; consumer policy belongs
in code and needs evaluation.

The existing `OperatorStore` owns `kind: judgment` attempts. Their scope identity
is `judgment:<hash(scope,batch)>` so explanation status/coverage and GLM retries do
not mistake them for explanation attempts. Existing recovery marks interrupted
attempts; explicit retries preserve successful unrelated artifacts.

The existing durable `budget.reserved`/`budget.settled` ledger admits before I/O.
It now supports optional concurrent-request and dollar reservations; existing
callers retain their defaults. Defaults for this seam, configurable through
`OperatorRunnerDeps.judgmentLimits`, are 4 requests, 300,000 total tokens, $0.02,
2 concurrent requests, and 10 seconds per request. Judgment events carry
`kind: judgment`; these defaults count judgment requests across the run, not GLM
history. Unscoped ledgers (including existing enrichment admission) still count
every event, preserving their aggregate limits. Retries never reset budgets.
Concurrent excess is returned as `limit`, not queued by a second scheduler.
Reservations link to durable attempts: recovery's interrupted state releases
only concurrency, while unknown token and dollar reservations remain charged.

Each admitted call conservatively reserves 81,920 tokens (documented 65,536 input
context ceiling plus 16,384 bounded typed output allowance) and $0.003 (rounded up
from the documented $0.042/M input-token price). System One has no documented
`max_tokens` parameter, so none is invented. These are admission safeguards,
**not a provider-enforced billing guarantee**; price/context changes need a
reviewed model/budget update. Unknown cost retains the dollar reservation, not a
fictional measured zero. Missing token usage retains the token reservation.
Actual reported token counts and optional `usage.cost_usd` are recorded even when
answers fail validation or a non-2xx response carries usage. Current TypeSafe
responses normally report tokens only, so cost remains explicitly unknown.
An interrupted reservation remains conservative across restart.

This aggregate safety has an intentional cross-provider consequence: three
judgment failures with no reported usage retain 245,760 tokens, exceeding the
default GLM run budget of 200,000. Subsequent GLM retry/refresh on that same run
can therefore be refused even though judgment admission has its own scope.
Recovery frees concurrency, not potentially billed usage. Do not erase events,
assume failures cost zero, or bypass the aggregate cap to resume enrichment;
an operator must explicitly choose a suitable finite budget or a new run.
The existing deterministic draft remains reviewable and publishable with the
normal incomplete-coverage acknowledgment. Generic failure codes intentionally
withhold provider payloads; finer safe diagnostics remain a nonblocking follow-up.

Cancellation checks the existing durable run state, plus the optional abort
signal; a 50ms cancellation check and the deadline abort in-flight I/O. A late
result cannot install into a cancelled run or overwrite a newer current draft.
Failed, unavailable, cancelled, limited and conflicted outcomes contain **no
answers**. They leave deterministic artifacts and publication usable.

Admission and locked installation both require `awaiting_review` or `complete`.
An explicit `judge` on a completed run may reopen it to `awaiting_review` only
after installing a new accepted draft; replay does not reopen it. Queued/running,
failed and interrupted runs remain with the existing scan/recovery owner.
Unknown scopes, oversized evidence, invalid schemas and corrupt replay data
produce durable failed attempts with a fixed error, not raw payloads. Invalid
operator limit configuration still throws; storage I/O failures may propagate
when even writing the failure record is impossible.

Question schemas are trusted server definitions, never key-redacted. If exact
credential/text scrubbing would alter one, reject it instead of silently changing
its meaning. Untrusted evidence/inputs use exact credential-field names, not
substring matching: `token`/`authorization` fields redact, but `tokenizer` and
`authorizationModel` retain semantic values. Those words are permitted as schema
option/question IDs. Known credentials of **any length** remain protected; short
credentials that collide with schema text fail closed, never bypass redaction.
Canonical hash ordering uses locale-independent string sorting. Configured
deadlines are passed to both SDK and outer cancellation, including >10 seconds.

## Identity, replay and publication

Validated results are written only into `operator-judgments.json` in a **new**
immutable artifact/draft via the existing publication service. The old files,
portable atlas, scanner facts, and published current pointer are untouched.
The selected artifact is naturally frozen when an operator later publishes it.

Each accepted row includes source draft, attempt, scope, batch, schema version,
question version, pinned model, evidence digest, and SHA-256 input hash. Hashing
includes complete questions, explicit inputs, and evidence. Reuse is restricted
to the selected draft's sidecar and exact identity. Reordered object properties
do not change identity; changed evidence/model/question/schema/inputs do.
Provider absence still allows replay of an exact accepted row.

Consumers must obtain a current result through this identity check, not treat
arbitrary old sidecar rows copied into a descendant draft as fresh. Published
readers use their version-pinned artifact. Raw states/questions/provider error
bodies are not persisted in the judgment sidecar or portable export. Live model
responses are not promised deterministic; replay of accepted bytes is stable.

## Evaluation baseline and remaining live work

`fixtures/judgments/baseline.json` contains 12 independently source-labelled cases
from pinned Okie, Zod (TS validation), and Tokio (Rust concurrency) excerpts.
Every label has a source-based rationale, authored before live inference. They
are provisional engineering annotations, **not independent human adjudication**.
Cases cover absent/stale evidence, misleading names, thin wrappers, failures,
and deliberately contradictory sources. The latter note is explicitly synthetic.
Six development and six held-out cases are fixed; do not tune prompts/thresholds
against held-out labels. This small same-repository split is a smoke baseline,
not evidence of repository-level generalization.

`fixtures/judgments/replay.json` is hand-authored synthetic transport data, not
captured live Jev output. It deliberately includes a confident wrong wrapper
answer and a service failure. The evaluation exercises the real SDK through a
fake transport and the durable boundary; labels/rationales are never sent as
state. A conservative code-only baseline always abstains, with missing/stale
evidence checked in code before any request. Run offline:

```sh
pnpm --filter @okie/server build
node --test apps/server/dist/judgmentEvaluation.test.js
node --test apps/server/dist/operatorJudgments.test.js apps/server/dist/operatorBudget.test.js
```

Synthetic replay scores only verify the harness: development 4/6 correct with
one failure, held-out 6/6; code baseline 2/6 and 3/6. **None are live quality
metrics.** CI never calls TypeSafe. No live request, cost, or latency was measured
for this slice.

Proposed future approval cap: one pass, at most **9 live requests**, no automatic
retries, 737,280 reserved total tokens (589,824 input ceiling), **$0.03 total**
admission budget at the documented price, 1 concurrent request, 10 seconds each.
Skip the three missing/stale cases in code. First independently adjudicate the
labels, freeze the question version, then record sanitized validated answers,
actual usage, unknown/measured cost status, latency and abstention/error rates
separately for development and held-out. This proposal is not authorization to
spend, and no production consumer should rely on live quality until measured.
