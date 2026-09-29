# Cloudflare deploy runbook (CLA-266)

This runbook covers how to set up, publish, deploy and roll back sourcefor.dev: the edge Worker `sourcefor-atlas`
and published atlases in R2. For the design, measurements and costs, see
[`../roadmap/cloudflare-deployment.md`](../roadmap/cloudflare-deployment.md).

**Launch is browse-only.** Staging and production deploy the Worker without the Ask container: their `wrangler.jsonc`
envs have no `containers` entry and no `ATLAS_API` binding, and `ASK_ENABLED` is `"0"`. Every browsing request (the
atlas, packs, excerpts, `source.json`, share pages) is served by the Worker from R2, plus GitHub raw for
`source.json`. `/api/auth/me` answers `ask: false`, and the web app hides Ask. `POST /api/ask` and
`POST /api/block-plan` return 404 at the edge. The container class, guard chain and proxy code stay in the repo for the
signed-in-Ask follow-up; only the local top-level env keeps the container.

Environments:

| Env | Host | Worker | R2 bucket |
|---|---|---|---|
| local (`wrangler dev`) | 127.0.0.1:4196 | — | `sourcefor-atlas-local` (on disk under `apps/edge/.wrangler/state`) |
| staging | staging.sourcefor.dev | `sourcefor-atlas-staging` | `sourcefor-atlas-staging` |
| production | sourcefor.dev (+ www.sourcefor.dev → 301 to the apex) | `sourcefor-atlas-production` | `sourcefor-atlas` |

Credentials: run `pnpm --filter @okie/edge exec wrangler login` once (OAuth). The account id is not a secret and sits in
`apps/edge/wrangler.jsonc` (`account_id`, inherited by every env), so `deploy:<env>` needs nothing from `.env`. Don't
set `CLOUDFLARE_API_TOKEN`: a token in the environment overrides the OAuth session. `deploy:<env>` and
`pnpm publish:atlas` strip it (the publish script also strips `CF_API_TOKEN` / API keys) from the wrangler child and
print a one-line note if they found one.

## 1. First-time setup (once per environment)

1. **Prerequisites:** Node 22+, pnpm 11.10+ and wasm-pack. Docker is not needed: the browse-only envs have no
   container image. Then run `pnpm install && pnpm build`.
2. **Buckets:**
   `pnpm --filter @okie/edge exec wrangler r2 bucket create sourcefor-atlas-staging` (and `sourcefor-atlas` for
   production). Leave them private: there is no public bucket URL, because the Worker is the only reader.
3. **Rate-limit namespaces:** the `namespace_id` values in `apps/edge/wrangler.jsonc` (`2661` staging, `2662`
   production) are integers you choose, and each must be unique in the account. Change them if they collide.
4. **Secrets:** none are needed for the browse-only launch. The table below is for when Ask is turned on later (names
   only; set each with `pnpm --filter @okie/edge exec wrangler secret put <NAME> --env <staging|production>`):

   | Secret | Used by | Required |
   |---|---|---|
   | `OKIE_LLM_API_KEY` | Ask (OpenRouter-compatible gateway). Passed into the container env at start. | yes, for Ask |
   | `JEV_API` | Jev block planner. Passed into the container env. | only with `OKIE_JEV_BLOCK_PLANNER=on` |
   | `TURNSTILE_SECRET_KEY` | Turnstile guard | only with `TURNSTILE_ENABLED=1` |

   Optional non-secret vars (set in `wrangler.jsonc` per env): `ASK_ENABLED` (`"0"` at launch; `"1"` turns on Ask and
   block-plan, which also needs the container back in the env), `OKIE_LLM_MODEL`, `OKIE_JEV_BLOCK_PLANNER`,
   `OKIE_ASK_PER_IP_WINDOW`, the budget caps below, and `TURNSTILE_ENABLED`. Nothing is baked into the image.
