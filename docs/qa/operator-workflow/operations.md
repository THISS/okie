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
