# Operator workflow operations

Configure operator access with `OKIE_OPERATOR_GITHUB_IDS`, a comma-separated
allowlist of stable numeric GitHub account IDs. Configure the browser origin with
`OKIE_PUBLIC_ORIGIN`; cookie-backed mutations reject any other Origin. The server
keeps the existing loopback default unless `OKIE_SERVER_HOST` is explicitly set.

`OKIE_SCAN_ROOT` contains legacy public scan slots and `operator-v1`, which holds
durable run metadata, atomic current pointers, and immutable artifact revisions.
Back up the entire scan root as one unit. Do not copy only `state.json`: a state
record references artifact directories by revision ID.

On restart, queued/running runs and attempts become `interrupted`; operators decide
whether to retry. A publication pointer rename failure leaves a frozen transaction
that can be retried with the same draft/current lineage. Retention does not prune
anything automatically. Remove an old artifact only after confirming no retained
publication or recovery record references it.

Hosted scans require a verified GitHub session and a public repository. They use the
configured OpenRouter-compatible gateway when credentials are available; the default
runtime model is `xiaomi/mimo-v2.6-pro` unless local/environment configuration
overrides it. Analyzer/toolchain gaps must remain visible as reduced coverage. Do not
run paid gateway calls in CI.

Operator enrichment fans out, then reduces. There is no coordinator or planning
call: every scope costs exactly one request. All in-scope leaves are queued at
once; a parent (component → container → system) is queued as soon as all of its
in-scope children have settled, so one container can run while other subtrees are
still in flight. Whenever several scopes are ready, parents dispatch before leaves
(then by scope ID) so upper levels finish as early as possible; completion order
still depends on provider latency. A component whose code children are below the
depth cap gets a bounded, deterministic digest of those symbols (name, export,
line range, first lines; about 6,000 characters, plus the total symbol count), and
the included symbols' source refs become allowed evidence for it. Prompts use
`operator-enrichment/v2`, which spells out the exact JSON output shape.
A parent receives only its children's prose (state, summary, role, interactions),
not their evidence or diagrams, which it could not cite anyway.
Validation stays strict about grounding (a missing evidence list or a ref outside
`allowedEvidence` rejects the explanation) but tolerates two observed model habits:
`interactions` returned as relation objects are rendered to text from the object's
own fields, and `null` optional fields are treated as absent. Stored evidence
keeps only `entityId`/`path`/`startLine`/`endLine`.

Incomplete-parent policy is **not run**. A child that failed still counts as
settled: its parent runs and receives that child as `failed` with no explanation.
A child that was never run (budget stop, cancellation) leaves its parent not run.
Retrying a scope marks only ancestors that already have an accepted explanation as
stale; a not-run ancestor stays not run.

Depth cap: `OKIE_LLM_ENRICH_DEPTH=component` (default) explains systems,
containers, and components; `code` symbols are opt-in with
`OKIE_LLM_ENRICH_DEPTH=code`. Scopes below the cap are never attempted.
An explicit per-scope retry is not limited by the depth cap.

The operator budget uses `OKIE_LLM_OPERATOR_MAX_REQUESTS` (default 512),
`OKIE_LLM_OPERATOR_MAX_TOKENS` (default 4,000,000),
`OKIE_LLM_OPERATOR_MAX_DOLLARS` (default 5), and `OKIE_LLM_OPERATOR_TIMEOUT_MS`
(per-request deadline for the operator gateway client, default 120,000 ms). Public
scan enrichment keeps `OKIE_LLM_MAX_SCOPES` / `OKIE_LLM_MAX_TOKENS` /
`OKIE_LLM_MAX_DOLLARS` and `OKIE_LLM_TIMEOUT_MS` (default 60,000 ms); the public
timeout key does not affect operator requests. Budget admission happens before an attempt is recorded,
in this order: the process-wide operator ledger (`OKIE_LLM_GLOBAL_MAX_TOKENS` /
`OKIE_LLM_GLOBAL_MAX_DOLLARS`), then the run's durable ledger. When either refuses,
any reservation already taken is released, no attempt row is written, the scope
stays `not run`, no further scopes are admitted, and in-flight scopes finish. Each
admitted request settles both reservations once with its reported usage. Every
accepted explanation is kept: a run stopped at the limit still writes its enriched
draft and records an `enrichment.budget_reached` event. Retries share the run's durable ledger, so retrying an exhausted run does
not reset its budget: a refused retry makes no request, creates no new draft,
marks nothing stale, and records an `enrichment.budget_refused` event plus a run
error explaining which limit to raise. Without a configured gateway every scope
stays `not run` and the run records `enrichment.unavailable`. Increasing configured limits is an explicit
operator action.

Concurrency: `OKIE_LLM_MAX_CONCURRENT` (default 64) caps a run's in-flight scopes
and, process-wide, in-flight requests per gateway provider (hostname). On a 429
the whole provider pauses and retries with exponential backoff starting at
`OKIE_LLM_RATE_LIMIT_BACKOFF_MS` (default 1000) for up to
`OKIE_LLM_RATE_LIMIT_RETRIES` (default 4) retries; after that the 429 is a real
failure. Rate-limit retries wrap only the raw gateway, below budget admission, so
they reserve nothing on the run or global ledger.

Retry once: a request that times out, or whose reply has an empty or missing
`choices[0].message.content`, gets exactly one more request inside the same
attempt row (its usage is the sum of both calls). That second request is a real
request for budget purposes: the first reservation is settled, then the retry is
admitted again through the run-level request cap and both ledgers. If the retry
is refused, the attempt fails with the original error and the run stops at the
limit. Nothing else is retried at this layer: validation rejects, other HTTP
errors, and 429s (handled by the limiter above) are not.

Leaf reasoning: `OKIE_LLM_REASONING_LEAVES=on` (default) sends request bodies
unchanged. With `off`, and only when the gateway host is OpenRouter, leaf requests
(scopes with no child explanations in their prompt, including components with a
symbol digest) carry `reasoning: { enabled: false }`. Parent (container and system)
requests and every non-OpenRouter gateway never get the field. The effective
setting is part of each attempt's input hash.

Each scope in the enriched `operator-explanations.json` carries an explicit
`state`: `accepted` (an explanation is pinned), `failed` (attempted, no accepted
explanation), or `not run` (never attempted: budget stop, cancellation, or below
the depth cap); `stale` is a separate flag. Draft coverage counts `accepted`,
`failed`, and `notRun` from those same states. Publishing any draft with failed,
not-run, or stale coverage requires acknowledgement.

`OKIE_LLM_GLOBAL_MAX_TOKENS` and `OKIE_LLM_GLOBAL_MAX_DOLLARS` apply across
operator runs through a durable ledger that is reserved before each run ledger. Token reservations include serialized
prompt bytes and the output cap before a request starts. Missing usage keeps the
reservation and displays unknown cost. Dollar limits stop new admissions based on
reported or estimated spend; they are not a hard provider billing guarantee.

Full TypeScript/Rust analysis reuses the scanner adapters. Provision repository
packages and the supported language tooling on the scan host where available;
inspect the portable bundle's `analysis.adapters` coverage and limitations rather
than treating every successful scan as a complete call graph. Published source
requests remain pinned to the captured commit; unavailable upstream source leaves
the saved excerpt usable.