5. **Budget caps** (per env `vars`; dormant while `ASK_ENABLED` is `"0"`; the values are placeholders until Brenton
   sets the real ones). A cap of `0` refuses everything; an unset or invalid value uses the placeholder.

   | Var | Placeholder | Meaning |
   |---|---|---|
   | `ASK_DAILY_MAX_DOLLARS` | 2 | Ask dollar ledger per UTC day (estimate reserved, settled to the gateway-reported cost) |
   | `ASK_ESTIMATED_DOLLARS_PER_REQUEST` | 0.01 | Reservation per Ask; kept when the gateway reports no cost |
   | `ASK_DAILY_MAX_REQUESTS` | 500 | Asks per UTC day |
   | `BLOCK_PLAN_DAILY_MAX_REQUESTS` | 200 | Block plans per UTC day (Jev reserves $0.003 each) |

6. **WAF (recommended):** in the dashboard (Security → WAF → Rate limiting rules), add a rule for
   `http.request.uri.path wildcard "/api/*"`, keyed by IP. The Free plan allows 1 rule with a 10 s period; Pro allows a
   1 min period.
7. **Custom domains:** these are created by the first deploy (`routes[].custom_domain: true`): `staging.sourcefor.dev`,
   and `sourcefor.dev` plus `www.sourcefor.dev` for production. The Worker 301s `www.<host>` to the same path and
   query on `OKIE_PUBLIC_ORIGIN` before anything else. The Worker runs first for every path (`run_worker_first: true`);
   `_headers` still apply to what it passes through `env.ASSETS`. A missing `/assets/*` file (a chunk of the previous
   build, asked for by a page loaded before a deploy) answers 404 `no-store` rather than the SPA shell. The cost is one
   Worker invocation per asset request (a pass-through; negligible on Workers Paid). Staging sets
   `ROBOTS_NOINDEX=1`: `X-Robots-Tag: noindex, nofollow` on every response and a disallow-all `/robots.txt`.
   The Worker also sets the security headers on every response (CLA-318, `apps/web/src/securityHeaders.ts`):
   `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin` everywhere, and a
   `Content-Security-Policy` on HTML only. Pages under `/r/...` have no `frame-ancestors`, because oEmbed iframes them
   with `?embed=1` and `*` would still block file:, data:, blob: and sandboxed parents. Every other page has
   `frame-ancestors 'self'`. There is no `X-Frame-Options`. Only when `WEB_ANALYTICS_TOKEN` is set (step 8) does the
   CSP also allow Cloudflare Web Analytics (`static.cloudflareinsights.com` script, `cloudflareinsights.com`
   reports); without it, no `cloudflareinsights` source appears. `vite preview` mirrors the headers (without analytics);
   `vite dev` never gets the CSP, because Vite's HMR uses inline scripts.
   `/sitemap.xml` lists `/`, `/new` and every published atlas's canonical `/r/<slug owner>/<slug repo>` on
   `OKIE_PUBLIC_ORIGIN`, with `lastmod` from `publishedAt`. It is served with `cache-control: public, max-age=300`.
   The Worker builds it from `index.json`, which each Worker isolate reads from R2 at most once a minute (the same
   cache serves the `/r` titles). A new publish can therefore take about a minute to appear in the sitemap, and up to
   5 more minutes in shared caches. Production's `robots.txt` points to it.
8. **Web Analytics (production only):** Cloudflare Web Analytics is cookieless, so there is no consent banner and no
   other tracker. In the dashboard (Analytics & Logs → Web Analytics → Add a site → `sourcefor.dev`), choose the
   **manual JS snippet install** and leave **automatic setup / JS snippet injection off** for the zone: the Worker
   injects the snippet itself, and Cloudflare's automatic injection on top would count every page view twice. Copy
   the site token from the snippet's `data-cf-beacon` (it is public; it ships in every page). Add
   `"WEB_ANALYTICS_TOKEN": "<token>"` to `env.production.vars` in `apps/edge/wrangler.jsonc`, then run `pnpm build`
   and `deploy:production`. The Worker then adds the beacon just before `</body>` of every HTML page it serves: the
   SPA shell, `/new`, `/r/...` (oEmbed embeds included; `WEB_ANALYTICS_IN_EMBEDS` in `apps/edge/src/analytics.ts`
   turns that off) and the 404 pages. JSON, PNG, assets and the sitemap are never touched. A token that is not 16-64
   letters or digits is ignored (no beacon, and no `cloudflareinsights` in the CSP). Injected pages carry no ETag or
   Last-Modified, and the Worker drops conditional headers on the shell, so the shell (`max-age=0,
   must-revalidate`) is refetched in full rather than 304'd to a copy without the beacon. Staging and local dev stay unset. The web build (and the portable
   viewer) never contain the beacon. To turn analytics off, remove the var and redeploy.
