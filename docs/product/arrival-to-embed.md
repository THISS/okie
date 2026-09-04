# Arrival to embed

Status: proposed product flow (the distribution narrative).

This is the user-facing journey — **land → scan → explore → embed** — stitched across the three roadmap docs that own its mechanism: acquisition and staging in [`../roadmap/scan-runner.md`](../roadmap/scan-runner.md), the gate and stages in [`../roadmap/scraper-pipeline.md`](../roadmap/scraper-pipeline.md), and hosting/embedding in [`../roadmap/embed-hosting.md`](../roadmap/embed-hosting.md). It does not restate their decisions; it decides the *product moments* between them — what the user sees, what they get, and where they choose. Where a roadmap doc already answers something, this doc links to it.

Much of the spine already ships: the paste-a-repo landing (`apps/web/src/scanLanding.tsx`), the scan worker and job model (`apps/server/src/{jobs,scanService,main}.ts`), and the deterministic-then-enrich staging. This doc names the gaps the founder still has to close — chiefly identity, private access, and the embed surface — and recommends a resolution for each.

The journey in one line:

> **Paste a public repo (or connect a private one) → watch the scan narrate itself → land in a hosted, evidence-backed atlas → PR a one-line embed onto your docs.**

Every embed is a back-link to the full hosted atlas — the growth loop [`embed-hosting.md`](../roadmap/embed-hosting.md) is built around. This flow's job is to make each hop feel inevitable.

## 1. Arrival & intake

### Two front doors

| Door | Who | Access path | State today |
|---|---|---|---|
| **Public view / embed** | Anyone, no account | `/r/{owner}/{repo}` and oEmbed | **Ships** — no login wall on the map |
| **Hosted scan** | Signed-in GitHub user (OAuth) or GitHub App install | `POST /api/scans {url}` after `/api/auth/github` | **Ships** — no session, no scan. HTTPS Bearer (OAuth) or loopback test-double; never operator `gh` |
| **Connect a private repo** | Signed-in + App installed | GitHub App install (read-only) → short-lived installation token | Gap — identity exists; private trees wait on installation-token mint |

`normalizeRepoInput` already accepts every shape a user is likely to paste (`https://github.com/owner/repo`, `owner/repo`, `.../tree/<ref>`, `gh:owner/repo@ref`), so the box is forgiving. Scanning requires GitHub identity (the Vercel-like abuse gate). Viewing a published atlas does not.

Design rule: **the public atlas view never requires an account, and hosted scan never uses a personal access token or operator `gh`.** GitHub OAuth names the account; the GitHub App (follow-up mint) carries private-tree trust.

### Minimal permissions

Acquisition is a pluggable stage ([`scan-runner.md`](../roadmap/scan-runner.md) "Source access options"), so each door asks for exactly what it needs and no more:

| Scan target | Identity asked of the user | GitHub permission | Why this is the floor |
|---|---|---|---|
| **Public repo** | GitHub OAuth (`read:user`) | Authenticated public API (Bearer) | Abuse gate: a real GitHub user, not operator `gh`. The tree is world-readable |
| **Private repo** | Sign in, install the **Okie GitHub App** on the specific repo/org | Read-only **`contents`** + **`metadata`** | `contents` reads the tree at a SHA; `metadata` resolves refs/default branch. Installation-token mint is the follow-up — private trees stay closed until then |
| **Account identity** | GitHub **OAuth** (`read:user`) | — | Names the account, raises GitHub rate limits, keys the scan quota |

The GitHub App is the Vercel pattern: **installable per repo/org, revocable in one click, short-lived tokens, no long-lived user PATs.** We never ask for write scope, never ask for `repo` (the coarse classic-PAT scope), and never store source — the checkout is ephemeral and discarded after the scan ([`scan-runner.md`](../roadmap/scan-runner.md) "Checkout strategy"). The redaction gate (release gate 8, [`ingestion-golden-tests.md`](../architecture/ingestion-golden-tests.md)) guarantees no raw source, secret, or absolute path escapes into a published atlas — the reason a private repo can safely yield a *shareable* map.

### Anonymous vs. signed-in

