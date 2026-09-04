# @okie/server

Local paste-a-repo scan process used by `pnpm dev` (Vite proxies `/api` and `/scan` here).

**This is not a deployable public API.** Hosted scan (`POST /api/scans`) requires a GitHub OAuth session (or a loopback test-double). Job list/status and `/scan/*` objects are still unauthenticated so public `/r/<owner>/<repo>` views have no login wall. If a gateway or Anthropic key is set in the process, enrichment is attempted for whoever can POST a scan.

## Published defaults

- Listen bind is loopback (`127.0.0.1:4180`). Override with `OKIE_SERVER_HOST` / `OKIE_SERVER_PORT` only when LAN access is intentional.
- `GET /healthz` (and `GET /`) reports `{ service, ok, public: false, bind, enrich }`. It does not return `scanRoot`, filesystem paths, LLM keys, OAuth secrets, or tokens.
- Hosted scan requires GitHub identity. `GET /api/auth/github` starts OAuth (`state` CSRF cookie; `redirect_uri` from `OKIE_PUBLIC_ORIGIN`, never the Host header). Callback tokens stay in the in-memory session — never in URLs, logs, or `/healthz`. GitHub reads use HTTPS Bearer for OAuth, or HTTPS-only for the loopback test-double. Never operator `gh`, never `GITHUB_TOKEN` / `GH_TOKEN`.
- Loopback without OAuth client credentials enables `GET /api/auth/github/test-login` so local QA can sign in without live GitHub App secrets. That path is off when the bind is not loopback.
- Public atlas *views* are the web app's `/r/<owner>/<repo>` URLs (CLA-30). They have no login wall. `/r/THISS/okie` is the dogfood share URL (published scan, bundled self-scan, or the golden demo). Docs sites embed those views via the web origin's `GET /oembed?url=` (JSON iframe payload); crawlers read Open Graph tags from the same share URL. This scan process does not serve oEmbed or OG images.

Do not expose this process on a public interface, a reverse proxy, or a hosted deployment until OAuth client credentials are set in env (gitignored) and you accept the remaining unauthenticated surfaces (`GET /scan/*`, job list).

GitHub OAuth env (never commit, never log):

| Setting | Env | Notes |
|---|---|---|
| Client ID | `OKIE_GITHUB_CLIENT_ID` | GitHub App or OAuth App client id |
| Client secret | `OKIE_GITHUB_CLIENT_SECRET` | Env only |
| Public origin | `OKIE_PUBLIC_ORIGIN` | Callback + cookie origin (default `http://localhost:4173`) |
| App slug | `OKIE_GITHUB_APP_SLUG` | Optional install redirect (`/api/auth/github/install`) |
| Test double | `OKIE_GITHUB_TEST_DOUBLE` | `1` force on / `0` force off; default on for loopback when OAuth is unset |

## LLM gateway (OpenRouter first)

Optional enrichment talks to an OpenAI-compatible gateway. Defaults suit OpenRouter:

| Setting | Env | Default |
|---|---|---|
| Base URL | `OKIE_LLM_BASE_URL` or `OPENAI_BASE_URL` | `https://openrouter.ai/api/v1` |
| API key | `OKIE_LLM_API_KEY` or `OPENROUTER_API_KEY` or `OPENAI_API_KEY` | unset (enrichment skipped) |
| Model id | `OKIE_LLM_MODEL` or `OPENROUTER_MODEL` or `OPENAI_MODEL` | `z-ai/glm-5.3-flash` |

Keys live in `.env` / process env only (gitignored). Put the key in a repo-root `.env`; the server loads it at startup without overriding variables already in the environment. Do not commit a key. There is no `.env.example` (CLA-16).

Ask Atlas (`GET`/`POST /api/ask`) uses the same gateway and the same GitHub session as hosted scan. `GET /api/ask` returns `{ connected: true|false }` with no key, base URL, or model id — it does not require sign-in. `POST /api/ask` and `GET /api/ask/thread` require a GitHub session (or loopback `test-login`): **401 without one**, and the gateway is not called. Unsigned visitors keep the deterministic atlas. With a session and a key, `POST /api/ask` answers one question from the client-supplied packets and accepted summaries for the selected (or isolated) scopes — never a silent whole-repo dump — and appends that Q&A to an in-process thread keyed by GitHub user + `owner/repo` + `commitSha`. Citations are filtered to those scope ids. The operator gateway key stays in process `.env`; it is never stored on the user, never written into a thread, never logged, and never returned on `/healthz`. Anthropic fallback keys do not connect Ask; the OpenAI-compatible gateway is the path.

