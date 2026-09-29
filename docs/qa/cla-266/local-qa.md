# CLA-266 local QA — PARTIAL, pre-fix run

Stopped early on coordinator request: scope changed (Ask disabled at launch). Checks 5 (store route off) and 6
(budget 429) were not run. No Cloudflare account calls were made (local wrangler only; `CLOUDFLARE_*` blanked).

## Setup

- Worktree `okie-work-11` @ `6bc2e92`. Node 22.23.1, pnpm 11.10.0, wrangler 4.136.1 (local), `pnpm build` green.
- Scan root: a scratch copy of `fixtures/scan/operator-v1`. It had no publication, so a scratch script published
  `repo:thiss/okie` draft rev 4 (`OperatorPublicationService.publishDraft`, `acknowledgeCoverage: true` because
  coverage was incomplete) and `acme/demo` (`publishFixtureVersion`).
- `pnpm publish:atlas --repo thiss/okie|acme/demo --env local --scan-root <scratch>`: 16 objects / 76 MB and 12 objects.
- Ports:
  - 4196: `pnpm --filter @okie/edge dev`, with `.dev.vars` = `DEV_BACKEND_ORIGIN=http://127.0.0.1:4195`,
    `DEV_STORE_ROUTE=1`, `OKIE_PUBLIC_ORIGIN=https://staging.sourcefor.dev`.
  - 4195: a logging proxy. It records every request that reaches the backend, with cf-connecting-ip, xff and the
    cost headers.
  - 4197: `apps/server` in public-readonly mode, mirroring from `:4196/__store` (mirrored 2 atlases).
  - 4199: a fake OpenAI-compatible gateway. It cites the first 2 `allowedCitationIds` and returns `usage.cost=0.0042`.
- Browser checks used Playwright at 1440×900. All processes are stopped and `.dev.vars` is removed.

## Results

| # | Check | Result | Evidence |
|---|---|---|---|
| 1a | `/r/THISS/okie` renders from the edge | PASS | `01-atlas-edge-load.png`. Canvas, inspector and L1 all render, and the backend proxy log shows 0 requests. |
| 1b | Drill container → component | PASS, but no pack fetch happens | `02-drill-*.png`. The default packet already holds all 4,048 entities, so the browser drill makes no `focus=` request. A pack hit was checked with curl instead: `neighborhood.json?focus=container:apps-server` returned 200 and nothing reached the backend. |
| 1c | Inspector excerpt | PASS | `03-inspector-excerpt-pack.png`. `excerpt.json?entity=code:…analyze-rust&version=…` returned 200 from the pack with no backend hit. An unknown entity returns 404 and does not wake the backend. |
| 1d | Leaf deep link `?sel=` | PASS (UI). Pack miss checked by curl only | `04-deeplink-leaf-sel.png`. The leaf is selected without any `focus=` fetch, because the whole atlas is resident. A curl of `focus=<leaf>` was proxied to the backend as `…&version=publication-c455…` (200, 118 ms). `excerpts=1` was also proxied with the version pinned. |
| 2a | No account or sign-in menu in the header | PASS, with a transient flash (bug B2) | After `/api/auth/me` resolves, the header buttons are only find, Mermaid, screenshot, link and repo. |
| 2b | Ask without sign-in, answer with citations, 2nd question appends | PASS | `05-ask-open-no-signin.png`, `06-ask-answer-1.png`, `07-ask-answer-2-thread.png`. Each answer shows 2 citations ("Show all 2 on map"). |
| 2c | Cost headers hidden from the browser | PASS | The proxy saw `cost=0.0042 tokens=1050`. The browser response had `x-okie-ask-cost-usd` and `x-okie-ask-tokens` absent, and no `set-cookie`. |
| 3 | `/new` shows the published list | PASS | `08-new-published-list.png`. Headings are "Source For Atlas" and "Published atlases", with 0 inputs or forms and 0 "sign in" text. The list shows acme/demo and thiss/okie. |
| 4a | `/r/<o>/<r>` OG HTML | PASS, with a caveat (B3) | `og:title` and `og:image` are present for THISS/okie, thiss/okie and acme/demo. No `4180` appears. The origin is the request origin (`http://127.0.0.1:4196`). The configured-origin path could not be exercised locally. |
| 4b | `/og/thiss/okie` PNG | PASS | 200 `image/png`, 1200×630 (`10-og-card-thiss-okie.png`). |
| 4c | `/oembed?url=…` | PASS | 200 JSON (rich, iframe `…/r/thiss/okie?embed=1`, thumbnail `/og/thiss/okie`). |
| 4d | Unknown repo | PASS | Each returns 404: `/r/nobody/nothing` (html), `/og/nobody/nothing`, oembed for an unknown repo, and oembed for a foreign origin. |
| 5a | Public `operator-explanations.json` has no claims | PASS | The response has keys `versionId` and `explanations`, with no `claims` or `claimsNote`. |
| 5b | No `private/` via `/scan/*` | PASS | Each returns 404: `private/…`, `..%2fprivate…`, `%2e%2e/versions/…/private/…`, `?version=../../private`, `?version=<v>/private`, `manifest.json`, `latest.json`, `atlas.okie.json`, `neighborhood.pack`. `/scan/%2e%2e/%2e%2e/atlas/…/private/…` returns 200, but it is the SPA `index.html` (the path normalises out of `/scan/`), not the object. |
| 5c | `/__store` with `DEV_STORE_ROUTE` unset | NOT RUN | The code returns 404 unless `=== '1'` (`index.ts`). |
| 5d | Spoofed `CF-Connecting-IP` | FAIL locally (see B1) | wrangler does not overwrite the header. |
| 5e | Operator and auth routes return 404 | PASS | `/api/auth/github`, `…/callback`, `/api/auth/logout`, `/api/operator/runs` (GET and POST), `/api/operator/session`, `/api/scans` (GET and POST), `/api/scan`, `PUT` and `DELETE /api/ask` all return 404, and none reach the backend. `/api/auth/me` returns `{authenticated:false, mode:"public"}`. |
| 6 | Budget cap: 3rd Ask returns 429 in the panel | NOT RUN | The edge per-IP rate limiter was seen returning 429 after 10 requests a minute. |
| 7 | Wasm MIME, immutable assets, root headers | PASS | The `.wasm` is served as `application/wasm`. `/assets/*` has `public, max-age=31536000, immutable`. `/` has `Origin-Agent-Cluster: ?1` and `Permissions-Policy: tools=(self)`. |

