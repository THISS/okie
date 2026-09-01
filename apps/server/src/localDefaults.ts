/**
 * Local-operator defaults for the unauthenticated scan HTTP process.
 *
 * This service has no auth. The published listen bind is loopback so LAN/WAN
 * clients cannot hit POST /api/scans, list jobs, or read scan artifacts
 * (CLA-17). Public atlas *views* are the web app's `/r/<owner>/<repo>` URLs
 * (CLA-30) — they have no login wall. Do not treat apps/server as a
 * deployable public API until GitHub auth/quotas land.
 */

export const DEFAULT_LISTEN_HOST = "127.0.0.1";

export type EnrichMode = "off" | "force" | "auto";

/** Loopback unless the operator explicitly sets OKIE_SERVER_HOST (still no auth). */
export function resolveListenHost(env: NodeJS.Dict<string> = process.env): string {
  const raw = env.OKIE_SERVER_HOST?.trim();
  return raw ? raw : DEFAULT_LISTEN_HOST;
}

/**
 * GET /healthz (and GET /) payload. Must not include scanRoot or any other
 * absolute filesystem path — those are operator-local and must stay off the wire.
 */
export function healthzBody(options: { enrich: EnrichMode; bind: string }): {
  service: "okie-scan-server";
  ok: true;
  public: false;
  bind: string;
  enrich: EnrichMode;
} {
  return {
    service: "okie-scan-server",
    ok: true,
    public: false,
    bind: options.bind,
    enrich: options.enrich,
  };
}