| Capability | Anonymous | Signed-in (OAuth) | Signed-in + App installed |
|---|---|---|---|
| Scan a **public** repo | ✗ (401 — sign in) | ✅ (rate-limited by account) | ✅ |
| Scan a **private** repo | ✗ | ✗ (identity present; token mint later) | follow-up |
| Explore / share the hosted atlas | ✅ | ✅ | ✅ |
| Public embed snippet | ✅ | ✅ | ✅ |
| **Own** an atlas (refresh-on-push, delete, pin default) | ✗ | ✗ | ✅ |
| **Private** embed (token-gated) | ✗ | ✗ | ✅ |
| Higher scan quota / priority | ✗ | ✅ (account-keyed limiter) | ✅ |

The split is deliberate: anonymous users get the *whole view* for public maps (explore, share, embed) so a share URL never hits a login wall. Scanning is the abuse/cost gate and requires GitHub identity.

### Rate & abuse limits

The public door is a free compute endpoint, so it is bounded at several layers. Most already exist:

| Control | Where | Value today | Extend for scale |
|---|---|---|---|
| Per-key submit limiter | `jobs.ts` `createSubmitLimiter` | 5 scans / 10 min / GitHub user id, plus IP | Account is the abuse key; IP remains a belt |
| Dedupe identical in-flight scans | `jobs.ts` `activeByKey` | one job per `slug@ref` | — (idempotent by scan determinism) |
| Single-worker CPU queue | `jobs.ts` | one job at a time | Worker pool + queue depth cap under load |
| Tarball size cap | `github.ts` `DEFAULT_MAX_TARBALL_BYTES` | 150 MB | Per-tier cap; clear over-limit error already exists |
| Request body cap | `scanServer.ts` `readJsonBody` | 16 KB | — |
| Non-TS/JS fail-closed | `scan.ts` (empty source set) | explicit error | Language-coverage message already actionable |
| Unknown/private-404 fail-closed | `github.ts` `acquisitionError` | "check owner/repo/ref, or that the repo is public" | — |

Gaps to close before self-serve at volume: a **global** concurrency/spend ceiling, and an **enrichment budget** cap per GitHub account (enrichment is the only paid step). Scan submit is already account-keyed (5 / 10 min) plus IP. Recommendation: keep the deterministic scan free and generous for signed-in users; cap enrichment spend per account, since the deterministic atlas already publishes instantly on its own ([`embed-hosting.md`](../roadmap/embed-hosting.md) §5).

### The waiting experience (a real product moment)

A scan is not a spinner — it is the first time the user watches Okie *understand their code*, and it should read like the pipeline thinking out loud. The worker already stages the job so the atlas URL goes live the moment the **deterministic** pass publishes, then enrichment upgrades in place ([`scanService.ts`](../../apps/server/src/scanService.ts)). Today the visible ladder is coarse — `queued → scanning → publishing → enriching → complete`. The recommendation here is to **narrate the actual pipeline stages inside "scanning"**, because those counts are the product's credibility:

| User-visible line | Pipeline stage ([`scraper-pipeline.md`](../roadmap/scraper-pipeline.md)) | What we can show live |
|---|---|---|
| Resolving the commit | Pin / acquire | `owner/repo @ <sha·12>` — the exact immutable pin |
| Reading the repository | Discover | *N files discovered* (deterministic, order-independent) |
| Finding structure | Extract | *N entities · M relations* across containers/components/code |
| Checking every claim | Gate (validate/adapt) | "validated" — the fail-closed honesty beat |
| Drawing the map | Compile (scene/timeline) | atlas URL goes **live** here (`atlasReady`) |
| Writing descriptions | Enrich (async, optional) | *K containers enriched* — reload upgrades in place |

Principles for the moment:

- **Publish the deterministic atlas first, always.** Instant gratification is the point ([`embed-hosting.md`](../roadmap/embed-hosting.md) §5); enrichment is a background upgrade the user can walk away from. The current UI already sends the user in at `atlasReady` and tells them descriptions keep cooking.
- **Enrichment is best-effort, never a blocker.** A gate rejection or LLM failure downgrades to "the deterministic atlas stands" — it does not fail the job (`scanService.ts` already does this; the landing surfaces `skipped`/`failed` honestly).
- **Every number shown is a real, deterministic count** — entities, relations, files, enriched containers — not a fake progress bar. That honesty *is* the marketing: the user watches the evidence accrue.
- **Fail closed, legibly.** Not found, private-without-access, non-TS, over-cap, rate-limited — each already returns an actionable message; the landing must render it as guidance, not a stack trace.

