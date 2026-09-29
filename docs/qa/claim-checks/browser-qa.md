# Claim checks (CLA-145) browser QA

Date: 2026-09-29. I drove Playwright (Chromium) against the uncommitted `okie-work-4` tree, based on `e106c3b` (CLA-149) over `ef89f2e`. I made no source edits and no commits. All publication happened inside the scratch operator store only.

## Setup

- **Web:** Vite on `localhost:4194`. It ran from a scratch config that imports `apps/web/vite.config.ts` and overrides only the port and the `/api` + `/scan` proxy target (→ `127.0.0.1:4195`).
- **Server:** `127.0.0.1:4195`. I rebuilt `@okie/server` and its dependencies with `tsc`, then ran them from a scratch copy of `dist/main.js`. The copy has one change: the operator allowlist is `new Set(["0"])`. The loopback GitHub test double always signs in as user id `0`, and `OKIE_OPERATOR_GITHUB_IDS` only accepts positive ids, so without this change the test double cannot be an operator. The user's servers on 4173 and 4180 were never touched.
- **Scan root:** a fresh scratch `OKIE_SCAN_ROOT` (`…/scratchpad/qa145/scan`).
- **Secrets:** the server loaded `.env` itself through `loadOperatorDotenv`. Env set explicitly on the process wins over `.env`. OAuth client id and secret were blanked so the test double stays active. No key values were printed, logged or screenshotted.
- **Enrichment caps:** `OKIE_LLM_OPERATOR_MAX_REQUESTS=12` for the run, raised to 15 and then 14 to allow exactly the stale-test retries. `OKIE_LLM_OPERATOR_MAX_DOLLARS=0.40`, `OKIE_LLM_GLOBAL_MAX_DOLLARS=0.60`, `OKIE_SCAN_ENRICH=0` (no public-scan enrichment).
- **Jev:** `OKIE_JEV_CLAIM_CHECKS=on` with the default `OKIE_JEV_MAX_*` caps, except the deliberate `OKIE_JEV_MAX_REQUESTS=1` and `JEV_API=invalid` restarts.
- **Source:** a real operator run on `https://github.com/THISS/okie`, which is public, at commit `ef89f2ed0da2`. Run `run-29928d3b-2606-4cde-a580-58479263395c`: 267 in-scope scopes, 4,131 below the depth cap.

## Results

