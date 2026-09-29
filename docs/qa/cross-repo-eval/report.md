# Cross-repo eval: baseline report (CLA-289)

This report checks whether Okie's current rules hold on 15 public repos beyond thiss/okie. The rules covered are Ask retrieval (CLA-265), Overview block order and the Jev block planner (CLA-149), C4 grouping, enrichment budgets (CLA-254) and Jev claim checks (CLA-145).

**Labels are drafts.** They were agent-written from the code at each pinned commit. Questions were frozen before any retrieval or model run. Overview hand orders were written after enrichment, because their candidate blocks come from it, but before any block order was scored. They count as ground truth only after Brenton's spot-check; see [label-review.md](label-review.md).

- Frozen commits: questions in `c4406c5`, `6878331` and `c84c832`; Overview hand orders in `ecef816`.
- Post-freeze label edits:
  - one unmatchable term fixed (`4d87249`);
  - trpc's C4 note, written by the lead once trpc's prepared scan existed (`ecef816`, marked in the note).

## How to reproduce

```
pnpm --filter './packages/*' build && pnpm --filter @okie/server build
node scripts/cross-repo-eval.mjs report --replay                  # offline: the tables below, from committed runs
node scripts/cross-repo-eval.mjs all --work <scratch> [--live --max-dollars 3]   # re-fetch, re-scan, re-run
```

**Checked-in inputs and outputs:**
- `fixtures/cross-repo-eval/manifest.json`: repo URL, pinned SHA, licence, size, and eval-only `evalPrepare` edits with the reason for each.
- `labels/*.json`: the draft labels.
- `runs/*.json`: compact recorded results.
- `metrics.json`: the numbers in this report.
- `spend.json`: the live-spend ledger.

**How CI and live runs differ:**
- CI (`apps/server/src/crossRepoEval.test.ts`) recomputes every metric from labels plus runs and asserts it equals `metrics.json`. It catches parser and scoring changes. It does not re-run retrieval, prompts or the scanner.
- Live stages need `--live`. They are capped against the ledger, with a worst-case reservation per in-flight request.

## Corpus

All 15 repos are permissively licensed. Sources are fetched into a scratch dir and never committed.

| Repo | Shape | Language | Tracked files | Licence | SHA |
|---|---|---|---|---|---|
| vercel/commerce | Next.js App Router app | TypeScript | 78 | MIT | `3761e52` |
| pmndrs/zustand | small library | TypeScript | 144 | MIT | `b57db4f` |
| hagopj13/node-express-boilerplate | Express service, generic dirs | JavaScript | 78 | MIT | `179ae84` |
| trpc/trpc | library monorepo, big test suite | TypeScript | 1,647 | MIT | `fa78a1b` |
| facebook/docusaurus | docs-heavy monorepo (40+ packages) | TypeScript | 4,275 | MIT | `baaa906` |
| excalidraw/excalidraw | app + packages via npm/yarn workspaces | TypeScript | 1,307 | MIT | `5a406e5` |
| tauri-apps/tauri | polyglot Rust + TS monorepo | Rust+TS | 1,086 | Apache-2.0 OR MIT | `d15cf9b` |
| BurntSushi/ripgrep | Rust CLI workspace, abbreviated crates | Rust | 237 | Unlicense OR MIT | `3fce3b5` |
| tokio-rs/axum | Rust library, many example crates | Rust | 503 | MIT | `d775cb2` |
| microsoft/TypeScript | scale: 66k files, ~61k test baselines | Go+TS | 66,763 | Apache-2.0 | `21b3aeb` |
| GoogleCloudPlatform/microservices-demo | 11 services, 5 languages | Polyglot | 364 | Apache-2.0 | `38e7348` |
| go-gitea/gitea | Go monolith + TS/Vue frontend | Go+TS | 6,349 | MIT | `fba8d7e` |
| saleor/saleor | Django + GraphQL monolith | Python | 4,675 | BSD-3-Clause | `58e2eb7` |
| rubygems/rubygems.org | Rails MVC | Ruby | 1,861 | MIT | `fd828b3` |
| spring-projects/spring-petclinic | Spring Boot, deep Java packages | Java | 132 | Apache-2.0 | `818c413` |

**Labels:**
- 126 Ask questions (8–9 per repo), each with 1–3 expected files, "must mention" terms and a category.
- 42 hand-ordered Overview nodes.
- One C4 grouping note per repo.

