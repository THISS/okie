/**
 * Runtime-agnostic GitHub OAuth helpers (CLA-316): no `node:` imports and no @okie/scan, so both the
 * Node server (githubOAuth.ts) and the sourcefor.dev edge Worker (apps/edge/src/auth.ts, workerd) use
 * the same cookie parsing, return-path sanitizing and authorize-URL building.
 */

export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";

/** `name=value; name2=value2` → a record. Values are percent-decoded when they decode cleanly. */
export function parseCookieHeader(header: string | string[] | null | undefined): Record<string, string> {
  const raw = Array.isArray(header) ? header.join("; ") : header ?? "";
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/**
 * A same-origin path to send the browser back to, or `fallback`: only a single-slash absolute path
 * with no scheme and no backslash survives (`//evil`, `/\evil`, `https://evil`, `evil`, and anything outside printable ASCII do not).
 */
export function safeReturnPath(raw: string | null | undefined, fallback = "/new"): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return fallback;
  if (raw.includes("://") || raw.includes("\\")) return fallback;
  // Printable ASCII only: control characters (a CR/LF would split a Location header), spaces and
  // non-ASCII (`/中`: a Location header must be a ByteString, so Headers would throw) all fall back.
  if (/[^\x21-\x7e]/.test(raw)) return fallback;
  return raw;
}

/** The GitHub authorize URL for one sign-in attempt. The client secret never goes in it. */
export function buildGithubAuthorizeUrl(input: { clientId: string; redirectUri: string; state: string; scope: string }): string {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("scope", input.scope);
  return url.toString();
}
