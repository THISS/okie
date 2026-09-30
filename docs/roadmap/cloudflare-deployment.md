# Cloudflare deployment (CLA-266)

Status: accepted for the first deploy (staging.sourcefor.dev, then sourcefor.dev). Operating steps are in the
runbook: [`../deploy/cloudflare-runbook.md`](../deploy/cloudflare-runbook.md).

Launch scope (Brenton, 2026-09-29): no self-serve. The operator scans public repositories locally and publishes
them. The site lists and serves only published public atlases. There is no public sign-in, no private repository and
no public scan trigger. Hosted scans, the cloud operator store, GitHub OAuth, sessions, webhooks and cron are deferred
until self-serve.

**Browse-only launch (Brenton, 2026-09-30).** Ask and block-plan are off at launch, and staging/production deploy
without the container. `ASK_ENABLED` is `"0"` in both envs and is the Worker's code default, so:

- `/api/auth/me` answers `ask: false`, and the web app hides every Ask affordance (button, panel, ⌘↵ shortcut, the
  WebMCP `ask_atlas` tool). It isn't shown broken.
- `GET /api/ask` answers `{ connected: false }` at the edge. `/api/ask/thread`, `POST /api/ask` and
  `POST /api/block-plan` return 404 without touching the guards, the budget or a container.
- The staging/production envs have no `containers` entry and no `ATLAS_API` binding. Their `v1` migration (already
  applied) lists both Durable Object classes; only the `AtlasBudget` binding exists, and it stays so the guard chain is ready. Code treats a missing binding as "backend
  unavailable" (503), and no browse path uses it.
- All browsing is served from R2: the gzip packs cover every entity, and `source.json` runs in the Worker (below).

The container class, guard chain and proxy code stay for a later signed-in-Ask ticket. The local top-level wrangler
env keeps the container, so that code stays testable (`ASK_ENABLED=1` in `.dev.vars`). The rest of this document
describes the full design, including those parts.

## Architecture

```
operator machine                       Cloudflare
────────────────                       ─────────────────────────────────────────────────────────────
okie-scan + operator UI                sourcefor.dev ─► Worker  (apps/edge, "sourcefor-atlas")
  └─ pnpm publish:atlas ── wrangler ─►   ├─ static assets: apps/web/dist (SPA fallback, _headers)
                           r2 put        ├─ /scan/index.json, /scan/<slug>/<file>   ◄── R2 (public/)
                                         ├─ /scan/<slug>/{neighborhood,excerpt}.json ◄── R2 gzip packs (range reads)
                                         ├─ /scan/<slug>/source.json ◄── GitHub raw @ commit (Cache API),
                                         │                               allowlist R2 packs/source-paths.json
                                         ├─ /r/*, /og/*, /oembed  (share pages, OG PNG, oEmbed)
                                         ├─ /api/auth/me  → { authenticated: false, mode: "public", ask }
                                         ├─ GET /api/ask, /api/ask/thread answered at the edge
                                         └─ ASK_ENABLED=1 only (not at launch):
                                            guards (Turnstile flag · per-IP rate limit · AtlasBudget DO)
                                              └─► POST /api/ask, /api/block-plan, pack misses
                                                   ─► Container "AtlasApiContainer" (apps/server,
                                                      OKIE_SERVER_MODE=public-readonly, one named instance)
                                                        └─ mirror ◄─ http://atlas-store.internal ◄─ R2 (public/ + private/)
```

- **Worker (apps/edge).** Serves the immutable app build as Workers Static Assets and published atlases from R2.
  Adding an atlas never rebuilds the app (embed-hosting's design rule). Share handling (`/r/*` Open Graph HTML,
  `/og/*` PNG cards, `/oembed`) moved out of the Vite middleware into one runtime-agnostic dispatcher
  (`apps/web/src/publicAtlasRoutes.ts`), which both the Vite dev/preview plugin and the Worker use. The configured
  public origin (`OKIE_PUBLIC_ORIGIN`) and the local scan origin (`OKIE_SCAN_ORIGIN` / `OKIE_SCAN_SERVER_PORT`)
  replaced the hard-coded `127.0.0.1:4180`. The Vercel stand-ins were removed.
- **Store layout** (`apps/server/src/publishedStoreLayout.ts`). `atlas/v1/index.json` (listing),
  `repos/<slug>/latest.json` (mutable pointer) and `repos/<slug>/versions/<versionId>/{manifest.json, public/*,
  private/*, packs/*}` (immutable). A version is written completely, manifest last, before `latest` moves, and the
  index is rewritten after that. `private/operator-explanations.json` keeps the operator-only claim mappings. Only
  the container can read it; the Worker never serves a `private/` key.