## Headline numbers (overall)

| Metric | Value |
|---|---|
| Scans that succeed as-is | **9 / 15** (all 15 after eval-only tree edits) |
| Expected files present in the atlas at all | **0.52** |
| Retrieval recall@5 / @10 / @full budget | **0.18 / 0.26 / 0.35** |
| Ask: cited-file recall | 0.34 |
| Ask: citation precision | 0.13 |
| Ask: declined ("not in evidence") | 0.33 |
| Ask: correct (answered + every must-mention term) | **0.37** |
| Claim checks: insufficient context (of 2,443 judged) | **0.29** |
| Claim checks: supported | 0.33 |
| Block order vs hand order, current default: Kendall τ / top-1 | 0.70 / 0.86 |
| Block order vs hand order, Jev planner: Kendall τ / top-1 | 0.66 / 0.88 |
| Blocks rendered that the labeler would omit | 35 over 42 nodes |
| Live spend (Jev at its token estimate) | **$1.73 of the $3 cap** |
| The same, booking Jev at the product's $0.003/request reservation | ~$3.21 (Jev reports no cost; see Cost) |

**How the overall figures are aggregated:**
- Retrieval and Ask are means over questions, pooled across repos. Every family here has one question. The per-repo mean differs by 0.01 or less.
- Claims are pooled over claim rows.
- Blocks are pooled over nodes.

**The same numbers split by repo shape:**

| Group | Recall@full | Correct | Declined |
|---|---|---|---|
| 3 small JS/TS repos, fully enriched | 0.63–0.83 | 0.75–0.89 | 0 |
| 6 larger TS/Rust repos, sampled enrichment | 0.31–0.65 | 0.38–0.67 | 0–0.22 |
| 6 repos in languages the scanner can't read | 0–0.17 | 0–0.22 | 0.38–1.0 |

## Per-repo metrics

| Repo | Corpus | Recall@5/@10/@full | In atlas | Cited recall | Precision | Declined | Correct | Claims insuff. ctx | Block τ default / Jev |
|---|---|---|---|---|---|---|---|---|---|
| commerce | enriched | .25/.38/.75 | .94 | .63 | .18 | 0 | .75 | .23 | 1.00 / 1.00 |
| zustand | enriched | .25/.50/.63 | .63 | .63 | .31 | 0 | .88 | .41 | 1.00 / 1.00 |
| node-express | enriched | .61/.72/.83 | .89 | .83 | .21 | 0 | .89 | .11 | 1.00 / 0.90 |
| trpc | sampled | .22/.22/.43 | .85 | .43 | .12 | .22 | .44 | .38 | 0.48 / 0.60 |
| docusaurus | sampled | .17/.22/.33 | .67 | .33 | .11 | .22 | .67 | .29 | 0.82 / 0.72 |
| excalidraw | sampled | .11/.22/.33 | .78 | .33 | .17 | .11 | .44 | .35 | 0.83 / 0.83 |
| tauri | sampled | .21/.27/.31 | .83 | .31 | .11 | 0 | .38 | .31 | 0.49 / 0.47 |
| ripgrep | sampled | .35/.58/.65 | .88 | .65 | .24 | 0 | .38 | .20 | 0.77 / 0.67 |
| axum | sampled | .25/.38/.50 | .75 | .50 | .21 | .13 | .38 | .07 | 1.00 / 0.80 |
| TypeScript | sampled | .06/.06/.06 | .10 | .06 | .03 | .38 | 0 | .41 | 0.67 / −0.17 |
| microservices-demo | scan only | .17/.17/.17 | .17 | .17 | .05 | .67 | .22 | – | −1.00 / 1.00 |
| gitea | sampled | .06/.11/.11 | .17 | .11 | .08 | .56 | .11 | .23 | 0.73 / 0.47 |
| saleor | scan only | 0/0/0 | 0 | 0 | 0 | 1.0 | 0 | – | – |
| rubygems.org | sampled | 0/0/0 | 0 | 0 | 0 | .75 | 0 | **.87** | 1.00 / 0.83 |
| spring-petclinic | scan only | 0/0/.06 | .06 | .06 | .06 | 1.0 | 0 | – | – |

