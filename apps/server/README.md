# @okie/server

Local paste-a-repo scan process used by `pnpm dev` (Vite proxies `/api` and `/scan` here).

**This is not a deployable public API.** The process has no authentication: `POST /api/scans` enqueues work, job list/status are open, and `/scan/*` serves artifacts from disk. If a gateway or Anthropic key is set in the process, enrichment is attempted for whoever can POST.

## Published defaults

- Listen bind is loopback (`127.0.0.1:4180`). Override with `OKIE_SERVER_HOST` / `OKIE_SERVER_PORT` only when LAN access is intentional — that still has no auth.
- `GET /healthz` (and `GET /`) reports `{ service, ok, public: false, bind, enrich }`. It does not return `scanRoot`, filesystem paths, or LLM keys.
- GitHub acquisition on this HTTP path is anonymous HTTPS (no operator `gh` auth). The CLI scanner is a separate, operator-local tool.

Do not expose this process on a public interface, a reverse proxy, or a hosted deployment until it has real auth.

## LLM gateway (OpenRouter first)

Optional enrichment talks to an OpenAI-compatible gateway. Defaults suit OpenRouter:

| Setting | Env | Default |
|---|---|---|
| Base URL | `OKIE_LLM_BASE_URL` or `OPENAI_BASE_URL` | `https://openrouter.ai/api/v1` |
| API key | `OKIE_LLM_API_KEY` or `OPENROUTER_API_KEY` or `OPENAI_API_KEY` | unset (enrichment skipped) |
| Model id | `OKIE_LLM_MODEL` or `OPENROUTER_MODEL` or `OPENAI_MODEL` | `anthropic/claude-sonnet-4` |

Keys live in `.env` / process env only (gitignored). Put the key in a repo-root `.env`; the server loads it at startup without overriding variables already in the environment. Do not commit a key. There is no `.env.example` (CLA-16).

Non-secret overlay (base URL / model id only) can live in `okie.local.json` at the repo root, or in a JSON file pointed at by `OKIE_LLM_CONFIG`:

```json
{ "baseUrl": "https://openrouter.ai/api/v1", "modelId": "anthropic/claude-sonnet-4" }
```

An `apiKey` field in that file is ignored. `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` remain a fallback for the existing Anthropic SDK path.

No key: enrichment is skipped and the deterministic atlas still publishes. Auto enrichment is also skipped when `OKIE_SCAN_ENRICH=0`.