| # | Check | Result |
|---|---|---|
| 1 | Real run, v4 prompt | The run stopped at the 12-request cap. 12 components were accepted, all of them leaves under `@okie/server` and one under `@okie/web`. **11 of 12 carry `claims`, 44 claims in total.** 10 of 12 have a `claimsNote` with 24 dropped mappings: 18 are `evidence index out of range`, 3 are `more than 3 evidence refs`, and 3 are hidden behind `+N more`. `githubOAuth.ts` lost every mapping (6 dropped) and reads "not evaluated". 30 of 46 key points were mapped. |
| 2 | Disabled | Pass. The panel shows the reason (`Set OKIE_JEV_CLAIM_CHECKS=on (and JEV_API)…`), `Re-check claims` is disabled, and rows read Not evaluated (01). After restarting with the flag on, the store persisted. After a later restart with the flag off, the stored Jev verdicts and live code-check rows still show next to the disabled reason (12). |
| 3 | Run checks | A per-scope `Re-check claims` pass on githubAccess used 1 request. The UI offers no whole-draft pass, so I posted `POST …/claim-checks {}` from the page: 11 scopes, 9 requests, 6 replayed. Every row shows the claim text, its origin (Summary / Key point n), evidence `path:lines` links, the verdict chip with confidence (for uncertain rows also "leaned supports"), and a code-check reason where one applies. The caption "Model judgment over captured excerpts, not verification." is present. There is no whole-scope correct badge, "Supported by excerpt" is a neutral grey chip, and the prose, key points and evidence above the panel stay fully visible (03, 04, 05). Evidence links open GitHub `blob/<pinned sha>#Lx-Ly`. There is no in-app excerpt view. |
| 4 | Review attention sort | Works as specified: tier order failed → stale/missing → contradicted → uncertain/insufficient → no mapping, and collapsed parents show "… below" (06, 07). In practice it did not help on this draft (finding M2). |
| 5 | Stale | Retrying `src/main.ts` with 1 request left marked the accepted ancestor `@okie/server` stale ("1 stale", header "accepted · stale"). `Re-check claims` on it returned 422 `claim_scopes_stale`, and the UI showed "Every selected scope's explanation is stale; refresh it, then re-check." (09, 09b). However, the ancestor's single claim reads **Context not captured**, not **Stale** (finding M3). |
| 6 | Unavailable | `OKIE_JEV_MAX_REQUESTS=1`: the chip reads "Unavailable" with the reason "This run's claim-check budget is exhausted (OKIE_JEV_MAX_*)", and the pass banner says the same (10). `JEV_API=invalid`: the chip reads "Unavailable" with the reason "Jev request timed out." after exactly 20 s (11, finding L3). Both are clearly distinct from "Insufficient evidence". |
| 7 | Not evaluated | Occurred naturally: `githubOAuth.ts` shows "Not evaluated: this explanation has no claim mapping." and its re-check button is disabled with a title (08). |
| 8 | Publication | I published rev 9 inside the scratch store only. Publishing still needs the existing "I acknowledge failed, not run, or stale…" checkbox: the button stays disabled until it is ticked, and there is no claim gate (13). Result: `publication-01da57f9…`. Public `/scan/thiss__okie/operator-explanations.json` has 13 accepted explanations with only the keys `format`, `summary`, `keyPoints` and `evidence`. It contains no `claims`, `claimsNote`, `claimChecks` or `summaryClaims` key. `/scan/thiss__okie/claim-checks.json` returns 404. The public atlas shows no claim-check UI (14). |
| 9 | Console | The 422 on the stale re-check is expected. The public atlas logged two 404s for `enrichment-report.json` and `enrichment-status.json`; these look like existing operator-publication behaviour, unrelated to CLA-145. There were no uncaught errors. |

### Real-draft state counts (whole-draft pass, rev 4, 44 claims over 11 scopes)

| supported | contradicted | insufficient | uncertain | insufficient-context | failed-check | not-evaluated | unavailable |
|---|---|---|---|---|---|---|---|
| 9 (20%) | 0 | 16 (36%) | 10 (23%) | 9 (20%) | 0 | 0 | 0 |

- **What the reviewer has to look at:** 35 of 44 claims (80%) come back needing a look. `llmRateLimiter`, `localDefaults` and `main.ts` have no supported claim at all.
- **Where insufficient context came from:** 5 claims cite a truncated capture on long symbols (`ask.ts:150-198`, `jobs.ts:73-155`). 4 cite a whole-file ref with no lines. `ArchitectureBrief.tsx` has a single file-level evidence item, so all 3 of its claims are unevaluable.
- **Container claim after the retry:** the one container claim added later (`@okie/server`, cites `apps/server` with no lines) is also insufficient context.

## Findings (by severity)

**M1: Dropped claim mappings are invisible to the operator.** `claimsNote` is stored, but no UI renders it: `ScopeClaimChecks.note` only covers stored-validation failures. On this draft, 24 claims were dropped over 10 of 12 scopes. The panel just shows fewer rows (for example, `main.ts` shows 2 claims out of 1 summary and 4 key points), with no hint that the other statements were never mapped. For a scope where every mapping was dropped (`githubOAuth.ts`), the specific reason is replaced by the generic "no claim mapping".

- **Repro:** open any accepted scope except githubAccess, ask.ts or ArchitectureBrief, and compare the key points with the claim rows.
- **Related prompt/model issue:** "evidence index out of range" is the main cause (18 of 21 enumerated drops). The raw replies are not stored, so I could not tell whether MiMo uses 1-based indices or indexes into `allowedEvidence`.

**M2: The review-attention sort doesn't separate scopes on a partial draft.** Not-run, failed, stale, not-evaluated and unavailable all share tier 1 ("Stale or missing coverage"), which ranks above contradicted and uncertain.

