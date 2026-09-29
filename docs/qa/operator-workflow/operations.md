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

## Incremental re-scans (CLA-271)

An incremental run re-scans the repository deterministically at a new commit. It diffs the result against the
baseline: the newest reviewable incremental draft chained on the current publication, else the publication, else the
latest reviewable draft (see the contract). A chain of updates therefore builds on the last one instead of paying for
the same change twice, and a manual publish restarts the chain. Only the scopes whose prompt input changed are
re-enriched, in one batch-retry pass that uses the normal budget, rate limiter and install path. Every other
explanation is carried over unchanged, with its version id and input hash. Removed scopes are dropped. A consumer whose
dependency changed only internally is marked stale for a claim re-check (`staleReason: "dependency-internal"`) instead
of being re-enriched. A scope whose evidence only moved lines is marked stale (`staleReason: "moved"`) instead of having
its line refs rewritten, so its evidence is never silently wrong. An explained below-cap scope whose own source or
relations changed, or that consumes a changed entity, is marked stale (`staleReason: "changed"` for its own change or a
surface change of what it consumes, `"dependency-internal"` for an internal one), since the pass never re-enriches
below the cap. Use Refresh to re-enrich any of these.

**Chain carry.** On a chained update, the scopes the previous unpublished update left failed, not run, or stale without
a reason are re-seeded (`carried` in the changelog; `dirty` is only what this commit changed). Gaps inherited from the
publication itself are never re-seeded; use Refresh for those. Commit-caused scopes are admitted first; carried ones
run in a second pass only when the first pass completed (a budget, cancelled or unavailable first pass admits nothing
more). An update "failed" a scope when it attempted the scope and left it unfinished (an ancestor re-reduced but still
held stale by an unfinished child counts). A scope two consecutive updates failed is dropped from the carry together
with every ancestor it holds stale, so later updates make no calls for them; it stays unfinished (`dropped`) until a
commit touches it again or the operator refreshes it.

**Unfinished scopes.** A stale scope without an overlay reason, or a dropped one, is listed as unfinished in both
changelog views, counted in the stale counts ("54 stale (52 unfinished)"), and never counted as reused from the
publication. The scope list and detail show why: `pending` ("changed; not re-enriched (budget stop or failure)" — only
for scopes this update selected, which the next update retries), `dropped` (Refresh it), or `inherited` (left
unfinished before this update chain, for example in the publication; Refresh it). The run error of an incremental run uses the same numbers as the
changelog outcome ("Update stopped at the run budget (OKIE_LLM_OPERATOR_*): 15 re-summarised, 19 not run, 52 kept stale
(changed; not re-enriched)."), covering both passes. Without a gateway it reads "Update was not run: no enrichment
gateway is configured: …"; any other pass error is kept verbatim after the counts.

**Cumulative changelog.** The changelog also records the publication→head diff (publication commit, the chain of
update steps, and cumulative counts and lists from the same diff function). The review panel defaults to this view
("Published abc1234 → this draft def5678 (2 updates)"), with "This update only" as the secondary view. The count is
"≥N updates" when the chain passes through a draft made before the chain was recorded, and the header is flagged "no
longer the live publication" when another version was published since (auto-publish is then refused; a manual publish
replaces the live version). Once this draft itself is published it reads "(live)" instead. `chain` lists the last 20 steps;
`chainLength` holds the total. Explanations are
split into "re-enriched since publication (unreviewed)" and "reused from publication"; stale overlays inherited from
earlier updates stay listed as stale.

Each update is
its own run (`kind: "incremental"`), and its draft carries a changelog (see
[operator-api-contract.md](../../architecture/operator-api-contract.md)).

