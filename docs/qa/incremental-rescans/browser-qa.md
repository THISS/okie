# Incremental re-scans (CLA-271) browser QA

> The first pass below ran at `14f54ca`. A refresh pass at `ca41e32` is at the end of this file. Where they differ, the refresh pass wins.

Date: 2026-09-29. I drove Playwright (Chromium) against `okie-work-7` at `14f54ca`. I made no source edits. All runs happened inside a scratch operator store.

## Setup

- **Web:** Vite on `localhost:4196`, started directly in `apps/web` with `OKIE_SCAN_SERVER_PORT=4197`. No scratch Vite config was needed because the proxy port is now an env var.
- **Server:** `127.0.0.1:4197`. `dist/` was already current with `14f54ca` (`tsc -b apps/server` was a no-op). I ran it from a gitignored scratch copy, `apps/server/dist/qa271-main.js`, with one change: `allowedGithubIds: new Set(["0"])`, so the loopback test double (user id `0`) is an operator. The copy has since been deleted. Ports 4173, 4174 and 4180 were never touched.
- **Scan root:** a scratch `OKIE_SCAN_ROOT` holding a `cp -cR` clone of the live measurement store. Its layout already matched what the server expects (`<root>/operator-v1/{state.json,artifacts,cache,current}`), so no adaptation was needed. `OKIE_PUBLIC_ORIGIN=http://localhost:4196`.
- **Secrets:** `.env` was loaded by the server. OAuth client id and secret were blanked and `OKIE_GITHUB_TEST_DOUBLE=1` was set. No key values were printed. The webhook secret and cron token were random scratch values, redacted below.
- **Caps:** `OKIE_LLM_OPERATOR_MAX_REQUESTS=15`, `OKIE_LLM_OPERATOR_MAX_DOLLARS=0.10`, `OKIE_LLM_GLOBAL_MAX_DOLLARS=0.15`, `OKIE_SCAN_ENRICH=0`. No claim checks and no Jev.
- **Starting data:** `repo:thiss/okie`, with a published full baseline at `31d72a8` and five legacy incremental drafts (`e39c594` → `f5053e7` → `5974e7a` → `34dcb5a` → `6f90940`). These predate the `publication`/`chain`/`cumulative` changelog fields.

## Results