- **Effect on the collapsed tree:** with 254 not-run scopes, every container ties at tier 1 and the containers stay in natural order. Every collapsed parent shows the same "Stale or missing coverage below" cue, so the `@okie/server` claim results are indistinguishable from untouched containers (06).
- **Effect inside a container:** 18 not-run components sort above the 11 scopes that actually have uncertain or insufficient claims (07).
- **Before any pass:** an accepted scope with claims that haven't been checked yet also gets the "Stale or missing coverage" cue. On a server with checks off, every mapped scope shows it (01), which reads as a coverage problem rather than "not checked yet".

**M3: A stale ancestor's claim reads "Context not captured", not "Stale".** In `readClaimCheckView`, the live code-check result wins over the stale test, and container and system claims can only cite directory-level evidence. So in this repo a stale ancestor's claims can never read Stale, and the stale path for ancestors is only reachable through unit fixtures.

- **What the operator still sees:** the header "accepted · stale" and the 422 refusal.
- **What's missing:** `Re-check claims` stays enabled on a fully stale scope. The refusal appears only as an alert at the top of the page, not in the panel.
- **Repro:** retry a child whose accepted parent cannot re-reduce (budget 1 left), then open the parent.

**L1: The run-level "Last claim-check pass" message appears in every scope's panel.** After the `main.ts` budget or invalid-key pass, `src/ask.ts` also said "Last claim-check pass: Some claim-check requests failed or timed out…" (12), even though ask.ts was not in that pass.

**L2: Claim text is shown as raw markdown.** Claim rows show literal `**` and backticks (for example `**\`src/githubAccess.ts\`**`), while the prose above them renders code spans (03).

**L3: An invalid `JEV_API` key reads as a timeout.** The request hangs for the full 20 s `OKIE_JEV_TIMEOUT_MS`, and the reason says "Jev request timed out." A bad key is indistinguishable from a slow provider, and a whole-draft pass with a bad key would take about 20 s per request, run sequentially.

**L4: Claim-check attempts are labelled with raw ids.** The activity list shows "claim-check:<32-hex>: judgment accepted" rows, which push enrichment attempts out of the latest-24 list (09b).

**L5: A claim-check pass briefly shows enrichment progress.** While a pass runs, the status area shows "Enriching… 0 settled / 267 scopes in scope". I saw this in DOM text about 1.5 s after clicking; the pass finished before a screenshot.

**Observation (not a bug):** one uncaptured or truncated ref makes the whole claim "insufficient context", even when its other refs are fine (`askThreads`, `ask.ts`, `jobs.ts`). This is conservative and matches the doc, but it accounts for 5 of the 9 insufficient-context claims.

## Spend

- **Enrichment (OpenRouter, `xiaomi/mimo-v2.6-pro`):** 14 requests (12 run + 2 retries). Measured **$0.0295** from the run ledger `measuredCostUsd` sum. The UI shows "measured $0.03". That is under the $0.40 run cap and the $0.60 global cap.
- **Jev (jev-1.13.0):**
  - 11 requests settled: 10 answered, plus 1 invalid-key timeout. 1 more was budget-refused with no request made.
  - 22,021 input tokens at about $0.042/1M, so an **estimated ~$0.001** actual.
  - The ledger reservation counted is 11 × $0.003 = $0.033, under the $0.10 cap.
  - Claim-check spend correctly stayed out of the enrichment "Run usage" readout.

## Screenshots