**Input hash.** Before CLA-271 every code scope's input hash, and its prompt at `OKIE_LLM_ENRICH_DEPTH=code`, changed
on every commit even when its code had not. The scanner stamps the commit SHA into each excerpt's `frozenRevision` and
each exposure's `evidence.source.commitSha`. Relation ids are also collision-numbered, so one new relation can renumber
unrelated ones. Component, container and system hashes were already stable, because the symbol digest carries neither.
Scope facts now leave out those three fields. Relationships are `(from, to, kind)`. Excerpt text, line numbers,
exposure and paths stay in. A test scans one repository at two commits with identical content and asserts equal
component and code hashes. Each incremental run also recomputes the hashes of reused explanations: `hashCheck` in the
changelog and the `incremental.diff` event. Drafts made before this change show mismatches there. A mismatch is
report-only: counted, never fails the run and never re-enriches; `PROMPT_VERSION` was not bumped.

**Known limitation.** Excerpts are capped at 48 lines, and the scan artifacts carry no per-file content hash or blob SHA
(`atlas.okie.json` holds source text only when `includeSource` is set, which operator runs do not). A change that
falls entirely below an entity's excerpt cap is invisible to the diff, and its scopes are reused. A full run
re-explains everything.

| Variable | Default | Effect |
| --- | --- | --- |
| `OKIE_INCREMENTAL_CRON_TOKEN` | unset (route 404) | Bearer token for `POST /api/operator/cron/incremental` (constant-time compare). |
| `OKIE_GITHUB_WEBHOOK_SECRET` | unset (route 404) | HMAC secret for `POST /api/operator/webhooks/github`. |
| `OKIE_INCREMENTAL_DEBOUNCE_MS` | `60000` | Per-repository quiet period before a push starts a run. |
| `OKIE_INCREMENTAL_AUTO_PUBLISH` | off | `1` publishes a finished incremental draft only when it is fully accepted: 0 failed, 0 not run, 0 stale, every in-scope scope accepted, artifact valid, and the publication it started from still current (a newer manual publish wins: `stale_publication`). Cron and webhook starts follow only this variable and ignore a body `autoPublish`; the session-authenticated operator route alone accepts a per-request `autoPublish: true`. |

Operators start an update with **Update to latest commit**, which calls
`POST /api/operator/repositories/<repo:owner/name>/incremental` and takes an optional `ref` (branch, tag or SHA).
The route returns 409 while any run for the repository is active; otherwise it queues a run and returns 202 at once.
No trigger (operator route, cron, webhook) awaits GitHub or the scan inside the request: the runner resolves the ref,
and a run whose HEAD equals the baseline commit ends `complete` with `incremental.upToDate` and no draft ("Already at the
latest commit"). Only a full 40-character SHA equal to the baseline answers 200 `up_to_date` directly. Scans (full and
incremental) run in a worker thread, so the server keeps answering requests, webhooks included, while a scan runs. At
most `OKIE_SCAN_WORKER_CONCURRENCY` scans (default 1) run at once per process; the rest queue in order. Known
limitation: cancelling a run does not stop its worker; the scan finishes and its result is discarded. Worker error
messages are scrubbed of GitHub tokens. When a run finds HEAD at the baseline (up to date, no draft), the repository's
earlier up-to-date no-op runs are deleted with their events, so cron ticks keep one such row per repository; only runs
with no draft revision (hence no attempts or artifacts) are removed.

GitHub read failures name what failed: "could not read the repository on GitHub (status N)" (with "rate limited" on a
rate-limited 403/429, and "not found, or not public" on 404), "ref “x” could not be resolved on GitHub for owner/repo
(status 422)", and "repository is not public" only when the read succeeded and the repository is private.

Cron (no browser session; public repositories are read anonymously over HTTPS). Without a body, it updates every
published repository:

```sh
# every 30 minutes
*/30 * * * * curl -fsS -X POST -H "Authorization: Bearer $OKIE_INCREMENTAL_CRON_TOKEN" \
  -H 'content-type: application/json' -d '{}' https://okie.example/api/operator/cron/incremental
# one repository at an explicit ref
curl -fsS -X POST -H "Authorization: Bearer $OKIE_INCREMENTAL_CRON_TOKEN" -H 'content-type: application/json' \
  -d '{"repositoryId":"repo:acme/demo","ref":"main"}' https://okie.example/api/operator/cron/incremental
```