- **Static-first browsing.** `/r/<owner>/<repo>` loads neighborhood packets that the server slices per focus. At
  publish time, the default view and every entity are precomputed into one packed object, and every entity's excerpt
  into another. Each entry is its own gzip member (`encoding: "gzip"` in the pack index). The Worker range-reads a
  slice and sends it as is with `Content-Encoding: gzip` (`encodeBody: "manual"`, `Vary: Accept-Encoding`) when the
  client accepts gzip. Otherwise it inflates the slice with `DecompressionStream`. The inflated bytes are identical to
  the server route. Identity-encoded packs still work. Normal browsing never wakes a container:
  - `excerpts=1` (never sent by the web client) is a 404 at the edge.
  - A pack miss is a 404 when no container is bound. With a container, the miss is forwarded pinned to the version,
    only for a published slug and under its own per-IP rate-limit bucket.
  - A missing or unparsable pack index isn't cached, so a later upload is picked up.
- **Source view at the edge.** `/scan/<slug>/source.json` ports apps/server `scanSource.ts` into the Worker: the same
  query validation, statuses (400/404/413/416/422/502), messages and response shape.
  - Allowlist: the version's `packs/source-paths.json`. The commit must be the version's commit, and owner/repo must
    match the slug.
  - Fetch: GitHub raw at the pinned commit (`redirect: "error"`, 15 s timeout, 1 MiB cap, fatal UTF-8 decode).
  - Cache: the raw file, keyed by repo + commit + path, for a year; the commit makes it immutable.
  - When GitHub is down or rate-limiting, an uncached file answers 502 "Historical source is unavailable right now.
    The saved excerpt remains available."
- **Attribution.** Every published `/r/<owner>/<repo>` page shows a small strip:
  - the upstream repository, the pinned commit and the licence, from the slug's `/scan/index.json` row;
  - links to GitHub at that commit and to the licence file;
  - "Source For Atlas" branding.

  It is rendered outside the React shell (`apps/web/src/atlasAttribution.ts`, mounted from `main.tsx`). The root
  shrinks by the strip's height, so it never covers canvas controls. Embeds (framed or `?embed=1`) show a compact
  22px line instead: `owner/repo · licence · source ↗`, every link opening GitHub in a new tab (CLA-328). The root
  shrinks by that height too.
- **Container (apps/server, public-readonly; not deployed at launch).** It serves only Ask, the Ask thread (always
  empty), block-plan, the dynamic `/scan` packets and `/healthz`. There are no OAuth, operator, scan-submit or
  incremental routes. Ask and block-plan are anonymous. The Worker forwards the client address as `x-okie-client-ip`,
  after deleting any client-supplied copy, because workerd can drop `CF-Connecting-IP` on the subrequest. The
  container binds `0.0.0.0` and trusts the address only with `OKIE_TRUSTED_PROXY=cloudflare`, which also ends the CLA-304 loopback exemption, so per-IP windows see real clients. It keeps no durable state. It
  mirrors published versions from R2 into a scratch operator-v1-shaped store, so every existing read path runs
  unchanged. The mirror reads R2 through the Worker's `outboundByHost` hook, so the image holds no R2 credentials.
- **Abuse and budget** (dormant while `ASK_ENABLED` is `"0"`). A pluggable guard chain runs before any Ask or
  block-plan container call, in this order:
  1. Turnstile, off unless `TURNSTILE_ENABLED=1`.
  2. The Workers Rate Limiting binding, per IP. IPv6 is keyed by its /64, and IPv4-mapped IPv6 by the IPv4 address.
  3. The `AtlasBudget` Durable Object: daily request caps per route, plus an Ask dollar ledger. It reserves an
     estimate on admission and settles to the container's `x-okie-ask-cost-usd`, which is stripped before the
     response goes out. A cap of `"0"` refuses everything.

  The container's CLA-304 per-IP windows, retrieval-worker admission and Jev planner ledger stay in place as the
  second layer.

## Why a container, not Ask in a Worker (input for CLA-312)

This was measured on the thiss/okie publication (19.2 MB snapshot, 4,048 entities):

| | Result |
|---|---|
| Precomputed Ask index | 5.7 MB JSON (gzip 1.3 MB) |
| Load | ~50 ms parse, 25 MB heap |
| Retrieval | 10–40 ms CPU per question |
| Results | byte-identical to the in-process path on 11 questions |
| Cold in-process build | 310 ms, ~80 MB heap (about 4× the snapshot) |

Ask in a plain Worker is viable, but it isn't simpler:

- It means porting about 1,350 lines (askRetrieval + ask). The `@okie/scan` barrel doesn't bundle for workerd.
- Near the 64 MB snapshot cap, the whole index would need about 85 MB of heap (extrapolated). That is too tight for
  128 MB, so the index would have to be sharded (core 1.25 MB + term postings + excerpt buckets) and retrieval made
  async.
- The logic would then exist in two copies until the Rust rewrite.
- The atlas view has the same problem. Neighborhood slicing needs the whole snapshot: 68 MB of heap for 19 MB, so it
  can't run in 128 MB at the cap. Precomputing every focus cost 419 MB and 32 s per publish; parents only cost
  25–37 MB and 2.3 s.

CLA-312 should revisit this: a Rust retrieval core could produce the sharded index at publish time and run in a
Worker.

## Measurements

Local numbers. The cold starts were taken under amd64 emulation on an arm64 Mac, so they overstate real hardware.