**Column definitions:**
- **Recall@k:** the share of expected files among the first k distinct files in Ask's ranked retrieval sections. "@full" is everything that fits the 24 KB budget, plus the selected scope's packets.
- **In atlas:** the share of expected files that exist in the scanned atlas at all.
- **Precision:** cited files that are expected files, divided by all cited files. It is a lower bound, because a valid citation outside the 1–3 labelled files still counts against it.

**Recall by question category** (pooled):

| Category | Recall@full |
|---|---|
| generic-dir | 0.57 |
| how-it-works | 0.41 |
| config | 0.35 |
| cross-cutting | 0.35 |
| framework-convention | 0.25 |
| locate | 0.22 |
| docs-answer | 0.20 |

## Where the current rules break, ranked by impact

Impact is judged by how many of the 218 expected files, how many repos, and how much of the product each break costs.

Of the 141 expected files Ask misses:
- **101 (72%) never enter the atlas.** That is a scanner and coverage problem.
- **40 are in the atlas but not retrieved.** That is ranking and budget.

### 1. Languages the scanner can't read leave the atlas empty

**Recommendation: adapt by signal.**

**What we saw:**
- The scanner extracts only TypeScript, JavaScript and Rust.
- 59 of 218 expected files are Go, Python, Ruby, Java, C# or Vue:

  | Language | Expected files |
  |---|---|
  | .go | 21 |
  | .py | 15 |
  | .rb | 12 |
  | .java | 8 |
  | .cs | 2 |
  | .vue | 1 |

- 6 of 15 repos score 0–0.17 recall and decline 38–100% of questions:
  - saleor and petclinic have 2 entities each;
  - gitea's enriched system summary calls the product "the TS frontend", because the Go backend is invisible;
  - the TypeScript repo's Go compiler is invisible;
  - rubygems maps only its JavaScript, much of it vendored libraries.

Ask mostly declines here: the declined rate is 0.33 overall and 1.0 on saleor and petclinic. But 14 answers on these repos were not declines, and only 3 of those met their must-mention terms. Fabrication itself was not measured.

**Recommendation:**
- Detect the dominant language from file extensions.
- When the scanner has no analyzer for that language, fall back to a file-level index: one component per source directory and one document per file, with path, head excerpt and top-level symbol names from a cheap regex.
- Then say in the atlas and in Ask's answer that the repo is only partially mapped.
- A model isn't needed for this.

### 2. Six of 15 scans fail outright as-is

**Recommendation: keep the rules, fix the implementation.**

**What we saw:**
- **Committed symlinks (4 repos: ripgrep, axum, saleor, rubygems.org).** Any committed symlink aborts the whole scan: "symlink/submodule is unsupported". The symlinks include `HomebrewFormula` (ripgrep), `README.md` (axum), `CLAUDE.md` (saleor), and `.claude/skills` and `config/deploy/*` (rubygems.org).
- **Scale (microsoft/TypeScript).** `git cat-file --batch` of every blob hits the 128 MB `maxBuffer` (ENOBUFS). The checkout is ~410 MB, mostly test baselines.
- **Long ids (trpc).** Duplicate-code relation ids longer than 192 characters fail validation (`relation:dup:<long-id>:<long-id>` between generated files), and the whole scan is rejected.
- **Eval workaround.** For eval only, the harness applies one local derivative commit per repo that drops the offending paths (`evalPrepare`, reason recorded in the manifest).
- **Knock-on effect.** axum's README is itself a symlink, so once it is dropped the system scope has no source ref to cite, and its explanation failed in this run.

**Recommendation:**
- Skip symlinks with a warning, or resolve them inside the tree.
- Stream blobs with a total byte cap and exclude generated/test-baseline trees by signal: file count, and `testdata`/`baselines` paths.
- Hash-truncate over-long relation ids.
- These are deterministic bugs, not rule choices.

### 3. Docs, config and env files are invisible

**Recommendation: adapt by signal.**

**What we saw:**
- 23 expected Markdown or MDX files are outside the atlas (of 25 labelled), including zustand's guides, ripgrep's `GUIDE.md` and docusaurus' docs.
- About 14 are config or data: `.env.example`, `ecosystem.config.json`, `app.example.ini`, `application*.properties`, `crowdin.yml`.
- "docs-answer" questions have the lowest recall (0.20), and only 0.33 of their expected files are in the atlas.
- The questions a newcomer asks first ("what do I configure?", "where's the guide?") are exactly the ones Ask can't source.

