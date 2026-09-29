/**
 * WebMCP host headers (CLA-40), split out of webmcp.ts so server-side hosts (the Vite plugin and the
 * Cloudflare edge Worker) apply them without bundling the inspector. webmcp.ts re-exports both names.
 */

/** Permissions-Policy + origin-keyed agent cluster for hosted chrome. */
export const WEBMCP_HOST_HEADERS = {
  'Permissions-Policy': 'tools=(self)',
  'Origin-Agent-Cluster': '?1',
} as const;

/**
 * Framed public atlas views (oEmbed) omit Origin-Agent-Cluster so WebGL2 can
 * present inside a cross-origin iframe. Do not widen `tools`.
 */
export function webMcpHostHeadersForFetchDest(
  dest: string | string[] | undefined,
): Record<string, string> {
  const token = (Array.isArray(dest) ? dest[0] : dest)?.split(',')[0]?.trim().toLowerCase();
  if (token === 'iframe' || token === 'embed' || token === 'object' || token === 'frame') {
    return { 'Permissions-Policy': WEBMCP_HOST_HEADERS['Permissions-Policy'] };
  }
  return { ...WEBMCP_HOST_HEADERS };
}