| # | Check | Result |
|---|---|---|
| 1 | Run list labels | Pass. Every incremental run reads "Update from `<from>` → `<to>`" with short SHAs. The baseline run has no label, just "thiss/okie" (01). |
| 2 | Legacy changelog panel | Pass. Legacy drafts render as "Changes in this update" with no cumulative toggle and no error. The panel shows the summary line, the short SHAs `34dcb5a → 6f90940`, and count chips (re-summarised, reused, stale, removed, kept stale). Expanded, it lists Changed with interface or internal notes, Relations added and removed, Re-summarised, and Kept stale (02, 03). On `31d72a8 → e39c594` it shows "Stale scopes · 1: src/App.tsx · dependency changed internally — re-check claims" (06). None of the legacy drafts has removed exports (all have `counts.removedExports: 0`). **Missing for legacy drafts:** the cumulative heading and view, and the chain. See L1. |
| 3 | Stale reasons | Pass for dependency-driven staleness. `src/main.tsx` reads "stale · re-check" in the scope list, with the title "Stale: dependency changed internally — re-check claims", and the detail reads "Stale: dependency changed internally — re-check claims." (04). Scopes kept stale by a budget stop carry no reason (M2). |
| 4 | Failed system scope on `6f90940` | Honest. `okie` reads "accepted · stale · softwareSystem", with the red attempt error "llm gateway response content is not JSON" above the previous accepted prose. The changelog lists it under "Kept stale". Coverage shows it as stale with "0 failed", and the attempts list shows "okie: incremental failed" (05). The list and detail give no "Stale: …" reason line for it. |
| 5 | Update to latest commit | Pass, with caveats. The banner read "Update queued from 6f90940 → ef89f2e." and the button was disabled while the run was running (07). Progress showed "Enriching… 0 settled · 15 in flight" and a live cumulative panel marked "re-enrichment in progress" (08). The run hit the 15-request cap as expected: "Enrichment stopped at the budget limit — 194/267 accepted, 19 not run, 54 stale", with "Retry not run (19)…". The cumulative heading reads "Published 31d72a8 → this draft ef89f2e (2 updates)" (should be 6, see L1). Summary: "removed exports validateDelegation, operatorDiagramSource (+2 more); 22 consumers updated; 82 changed, 533 added, 12 removed, 1265 edge changes; 33 re-summarised since publication (unreviewed); 2 stale; 215 reused from publication". Removed exports list consumer counts, stale scopes carry reasons, and the lists "Re-summarised in this update (unreviewed) · 15", "Re-enriched since publication in earlier updates (unreviewed) · 18", "Kept stale · 52" and "Not run · 19" are all present (09, 10). "This update only" switches to `6f90940 → ef89f2e`: 80 changed, 488 added, 1130 edge changes, 15 re-summarised, 179 reused, and 15 + 179 + 52 + 19 + 2 = 267 in scope (11). Coverage is honest: not-run scopes read "Not run: this in-scope scope was left unrun by a budget stop, a cancellation, or a missing gateway." (12), and publishing needs the coverage acknowledgement. |
| 6 | Update again right away | Pass. The page showed "Already at the latest commit (ef89f2e)." No run was created (7 runs and 297 attempts before and after), so there was no paid pass (14). Clicking during an active run could not be exercised from the UI: the run page disables the button, and the other run pages would not load while the server was blocked (M1). |
| 7 | Webhook and cron | Pass. See the transcript below. Without a secret or token, both routes return 404. A bad or missing signature returns 401. A signed non-default branch is ignored ("branch") and a signed `ping` is ignored ("event"). Two signed default-branch pushes returned 202 `scheduled` (`debounceMs: 3000`). A redelivery with the same `X-GitHub-Delivery` returned 200 `duplicate_delivery`. After the debounce, **no run was created**, which is correct because HEAD is unchanged, but nothing recorded that the debounced start happened (L3). Cron with no token or a wrong token returns 401. With the right token, both an empty body and `{repositoryId}` returned 200 `up_to_date` (`ef89f2e` = baseline) in about 0.1–0.2 s. |
| 8 | Console | No errors on any operator page. The only errors were two 404s for `/scan/index.json` on the public `/new` landing, because the scratch root has no public scan index. That is expected. |
| 9 | Timing (GitHub tarball path) | Queued → `incremental.diff`: **123.0 s**. That covers the tarball fetch, TS and Rust analysis, and the diff, with **2 rust-analyzer SCIP cache misses** (two new cache entries were written). Enrichment took **59.5 s** (15 requests in parallel). Total wall time was **182.5 s**. The earlier ~28 s in-process measurement used a local checkout. Here the Rust SCIP cold path dominates, and other agents' rust-analyzer and test processes were competing for CPU on the machine. |

### Transcripts (secrets redacted)

