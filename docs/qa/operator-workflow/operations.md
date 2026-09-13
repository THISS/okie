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
runtime model remains `z-ai/glm-5.3-flash` unless local/environment configuration
overrides it. Analyzer/toolchain gaps must remain visible as reduced coverage. Do not
run paid gateway calls in CI.

The hosted budget uses `OKIE_LLM_MAX_SCOPES`, `OKIE_LLM_MAX_TOKENS`,
`OKIE_LLM_MAX_DOLLARS`, and `OKIE_LLM_TIMEOUT_MS`. Coordinator calls count toward
request limits alongside explanation calls. The existing default is 16 requests;
large repositories can reach that limit with substantial enrichment gaps. Review
coverage before publishing and configure an appropriate budget for the repository.
Retries share the run's durable ledger, so retrying an exhausted run does not reset
its budget. Increasing configured limits is an explicit operator action.

`OKIE_LLM_GLOBAL_MAX_TOKENS` and `OKIE_LLM_GLOBAL_MAX_DOLLARS` also apply across
operator runs through a durable ledger. Token reservations include serialized
prompt bytes and the output cap before a request starts. Missing usage keeps the
reservation and displays unknown cost. Dollar limits stop new admissions based on
reported or estimated spend; they are not a hard provider billing guarantee.

Full TypeScript/Rust analysis reuses the scanner adapters. Provision repository
packages and the supported language tooling on the scan host where available;
inspect the portable bundle's `analysis.adapters` coverage and limitations rather
than treating every successful scan as a complete call graph. Published source
requests remain pinned to the captured commit; unavailable upstream source leaves
the saved excerpt usable.