## 2. The deliverable

The scan produces one hosted, commit-pinned artifact set (six JSON objects — `extraction, snapshot, view, story, scene, timeline`, plus an optional `enrichment-report`; `scanService.ts` `publishArtifacts`). To the user that resolves into three things:

### The interactive atlas (the map)

A semantic-zoom C4 atlas from system context (L1) down to the public API of every file (L4), governed by the frozen interaction contract in [`golden-okie-hierarchy.md`](./golden-okie-hierarchy.md) and [`interaction-semantics.md`](./interaction-semantics.md): wheel/pinch changes *detail*, `Open inside` changes *scope*, selection never moves the camera, Back restores exact state. Every node carries **linked worktree evidence** — the value proposition is that a claim is one click from the source line that backs it. This is the same renderer whether the atlas is a curated flagship, a pasted public repo, or a private connected repo; only the data beside the immutable app bundle differs ([`embed-hosting.md`](../roadmap/embed-hosting.md) design rule).

### Guided stories (the deep-dive)

A deterministic, cinematic tour — camera flights, focus, narration — of a chosen path through the system ([`interaction-semantics.md`](./interaction-semantics.md) "Story camera flights"). Every scan ships at least an overview story (`overview-story.ts` `buildOverviewStory`). When the snapshot contains known product surfaces, the scan also emits **user-flow** stories (paste-a-repo `/new`, Ask, embed/oEmbed) from documented templates (`flow-story.ts`); enrichment only fills accepted `responsibility` into copy. Overview remains the default C4 nest tour. Stories are the **marketing-gold** surface an embed can autoplay-off and a reader can launch — a system explains itself without a maintainer narrating.

### Knowledge-graph summaries at each level

At every level the user gets an inferred, evidence-linked **responsibility** — a one-line "what this is and does," curated with linked source, never a bare confidence percentage ([`golden-okie-hierarchy.md`](./golden-okie-hierarchy.md) "Golden responsibilities"). The hierarchy reads as a graph you can query at any altitude:

| Level | Summary the user gets | Backing query |
|---|---|---|
| L1 Context | System purpose + people/external relationships | snapshot roots + relations |
| L2 Containers | Container responsibility + technology + direct relationships | scoped view |
| L3 Components | Component role + local relationships + source anchors | scoped view |
| L4 Code | Symbol/module, path, line range, parent component | file outline |

The same summaries are exposed to agents over the read surface in [`mcp-surface.md`](../roadmap/mcp-surface.md) (`get_entity`, `get_scoped_view`, `get_file_outline`, `get_spec` with tiered `summary`/`deepDive`) — the shared-query-layer rule guarantees a human and an agent read *the same graph*. Deterministic facts carry no percentage; inferred/explanation claims carry an honest qualifier.

## 3. Embedding & sharing

[`embed-hosting.md`](../roadmap/embed-hosting.md) is the authority for the `/embed` route, chrome policy, asset layout, and caching. This section extends it only where it is thin.

### Deep links into a scope or story

The atlas's own URL state already encodes scope, selection, camera, and paused story frame ([`interaction-semantics.md`](./interaction-semantics.md); `canonicalNavigationUrl` rewrites only the query and preserves the path). So a deep link is *free*: the clean hosting path selects the repo, and the preserved `?nav=…` query selects the scope/story within it — the two coexist on one URL ([`embed-hosting.md`](../roadmap/embed-hosting.md) §1). Product surfaces to add: a **"Copy link to this view"** action (already the natural output of the nav state) and an **embed snippet that inherits the current scope/story**, so a docs author can embed *exactly* the component or tour they're writing about, not the L1 root.

```
https://atlas.okie.dev/r/colinhacks/zod?nav=1&root=<id>&story=<id>&step=3
https://atlas.okie.dev/embed/r/colinhacks/zod?root=<id>          ← scoped embed
```

### Embed snippet shape — iframe first, script as progressive enhancement