```
# Server without OKIE_GITHUB_WEBHOOK_SECRET / OKIE_INCREMENTAL_CRON_TOKEN
POST /api/operator/webhooks/github                   -> 404 {"error":"not found"}
POST /api/operator/cron/incremental (Bearer x)       -> 404 {"error":"not found"}

# Restarted with secret, token and OKIE_INCREMENTAL_DEBOUNCE_MS=3000 ("incremental: cron on, webhook on, auto-publish off")
bad signature                                        -> 401 {"error":"invalid signature","code":"signature_invalid"}
missing signature                                    -> 401 {"error":"invalid signature","code":"signature_invalid"}
refs/heads/feature-x (signed)                        -> 200 {"ignored":"branch"}
X-GitHub-Event: ping (signed)                        -> 200 {"ignored":"event","event":"ping"}
refs/heads/main push #1 (signed, THISS/okie)         -> 202 {"scheduled":true,"repositoryId":"repo:thiss/okie","pushedCommitSha":"ef89f2e…","debounceMs":3000}
refs/heads/main push #2 (signed, new delivery)       -> 202 {"scheduled":true,…}
redelivery of #1 (same X-GitHub-Delivery)            -> 200 {"ignored":"duplicate_delivery"}
  … after the debounce: runs 7 → 7, attempts 297 → 297, no new events, no server log line
cron, no Authorization                               -> 401 {"error":"invalid cron token","code":"cron_unauthorized"}
cron, wrong token                                    -> 401 {"error":"invalid cron token","code":"cron_unauthorized"}
cron, Bearer <redacted>, empty body                  -> 200 {"results":[{"repositoryId":"repo:thiss/okie","status":"up_to_date","commitSha":"ef89f2e…","baselineCommitSha":"ef89f2e…"}]}
cron, Bearer <redacted>, {"repositoryId":"repo:THISS/okie"} -> 200 (same, up_to_date)
```

## Findings (by severity)

> **Superseded (ca41e32):** M2, L1, L2 and L3 below are fixed. M1 is fixed for the scan itself (the server answers throughout the 98 s scan), but a shorter main-thread stall of about 6 s remains when the diff is built (R1). See "Refresh pass (ca41e32)" at the end for the re-check and the new findings.

**M1: The operator server stops responding for about 2 minutes during a GitHub-path update scan.** From about 5 s after clicking "Update to latest commit" until the `incremental.diff` event about 2 minutes later, every request to `:4197` timed out: `curl` to `/api/operator/session` returned nothing within 10 s and 20 s, and the operator page sat on "Checking operator access…".

- **Cause:** `packages/scan/src/analyze-rust.ts` runs `rust-analyzer scip` through `spawnSync` (timeout 120 s), and this commit missed the SCIP cache twice. `spawnSync` blocks the process's only event loop. This code predates CLA-271.
- **Why CLA-271 makes it matter:** webhooks and cron now call into the same process. A GitHub push delivered during a cold scan would time out (GitHub waits 10 s), and every operator page freezes.
- **Repro:** use a store whose SCIP cache lacks the target commit, click "Update to latest commit", then `curl -m 10 http://127.0.0.1:<port>/api/operator/session` while the run is before `incremental.diff`.

**M2: "Kept stale" scopes carry no reason.** After a budget stop, 52 dirty scopes are "kept stale". In the scope list they read plain "stale", with no "· re-check" and no title. The detail shows "accepted · stale · component" with no "Stale: …" line, and the changelog's "Kept stale · 52" list shows only names and kinds. The reviewer can't tell "this changed and the budget ran out" from other staleness. Only the 2 dependency-driven scopes get a reason (13). The same applies to the failed legacy `okie` system scope, although its attempt error is shown.

**L1: The cumulative "(N updates)" count restarts at legacy drafts.** The new draft says "Published 31d72a8 → this draft ef89f2e (2 updates)", but there are 6 updates since the publication. `chainCarry` extends `last.chain`, and the legacy `6f90940` changelog has no `chain`, so the chain holds only `6f90940` (`chainSteps: 1`). The cumulative counts are right because they come from a direct diff against the publication, and "Re-enriched since publication in earlier updates · 18" is also right. Only the update count is wrong. This affects only stores that predate the chain field.

**L2: Two different "not run" counts on one page.** The run banner says "Updated 15 of 81 selected scopes: stopped at the run budget (OKIE_LLM_OPERATOR_*); 66 not run.", but the coverage chips and changelog say "19 not run" and "52 kept stale" (14). The 66 counts selected scopes that were never attempted; the chips count scopes with no explanation. The same words mean different things.

**L3: Debounced webhook starts leave no trace.** In `createIncrementalScheduler.fire`, the start result is dropped and exceptions are swallowed (`catch { result = undefined; }`), with no log and no event. After a 202 `scheduled`, the operator can't see whether the fire resolved "up to date", deduped, or failed to resolve GitHub HEAD. Cron at least returns the result.