**Recommendation:**
- Index README, `docs/**/*.md(x)` and `*.example`/`*.env.*`/`*.ini`/`*.properties` as bounded document entities.
- Scale it by a docs-ratio signal: docs-heavy repos get more, code-heavy repos get headings only.
- Deterministic. No model is needed.

### 4. Ranking falls off in larger monorepos

**Recommendation: adapt the budget by signal, then try model reranking.**

**What we saw:**
- Share of in-atlas expected files that are retrieved:

  | Repos | Retrieved / in atlas |
  |---|---|
  | small repos | 0.83–1.0 |
  | trpc, docusaurus, excalidraw, tauri | 0.40–0.50 |

- Recall@5 is 0.18 overall, even though @full is 0.35. The right file is often in the packet but ranked low. Answers also cite many other files (precision 0.13), though that isn't shown to follow from the ranking.
- Results for the offline budget variants (product default unchanged):

  | Variant | Recall@full |
  |---|---|
  | double (48 KB) | 0.42 |
  | depth-scaled budget, `24 KB × clamp(1 + (median depth − 2)/4, 1, 2)` | 0.39 |
  | size-scaled | 0.37 (hurts the small repos) |
  | half (12 KB) | 0.25 |

  The depth-scaled budget helps only the five deep monorepos and hurts nothing.

**Recommendation:**
- Adopt a depth- or entity-count-scaled byte budget.
- Separately, measure Jev/LLM reranking of the top ~40 retrieved sections on the four monorepos where ranking, not coverage, is the gap. That wasn't run here; see next steps.

### 5. C4 grouping is poor across the corpus

**Recommendation: keep the rule, extend detection, adapt granularity by signal.**

**What we saw:**
- Label verdicts: 0 sensible, 7 partly, 8 wrong.
- **Workspaces not recognised:**
  - npm/yarn `workspaces` arrays aren't read, so excalidraw and TypeScript each collapse to one container;
  - Cargo glob members (`axum-*`) aren't expanded;
  - microservices-demo's 11 services are one container.
- **Naming:**
  - names come from the root `package.json` or the clone dir: `system:root` for docusaurus and trpc, a scaffolder name for node-express, "BurntSushi_ripgrep";
  - ripgrep's crate names lose the `grep-` prefix.