[`embed-hosting.md`](../roadmap/embed-hosting.md) §2 specifies the iframe. Recommendation: **iframe is the canonical, only-required snippet** — it is CSP-isolated, works in every docs pipeline (Markdown, MDX, Docusaurus, GitBook), and needs no trust of Okie JS on the host page. Offer a `<script>` loader *only* as an optional enhancement for auto-sizing (post-message height) and lazy mount; it must degrade to a plain iframe when JS is blocked. Never make the script the required path — a docs PR reviewer will reject third-party JS far more readily than a sandboxed iframe.

```html
<!-- canonical: copy-paste, no JS trust required -->
<iframe src="https://atlas.okie.dev/embed/r/colinhacks/zod"
        width="100%" height="560" loading="lazy"
        style="border:0;border-radius:12px"
        title="zod architecture atlas — built with Okie"></iframe>
```

### Versioning & refresh on new commits

Fully owned by [`embed-hosting.md`](../roadmap/embed-hosting.md) §4 + [`scan-runner.md`](../roadmap/scan-runner.md) R3b: commit-pinned objects are immutable and cache-forever; `latest` is a cheap mutable alias; a push/cron rescan publishes a *new* sha prefix and flips only `latest` + the manifest row. Product layer on top: **the snippet defaults to `latest`** (a docs page wants the current picture) and offers a `.../<sha>` variant for authors who want a frozen diagram, with the pinned sha carried in the attribution back-link. For owned repos, "refresh on push" is a per-atlas toggle the App's webhook drives.

### Private embeds & auth

[`embed-hosting.md`](../roadmap/embed-hosting.md) lists private-repo embeds as an explicit non-goal for v1 (public-only). This flow needs them for the connected-repo audience, so here is the thin extension it defers:

- **Public embed** = no auth; the object is world-readable behind the CDN (v1 as written).
- **Private embed** = the atlas objects sit behind an auth check, and the snippet carries a **signed, scoped, expiring embed token** (per-atlas, revocable, `frame-ancestors`-locked to the customer's own domains). The token authorizes *reading a specific atlas in a specific frame*, never the GitHub App's repo access — the two are separate trust domains. Recommendation: **defer private embeds to a paid tier after public embeds prove the loop**, exactly as [`embed-hosting.md`](../roadmap/embed-hosting.md) frames it; when built, use signed embed tokens + `frame-ancestors` allowlist, not IP or referrer checks.

## 4. Open questions (founder decisions)

1. **Is enrichment free on pasted public repos, or sign-in-gated?**
   Enrichment is the only paid (LLM) step and the only anonymous-spend risk. **Recommendation:** publish the deterministic atlas free and instantly for everyone; gate *enrichment of arbitrary pasted repos* behind sign-in once cost is real, while keeping enrichment automatic for the operator-curated flagship set. The deterministic base is already a complete, shippable product ([`embed-hosting.md`](../roadmap/embed-hosting.md) §5), so this costs the anonymous user nothing essential.

2. **When does the GitHub App land, and does OAuth ship before it?**
   **OAuth-lite ships in this slice** (sign-in required to scan a public repo; account-keyed submit limiter). Private repos still need App installation-token mint — identity is present, private trees stay closed until that follow-up.

3. **Framing/CSP posture at launch — open vs. allowlist?**
   [`embed-hosting.md`](../roadmap/embed-hosting.md) flags this as a pre-launch checklist item. **Recommendation:** ship **public embeds with open `frame-ancestors`** (the growth loop wants zero friction to embed anywhere) and reserve the `frame-ancestors` *allowlist* for private embeds, where restricting to the customer's domains is a feature, not a limit. Never `X-Frame-Options: DENY` on `/embed/*`.

---

Cross-references: [`../roadmap/scan-runner.md`](../roadmap/scan-runner.md) (acquisition, checkout, cadence) · [`../roadmap/scraper-pipeline.md`](../roadmap/scraper-pipeline.md) (stages, the gate, fan-out) · [`../roadmap/embed-hosting.md`](../roadmap/embed-hosting.md) (hosting, `/embed`, caching, versioning) · [`../roadmap/mcp-surface.md`](../roadmap/mcp-surface.md) (the same graph for agents) · [`golden-okie-hierarchy.md`](./golden-okie-hierarchy.md) & [`interaction-semantics.md`](./interaction-semantics.md) (the deliverable's contract).