**Observations (not bugs):**
- The run list shows the last-updated time, not the start time: the new run read 4:23:47 while running and 4:24:46 when done, but it was created at 4:21:44.
- `budget.reserved` events for this run show `"dollars": 0`, so the $0.10 dollar cap is enforced only on measured settlement. The request cap is what stopped the run.
- `carried: 0`: the failed legacy `okie` system scope was not re-seeded from the chain. It stays in "Kept stale".

## Spend

- **Enrichment (OpenRouter, measured):** 15 requests, 43,482 input / 18,018 output tokens, **$0.0276** (sum of the `budget.settled` `measuredCostUsd` values; the UI shows "measured $0.03"). That is under the $0.10 run cap and $0.15 global cap. No other paid calls: the second "Update to latest commit", both webhook pushes and both cron calls resolved `up_to_date` with no run.

## Screenshots

- `01-run-list-update-labels.png`: run list with the "Update from … → …" labels.
- `02-changelog-collapsed-legacy.png`: legacy draft `34dcb5a → 6f90940`, changelog collapsed.
- `03-changelog-expanded-legacy.png`: same draft expanded, plus the failed `okie` system scope detail.
- `04-stale-reason-list-and-detail.png`: `src/main.tsx` "stale · re-check" in the list and detail.
- `05-failed-system-kept-stale.png`: `okie` system scope, accepted · stale with the attempt error.
- `06-changelog-expanded-stale-reason.png`: legacy `31d72a8 → e39c594`, with the stale scope and its reason.
- `07-update-started.png`: "Update queued from 6f90940 → ef89f2e."
- `08-update-progress.png`: 15 in flight, live cumulative panel.
- `09-finished-cumulative-collapsed.png`: budget stop and the cumulative "Changes since publication".
- `10-finished-cumulative-expanded.png`: cumulative lists, with removed exports and stale reasons.
- `11-finished-this-update-only.png`: "This update only" view.
- `12-coverage-not-run-budget-stop.png`: not-run filter and the not-run reason.
- `13-kept-stale-no-reason.png`: a kept-stale scope with no reason (M2).
- `14-update-again-already-latest.png`: "Already at the latest commit (ef89f2e)."

## Refresh pass (ca41e32)

Date: 2026-09-29. Playwright (Chromium) against `okie-work-7` at `ca41e32`. No source edits, no dist rebuild.

### Setup

Same as the first pass, with these differences:

- **Server:** a gitignored scratch copy, `apps/server/dist/qa271r-main.js`, with the one-line allowlist patch `allowedGithubIds: new Set(["0"])`. It sits next to `main.js` so the worker entry (`scanWorkerMain.js`) resolves. The copy has since been deleted.
- **Store:** a fresh `cp -cR` clone of the live measurement store in a scratch `OKIE_SCAN_ROOT`, with the same starting data: the full baseline `31d72a8` and five legacy drafts ending at `6f90940`. The first pass's `ef89f2e` draft was not in this store, so this pass recreated it. The original store was not modified.
- **Caps:** `OKIE_LLM_OPERATOR_MAX_REQUESTS=15`, `OKIE_LLM_OPERATOR_MAX_DOLLARS=0.05`, `OKIE_LLM_GLOBAL_MAX_DOLLARS=0.06`, `OKIE_SCAN_ENRICH=0`. No claim checks and no Jev.
- Ports 4173, 4174 and 4180 were never touched. No secrets were printed. The webhook secret was a random scratch value, kept in a mode-600 scratch file and deleted afterwards.

### Results

