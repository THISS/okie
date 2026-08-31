# @okie/server

Local paste-a-repo scan process used by `pnpm dev` (Vite proxies `/api` and `/scan` here).

**This is not a deployable public API.** The process has no authentication: `POST /api/scans` enqueues work, job list/status are open, and `/scan/*` serves artifacts from disk. If `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` is set in the process, enrichment runs for whoever can POST.

## Published defaults

- Listen bind is loopback (`127.0.0.1:4180`). Override with `OKIE_SERVER_HOST` / `OKIE_SERVER_PORT` only when LAN access is intentional — that still has no auth.
- `GET /healthz` (and `GET /`) reports `{ service, ok, public: false, bind, enrich }`. It does not return `scanRoot` or other filesystem paths.
- GitHub acquisition on this HTTP path is anonymous HTTPS (no operator `gh` auth). The CLI scanner is a separate, operator-local tool.

Do not expose this process on a public interface, a reverse proxy, or a hosted deployment until it has real auth.
