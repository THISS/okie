# Embed & hosting

Status: proposed roadmap (distribution layer).

The growth flow the product is aimed at: **paste an open-source repo → get a hosted atlas → PR a one-line embed onto the project's docs site.** Every embed on a popular docs page is a back-link that sends readers to the full hosted atlas — a self-reinforcing loop. This document decides the hosting shape, the `/embed` route, caching/versioning, and the staging that gets there. It builds on [`scan-runner.md`](./scan-runner.md) R3a (the `fixture=scan:<slug>` per-repo shape already shipped) and does not restate it.

Design rule: the **app build is immutable**; a repo's atlas is **data added beside it**, never a rebuild. That single rule drives every decision below.

## What exists today (the substrate)

| Capability | Today (file · symbol) | Gap for hosting |
|---|---|---|
| Static app | `apps/web` · `vite build` → `dist/` (single `index.html` + `/src/main.tsx`, default `base:'/'`) | no `base` for subpath deploys; no SPA rewrite for clean paths |
| Per-repo trio load | `renderer/scanFixture.ts` · `import.meta.glob('…/fixtures/scan/*/{snapshot,view,story}.json')` | **build-time** bundling — a new repo currently needs a rebuild |
| Injectable loader seam | `scanFixture.ts` · `loadScanFixture(load?: ScanTrioLoader, …, slug?)` | the seam exists; no runtime-`fetch` provider yet |
| Repo selection | `renderer/query.ts` · `readDemoQuery` → `?fixture=scan:<slug>` | query-only; no clean `/r/<owner>/<repo>` path routing |
| URL/nav semantics | `navigation/navigationState.ts` · `canonicalNavigationUrl` (rewrites `url.search`, **preserves `pathname`**, clears hash) | fine as-is — clean paths survive; nav state rides the query |
| Manifest | `scan/manifest.ts` · `index.json` (`{slug,repositoryId,commitSha,generatedAt,entityCount}`) | is the picker/version index; not yet served |
| Chrome gating precedent | `App.tsx` · `devMode` (`okie.devMode`, `data-dev-mode`, Shift+Alt+D) conditionally hides dev UI | need an analogous **URL-sourced** `embed` mode |
| GPU fallback | renderer WebGPU→WebGL2 (see CLAUDE.md GOTCHAS) | embeds run in sandboxed iframes — must degrade cleanly |

## 1. Hosted architecture & asset layout

Two decoupled artifacts behind one CDN:

- **App bundle** (immutable, rarely changes): the `vite build` output. Set `base` to the deploy root (`/` on a dedicated domain like `atlas.okie.dev`).
- **Per-repo trio objects** (append-only, change constantly): object storage, one prefix per commit-pinned scan:

```
/                         → app bundle (index.html, assets/*)
/scan/index.json          → manifest (all repos, current sha per slug)
/scan/<owner>__<repo>/<sha>/{snapshot,view,story}.json   → immutable, commit-pinned
/scan/<owner>__<repo>/latest → tiny JSON alias { sha } (mutable)
```

