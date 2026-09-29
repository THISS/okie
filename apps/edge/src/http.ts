/** Small response helpers shared by the edge routes. */

/** Same bytes as apps/server `sendJson` (pretty by default, trailing newline). */
export function jsonText(body: unknown, pretty = true): string {
  return `${pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body)}\n`;
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(jsonText(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

/** The server's generic miss: `404 { "error": "not found" }`. */
export function notFoundJson(): Response {
  return jsonResponse(404, { error: 'not found' });
}

/** Fully static `/scan` objects of an immutable version. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
/** Objects resolved through the mutable `latest.json` pointer (and the index): short, shared-cacheable. */
export const LATEST_CACHE_CONTROL = 'public, max-age=60';