9. **First-deploy lessons (fresh account):**
   - Error **10063**: the account has no workers.dev subdomain yet. Open Workers & Pages in the dashboard once to
     create it, then deploy again.
   - Error **100117**: a custom-domain hostname already has DNS records. Delete them in the dashboard (DNS → Records)
     first, then deploy again.

## 2. Publish an atlas

Scan and publish in the local operator UI as usual. Then upload the repository's current publication:

```sh
pnpm --filter @okie/server build        # the publish script runs from apps/server/dist
pnpm publish:atlas --repo thiss/okie --env staging --scan-root ~/sites/okie/fixtures/scan
pnpm publish:atlas --repo thiss/okie --env production --scan-root ~/sites/okie/fixtures/scan --yes
```

- The operator store is read-only here: the script never takes the lock and never writes.
- Licence first: it asks the GitHub licence API for the repository at the published commit (unauthenticated) and records
  `{ spdxId, name, url }` in the manifest and the index row. No licence file, GitHub's `NOASSERTION`, or a failed lookup
  refuses the publish. After checking the repository's terms by hand, pass `--license-override` with an SPDX id or an
  SPDX expression (no lookup, no URL). Quote expressions and use upper-case operators: `--license-override "MIT AND
  CC-BY-4.0"` (code MIT, docs CC-BY, e.g. facebook/docusaurus), `--license-override "Unlicense OR MIT"` (dual
  licence, e.g. BurntSushi/ripgrep). The attribution strip shows an expression as `licence: <expression>`. A version is
  immutable, so changing the licence of a published atlas needs a new operator publication (a new version id).
- GitHub's casing: the publish also asks `GET api.github.com/repos/<owner>/<repo>` (unauthenticated) and records
  `ownerLogin` / `repoName` in the index row (`BurntSushi` where `owner` is `burntsushi`). The attribution strip, the
  `/new` list, and the `/r` title, oEmbed title and card text show that casing. Without it they show the stored names.
  URLs keep the slug form. A failed lookup doesn't stop the publish: the row keeps the names it already had, or goes
  without. To fill rows published before CLA-318, run the one-off backfill. It rewrites `index.json` only: no new
  versions, pointers or manifests. Rows that already have both names are skipped, and a failed lookup leaves its
  row unchanged:

  ```sh
  pnpm publish:atlas --env staging --backfill-names --dry-run   # reads the env's index.json, prints one line per row, writes nothing
  pnpm publish:atlas --env staging --backfill-names
  pnpm publish:atlas --env production --backfill-names --yes
  ```

  `--env local [--persist-to <dir>]` runs against the local bucket, and `--dry-run --out <dir>` runs against a
  directory store. Don't publish while it runs: it reads, then rewrites `index.json`.
- Share URLs: `/r/<owner>/<repo>` resolves through the scan slugger (`BurntSushi` → `burnt-sushi`). A URL that misses
  but matches a published row once case and punctuation are ignored (`/r/burntsushi/ripgrep`) 301s to the canonical
  `/r/<slug owner>/<slug repo>`.
- It uploads the version's `public/` files, `private/operator-explanations.json`, the packs,
  `packs/source-paths.json` (the paths the pinned source view may fetch) and `manifest.json`, then moves `latest.json`,
  then rewrites `index.json`. An unreadable remote `index.json` fails the publish before anything is uploaded.
