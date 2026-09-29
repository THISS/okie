# scripts/

Repo-level generators run by root `package.json` before `check`/`build`/`dev`.
Outputs are gitignored and rebuilt on demand — never hand-edit them.

- **`build-wasm.mjs`** — wraps `wasm-pack build crates/atlas-wasm --target web
  --out-dir pkg`. Profiles: default `--profiling`, `--release`, `--debug`.
  Needs wasm-pack 0.13+. Run via `pnpm generate:wasm[:debug|:release]`.
- **`generate-stress.mjs`** — writes a deterministic seeded stress scene
  (`--nodes`, `--edges`, `--seed`, `--output`) under `fixtures/renderer/`.
  Run via `pnpm generate:stress`.
- **`measure-band-cost.mjs`** — CLA-67 per-band compile/payload/CPU-frame curve
  into `fixtures/architecture/band-cost-curve.json`. Does not change the 2000
  hang-guard. Run after building `@okie/scene-compiler`.
- **`measure-geometry-diagnostics.mjs`** — CLA-140 report-only route geometry
  diagnostics: rewrites `fixtures/architecture/geometry-diagnostics-baseline.json`
  and `docs/qa/geometry-diagnostics/*.svg`, then prints the grid-vs-all-pairs
  benchmark (`--no-bench` skips it). Run with `node --expose-gc` after building
  `@okie/scene-compiler`.
- **`evaluate-block-planner.mjs`**: CLA-149 Jev block planner vs the default Overview order on the
  thiss/okie system and containers (build `@okie/server` first).
  - `--capture --artifact=<scratch dir with copies of snapshot.json + operator-explanations.json> [--version=<publication id>]`
    rebuilds `fixtures/judgments/block-planner/nodes.json`: the real web composer (bundled by esbuild)
    picks the blocks and the server derivation supplies size and previews.
  - `--live --output=<path> [--max-dollars=≤0.10]` makes one Jev request per node (needs `JEV_API`).
    Each request reserves $0.003 against the cap, so a cap admits `cap / 0.003` nodes.
    `--write-replay` records the raw answers into `replay.json`.
  - `--replay --output=<path>` runs offline (CI asserts it in `apps/server/src/blockPlans.test.ts`).
- **`evaluate-claim-checks.mjs`**: CLA-145 held-out claim-check evaluation over
  `fixtures/judgments/cla145/heldout.json`, using the real server pipeline (build `@okie/server` first).
  - `--live --output=<path>` calls Jev (needs `JEV_API`). `--write-replay` records the raw answers
    into `replay.json`.
  - `--replay` runs offline against the recorded live answers in `replay.json` (CI asserts the same
    numbers in `apps/server/src/claimCheckEvaluation.test.ts`).
  - Reports per-category false acceptance and false alarms, review load, p50/p95 latency, cost and
    accuracy at several confidence thresholds.
- **`cross-repo-eval.mjs`**: CLA-289 cross-repo evaluation over the pinned corpus in
  `fixtures/cross-repo-eval/manifest.json` (build `@okie/server` first).
  `node scripts/cross-repo-eval.mjs <fetch|scan|enrich|claims|ask|blocks|report|all> [--repos a,b] [--work <dir outside the repo>]`.
  - `fetch` shallow-fetches each pinned SHA into `--work/repos/<owner>_<repo>` (`--mirror <dir>` fetches from local
    clones), verifies it and applies `evalPrepare` as one deterministic local commit; `scan` records the as-is outcome
    at the pin, then scans the prepared commit.
  - `enrich`/`claims` run the real operator runner / claim-check pipeline with per-repo caps; `ask` records retrieval
    (free) and, with `--live`, AFTER answers; `blocks` captures Overview candidates (+ a Jev order with `--live`) and
    writes a shuffled labeler sheet to `--work/blocks/<slug>.json`.
  - `enrich --sample K [--sample-single N]` enriches a sampled subtree (top-K components per container by relation
    degree, ties by id) from a local sampled commit, so containers and the system still reduce (from the sample);
    explanations are overlaid onto the full-scan snapshot for Ask/blocks and the run records `enrichment.scope`.
    `--skip-enrich a,b` records `enrichmentSkipped` (scanner-blind repos) instead.
  - Paid calls need `--live`; every live stage books actual spend in `fixtures/cross-repo-eval/spend.json` and refuses
    before a request that could cross `--max-dollars` (default and ceiling $3). `--fake` dry-runs enrich/claims for free.
    One live process at a time (O_EXCL `spend.json.lock`, ledger re-read under it). Repos run in a pool
    (`--repo-concurrency 4`); each paid request/stage reserves its worst case in-process and settles to actual, so
    parallel repos cannot overshoot together. Per repo: `--max-concurrent 32` enrichment, `--ask-concurrent 16` Ask
    (own rate limiter per repo; 429s back off, retry and are counted); claim checks stay sequential (product pipeline).
    `ask`/`blocks` refuse to replace paid answers / Jev orders recorded over another corpus unless `--force`.
    `--live` with a gateway model outside the known pricing table is refused unless `--price-per-mtok in/out` is given.
  - Two phases: all git/scan work (incl. the sampled commit + scan) finishes for every repo before any paid stage
    starts, so a long synchronous scan never stalls another repo's in-flight paid requests.
  - Records carry provenance (harness `HEAD` + dirty flag, model id, effective caps), why each enrichment scope failed
    and each claim row's product `reason` + scope kind; `status: "rejected"` labels are never scored.
  - Results land in `fixtures/cross-repo-eval/runs/<slug>.json`; `report` recomputes `metrics.json`, which
    `apps/server/src/crossRepoEval.test.ts` replays offline in CI.
- **`cross-repo-eval-label-sheet.mjs`**: renders `docs/qa/cross-repo-eval/label-review.md` (a spot-check sheet with
  GitHub permalinks at each pinned SHA) from `fixtures/cross-repo-eval/{manifest.json,labels/*.json}`.
  Deterministic and offline: `node scripts/cross-repo-eval-label-sheet.mjs`.
- **`generate-claim-check-heldout.mjs`** re-extracts the held-out excerpt text from the pinned
  commit (`git show`). The labels live in the script and were fixed before any live run.
- **Pins:** both script paths are dogfooding-pinned in the golden fixture; keep
  `build-wasm.mjs`'s wasm-pack args + crate name frozen (the WASM import
  boundary). See the dogfooding-pin gotcha in root `CLAUDE.md` before editing.
