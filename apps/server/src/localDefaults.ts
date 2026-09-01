/**
 * Local-operator defaults for the scan HTTP process.
 *
 * Hosted *scan* (`POST /api/scans`) requires GitHub sign-in. Public atlas
 * *views* (`/r/<owner>/<repo>` on the web app, `/scan/*` objects here) have
 * no login wall (CLA-30). The published listen bind is loopback so LAN/WAN
 * clients cannot hit the unauthenticated surfaces that remain (CLA-17).
 */

export const DEFAULT_LISTEN_HOST = "127.0.0.1";

export type EnrichMode = "off" | "force" | "auto";

/** Loopback unless the operator explicitly sets OKIE_SERVER_HOST. */
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
