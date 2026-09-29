# Ask retrieval — worst-case-query performance (CLA-304, H1)

H1: Ask retrieval (`apps/server/src/askRetrieval.ts` `retrieveAskSections` / `expandToken`) ran
synchronously on the Node event loop, and each out-of-vocabulary query token did an O(vocab)
edit-distance pass plus a prefix scan over every longer term. One hostile question pinned the loop
for seconds, stalling every other request the process serves.

Fix (`d463e8c`, `c1d974a`, review fixes `f8c4c5a`, `1d63195`): snapshot parse, index build and search run on a persistent worker
thread (`askWorker.ts`) with bounded admission (at most 8 pending, 1 cold build; the rest get
`429` + `retry-after`). The account window and a per-IP window (loopback exempt) are checked before the body is read. Queries are capped at 32
distinct tokens, and tokens over 40 chars match exactly. Fuzzy/prefix expansion walks the sorted
vocabulary with a banded edit distance and bounded prefix scans, and expansions are memoised per
index.

## Method

`scripts/ask-dos-bench.mjs` is local and self-contained: a seeded synthetic snapshot, a locally
started copy of our own compiled server (`createScanHttpServer`, fake signed-in session,
`allowAsk` always allows; the bench client is loopback, which the AFTER per-IP window exempts), and a stub OpenAI-style gateway on `127.0.0.1` returning a
canned answer. There is no external network and no LLM spend. A `setInterval(…, 10 ms)` in the
server process measures timer lateness.

- **In-process:** `buildAskIndex`, then `retrieveAskSections` per query category. The *first call*
  column is the honest one for the fix, because the fix memoises expansions per index and repeats
  are cheaper. These calls bypass the 2,000-char HTTP question cap, so they are an algorithmic upper
  bound.
- **HTTP:** `POST /api/ask` with a *distinct* hostile out-of-vocab question per request, so no
  cache helps: one cold request (includes the index build), 6 sequential warm requests, then a
  burst of 12 concurrent. Each response's `retrieval.mode` / `sectionCount` is checked, so a fast
  but failed search cannot pass as a win: every 200 in both runs was `mode: atlas`.

Environment: Apple M1 Pro (10-core, 32 GB), macOS (Darwin 25.3.0), Node v22.23.1. Snapshot:
24,553 entities, **54.47 MB** (under the 64 MB `MAX_ASK_SNAPSHOT_BYTES` cap), **138,409**
vocabulary terms. BEFORE = `2dc18ed`, AFTER = `f8c4c5a` (the final commit `1d63195` changes admission bookkeeping and the planner window only, not the retrieval or worker hot path). Both used the same harness and parameters on a quiet
machine. An earlier AFTER run at `c1d974a` gave the same picture (event-loop lateness max 5.0 ms).

## Before / after

### In-process `retrieveAskSections` (ms)

| Query category | BEFORE first / median | AFTER first / median |
|---|--:|--:|
| benign (in-vocab, 51 chars) | 28.7 / 17.9 | 30.4 / 18.2 |
| worst-case: out-of-vocabulary tokens (400, ~2.4k chars) | **6,988 / 7,588** | **43 / 12.5** |
| worst-case: long tokens (5 × 400 chars) | 3.1 / 2.3 | 1.8 / 1.4 |
| repeated token (×400) | 315 / 223 | 12.4 / 7.7 |
| near-miss typos (400, ~4.3k chars) | **51,846 / 30,210** | **259 / 15.5** |
| `buildAskIndex` (median / max) | 5,950 / 7,761 | 5,396 / 6,210 |

### HTTP `POST /api/ask` (hostile out-of-vocab questions)

| Metric | BEFORE | AFTER |
|---|--:|--:|
| Cold request latency (includes index build) | 12,704 ms | 5,233 ms |
| Event-loop lateness during the cold request (worker busy building) | **12,578 ms** | **6.8 ms** |
| Warm request latency (median / max) | 6,172 / 12,298 ms | 27 / 40 ms |
| Event-loop lateness per warm request | 5,648 – 12,270 ms | 2.1 – 4.1 ms |
| Burst of 12 concurrent: status codes | 12 × 200 | 8 × 200, **4 × 429** (busy) |
| Burst wall time / event-loop lateness max | 64,849 / 6,349 ms | 234 / 3.5 ms |
| Event-loop lateness over the whole run (max / p99) | **12,578 / 12,270 ms** | **6.8 / 3.5 ms** |