## Bugs / findings

**B1 — `CF-Connecting-IP` does not reach the backend, and a client-supplied value keys the edge limiter
locally (medium; production behaviour unverified).**

Repro (wrangler dev + `DEV_BACKEND_ORIGIN`):

```
for i in $(seq 1 12); do curl -s -o /dev/null -w "%{http_code} " -X POST :4196/api/ask \
  -H 'content-type: application/json' -H "CF-Connecting-IP: 10.0.0.$i" -d '{"question":"x","packets":[],"relations":[],"atlas":{"owner":"thiss","repo":"okie","commitSha":"2d19ce39…"}}'; done
```

- **Distinct spoofed IPs.** All 12 requests return 200. With one fixed spoofed IP, or with no header, the 11th and
  12th return 429. So locally the Worker keys `ASK_RATE_LIMITER` on the client-supplied header. In production the
  Cloudflare edge overwrites that header, so this part is local only.
- **Header dropped on the proxy hop.** The logging proxy saw `cf-connecting-ip=-` on every proxied request, even
  though `proxiedRequest` sets it. So workerd drops `CF-Connecting-IP` on the outbound `fetch()` to
  `DEV_BACKEND_ORIGIN`.
- **Risk if the container hop does the same.** If `ATLAS_API.getByName(...).fetch` behaves this way, the container
  under `OKIE_TRUSTED_PROXY=cloudflare` falls back to the socket address. Every public client would then share one
  CLA-304 per-IP window, with no loopback exemption, and that becomes a global throttle.
- **Next step.** Verify on staging, or with `--enable-containers`. If the header is stripped, forward it under a
  private header name (for example `x-okie-client-ip`) that the Worker sets after deleting any client copy.

**B2 — Sign-in affordance flashes before `/api/auth/me` resolves (low).** The first a11y snapshot of `/r/THISS/okie`
contained `group > "Sign in with GitHub" "?"` in the banner. Once `auth/me` returned `mode: "public"` it was gone.
Repro: load `/r/THISS/okie` and snapshot immediately. Public mode could default to "no account UI" until the answer
arrives.

**B3 — The configured `OKIE_PUBLIC_ORIGIN` could not be exercised locally (info).** Share tags use the request
origin. With `Host: staging.sourcefor.dev`, wrangler builds `http://staging.sourcefor.dev`, which is not the
allowlisted `https://…`, so the response is 404. The same happens with `Host: evil.example`, which is correct. The
check still needs an https run (`--local-protocol https`) or staging. `X-Forwarded-Host: evil.example` is ignored,
which is correct.

**B4 — Console noise in public mode (low).**

- Every atlas load logs 404s for `enrichment-report.json` and `enrichment-status.json`. Those files are optional
  and absent from the publication; for acme/demo `stories.json` is also missing.
- `/new` calls `GET /api/operator/session`, which returns 404.
- The browser logs all of these as console errors.

**B5 — Stale container Durable Object alarm errors in wrangler dev (low, dev only).** The existing
`apps/edge/.wrangler/state` held an `AtlasApiContainer` alarm. With containers disabled, it logs "Containers have
not been enabled for this Durable Object class" at startup. Clear the state, or use `--persist-to`, to avoid it.

**Pre-existing, not CLA-266.** The live region reads "Okie architecture atlas loaded. Okie selected." on
`/r/acme/demo`. It is hard-coded in `App.tsx:1537` and dates from the baseline commit.