- **Grouping:**
  - components are always one per file, with no directory grouping: 523 flat components in excalidraw, 182 in gitea;
  - build/lint configs, vendored JS (`vendor/javascript/jquery.js`) and generated fixtures (171 heyapi test routers in trpc's `@trpc/openapi`) are first-class components;
  - examples fold into library containers.
- **Data quality:** tauri has a duplicate container, and a tooling container whose sourceRef path doesn't exist.

**Recommendation:**
- Read npm/yarn `workspaces` and Cargo globs.
- Take the system name from README title or repo name rather than `package.json` "root".
- Group components by directory once a container has more than ~40 files.
- Demote config, vendored and generated paths by pattern.
- All deterministic.

### 6. Enrichment budgets: capped runs never explain parents

**Recommendation: adapt with budget-aware sampling.**

**What we saw:**
- Enrichment runs leaves first, and a parent only runs once every child has settled. So any cap that cuts the leaves leaves the container and system unexplained. For example, commerce capped at 64 requests got 64 of 66 components accepted and no container or system run (real runner, fake gateway; pinned in `crossRepoEval.test.ts`).
- The dollar cap is soft by the number of requests in flight. It is checked after costs return, and nothing is reserved at admission: a $0.03 cap spent $0.071 at the product default concurrency (an offline fake-gateway run during harness development; not committed as a test).
- Cost is about $0.001–0.003 per request. Full enrichment of the 12 larger repos (~2,800 scopes) would cost ~$4–5.5, and docusaurus alone ~$1.4.
- The harness's `--sample K` option (top-K components per container by relation degree, via a derivative tree) still let every parent run. It cost $0.03–0.24 per repo. Three parents failed: a ripgrep container, a tauri container and the axum system.
- The cost of sampling: parent summaries are written from a sample, and most components have no explanation. That caps what the enriched corpus can add to Ask on the larger repos.

**Recommendation:**
- Make the product enrichment budget-aware: pick a bounded subtree so parents always reduce.
- Reserve dollars at admission.
- Deterministic selection. The model is only the explainer it already is.

### 7. Claim checks: 29% insufficient context

**Recommendation: keep the rule, fix evidence capture.**

**What we saw:**
- The rate ranges from 0.07 (axum) to 0.41 (zustand, TypeScript), and is 0.87 on rubygems.
- All 709 rows come from the code check, before Jev sees them. The scanner's captured excerpts don't cover the cited evidence, because the capture is missing or truncated.
- By scope kind, the rows are 635 components, 67 containers, 4 systems and 3 external systems.
- By reason (backfilled offline from the product's stored checks): 386 truncated-capture and 323 missing-capture. There were no oversized-evidence rows.
- On rubygems, the scanner sees only its JavaScript.

**Recommendation:**
- Capture excerpts that cover what enrichment is allowed to cite. That means symbol-range excerpts for components, plus README, manifest and entry-file heads for containers and systems. Alternatively, restrict enrichment evidence to already-captured ranges.
- Keep the insufficient verdict as the honest outcome when evidence is truly missing.

### 8. Overview block order: keep the current default

**Recommendation: keep the default. Jev shows no clear difference.**

**What we saw:**

| Order | τ | Top-1 | Top-3 |
|---|---|---|---|
| Default | 0.70 | 0.86 | 0.91 |
| Jev planner | 0.66 | 0.88 | 0.90 |

- The pooled figures are above. Per-repo means are 0.68 / 0.86 for the default and 0.70 / 0.89 for Jev, so the gaps are about 0.03 either way.
- The default and Jev orders differ on 29 of the 42 nodes.

- Jev drops 7 blocks the labeler wanted: `children`/`evidence` on system nodes.
- Both orders render the 35 blocks the labeler would omit:
  - `nodeRefs:related` duplicates the relation blocks;
  - `relations:parent` points back to a system of the same name.
- Where the default disagrees, it is signal-shaped:
  - lead with `children` when the enriched summary is about test fixtures (trpc openapi/upgrade);
  - demote `children` when the list opens with config or generated files (excalidraw, gitea, TypeScript);
  - raise dependents on hub containers (trpc server, docusaurus theme-common).

**Recommendation:**
- Keep the default order.
- Drop `nodeRefs:related` when both relation blocks render, and drop `relations:parent` on enriched containers.
- Consider two deterministic signals: children-list quality and dependent count.
- **Caveats:**
  - 22 of 42 nodes are trivial single-container system/container pairs.
  - 23 of the 42 hand orders equal the default order on shared candidates. The labeler worked from shuffled sheets and was told not to read the recorded default orders, but that can't be verified.

### 9. Answer correctness tracks coverage and repo size

**Recommendation: covered by findings 1, 3 and 4.**

**What we saw:**
- Correctness ranges from 0.75 to 0.89 on the three small repos, 0.38 to 0.67 on the sampled monorepos, and 0 to 0.22 where the scanner is blind.
- Repo size is confounded with enrichment mode (full vs sampled) and language, so this doesn't isolate one cause.
- Generic-dir questions (`utils/`, `middlewares/`) have the best recall of any category (0.57). So generic directory naming doesn't look like the main problem. Wording was not varied.

## Cost and time per repo

**Cost basis:**
- Enrichment and Ask use gateway-reported cost, model `xiaomi/mimo-v2.6-pro`.
- Jev is a token estimate at the documented jev-1.13.0 input price, because Jev reports no cost.
- At the product's $0.003-per-request reservation, Jev would book about $1.53 (claims $1.40, plus 42 planner requests × $0.003), and the total would be about $3.21.
- The $3 cap therefore holds only on the token-estimate basis. Confirming real Jev spend needs Jev's own usage records.

**Timing:**
- Scan times are single-threaded.
- The three pilot repos were enriched at concurrency 4, one repo at a time.
- Of the sampled runs, docusaurus used concurrency 32; the other eight used concurrency 8.
- Most of the sampled runs came from an earlier harness revision. Runs don't yet record the harness SHA; the harness now does.

| Repo | Scan (as-is → prepared) | Enrichment | Claims (Jev) | Ask | Blocks (Jev) | Total $ |
|---|---|---|---|---|---|---|
| commerce | 2.6 s | full 68 scopes, $0.071, 508 s | $0.004 | $0.031 | <$0.001 | 0.107 |
| zustand | 10.0 s | full 32, $0.038, 233 s | $0.001 | $0.032 | <$0.001 | 0.072 |
| node-express | 17.9 s | full 45, $0.061, 472 s | $0.003 | $0.035 | <$0.001 | 0.099 |
| trpc | FAIL → 24.8 s | K=5, 55/485 comps, $0.122, 326 s | $0.004 | $0.049 | <$0.001 | 0.175 |
| docusaurus | 39.4 s | K=3, 115/770, $0.243, 333 s | $0.008 | $0.060 | <$0.001 | 0.312 |
| excalidraw | 85.3 s | K=5, 30/523, $0.088, 197 s | $0.003 | $0.043 | <$0.001 | 0.134 |
| tauri | 96.2 s | K=5, 77/316, $0.193, 389 s | $0.006 | $0.047 | <$0.001 | 0.247 |
| ripgrep | FAIL → 20.2 s | K=5, 44/88, $0.138, 397 s | $0.005 | $0.045 | <$0.001 | 0.188 |
| axum | FAIL → 141.7 s | K=5, 30/116, $0.069, 235 s | $0.003 | $0.040 | <$0.001 | 0.112 |
| TypeScript | FAIL (ENOBUFS) → 39.1 s | K=5, 30/158, $0.077, 167 s | $0.002 | $0.035 | <$0.001 | 0.115 |
| microservices-demo | 1.8 s | skipped (scanner-blind) | – | $0.011 | <$0.001 | 0.011 |
| gitea | 4.9 s | K=5, 30/182, $0.063, 194 s | $0.003 | $0.039 | <$0.001 | 0.105 |
| saleor | FAIL → 1.5 s | skipped (scanner-blind) | – | $0.003 | <$0.001 | 0.003 |
| rubygems.org | FAIL → 17.6 s | K=5, 30/38, $0.034, 267 s | $0.000 | $0.015 | <$0.001 | 0.049 |
| spring-petclinic | 0.1 s | skipped (scanner-blind) | – | $0.002 | <$0.001 | 0.002 |
| **Total** | | **$1.196** | **$0.043** | **$0.487** | **$0.003** | **$1.730** |

**Unit costs:**
- enrichment ≈ $0.001–0.003 per request, and 3–11 s per scope at concurrency 4;
- Ask ≈ $0.004 per question;
- Jev ≈ $0.00002 per claim at the token estimate.

**Projection:** full, unsampled enrichment of the whole corpus would be ~$4.5–6.

## Next steps (not run here)

1. **Jev/LLM reranking of retrieval** on trpc, docusaurus, excalidraw and tauri. This is where ranking, not coverage, is the gap. Rerank the top ~40 sections and measure recall@5 on the same labels. About 35 questions × one rerank call ≈ $0.10–0.15.
2. **Re-run after fixes 1–3.** Once the scanner covers docs and config, handles symlinks and has a file-level fallback, re-run with `node scripts/cross-repo-eval.mjs all --live` to separate scanner fixes from ranking fixes.
3. **Label spot-check.** After Brenton's spot-check, re-score with `report` (free). Questions and overviews marked `rejected` are skipped by scoring.
4. **Harder block-order labels.** More multi-container nodes are needed. Most current nodes are trivial.

## Known limits of this baseline

- **Labels:** all labels are drafts, and correctness uses literal "must mention" terms. Short terms (3 characters or fewer, or with no letters) need word boundaries.
- **Sampled enrichment:** it understates what full enrichment would give on the larger repos.
- **Recorded failures:** all are recorded as-is.
  - 17 enrichment scopes failed: tauri 5, docusaurus 3, axum 2, node-express 2, and one each in zustand, ripgrep, TypeScript and rubygems.
  - 19 claims were unavailable: zustand 6, trpc 5, axum 5, commerce 3.
  - Reasons, backfilled from the stored runs: all 17 scope failures were model output problems (14 rejected by the validator, 3 invalid output). All 19 unavailable claims were invalid Jev responses. None were timeouts.
  - The later runs did execute scans synchronously alongside other repos' paid requests. The harness now finishes all scans before any paid stage.
- **Replay:** CI replay does not catch retrieval, prompt or scanner drift. Re-record live after changing those.