| # | Check | Result |
|---|---|---|
| 1 | M1: server responsive during a GitHub-path scan | **Pass, with a residual stall (R1).** Clicking "Update to latest commit" on `34dcb5a → 6f90940` sent `POST …/incremental`, which returned **202 in 83 ms** ("Update queued from 6f90940.") (201). `curl -m 5 /api/operator/session` ran every 2 s for the whole run. Over the 98 s scan phase, 48 of 49 probes returned 200 in 0.7–3.3 ms. Other run pages opened normally mid-scan (202). The exception was **one probe that timed out at 5 s, followed by one at 0.92 s**, between 17:04:09 and 17:04:17. That window brackets the `incremental.diff` event (17:04:11), when the worker returns. Through enrichment the probes stayed at about 1 ms (max 0.46 s, at completion). |
| 2 | M2: kept-stale reasons and the Unfinished list | **Pass.** List: kept-stale scopes read "stale · pending" with the title "Stale: changed; not re-enriched (budget stop or failure) — the next update retries it". This includes the `okie` system scope and containers. Detail: `src/operatorRunner.ts` reads "accepted · stale · component" and "Stale: changed; not re-enriched (budget stop or failure) — the next update retries it." (205). Changelog: "Unfinished (explanation not current) · 52" lists each scope with that reason. "Kept stale in this update (changed; not re-enriched) · 52" carries the reason in its heading (204). The stale counts include the unfinished scopes: "54 stale (52 unfinished)" appears in the summary and the chips. |
| 2b | L2: banner matches the changelog | **Pass.** Banner: "Update stopped at the run budget (OKIE_LLM_OPERATOR_*): 15 re-summarised, 19 not run, 52 kept stale (changed; not re-enriched)." The changelog chips show 19 not run and 52 kept stale, with "Re-summarised in this update · 15". These match the `incremental.finished` event (resummarised 15, notRun 19, keptStale 52, unfinished 52) (203). |
| 3 | L1: legacy chain count | **Pass.** "Published `31d72a8` → this draft `ef89f2e` (≥2 updates)". The same "(≥2 updates)" appears in the summary line. The event has `chainSteps: 1`, because the chain stops at the legacy `6f90940`. |
| 4 | Superseded-publication flag | **Pass.** I manually published the `6f90940` draft (revision 12) in the scratch store. After that, the `ef89f2e` draft's header reads "Published `31d72a8` **(no longer the live publication)** → this draft `ef89f2e` (≥2 updates)" (206). |
| 5 | Unresolvable ref | **Pass (see R3).** I sent an in-page `fetch` POST to `/api/operator/repositories/repo%3Athiss%2Fokie/incremental` with `{"ref":"refs/heads/definitely-missing-branch"}`, using the page's session cookie and same-origin headers. It returned **202 in 75 ms** `{"status":"started",…,"baselineCommitSha":"6f90940…"}`. About 1 s later the run was **Failed**, with the error "GitHub API request failed (status 422)." It was labelled "Update from 6f90940 → refs/heads/definitely-missing-branch". No 502 (207). |
| 6 | L3: webhook fire is recorded | **Pass.** I restarted the server with `OKIE_GITHUB_WEBHOOK_SECRET=<redacted>` and `OKIE_INCREMENTAL_DEBOUNCE_MS=2000` ("incremental: cron off, webhook on, auto-publish off"). First I published the `ef89f2e` draft, so the fire would resolve with no paid pass. A signed `push` to `refs/heads/main` for `THISS/okie` returned `202 {"scheduled":true,"repositoryId":"repo:thiss/okie","pushedCommitSha":"ef89f2e…","debounceMs":2000}` in 9 ms. After the debounce, a run `ef89f2e → ef89f2e` was created and completed. Its event log reads "Run running · Incremental webhook fire · Already at the latest commit (ef89f2e) · Run complete". The stored event is `incremental.webhook_fire {status: "started", runId}` (208). |
| 7 | Console | **Pass.** No errors on any operator page during the pass. The only warnings were the Playwright Permissions-Policy "tools" origin-trial warnings, which are harness noise. |

### Timings (GitHub tarball path, `6f90940 → ef89f2e`)

