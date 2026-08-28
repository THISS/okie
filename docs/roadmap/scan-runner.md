# Scan runner

Status: proposed roadmap (operational layer).

The executable that turns a repository into atlas data. [`scraper-pipeline.md`](./scraper-pipeline.md) defines the stages and guardrails; this document decides how the stages actually run: source access, checkout, refresh cadence, and where agents fan out. The end-to-end product journey these stages power — paste/connect, the scan-progress moment, then the hosted atlas and embed — is in [`../product/arrival-to-embed.md`](../product/arrival-to-embed.md). Today no scanner exists — the atlas renders the hand-authored fixture via `pnpm generate:fixtures`, and `extraction.ts` (the intake gate) has no producers.

## Source access options

| Option | Fit | Notes |
|---|---|---|
| Local path | **first** (dogfood) | Point at a working tree/clone. No auth. Pin = `git rev-parse HEAD` + tree hash. |
| PAT / `gh` CLI | early remote repos | Runs wherever the operator's credentials live. Fine for one user; not shareable. |
| GitHub App | **hosted product** | The Vercel pattern: installable per repo/org, read-only `contents` + `metadata` permissions, short-lived installation tokens, push webhooks trigger rescans. No user PATs; revocable. |

Design rule: source acquisition is a pluggable stage. The runner sees `acquire(pin) → immutable file tree`; local path, `gh`, and App tokens are interchangeable providers.

## Checkout strategy

Ephemeral, always pinned: fetch the tree at one commit into a temp directory, verify the tree hash, scan, discard. For GitHub the tarball-at-SHA endpoint beats a git clone (one archive, no history); locally, `git worktree add --detach` gives the same isolation for free. Nothing long-lived; the snapshot's `commitSha`/tree hash is the identity, not the checkout.

Trade-off to decide per extractor: syntax-level extraction (imports, exports, symbols, containment) needs only the tree; full type-aware TS extraction wants `node_modules` (an install step — slow, network, lockfile-pinned). M1 starts syntax-level: deterministic, install-free, and enough for entities/relations/anchors.

## Refresh cadence

1. **Full rescan** (first): every run scans the whole tree at the new pin. Simple, deterministic, and the baseline the equivalence gate needs.
2. **Diff-scoped incremental** (optimization, already designed): `git diff A..B` (or the GitHub compare API) → dirty scopes → re-extract only those, reuse the rest by content hash — see "Incremental rescan" in `scraper-pipeline.md`. Only allowed because incremental ≡ full is enforced by a golden gate.
3. **Triggers**: manual CLI now; webhook push events (App) or cron later. Every trigger resolves to the same call: `scan(repo, commit)`.

## Where agents fan out

Deterministic extractors produce the observed base (structure, anchors, imports). Agents add what parsers cannot — responsibilities, conceptual containers, stories, spec prose — each given one bounded scope of the ephemeral checkout and required to return an `ArchitectureExtraction` document. `validateArchitectureExtraction` disposes; reconciliation assigns identity; canonical-sort merge makes agent completion order irrelevant. An agent failure loses that scope's enrichment, never the deterministic base.

## Proposed CLI shape

```
okie-scan --source <path | gh:owner/repo> [--commit <sha>] [--enrich] --out <dir>
```

Stages: pin → acquire → discover → extract (deterministic) → [agent enrich] → validate → adapt → `ArchitectureSnapshot` + generated `ArchitectureView` JSON → compile via `@okie/scene-compiler` → renderer scene/timeline JSON. Output is the same shape as `fixtures/`; the web app needs one new loading path for scanned snapshots alongside the demo/stress query modes.

## Build order

- **R1 — `okie-scan` local mode + TS syntax extractor. SHIPPED.** `packages/scan` scans Okie itself (commit+tree pinned, `generatedAt` = committer date); output passes the full gate untouched, covers 31/31 TS golden anchors, and is byte-identical across shuffled discovery orders and independent runs. The app loads it via `?fixture=scan` (pre-mount bootstrap, fail-closed validation errors). Dogfooding immediately paid: the first real scan exposed an unclamped corner-radius compiler bug that silently forced Canvas2D fallback — fixed at every emission site with an invariant sweep test.
- **R2 — agent enrichment pass. SHIPPED.** `okie-scan --emit-packets` writes bounded, redacted per-container packets (content-addressed manifest, `promptVersion okie-enrichment/v1`); `--enrich-from` applies recorded agent proposals through the gate with atomic per-container rules (validation, scope, observed-facts immutability, total coverage, file cohesion) and deterministic remap of the dependency graph onto the proposed logical components (evidence unioned, self-loops reported). Dogfooded on Okie: five agents, two correct first-round gate rejections (id-prefix violation; stale-packet drift from a mid-flight commit), one iteration, 5/5 accepted → 34 logical components. QA-verified: replay-deterministic, zero observed-field drift across 1,084 code entities, per-container fallback, renders on GPU. Open for M3: the live-LLM call adapter, response capture, and hash-domain caching.
- **R3a — GitHub acquisition + multi-repo serving. SHIPPED.** `okie-scan --source gh:owner/repo[@ref]` resolves the ref to a commit via the REST API (anonymous, transparent `gh`-CLI fallback on rate-limit/403/private-404; no tokens read or logged), fetches the codeload tarball at the SHA into a temp dir, walks the extracted tree through the **same** deterministic discovery core as `git ls-files`, then discards the checkout. `generatedAt` = the commit's committer date, so re-scans of a SHA are byte-identical (verified across all six artifacts). Per-repo output (`fixtures/scan/<owner>__<repo>/`) plus a slug-sorted `index.json` manifest let scanned repos coexist; the app serves them at `?fixture=scan:<slug>` (reload/shareable via the already-preserved `fixture` param — no change to the pinned navigation machinery — fail-closed on an unknown slug). Live-proofed end-to-end on `colinhacks/zod` (2,803 entities, ~14 s) and `lukeed/clsx`.
- **R3b — cadence (next).** GitHub App tarball acquisition, webhook push + cron triggers, then diff-scoped incremental rescan gated by the incremental≡full equivalence check.

Acceptance for each ties back to the `scraper-pipeline.md` milestones (R1≈M1, R3⊃M2).
