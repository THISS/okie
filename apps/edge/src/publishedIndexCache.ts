import { publishedIndexKey } from '../../server/src/publishedStoreLayout';

/**
 * The published index.json, parsed, cached per isolate for a short TTL (CLA-318). Share pages
 * (/r titles, oEmbed, card text) and /sitemap.xml read it on every request; with the cache an
 * isolate reads R2 at most once per TTL. A missing object is cached too (as `undefined`); a failed
 * read or unparsable body is not cached and reads as `undefined`. A new publish shows up within
 * the TTL, like the other latest-resolved responses (60 s).
 */
export const PUBLISHED_INDEX_CACHE_TTL_MS = 60_000;

// One Worker, one ATLAS_BUCKET: the entry is not keyed by the binding object (env may be a fresh
// object per request).
type Entry = { at: number; value: unknown };
// Only the parsed value is shared across requests (never a pending read: workerd forbids awaiting
// another request's I/O).
let entry: Entry | undefined;

export async function readPublishedIndex(bucket: R2Bucket, now: number = Date.now()): Promise<unknown> {
  if (entry && now - entry.at < PUBLISHED_INDEX_CACHE_TTL_MS) return entry.value;
  try {
    const object = await bucket.get(publishedIndexKey());
    const value = object ? await object.json() : undefined;
    entry = { at: now, value };
    return value;
  } catch {
    return undefined;
  }
}

/** Tests: forget the cached index. */
export function resetPublishedIndexCache(): void {
  entry = undefined;
}