- Packs: `neighborhood` holds the default view and every entity (leaves included), `excerpt` every entity's excerpt.
  Each entry is its own gzip member of the exact route body (`encoding: "gzip"` in the pack index). thiss/okie
  (4,048 entities) takes ~32 s and ~700 MB RSS to build: neighborhood 432 MB of bodies → 34.7 MB, excerpt 5.1 → 1.9 MB,
  71 MB uploaded in 17 objects. A pack over 300 MB fails the publish (wrangler puts at most 315 MB per object).
- Versions are immutable. Re-publishing the same version is a no-op apart from the pointer and index. A different
  manifest under an existing version id is refused.
- `--dry-run [--out <dir>]` writes the objects to a local directory instead, and `--env local [--persist-to <dir>]`
  writes to the local `wrangler dev` bucket.
- The site picks up a new version without a redeploy:
  - latest-resolved responses cache for 60 s;
  - the container mirror polls `index.json` every 60 s and also fetches on demand.

## 3. Deploy the Worker

```sh
pnpm build                                    # apps/web/dist + gates
pnpm --filter @okie/edge deploy:staging       # wrangler deploy --env staging (Worker + static assets; no container, no Docker)
```

To validate the config without deploying (no account calls, no Docker):
`pnpm --filter @okie/edge exec wrangler deploy --dry-run --env staging --outdir <scratch dir>`. It prints warnings
that the top-level `containers` and `ATLAS_API` binding aren't in the env; that is intended.

Then run the smoke checks against staging:

- `/`, `/new` (published list), `/r/<owner>/<repo>` (atlas renders, OG tags in the HTML), `/og/<owner>/<repo>` (PNG),
  `/oembed?url=https://staging.sourcefor.dev/r/<owner>/<repo>`.
- On `/r/<owner>/<repo>`: no Ask button, panel or ⌘↵ shortcut; no account menu; the attribution strip at the bottom
  shows the repository, commit and licence, linking to GitHub (it is hidden in embeds).
- Headers: `curl -sI <origin>/ | grep -iE 'content-security|x-content-type|referrer-policy'` shows all three
  with `frame-ancestors 'self'`. `curl -sI <origin>/r/<owner>/<repo>` shows a CSP without `frame-ancestors`. A JSON or asset
  response has `nosniff` and no CSP. In a browser, the console on `/`, `/new` and `/r/<owner>/<repo>` (and in an embed)
  shows no `Refused to …` CSP errors.
- `curl -s <origin>/sitemap.xml` lists `/`, `/new` and each published atlas (`content-type: application/xml`).
  Production's `/robots.txt` ends with `Sitemap: https://sourcefor.dev/sitemap.xml`.
- Production with `WEB_ANALYTICS_TOKEN` set: `curl -s https://sourcefor.dev/ | grep -o cloudflareinsights.com/beacon | wc -l`
  prints exactly `1` (same for `/new` and `/r/<owner>/<repo>`). `2` means Cloudflare's automatic injection is also on:
  turn it off (step 8). Staging prints `0`. In a browser, the Network tab
  shows `beacon.min.js` and a `cdn-cgi/rum` POST with no CSP errors, and page views appear in Web Analytics within
  a few minutes.
- `/scan/index.json`, `/api/auth/me` (`{ mode: "public", ask: false }`), `/api/ask` (`{ connected: false }`).
- `curl -s -o /dev/null -w '%{http_code}' <origin>/assets/missing.js` answers `404`, and `curl -sI` on a real chunk
  from the page (`<origin>/assets/index-<hash>.js`) still shows `cache-control: public, max-age=31536000, immutable`
  (`_headers` through the Worker). On staging,
  `curl -sI <origin>/ | grep -i x-robots-tag` shows `noindex, nofollow` and `/robots.txt` disallows everything;
  production serves the allow-all `robots.txt` from the web build.
- `curl -sI -H 'accept-encoding: gzip' '<origin>/scan/<slug>/neighborhood.json'`: `content-encoding: gzip`,
  `vary: Accept-Encoding`.
  The pack must be decompressed exactly once:
  `curl -s --compressed '<origin>/scan/<slug>/neighborhood.json' | node -e 'JSON.parse(require("fs").readFileSync(0, "utf8")); console.log("ok")'`
  prints `ok`. A double-gzipped body fails to parse.