| What | Result |
|---|---|
| Publish build, thiss/okie | 2.4 s (packs 2.26 s). 76 MB in 16 objects: neighborhood pack 37 MB / 246 entries, excerpt pack 5.1 MB / 4,048 entries |
| Publish build, colinhacks/zod | 0.38 s. 11.4 MB |
| Container image | 290 MB (app 72 MB), node:22-slim, non-root |
| Container RSS, 3 atlases warm (main + Ask worker) | idle 146 MB → peak ~513 MB with the image defaults (Ask worker heap 512 MB, 2 warm indexes, 2 cached trios) |
| Cold start, emulated | start → `/healthz` 5.1–10.8 s. Plus first okie neighborhood, including the 3-atlas mirror sync: 12.7–26.5 s. The Cloudflare docs quote 1–3 s cold starts on real hardware. |
| Pack-hit neighborhood (Worker, local) | one R2 range read. The container is not involved. |
| Server default neighborhood, okie (native) | 656 ms cold / 458 ms warm |

Still to measure on staging: real container cold start, and R2 read latency for the mirror's first sync of a large
snapshot (up to 64 MB).

## Cloudflare facts used (checked 2026-09-29, developers.cloudflare.com)

- **Instance types.** `lite` 1/16 vCPU · 256 MiB · 2 GB; `basic` 1/4 · 1 GiB · 4 GB; `standard-1` 1/2 · 4 GiB ·
  8 GB; up to `standard-4` 4 vCPU · 12 GiB · 20 GB.
- **Disk and sleep.** Disk is ephemeral. `sleepAfter` defaults to 10 minutes. Images must be linux/amd64.
- **Container pricing.** Memory $0.0000025/GiB-s, CPU $0.000020/vCPU-s (active only) and disk $0.00000007/GB-s, after
  25 GiB-h, 375 vCPU-min and 200 GB-h included per month. A sleeping container is not billed.
- **Workers.** 128 MB memory, CPU up to 5 min on Paid, 64 MiB script. Static assets are free and unlimited, up to
  25 MiB per file.
- **R2.** $0.015/GB-month, Class A $4.50/M, Class B $0.36/M, free egress. The free tier covers 10 GB-month, 1M
  Class A and 10M Class B operations. `wrangler r2 object put` handles up to 315 MB per object.

## Cost estimate (monthly)

| Item | Estimate |
|---|---|
| Workers Paid plan (includes Containers and Durable Objects) | $5 |
| Container | $0 at the browse-only launch (not deployed) |
| Container `basic` once Ask is on, awake ~2 h/day | ~$0.35–1 |
| Container `basic` once Ask is on, warm 24/7 (worst case) | ~$7 at low CPU, ~$19 at full CPU |
| R2: ~90 MB per okie-sized version, 10 atlases × 3 versions | inside the free tier |
| Durable Objects, rate limiting, static assets | negligible |
| LLM (Ask) | $0 at launch; then bounded by `ASK_DAILY_MAX_DOLLARS` (placeholder $2/day) |
| Jev (block planner) | $0 at launch; then ≤ `BLOCK_PLAN_DAILY_MAX_REQUESTS` × $0.003 (placeholder: 200/day = $0.60) |
| GitHub raw (source view) | free and unauthenticated; the Cache API keeps repeat views off GitHub |

## Risks

- **GitHub raw availability (launch).** The full-source view depends on unauthenticated GitHub raw fetches. An
  uncached file shows a clear message when GitHub is down or rate-limiting, and the saved excerpt still shows.
- **Public anonymous Ask** spends real money. It is bounded by the daily dollar and request caps and per-IP limits.
  Turnstile is ready behind a flag (decision pending), and a WAF rate-limit rule is recommended in the runbook.
- **Cold start on a pack miss.** A pack miss, and every first Ask after sleep, pays the container cold start plus the
  mirror sync.
- **Container memory.** It is sized for 1 GiB with about three warm atlases. Several near-cap (64 MB) snapshots need
  `standard-1`. When the Ask worker runs out of memory it is restarted, and Ask falls back to answering from the
  selected scope.
- **One named container instance.** It is a single point of failure for Ask. The atlas view keeps working on pack
  hits. Scaling out means `getRandom` across instances, each with its own mirror.
- **Container budgets reset.** The container's in-process budgets (the Jev planner ledger, per-IP windows) reset on
  sleep. The Durable Object ledger is the durable cap.

## Follow-ups

- CLA-315: rebrand the `OKIE_*` / `@okie` names and the bucket and worker names, if they change.
- CLA-312: Rust/axum rewrite. Consider Ask and neighborhood slicing at the edge from sharded precomputed indexes (above).
- Self-serve: hosted scans in a container (CLA-305 sandbox, rust-analyzer and the pre-filled cargo cache), the
  operator store on D1/R2, GitHub OAuth with sessions in KV or Durable Objects, webhooks and cron.
- Give `@okie/scan` a slimmer import path for the helpers the server uses. That would save about 90 MB per process in
  the container.
- Turnstile widget on the client, once the bot-gate decision is made.
- Per-PR preview environments. The config has local, staging and production only.