| Phase | Duration |
|---|---|
| Click → 202 | 83 ms |
| Queued → `incremental.diff` (tarball, TS + Rust analysis in the worker, diff) | **97.9 s** |
| `incremental.diff` → first enrichment request | 6.3 s |
| Enrichment (`enrichment.finished.durationMs`) | **68.1 s** (15 requests, budget stop) |
| Total (`incremental.finished.durationMs`) | **166.1 s** |

The diff matches the first pass: 80 changed, 488 added, 12 removed, 1,130 edge changes, 4 removed exports, 86 dirty, 179 reused (all 179 hash-checked, 0 mismatches), and `carried: 0`, `dropped: 0`.

### Findings

**R1 (Low): a ~6 s main-thread stall remains when the scan result returns.** The worker fixes the long SCIP block. After the worker posts its result, though, the main thread was unresponsive for about 6 s: one 5 s probe timeout plus one 0.92 s response, around the `incremental.diff` event. `scanWorkerMain.ts` returns only `{commitSha, artifacts}`, so the incremental diff and the draft/artifact write, plus deserialising the large artifacts, still run on the main thread. That is inside GitHub's 10 s webhook timeout, but not by a wide margin on a larger repository. Repro: poll `curl -m 5 http://127.0.0.1:<port>/api/operator/session` every 2 s through an "Update to latest commit" run. One probe near `incremental.diff` stalls.

**R2 (Low): a finished run briefly says "This run ended without a draft."** On loading `/operator?run=<finished incremental run>`, the review pane shows "This run ended without a draft." for about 170 ms (measured at 114–284 ms after navigation) before the draft and changelog load. `noDraftMessage` is rendered whenever `detail` is still undefined, so the loading state reads the same as the terminal state. Repro: navigate directly to a finished run and sample `document.body.innerText` every 100 ms.

**R3 (Low): the unresolvable-ref error doesn't name the ref.** The failed run shows "GitHub API request failed (status 422)." The run label shows the ref, but the error says nothing like "could not resolve refs/heads/definitely-missing-branch". An operator has to infer the cause from the label.

**Observations (not bugs):**
- Every up-to-date start now creates a run row. For example, the webhook fire made "Update from ef89f2e → ef89f2e · Complete". Repeated pushes, cron ticks or clicks at HEAD will add one no-op row each. At `14f54ca`, up-to-date starts created no run.
- After I published the `ef89f2e` draft itself, its header still reads "Published 31d72a8 (no longer the live publication) → this draft". That is accurate about the base, but it doesn't say that this draft is now the live one.
- "Re-enriched since publication in earlier updates (unreviewed)" is 9 here, but it was 18 in the first pass on the same starting data, which gives a total of 24 versus 33. This may come from the bounded chain carry. I did not investigate it.
- The global ledger mirrors each run settlement under `global-operator-enrichment`. Summing all `budget.settled` events double-counts the spend.

### Spend

- **Enrichment (OpenRouter, measured):** 15 requests, 43,482 input / 17,506 output tokens, **$0.0171** (the sum of the run's `budget.settled` `measuredCostUsd`; the UI shows "measured $0.02"). That is under the $0.05 run cap, the $0.06 global cap and the $0.06 pass cap. The failed-ref run and the webhook-fired run made no paid calls.

### Screenshots

- `201-update-queued-202.png`: "Update queued from 6f90940." right after the 202.
- `202-scan-running-server-responsive.png`: the run page loaded mid-scan.
- `203-finished-banner-changelog.png`: full page with the banner, coverage, the cumulative changelog, and the `okie` system scope with its kept-stale reason.
- `204-changelog-unfinished-kept-stale-reasons.png`: Unfinished and Kept stale lists expanded.
- `205-kept-stale-reason-list-detail.png`: `src/operatorRunner.ts` kept-stale reason in the list and the detail.
- `206-header-no-longer-live-publication.png`: header with "(no longer the live publication)" and "(≥2 updates)".
- `207-unresolvable-ref-failed-run.png`: the failed run for `refs/heads/definitely-missing-branch`.
- `208-webhook-fire-event-log.png`: run event log with "Incremental webhook fire".