- Open "View full source" in the inspector once. `source.json` fetches the file from GitHub raw at the pinned commit
  and caches the raw file in the Cache API (a year, keyed by repo + commit + path). When GitHub is down or
  rate-limiting, an uncached file answers 502 "Historical source is unavailable right now. The saved excerpt remains
  available." and the saved excerpt still shows.

Production is the same command with `deploy:production`, after staging looks right. Never deploy production first.

## 4. Roll back

- **Worker code:**
  `pnpm --filter @okie/edge exec wrangler deployments list --env <env>`, then
  `pnpm --filter @okie/edge exec wrangler rollback <deployment-id> --env <env>`.
  A rollback restores the Worker script and its static assets.
- **An atlas:** move the pointer back to an earlier immutable version that is already in R2:
  `pnpm publish:atlas --repo <owner/name> --env <env> --set-latest <versionId>` (production also needs `--yes`).
  This checks that the version's manifest exists in that bucket, rewrites `latest.json` and then `index.json` (the row
  is rebuilt from the manifest), and uploads nothing else.
  Version ids are listed in the old manifests (`previousVersionId`) and in the operator UI's publication history.
- **Take an atlas offline:** delete `atlas/v1/repos/<slug>/latest.json` and its row in `index.json`. The versions can
  stay; nothing serves a version without a pointer except pinned `?version=` links.
- **Ask spending too fast (once Ask is on):** set `ASK_ENABLED` to `"0"` and redeploy. Ask and block-plan then 404 at
  the edge, the web app hides Ask, and the atlas stays up. For a softer brake, set `ASK_DAILY_MAX_DOLLARS` /
  `ASK_DAILY_MAX_REQUESTS` low (`0` refuses all).

## 5. Local QA (no Cloudflare account)

Browse-only, exactly as staging/production serve it (no backend, no `.dev.vars` needed):

```sh
pnpm publish:atlas --repo <owner/name> --env local --scan-root <scratch copy of a scan root>
pnpm --filter @okie/edge dev                                  # wrangler dev on 127.0.0.1:4196, containers off
```

With Ask on, against a locally run apps/server:

```sh
cp apps/edge/.dev.vars.example apps/edge/.dev.vars          # uncomment ASK_ENABLED=1; DEV_* are local only
OKIE_SERVER_MODE=public-readonly OKIE_SERVER_PORT=4195 OKIE_SCAN_ROOT=$(mktemp -d) \
  OKIE_PUBLISHED_STORE_URL=http://127.0.0.1:4196/__store node apps/server/dist/main.js
pnpm --filter @okie/edge dev
```

- Don't use ports 4173, 4174 or 4180; they belong to the operator's own servers.
- To try the real container locally (Docker running), run
  `pnpm --filter @okie/edge exec wrangler dev --env='' --port 4197 --enable-containers`.

## Container sizing (not deployed at launch)

This applies once the signed-in-Ask follow-up adds the container back to staging/production (an `ATLAS_API` binding,
and the `containers` entry; the `v1` migration already created `AtlasApiContainer`). The instance is `basic` (1/4 vCPU, 1 GiB, 4 GB disk), `max_instances: 2`, and all traffic goes to one named instance.
It sleeps after 10 minutes idle, and a sleeping container isn't billed.

The image sets these memory defaults:

| Var | Image value |
|---|---|
| `OKIE_ASK_WORKER_MAX_HEAP_MB` | 512 |
| `OKIE_ASK_MAX_WARM_INDEXES` | 2 |
| `OKIE_NEIGHBORHOOD_CACHE_ENTRIES` | 2 |

With those, the measured peak RSS (main process plus Ask worker, three atlases warm, including a 19 MB snapshot) is
about 513 MB. With several near-cap (64 MB) snapshots, move to `standard-1` (4 GiB) and raise the three values.
