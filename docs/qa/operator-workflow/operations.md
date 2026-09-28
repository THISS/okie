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
`operator-enrichment/v4` (CLA-260 voice; v4 adds CLA-145 claim mapping): an area owner's short note for a new teammate,
with a summary, 2-5 key points, evidence, and an optional Mermaid diagram or small
table. See [operator-enrichment-prompt.md](../../architecture/operator-enrichment-prompt.md).
A parent receives only its explained children's name, kind and prose: summary and key
points (a legacy v1/v2 child sends its summary only). Enrichment state and unexplained
(failed or not run) children are left out of the prompt, but stay in its input hash. It never receives their evidence,
diagrams or tables, which it could not cite anyway.
Validation stays strict about grounding: a missing evidence list or a ref outside
`allowedEvidence` rejects the explanation. Over-limit or HTML-bearing summaries and
key points also reject. An invalid optional diagram or table is dropped with a
`diagramError` note, `null` optional fields count as absent, and stored evidence
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

Retry once: a request that times out, fails in transport (`fetch failed`,
`terminated`, or a dropped response body; stored as
`llm gateway transport error (<cause code>)`, retried after a 1.5 s delay), or
whose reply has an empty or missing `choices[0].message.content`, gets exactly one more request inside the same
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

## Claim checks (CLA-145)

Claim checks are report-only and **off by default**. Turn them on with `OKIE_JEV_CLAIM_CHECKS=on`;
they also need `JEV_API`. `POST /api/operator/drafts/:id/claim-checks` takes an optional
`{ scopeIds }` (at most 256 known scopes that have a claim mapping). Without `scopeIds` it checks
every non-stale scope with a claim mapping. The route uses the same mutation auth, `run_active` and
`draft_superseded` guards as retry. When claim checks are off it answers 422
`claim_checks_disabled`.

Stale scopes are never sent to Jev. A selection whose scopes are all stale gets 422
`claim_scopes_stale` (refresh first). A pass skips the stale members of a mixed selection and
writes no rows for them; its event reports them as skipped with "Explanation is stale; refresh it,
then re-check."

A pass runs in two steps.

1. **Code checks.** Each cited ref is resolved against the pinned `snapshot.json`: the entity, the
   ref path, the cited lines inside a declared range, and a captured excerpt at the artifact
   commit that passes integrity checks and covers the lines.
   - A failure is a **failed check** and goes to no model.
   - Missing or truncated capture is **insufficient context**: insufficient evidence, not falsehood.
2. **Jev.** The remaining claims go to Jev in batches of at most 8 claims and 24 KB per scope. The
   shared state holds only the cited excerpts, never explanation prose.