**The one required app change:** today `scanFixture.ts` reads trios via `import.meta.glob` (resolved at *build* time — it cannot see objects uploaded after the build). Hosting needs a **runtime-`fetch` `ScanTrioLoader`** — `(name) => fetch('/scan/<slug>/<sha>/'+name+'.json')`. The seam already exists (`loadScanFixture`'s injectable `load`), so this is additive: keep `import.meta.glob` for local `pnpm dev` (`fixtures/scan/`), select the fetch provider in the hosted build. No compiler/renderer change.

**URL mapping.** Clean paths for humans, resolved to a slug at bootstrap (the same place `readDemoQuery` reads `fixture` today):

| Hosted URL | Resolves to | Notes |
|---|---|---|
| `/r/<owner>/<repo>` | slug `<owner>__<repo>` @ `latest` | shareable full view |
| `/r/<owner>/<repo>/<sha>` | that immutable pin | permalink for docs |
| `/embed/r/<owner>/<repo>[/<sha>]` | same, embed mode | iframe target |
| `?fixture=scan:<slug>` | (dev/local, unchanged) | the R3a form |

Reconciles cleanly with nav: `canonicalNavigationUrl` only rewrites the query and preserves `pathname`, so the clean path is inert to the nav machinery and the `?nav=1&…` state coexists on the same URL. Hosting needs one **SPA rewrite** (serve `index.html` for `/r/*` and `/embed/*`); a thin router maps the path to a slug before `loadScanFixture`.

## 2. The `/embed` route

Minimal chrome so the atlas sits cleanly inside a foreign docs page. Mode is **URL-sourced** (path `/embed/*` or `?embed=1`), surfaced on the shell like `data-dev-mode` (e.g. `data-embed`) — never a localStorage toggle, because an embed must be stable and shareable.

| Region (App symbol) | In embed | Rationale |
|---|---|---|
| Canvas map (`aria-label` interactive map) | **Keep** | the product |
| Band rail L1–L4 · `Minimap` | **Keep** | orientation + drill is the whole interaction |
| Inspector / Details (`inspector*`) | **Keep**, auto-collapse under a width breakpoint | evidence is the value proposition |
| Guided story (`zod overview`) | **Keep**, autoplay-off default | the deterministic tour is marketing gold |
| Global search ⌘K (`searchOpen`/`search`) | **Drop** | no cross-repo nav in an embed |
| Ask Atlas | **Drop** | no LLM surface in a free embed |
| Dev UI (diagnostics, mode toggle, `+ Diagram`) | **Drop** (already `data-dev-mode`-gated) | never in prod |
| **Attribution "Open in Okie ↗"** | **Add** | the growth loop — deep-links to the full `/r/...` view |

**Sizing/responsive.** The iframe's box drives layout; the app already picks a deterministic aspect at boot (`main.tsx` · `bootstrapScanAspect`, portrait/landscape) and has mobile-width handling. In embed mode: auto-collapse the inspector below a breakpoint, recommend `min-height:480px`, and lean on the existing WebGPU→WebGL2 fallback for sandboxed iframes. The snippet a docs PR adds:

```html
<iframe src="https://atlas.okie.dev/embed/r/colinhacks/zod"
        width="100%" height="560" loading="lazy"
        style="border:0;border-radius:12px"
        title="zod architecture atlas — built with Okie"></iframe>
```

The app must be framable: **do not** send `X-Frame-Options: DENY`; set a permissive `frame-ancestors` CSP on `/embed/*` (or leave framing open for v1).

## 3. Hosting recommendation

**Static host + object storage + CDN**, app and trios separated:

- App bundle on a static host (Vercel / Netlify / Cloudflare Pages / S3+CloudFront) with SPA rewrites.
- Trios + `index.json` in object storage (S3 / R2 / GCS) behind the same CDN. Adding a repo = uploading objects; **no app redeploy** (the reason §1 mandates runtime fetch).

**Who runs scans:**

| Option | Fit | Tradeoff |
|---|---|---|
| Manual `okie-scan` CLI (operator) | **v1** | Zero infra; operator-curated marketing set; R3a already emits exactly these objects. Not self-serve. |
| Scan worker (queue + `scanGithubRepository`) | v2 | Self-serve paste-a-repo; needs rate limits + abuse/cost controls (the tarball cap already exists). |

Recommendation: **launch on the CLI path** — a curated set of high-visibility OSS atlases is the strongest marketing surface and needs no new infra, since R3a already produces the assets. Add the worker only when self-serve demand is proven.

## 4. Versioning & caching

- **Commit-pinned = immutable.** `/scan/<slug>/<sha>/*.json` never changes (guaranteed by R3a determinism: `commitSha` + committer-date `generatedAt`). Serve `Cache-Control: public, max-age=31536000, immutable` — cache forever, everywhere.
- **`latest` alias = mutable, cheap.** `/scan/<slug>/latest` (short TTL / revalidate) names the newest sha; `index.json` records it per slug.
- **Embeds default to `latest`, offer a pin.** A docs page usually wants a stable picture → recommend the snippet default resolve `latest` **once at load** and deep-link the pinned sha in the attribution link; offer a `.../<sha>` snippet for docs that want a frozen diagram.
- **R3b hook.** Webhook-push / cron rescans ([`scan-runner.md`](./scan-runner.md) R3b) publish a *new* immutable sha prefix, then flip only `latest` + the manifest row — no cache invalidation of existing objects. Diff-scoped incremental (equivalence-gated) keeps rescans cheap.

## 5. Enrichment posture for marketing scans

- **Deterministic-only (R1) is instant and free** — no LLM, publishable the moment the scan finishes. Every marketing atlas can go live immediately on the deterministic base.
- **Enrichment (R2 / M3) is an async curation upgrade** — logical components, prose, top-level actors — layered later *without touching observed facts* (atomic per-scope; the deterministic base always publishes).

Recommendation: **publish deterministic-only at paste/scan time** (instant gratification is the point of the flow), then optionally enrich the flagship repos asynchronously and republish (a new object under the same sha; enrichment carried by cache domains). Never block an embed on enrichment.

## Staging

- **v1 — curated hosted atlases + embed route.** Manual CLI scans → trio objects on a static host/CDN; runtime-`fetch` loader; `/r/<owner>/<repo>` full view + `/embed/...` minimal chrome; commit-pinned + `latest`; the one-line iframe snippet; attribution back-link. *Acceptance:* a docs PR embedding the snippet renders the atlas inside a foreign page (framable, GPU-fallback safe); a pinned URL is byte-stable and cache-immutable; **adding a new repo's trio requires no app rebuild** (runtime fetch, not `import.meta.glob`); unknown slug fails closed (as R3a).
- **v2 — paste-a-repo self-serve.** A web form → scan worker (`scanGithubRepository` behind a queue, reusing the tarball cap + adding rate/size/private-repo policy) → publishes trio + updates the manifest; a "copy embed snippet" affordance. *Acceptance:* paste → hosted atlas URL within one scan; abuse controls enforced; a repeat scan of the same sha is idempotent (identical objects, no duplicates — R3a determinism).
- **v3 — freshness.** R3b webhooks/cron repoint `latest` and run diff-scoped incremental rescans. *Acceptance:* a push to a tracked repo republishes within the cadence; immutable sha objects stay cached; `latest` embeds reflect the new sha; incremental ≡ full at B (the equivalence gate).

## Non-goals / open questions

- **Private repos in embeds** — v1 is public-only; private hosting is an auth story out of scope here.
- **Per-host theming** — embeds inherit the app theme (light/dark honored); custom palettes are deferred.
- **Embed analytics** — view counts would quantify the growth loop; candidate for v2 (needs a privacy-respecting, framing-safe beacon).
- **Framing/CSP posture** — must allow framing on `/embed/*` (no `X-Frame-Options: DENY`); decide `frame-ancestors` (open vs allowlist) before v1 launch.
- **Iframe GPU** — confirm WebGL2 renders under a sandboxed iframe across target browsers; the WebGPU→WebGL2 fallback should cover it, but it is a launch checklist item.