Non-secret overlay (base URL / model id only) can live in `okie.local.json` at the repo root, or in a JSON file pointed at by `OKIE_LLM_CONFIG`:

```json
{ "baseUrl": "https://openrouter.ai/api/v1", "modelId": "z-ai/glm-5.3-flash" }
```

An `apiKey` field in that file is ignored. With a gateway key, each enrichment scope POSTs the bounded, redacted packet to `{baseUrl}/chat/completions` (OpenAI-compatible). Packet excerpts reuse the existing GitHub token scrub (`gho_` / `ghp_` / `github_pat_`); the operator key is stripped from the outbound JSON body (it stays on `Authorization`). Gateway error strings are scrubbed the same way before `job.error` and logs. The reply's `choices[0].message.content` is parsed into the container-id-keyed document the merge gate already consumes. Live prompts ask for a short summary of **that packet's scope only**; hallucinated ids and out-of-scope entities still reject the scope. `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` remain a fallback for the Anthropic SDK and are not sent to the gateway. Packets are built and sent only while the ephemeral checkout exists.

No key: enrichment is skipped and the deterministic atlas still publishes. Auto enrichment is also skipped when `OKIE_SCAN_ENRICH=0`. OpenRouter is optional — paste-a-repo still maps the repo without a gateway key.

The scan job (`GET /api/scans/:id`) and the paste-a-repo landing report whether enrichment **ran** (provider host + model id), was **skipped (no key)**, or **failed**. They never include the API key or a gateway URL that carries a token (`user:pass@host`, `?api_key=`). `GET /healthz` stays `{ service, ok, public, bind, enrich }` — no keys, no model id, no `scanRoot`.

The enrichment pass uses the configured model id as an opaque string (no hardcoded model table beyond the default above). Change the env var or `okie.local.json` — no code change. A present-but-empty model (`OPENROUTER_MODEL=""`, or `"modelId": ""` in local config) or a provider-rejected id fails **the enrichment pass only**: the job still completes with the deterministic atlas and an enrichment failed note.

Enrichment is bounded so a paste-a-repo job cannot run unbounded:

| Setting | Env | Default |
|---|---|---|
| Per-request timeout | `OKIE_LLM_TIMEOUT_MS` | `60000` (60s) |
| Max scopes per scan | `OKIE_LLM_MAX_SCOPES` | `16` |
| Max tokens per scan | `OKIE_LLM_MAX_TOKENS` | `200000` (from gateway `usage` when present) |
| Max code entities per packet | (constant `MAX_ENRICHABLE_CODE_ENTITIES`) | `500` (covers THISS/okie `@okie/web` chunk 1 at 474; oversized *packets* skip, remainders can still run) |
| Max dollars per scan | `OKIE_LLM_MAX_DOLLARS` | `1` (enforced only if the gateway returns cost) |
| Global max tokens | `OKIE_LLM_GLOBAL_MAX_TOKENS` | unset (no process-wide token ceiling) |
| Global max dollars | `OKIE_LLM_GLOBAL_MAX_DOLLARS` | unset (no process-wide dollar ceiling) |

A per-scope timeout omits that scope and continues. Hitting a scan-level cap skips remaining scopes; the deterministic atlas stays live. HTTP 429 or 5xx skips remaining scopes, records **enrichment failed**, and leaves the atlas up. Invalid env values keep the defaults. These numbers are not on `/healthz`.

The system packet is scheduled **before** container packets so a 200k token cap cannot starve the system-scope summary after three container proposals. A packet over the 500-code cap is skipped on its own; remainder chunks for the same container are still asked when they fit. The 2000 hang-guard is a different axis and is not this table.

The global token/$ cap is a **process-wide** ceiling across GitHub users (CLA-38), not a per-account quota. The existing 5 scans / 10 minutes per-user (plus IP) submit limiter stays. When the process is already at the global cap, enrichment is skipped (`enrichment.state: skipped`, note `global enrichment budget reached`) and the deterministic atlas still publishes. Unset / invalid global env values mean no global ceiling — only the per-scan caps apply. Dollar totals are enforced only when the gateway reports cost. Spend totals, keys, and gateway URLs never appear on `/healthz`, in job JSON, or in logs.