A pass installs **one** new artifact and draft revision (`claim-checks.json`). Coverage,
publication and acknowledgement are unchanged. The pass reports its outcome (for example a budget
stop, no provider, or skipped stale scopes) in the `message` of its `claim_checks.finished` event,
shown in the event log and once at the draft level (not in every scope's panel). While a pass runs,
the status reads "Checking claims…", not enrichment progress. It never sets, clears or overwrites
`run.error`, which stays the enrichment error. Claim-check attempts are listed apart from enrichment
attempts ("<scope>: claim check accepted"), so they never displace them from the capped list.
A timeout stops the rest of the pass, because the remaining batches would each wait out the same
deadline. A live run with an invalid `JEV_API` stalled until `OKIE_JEV_TIMEOUT_MS`. A fast 401 or
403 reads as a provider failure, not a timeout.

Claim mappings are operator-only. The public `/scan/<slug>/operator-explanations.json` strips
`claims` and `claimsNote`, and `claim-checks.json` is not a published scan file.

A summary claim must be one or more whole sentences of the summary. It starts at the start of the
summary or after `[.!?]` and a space, and ends at a sentence end or the end of the summary, with at
least 12 characters. A fragment that would drop a negation ("writes rows to disk" out of "never
writes rows to disk") is dropped with a note.

Claim evidence should be ref objects copied verbatim from `allowedEvidence`. Each one is resolved
like the reply's `evidence` and must also appear in it. Zero-based indices into the reply's
`evidence` still work. Dropped mappings are shown in the claim panel ("N statements could not be
mapped to evidence and were not evaluated"), with the stored `claimsNote` collapsible.

Each claim reads as one of these states:

- supported, contradicted or insufficient: Jev's choice at a reported confidence of at least 0.7.
  The 0.7 threshold is provisional. It comes from the live held-out run (jev-1.13.0, 33 claims):
  every threshold from 0.3 to 0.7 gave 32 correct, 0 false acceptances and 0 false alarms. At 0.8,
  a correct supported answer at confidence 0.75 (the lowest correct confidence seen) became
  uncertain. With only 28 judged cases, re-evaluate before relying on it.
- uncertain: below the threshold.
- unavailable: no provider, a failure or timeout, or a budget refusal.
- failed check.
- insufficient context.
- not evaluated.
- stale.

A stored check is fresh only while three things still match: its claim id, its evidence digest
(the excerpt bytes plus the commit) and its explanation digest. When the scope is `stale` in
`operator-explanations.json` (for example, a retried child), every claim reads **stale** ("Explanation
is stale; refresh it, then re-check"), even over the live code check. "Re-check claims" is disabled
there, with the reason shown inline.

The **Review attention** sort orders scopes by attention tier:

1. failed check
2. stale
3. contradicted
4. uncertain or insufficient
5. context not captured
6. not checked, not run or not evaluated
7. nothing to review

A parent takes the worst tier in its subtree. A collapsed parent shows a "… below" cue only for
tiers 1 to 5, so untouched scopes never outrank real results. Identical
per-claim inputs replay from `claim-checks.json` without a provider call. There is no automatic
retry.

Budget, per run (ledger kind `claim-check`):

| Variable | Default | Controls |
| --- | --- | --- |
| `OKIE_JEV_MAX_REQUESTS` | 32 | requests per run |
| `OKIE_JEV_MAX_TOKENS` | 2,621,440 | tokens reserved per run |
| `OKIE_JEV_MAX_DOLLARS` | 0.10 | dollars per run |
| `OKIE_JEV_TIMEOUT_MS` | 20,000 | deadline per request |

Each request reserves 81,920 tokens and $0.003. Jev bills input only, at about $0.042 per 1M
tokens, and reports no cost, so the reservation stays counted: 32 × $0.003 = $0.096. Every request
is admitted through the process-wide ledger (`OKIE_LLM_GLOBAL_*`) first, then this `OKIE_JEV_*` run
ledger. Claim checks do **not** count toward the enrichment run ledger (`OKIE_LLM_OPERATOR_*`),
the run's budget readout, or enrichment progress and per-scope cost averages. CLA-144 judgments
still count toward the enrichment ledger as before.

To evaluate claim checks, run `node scripts/evaluate-claim-checks.mjs --live --output=<path>`
(add `--write-replay` to record raw answers). Use `--replay` to run offline against
`fixtures/judgments/cla145/replay.json`, which holds raw jev-1.13.0 answers recorded by the live
run. CI replays them through the real pipeline and asserts the recorded numbers: 33 claims,
32 correct, 0 false acceptances, 0 false alarms, and one miss (`finished-detail-cost`).

## Jev block planner (CLA-149)

The Jev block planner orders a published node's Overview blocks. It is **off by default** on both
the server and the client. See `docs/roadmap/overview-blocks.md` ("Jev planner") for the design.
The route is `POST /api/block-plan` on the scan server. It is public and needs no sign-in, so every
cap below applies to all callers together.

| Variable | Default | Controls |
| --- | --- | --- |
| `OKIE_JEV_BLOCK_PLANNER` | off | `on`/`true`/`1`/`yes` enables the route; otherwise it answers `{ state: "unavailable", reason: "disabled" }` |
| `OKIE_JEV_PLANNER_MAX_REQUESTS` | 100 | Jev requests per server process |
| `OKIE_JEV_PLANNER_MAX_DOLLARS` | 0.30 | dollars per server process ($0.003 reserved per request) |
| `OKIE_JEV_PLANNER_TIMEOUT_MS` | 10,000 | deadline per request |
| `OKIE_JEV_PLANNER_PER_IP` | 30 | Jev-bound requests per IP per 10 minutes (cache hits are free) |
| `OKIE_LLM_GLOBAL_MAX_DOLLARS` | none | **required**: without it the route answers `{ state: "unavailable", reason: "no-global-cap" }`. The global ledger is durable lifetime spend shared with operator enrichment, judgments and claim checks, so size it above spend already recorded in the store or every plan answers `global-budget` |

**Guard order.** The kill switch, the global-cap check and a fixed per-IP window of 240 requests per
10 minutes (all requests, cache hits included) run before the request is validated, before operator
state is read and before any snapshot is read. The per-IP limits use the socket address only;
`X-Forwarded-For` is never trusted. Behind the Vite dev proxy or any loopback reverse proxy every
caller shares one address, so both per-IP limits are effectively **global** there.

**Fallback logs.** Every fallback except `disabled` logs one key-free, counted line, for example
`block-plan fallback reason=invalid-response count=3`. No request body, key or model text is logged.

**Scan root.** The planner writes `<OKIE_SCAN_ROOT>/block-plans/<versionId>.json`. Never point `OKIE_SCAN_ROOT` at another checkout's scan root, such as a sibling worktree's `fixtures/scan`. For local QA, clone the fixtures into a scratch root and point the server there:

```sh
SCRATCH=$(mktemp -d)/scan && mkdir -p "$SCRATCH"
cp -cR <other checkout>/fixtures/scan/operator-v1 "$SCRATCH/"   # APFS clone: instant, copy-on-write
OKIE_SCAN_ROOT="$SCRATCH" OKIE_SERVER_PORT=<spare port, not 4180> OKIE_JEV_BLOCK_PLANNER=on JEV_API=… pnpm --filter @okie/server dev
OKIE_SCAN_SERVER_PORT=<same port> pnpm --filter @okie/web exec vite --port <spare port, not 4173>
```

The evaluation script's `--capture` reads only `snapshot.json` and `operator-explanations.json`. Copy those two files out of the artifact into a scratch directory, and pass that directory as `--artifact`.

Each request also needs `JEV_API`. At most 4 requests are in flight at once. Identical concurrent
requests share one call. Every request goes through the process-wide ledger (`OKIE_LLM_GLOBAL_*`)
first, then through the planner ledger. The planner ledger is in memory, so a restart resets it.
Only each slug's current publication is planned. Plans are cached in memory (LRU) and in
`<scan root>/block-plans/<versionId>.json`, keyed by publication version, node, sorted candidate
`id:type` set, question version and model. Each version's file is loaded into memory once and
written atomically (temp file + rename). A cached plan never spends. To evaluate, run `node scripts/evaluate-block-planner.mjs --live --output=<path>`, or use
`--replay`. The replay reads `fixtures/judgments/block-planner/replay.json`.