GitHub webhook: in the repository go to Settings → Webhooks → Add webhook. Set the payload URL to
`https://<public origin>/api/operator/webhooks/github`, the content type to `application/json`, and the secret to
`OKIE_GITHUB_WEBHOOK_SECRET`, and choose "Just the push event". The route accepts only signed `push` events to the
default branch (`ref == refs/heads/<default_branch>`), for repositories that already have an operator run. The push
is only a trigger: when the per-repository debounce fires, the start resolves the default branch's HEAD, so a burst of
pushes becomes one run at the current HEAD and a late or out-of-order older push can never move a draft backwards.
Redeliveries are dropped on `X-GitHub-Delivery` (a bounded in-memory LRU of signed deliveries). A push that arrives while
a run is active leaves exactly one follow-up pending, and that follow-up starts after the active run ends. Pending
pushes and the delivery LRU live in memory, so a restart drops them (the next push or cron tick catches up). Each
debounced start is recorded as an `incremental.webhook_fire` event (`started`, `up_to_date`, `active`, or `failed` with a
generic reason) on the repository's newest run, or logged server-side when the repository has no run. Both
automation routes check the method and configuration (and the cron token) before reading a body, and refuse
oversized bodies with 413.

**Scan cost.** Operator scans (full and incremental) use a content-addressed rust-analyzer SCIP cache at
`<store root>/cache/rust-scip`. Its key is `rust-analyzer --version`, `rustc -vV` (release and host, resolved in the
tree), the exact invocation (host, or wasm32 with its config), and a sha256 over the sorted (relative path, content) of
`*.rs`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain*`, `rust-project.json`, `rust-analyzer.toml` and `.cargo/config*` at
any depth, plus every file under each crate root (a directory whose `Cargo.toml` has `[package]`; `include!` and build
scripts can read any of them). Symlinks are hashed by target. Only `.git` is skipped (a committed `target/` is content).
A virtual workspace root is not a crate root, so a commit that touches no Rust input skips rust-analyzer entirely. A
repository whose ROOT `Cargo.toml` has `[package]` makes the root a crate root: every file in the repository is then
hashed, so any commit misses the cache (behaviour kept as is: correct, only slower). Entries are written atomically; a
corrupt entry is a miss; a failed run is never stored. Build-script and proc-macro failure detection is best-effort
only: rust-analyzer 1.87 `scip` prints nothing and exits 0 when a build script panics or a proc-macro fails to build, so
an index that depends on the environment (for example a build script that panics without a system library) can be
cached and reused for the same tree. Detecting that reliably is a follow-up. A hit refreshes the entry's mtime; after each write the directory is swept
oldest-first to `OKIE_SCIP_CACHE_MAX_MB` (default 512), and temp files older than an hour are removed. It is safe to
delete the directory at any time.

**Latency.** An incremental run's enrichment time is dominated by the sequential leaf → container → system reduce, about
20–85 s per call with the default model. Small commits therefore take about 2–3 minutes end to end, even though the scan
is about 28 s and there are only 4–11 requests. This is expected; no design change is planned.

**Errors.** A cron tick reports one generic message per repository ("could not start the incremental run"); the
detail is logged server-side only. GitHub resolution errors surface on the run itself (it fails with the error). If queueing a started run fails, the run
is marked failed ("The incremental run could not be queued.") so the repository is not left blocked.

Measure a chain of updates offline with
`node scripts/measure-incremental.mjs --repo <checkout> --from <A> --to <B>,<C>,<D>`. It is a dry run by default (fake
gateway); only `--live` makes paid gateway calls. It always uses a scratch store, never `OKIE_SCAN_ROOT`, and keeps the
SCIP cache inside it. Per step it prints commit-caused dirty and carried counts, requests, cost, scan and enrichment
time, the per-level spans (leaf/container/system) and the enrichment critical path (first leaf start → last system end).
