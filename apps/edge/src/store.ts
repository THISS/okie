import { PUBLISHED_STORE_PREFIX } from '../../server/src/publishedStoreLayout';

/**
 * Raw store reads for the Ask container's mirror: `GET http://atlas-store.internal/<key>` (the container's
 * outbound handler) and, only when `DEV_STORE_ROUTE=1`, `GET /__store/<key>` on the Worker itself so a
 * locally run apps/server can mirror from wrangler dev. Unlike `/scan/*` this DOES return `private/`
 * objects — it is never reachable from the public internet in production (the `/__store` route is off
 * unless the dev var is set, and the outbound host only exists inside the container network).
 */
export const STORE_HOST = 'atlas-store.internal';
export const DEV_STORE_PREFIX = '/__store/';

/** A store key the mirror may read: under `atlas/v1/`, no traversal, no empty segments. */
export function isMirrorableStoreKey(key: string): boolean {
  if (!key.startsWith(PUBLISHED_STORE_PREFIX) || key.length > 1024) return false;
  if (key.includes('..') || key.includes('\\') || key.includes('//') || /[\u0000-\u001f\u007f]/.test(key)) return false;
  return !key.endsWith('/');
}

function contentTypeFor(key: string, stored: string | undefined): string {
  if (stored) return stored;
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

function storeNotFound(): Response {
  return new Response('not found\n', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}

/** Serve one bucket object by key (GET/HEAD; `Range` honoured so packs can be sliced). */
export async function handleStoreRead(request: Request, bucket: R2Bucket, key: string): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('method not allowed\n', { status: 405, headers: { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' } });
  }
  if (!isMirrorableStoreKey(key)) return storeNotFound();
  if (method === 'HEAD') {
    const head = await bucket.head(key);
    if (!head) return storeNotFound();
    return new Response(null, {
      status: 200,
      headers: {
        'content-type': contentTypeFor(key, head.httpMetadata?.contentType),
        'content-length': String(head.size),
        etag: head.httpEtag,
        'cache-control': 'no-store',
      },
    });
  }
  const ranged = request.headers.has('range');
  const object = await bucket.get(key, ranged ? { range: request.headers } : {});
  if (!object) return storeNotFound();
  const headers: Record<string, string> = {
    'content-type': contentTypeFor(key, object.httpMetadata?.contentType),
    etag: object.httpEtag,
    'cache-control': 'no-store',
    'accept-ranges': 'bytes',
  };
  const range = object.range as { offset?: number; length?: number } | undefined;
  if (ranged && range && typeof range.offset === 'number') {
    const length = range.length ?? object.size - range.offset;
    headers['content-range'] = `bytes ${range.offset}-${range.offset + length - 1}/${object.size}`;
    headers['content-length'] = String(length);
    return new Response(object.body, { status: 206, headers });
  }
  headers['content-length'] = String(object.size);
  return new Response(object.body, { status: 200, headers });
}

/** Key from `http://atlas-store.internal/<key>` or `/__store/<key>` (percent-decoded; undefined if malformed). */
export function storeKeyFromPath(pathname: string, prefix: string): string | undefined {
  if (!pathname.startsWith(prefix)) return undefined;
  try {
    return decodeURIComponent(pathname.slice(prefix.length));
  } catch {
    return undefined;
  }
}

/** The container's outbound handler for `atlas-store.internal` (public AND private keys, GET/HEAD only). */
export function atlasStoreOutbound(request: Request, bucket: R2Bucket): Promise<Response> {
  const key = storeKeyFromPath(new URL(request.url).pathname, '/');
  return key === undefined ? Promise.resolve(storeNotFound()) : handleStoreRead(request, bucket, key);
}