- `01-disabled-state.png`: flag off; reason, disabled re-check, not-evaluated rows, scope-list cue.
- `02-recheck-queued-notice.png`: the report-only notice after `Re-check claims`.
- `03-scope-recheck-results.png`: githubAccess verdicts: supported, insufficient, uncertain with leaned choice and confidence.
- `04-prose-and-claims-inspector.png`: full inspector; prose, key points and evidence visible above the claim panel.
- `05-whole-draft-pass-insufficient-context.png`: ask.ts after the whole-draft pass, with truncated-capture code checks.
- `06-review-attention-collapsed.png`: attention sort, collapsed containers with roll-up cues.
- `07-review-attention-expanded-server.png`: attention sort inside `@okie/server`.
- `08-no-claim-mapping-not-evaluated.png`: githubOAuth, not evaluated (no mapping).
- `09-stale-ancestor-recheck-refused.png`, `09b-stale-refused-page-top.png`: stale ancestor and the `claim_scopes_stale` refusal.
- `10-unavailable-jev-budget.png`: unavailable, Jev run budget exhausted.
- `11-unavailable-invalid-jev-key.png`: unavailable, invalid key (reads as timeout).
- `12-disabled-after-pass-stored-and-code-checks.png`: flag off again; stored verdicts and code checks persist.
- `13-publish-ack-required.png`: existing coverage acknowledgement, no claim gate.
- `14-published-atlas.png`: published atlas in the scratch store, no claim UI.

## r2 recheck

Date: 2026-09-29. This round tests the builder's fixes, uncommitted on the same `okie-work-4` tree over `e106c3b`. I rebuilt `@okie/server` and its dependencies. The ports (4194/4195) and the id-0 allowlist harness are the same as round 1. The scratch store is fresh (`scratchpad/qa145-r2/`), so there is no replay of round-1 answers.

**Caps and run:**
- Enrichment: 12 requests, $0.40 run, $0.60 global. As in round 1, I raised the run cap to 13 and then 14 only to allow the two stale-test retries (`@okie/server`, then `src/llmRateLimiter.ts`).
- Jev: default caps, plus one restart with `OKIE_JEV_MAX_REQUESTS=1` (it made no requests).
- Run `run-f6d456e8-8c8a-4008-86d6-c2b85206072a`: stopped at the limit with 12 accepted and 255 not run.

### Numbers

| | r1 | r2 |
|---|---|---|
| Explanations with claims | 11 / 12 | **12 / 12** |
| Claims | 44 | **59** |
| Dropped mappings | 24 (18 index out of range, 3 >3 refs, 3 hidden) | **5** (4 "evidence ref is not in the reply's evidence", all summary claims in `enrichment.ts` and `ask.ts`; 1 "not whole verbatim sentence(s) of the summary" in `ArchitectureBrief.tsx`) |
| Key points mapped | 30 / 46 | **44 / 45** |

The whole-draft pass (`POST …/claim-checks {}`, 12 scopes, 11 requests, 59 claims) gave these counts:

| | supported | contradicted | insufficient | uncertain | insufficient-context | failed-check |
|---|---|---|---|---|---|---|
| r1 (44) | 9 (20%) | 0 | 16 (36%) | 10 (23%) | 9 (20%) | 0 |
| r2 (59) | **24 (41%)** | **1** | **9 (15%)** | **21 (36%)** | **4 (7%)** | 0 |

- **The contradiction is a true positive.** `githubOAuth.ts` key point 1 says `resolveGithubOAuthConfig()` "derives … bind from env". In the source, `bind` is a parameter, not read from env.
- **Uncertain is now the largest bucket that needs a look.** Its confidences run from 0.21 to 0.67, and 12 of the 21 fall between 0.5 and 0.67, just under the provisional 0.7 threshold.
- **Insufficient context has dropped.** The remaining cases are 3 truncated captures (`ask.ts`, `jobs.ts`) and 1 claim citing the whole `ArchitectureBrief.tsx` file.

### Verified

