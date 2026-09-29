import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { clientIpKey, isLoopbackAddress } from "./jobs.js";

/**
 * CLA-266 trusted-proxy client address. Off by default: the client is the raw socket address.
 * `OKIE_TRUSTED_PROXY=cloudflare` (the container behind the edge Worker) trusts, in order:
 *   1. `CF-Connecting-IP` when it parses as an IPv4/IPv6 literal;
 *   2. `x-okie-client-ip` — the Worker→container hop may drop CF-Connecting-IP, so the Worker deletes any
 *      client-sent copy of this header and sets it from its own CF-Connecting-IP;
 *   3. the socket address.
 * X-Forwarded-For is never trusted: any hop can append to it.
 */
export type TrustedProxy = "cloudflare";

export const CLOUDFLARE_CLIENT_IP_HEADER = "cf-connecting-ip";
/** Set by the edge Worker (after deleting any client copy) from the request's CF-Connecting-IP. */
export const EDGE_CLIENT_IP_HEADER = "x-okie-client-ip";

/** `OKIE_TRUSTED_PROXY`: only the exact value `cloudflare` enables a proxy; anything else is untrusted. */
export function resolveTrustedProxy(env: NodeJS.Dict<string> = process.env): TrustedProxy | undefined {
  return env.OKIE_TRUSTED_PROXY?.trim().toLowerCase() === "cloudflare" ? "cloudflare" : undefined;
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name];
  // A repeated header is ambiguous (a client could have supplied one copy): never trusted.
  return typeof raw === "string" ? raw.trim() : undefined;
}

/** A bare IP literal (no zone id, no port, no brackets) or undefined. */
export function parseIpLiteral(value: string | undefined): string | undefined {
  if (!value || value.length > 45 || value.includes("%")) return undefined;
  return isIP(value) ? value : undefined;
}

export interface ClientAddress {
  /** The address the per-IP windows key on (before `clientIpKey` normalisation). */
  address: string;
  /** True when the address came from a trusted proxy header. */
  fromProxy: boolean;
}

export function resolveClientAddress(request: IncomingMessage, trustedProxy: TrustedProxy | undefined): ClientAddress {
  if (trustedProxy === "cloudflare") {
    const header = parseIpLiteral(headerValue(request, CLOUDFLARE_CLIENT_IP_HEADER)) ?? parseIpLiteral(headerValue(request, EDGE_CLIENT_IP_HEADER));
    if (header) return { address: header, fromProxy: true };
  }
  return { address: request.socket.remoteAddress ?? "unknown", fromProxy: false };
}

/** Rate-limit key for the client (IPv4-mapped → IPv4, IPv6 grouped by /64). */
export function clientAddressKey(request: IncomingMessage, trustedProxy: TrustedProxy | undefined): string {
  return clientIpKey(resolveClientAddress(request, trustedProxy).address);
}

/**
 * The Ask per-IP loopback exemption: only without a trusted proxy (the local dev / hosting proxy, where every
 * caller shares one loopback address). With a trusted proxy the address is the real client, never exempt.
 */
export function exemptFromIpWindow(request: IncomingMessage, trustedProxy: TrustedProxy | undefined): boolean {
  return trustedProxy === undefined && isLoopbackAddress(request.socket.remoteAddress ?? "unknown");
}