Before the fix, every hostile request blocked the loop for its whole duration: about 12 s cold and
6–12 s warm. The 12-request burst was serialised over about 65 s. One of those 12 answers failed
with a gateway `ECONNRESET` because the stub gateway shares the process and was starved too.

After the fix, the loop stays under 7 ms late throughout, including while the worker builds the
cold index. Admission control refuses the overflow in the burst with `429` + `retry-after: 5`
instead of queueing it. Those were the only 429s in the run.

BEFORE timings varied between runs (an earlier run with a narrower harness measured 6.6 s median
for out-of-vocab tokens, 26.5 s for typos and 10.3 s cold). The gap between BEFORE and AFTER is 2–3
orders of magnitude in every run. Raw JSON: `before.json` and `after.json`, kept with the review
artifacts rather than in git.

## Retrieval quality is unchanged

- **`apps/server` `askEval.test` (live retrieval over the committed THISS/okie self-scan):** 6/6
  pass on both builds. The TAP output is identical apart from durations, including every
  per-question recall/sections/bytes diagnostic row. The tuning set, held-out v1 and held-out v2
  family means are unchanged.
- **Direct output equivalence (scratch script, not committed):** each build's own
  `retrieveAskSections` ran over the same self-scan (4,753 entities) for 316 questions: the 32
  eval questions, the 126 cross-repo label questions, and a one-edit misspelling of each to
  exercise the rewritten fuzzy/prefix path. **0 mismatches** in section ids, folded symbols, bytes
  or the hash of the full section payload.

  | Question set | n | mean sections | mean bytes | BEFORE = AFTER |
  |---|--:|--:|--:|:-:|
  | ask-eval (family-mean recall 0.917) | 32 | 20.38 | 23,678 | yes |
  | ask-eval, misspelled | 32 | 21.88 | 23,800 | yes |
  | cross-repo label questions | 126 | 24.40 | 23,898 | yes |
  | cross-repo label questions, misspelled | 126 | 24.60 | 23,845 | yes |

- **Cross-repo retrieval, recomputed (free `ask` stage, no `--live`/`--replay`):** all 15
  manifest repos were fetched at their pinned SHAs and scanned once into a scratch `--work` dir.
  The `ask` stage then ran twice over those same scans: once from a `2dc18ed` checkout (old
  `vocabByLength` scan code in its dist) and once from `f8c4c5a`. `--force` was needed because the
  committed runs hold paid answers over enriched exports that are not in git. It only drops those
  answers from the rewritten run files, which were restored afterwards (`git checkout --
  fixtures/cross-repo-eval`). Result: 126 questions and **0 differences** in ranked paths,
  selected-scope packets, every byte-budget variant, bytes or section count, in every repo.

  | Build | recall@5 | recall@10 | recall@full | mean bytes | mean sections |
  |---|--:|--:|--:|--:|--:|
  | BEFORE `2dc18ed` | 0.1944 | 0.2474 | 0.3743 | 15,324 | 16.70 |
  | AFTER `f8c4c5a` | 0.1944 | 0.2474 | 0.3743 | 15,324 | 16.70 |

  These are question means over the deterministic *scan* corpus, so they differ from the
  committed `metrics.json`, which uses family means over the enriched corpora. What matters here
  is that BEFORE and AFTER are equal.
- **`node scripts/cross-repo-eval.mjs report --replay`:** byte-identical on both builds (recall@5
  0.1825, @10 0.2566, @full 0.3452 over 126 questions). This replays the recorded rankings rather
  than rerunning retrieval, so it only confirms the report path; the recomputed comparison above
  is the evidence.

## Rerun

```
pnpm --filter './packages/*' build && pnpm --filter @okie/server build
TMPDIR=<scratch dir> node scripts/ask-dos-bench.mjs --server <build root containing apps/server/dist> \
  --vocab 120000 --target-mb 55 --runs 3 --warm 6 --burst 12 --cap-ms 120000 [--json --out <file>]
```

Without `--json` it prints markdown tables. The same command runs against the pre-fix and fixed
builds. The harness reports status codes rather than failing when an API differs.