| # | Check | Result |
|---|---|---|
| 1 | Claim-mapping rate | See Numbers. Mapping now uses evidence ref objects, and index-out-of-range drops are gone. |
| 2 | Dropped-mapping notice | Pass. The panel shows "2 statements could not be mapped to evidence and were not evaluated" with a collapsible detail listing the reasons (r2-01). |
| 3 | Real-draft counts | See Numbers. |
| 4 | Review attention | Pass. Before the pass, an accepted scope nobody has checked shows "Not checked yet", not "Stale or missing coverage". Collapsed containers show a "… below" cue only when real results exist: `@okie/server` shows "Contradicted below" and `@okie/web` "Context not captured below"; untouched containers show no cue (r2-02, r2-04). Inside `@okie/server`, the contradicted `githubOAuth.ts` comes first, then the 10 uncertain/insufficient scopes, then the 18 not-run components (r2-05). |
| 5 | Stale ancestor | Pass. After the child retry, `@okie/server` (accepted · stale) shows all 4 claims as **Stale**. The panel note says "Explanation is stale; refresh it, then re-check." and `Re-check claims` is disabled with that reason as its title (r2-08). Because the button is disabled, the stale 422 cannot be reached from the UI. I checked the inline refusal path with a real 422 instead: the page still thought checks were on, and the server had been restarted with them off, so it returned 422 `claim_checks_disabled`. The panel showed it inline: "Claim checks are off on this server (OKIE_JEV_CLAIM_CHECKS)." (r2-09). A mixed selection through the API (`main.ts` + stale `@okie/server`) skipped the stale scope and reported it. |
| 6a | Last pass message | Pass. It appears once, at draft level ("Last claim-check pass: Claim checks finished; 1 stale scope was skipped …"), and not in the scope panel (r2-10). |
| 6b | Markdown | Pass. Claim text renders code spans and bold (r2-06). |
| 6c | Activity list | Pass. Enrichment attempts keep their own "Latest attempts" list. Claim checks sit in a separate "Claim-check attempts · N" disclosure labelled "src/main.ts: claim check accepted" (r2-07). |
| 6d | Running status | Pass. A per-scope re-check from the UI shows "Checking claims… 1 scope selected. Report-only: model judgment over captured excerpts." (r2-03). A pass started through the API finished before the page polled. |
| 7 | Publication | Pass. Publishing needs only the coverage acknowledgement (r2-11) and produced `publication-08368334…` in the scratch store only. Public `operator-explanations.json` has 13 explanations with the keys `format`, `summary`, `keyPoints`, `evidence` and `diagram`. There is no `claims`, `claimsNote`, `claimChecks` or `summaryClaims` key, and `claim-checks.json` returns 404. |

The only console error was the intentional 422.

### Remaining findings

- **Low: stale rows keep the "Code check:" prefix.** A stale row whose earlier result came from a code check reads "Code check: Explanation is stale; refresh it, then re-check." Staleness isn't a code-check result.
- **Observation: container and system claims can't be judged.** They can only cite directory-level evidence (`apps/server`), so they read "Context not captured" when fresh (4 of 4 on `@okie/server`), and "Stale" once a child changes.
- **Observation: no whole-draft pass in the UI.** It is still available only through the API (`{}` body).
- **Observation: review load has moved to "uncertain".** 21 of 59 claims are uncertain, many at 0.5–0.67. If that band is meant as a signal, the provisional 0.7 threshold is worth revisiting with this data.

### r2 spend

- **Enrichment (OpenRouter):** 14 requests (12 run + 2 stale-test retries), measured **$0.0298**.
- **Jev:** 12 requests, all answered, 35,106 input tokens, about **$0.0015** estimated. The ledger reserves 12 × $0.003 = $0.036, under the $0.10 cap. The mixed and cap-1 passes replayed without requests.

### r2 screenshots

- `r2-01-dropped-mapping-notice.png`: "2 statements could not be mapped…" with the detail expanded.
- `r2-02-attention-before-pass.png`: attention sort before any Jev pass (code-check results only).
- `r2-03-checking-claims-status.png`: "Checking claims…" status during a UI re-check.
- `r2-04-attention-collapsed-after-pass.png`: collapsed roll-up cues after the pass.
- `r2-05-attention-expanded-server.png`: `@okie/server` children in attention order.
- `r2-06-contradicted-and-markdown.png`: contradicted claim and rendered markdown.
- `r2-07-activity-lists.png`: separate enrichment and claim-check attempt lists.
- `r2-08-stale-ancestor.png`: stale ancestor with claims reading Stale and re-check disabled with its reason.
- `r2-09-inline-refusal.png`: a 422 refusal shown inline in the panel.
- `r2-10-last-pass-draft-level.png`: the last-pass message at draft level.
- `r2-11-publish-ack.png`: the existing coverage acknowledgement, with no claim gate.
