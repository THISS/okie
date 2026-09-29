import {
  PUBLISHED_SOURCE_PATHS_SCHEMA,
  publishedSourcePathsKey,
  type PublishedSourcePaths,
} from '../../server/src/publishedStoreLayout';
import { repoSlugFor } from '../../web/src/renderer/route';
import { jsonResponse, jsonText } from './http';

/**
 * `/scan/<slug>/source.json` at the edge (CLA-266): the pinned "view full source" range, served by the
 * Worker with the semantics of apps/server/src/scanSource.ts (same query validation, statuses, messages
 * and response shape) so the browse-only launch needs no container.
 *
 *   - Allowlist: the version's `packs/source-paths.json` (paths recorded in the snapshot's sourceRefs at
 *     the published commit). The commit must be the version's commit; owner/repo must be the slug's.
 *   - Upstream: `https://raw.githubusercontent.com/<o>/<r>/<sha>/<path>`, 15 s timeout, 1 MiB cap, fatal
 *     UTF-8 decode, NUL → 422. Redirects are never followed: workerd rejects `redirect: "error"`, so the
 *     fetch uses `redirect: "manual"` and anything but a 200 (a 3xx included) is a failure.
 *   - Cache: the RAW file (not a per-line-range response) goes through the Cache API keyed by
 *     repo + commit + path. The commit pins the bytes, so it is immutable for a year. GitHub being down
 *     or rate-limiting only affects uncached files, which answer 502 with a clear message.
 */

export const MAX_SOURCE_BYTES = 1024 * 1024;
export const MAX_SOURCE_LINES = 500;
export const SOURCE_FETCH_TIMEOUT_MS = 15_000;
export const SOURCE_UNAVAILABLE_ERROR = 'Historical source is unavailable right now. The saved excerpt remains available.';
const RAW_CACHE_CONTROL = 'public, max-age=31536000, immutable';

export class SourceRequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Byte-for-byte apps/server/src/scanSource.ts `validSourcePath`. */
export function validSourcePath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && !/[\\:%?#\u0000-\u001f\u007f]/u.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export type SourceRange = {
  repository: string;
  commit: string;
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: string[];
  digest: string;
};

export type SourceDeps = {
  bucket: R2Bucket;
  /** Upstream fetch (GitHub raw). Injected in tests. */
  fetch: typeof fetch;
  /** Cache API store for raw files; undefined disables it. */
  cache: Cache | undefined;
  waitUntil(promise: Promise<unknown>): void;
  /** Origin the synthetic cache keys live under (the request's own origin). */
  origin: string;
  timeoutMs?: number;
};

type Query = { owner: string; repo: string; commit: string; path: string; version: string | null; start: number; end: number };

function parseQuery(params: URLSearchParams): Query {
  const owner = params.get('owner') ?? '', repo = params.get('repo') ?? '';
  const commit = params.get('commit') ?? '', path = params.get('path') ?? '';
  const version = params.get('version');
  const start = Number(params.get('start')), end = Number(params.get('end'));
  if (!/^[a-zA-Z0-9-]+$/u.test(owner) || !/^[a-zA-Z0-9_.-]+$/u.test(repo)
    || !/^[a-f0-9]{40}$/u.test(commit) || !validSourcePath(path)
    || (version !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,180}$/u.test(version))
    || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end - start + 1 > MAX_SOURCE_LINES) {
    throw new SourceRequestError(400, 'Invalid immutable source request.');
  }
  return { owner, repo, commit, path, version, start, end };
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T | undefined> {
  const object = await bucket.get(key);
  if (!object) return undefined;
  try { return await object.json<T>(); } catch { return undefined; }
}

async function sourcePathsFor(bucket: R2Bucket, slug: string, versionId: string): Promise<PublishedSourcePaths | undefined> {
  const parsed = await readJson<PublishedSourcePaths>(bucket, publishedSourcePathsKey(slug, versionId));
  if (!parsed || parsed.schema !== PUBLISHED_SOURCE_PATHS_SCHEMA || !Array.isArray(parsed.paths)) return undefined;
  return parsed;
}

function rawUrl(query: Query): string {
  return `https://raw.githubusercontent.com/${encodeURIComponent(query.owner)}/${encodeURIComponent(query.repo)}/${query.commit}/${query.path.split('/').map(encodeURIComponent).join('/')}`;
}

function cacheKey(origin: string, query: Query): string {
  return `${origin}/__source-cache/${encodeURIComponent(query.owner.toLowerCase())}/${encodeURIComponent(query.repo.toLowerCase())}/${query.commit}/${query.path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Read at most MAX_SOURCE_BYTES from a body (413 past it). */
async function boundedBytes(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_SOURCE_BYTES) throw new SourceRequestError(413, 'File exceeds the 1 MiB source limit.');
      chunks.push(next.value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const out = new Uint8Array(bytes);
  let at = 0;
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength; }
  return out;
}

/** The raw file bytes: Cache API hit, else GitHub raw (then cached). */
async function rawFile(query: Query, deps: SourceDeps): Promise<Uint8Array> {
  const key = cacheKey(deps.origin, query);
  const cached = deps.cache ? await deps.cache.match(key).catch(() => undefined) : undefined;
  if (cached?.body) return boundedBytes(cached.body);

  let response: Response;
  try {
    response = await deps.fetch(rawUrl(query), { redirect: 'manual', signal: AbortSignal.timeout(deps.timeoutMs ?? SOURCE_FETCH_TIMEOUT_MS) });
  } catch {
    throw new SourceRequestError(502, SOURCE_UNAVAILABLE_ERROR);
  }
  // Down, rate-limited (403/429) or missing upstream: the saved excerpt stays the fallback.
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new SourceRequestError(502, SOURCE_UNAVAILABLE_ERROR);
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_SOURCE_BYTES) {
    await response.body.cancel().catch(() => {});
    throw new SourceRequestError(413, 'File exceeds the 1 MiB source limit.');
  }
  const bytes = await boundedBytes(response.body);
  if (deps.cache) {
    const put = deps.cache.put(key, new Response(bytes, {
      headers: { 'content-type': 'application/octet-stream', 'cache-control': RAW_CACHE_CONTROL },
    }));
    deps.waitUntil(put.catch(() => undefined));
  }
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** The source range for `slug` + query, or a SourceRequestError with the server's status and message. */
export async function sourceRange(
  slug: string,
  params: URLSearchParams,
  resolveVersion: (version: string | null) => Promise<string | undefined>,
  deps: SourceDeps,
): Promise<SourceRange> {
  const query = parseQuery(params);
  if (repoSlugFor(query.owner, query.repo) !== slug) throw new SourceRequestError(404, 'Repository does not match this published atlas.');
  const versionId = await resolveVersion(query.version);
  const allowlist = versionId ? await sourcePathsFor(deps.bucket, slug, versionId) : undefined;
  if (!allowlist) throw new SourceRequestError(404, 'Published snapshot unavailable.');
  if (allowlist.commitSha !== query.commit
    || allowlist.owner.toLowerCase() !== query.owner.toLowerCase() || allowlist.repo.toLowerCase() !== query.repo.toLowerCase()
    || !allowlist.paths.includes(query.path)) {
    throw new SourceRequestError(404, 'Source is not recorded at this published revision.');
  }
  const bytes = await rawFile(query, deps);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes); }
  catch { throw new SourceRequestError(422, 'Source is not UTF-8 text.'); }
  if (text.includes('\0')) throw new SourceRequestError(422, 'Source is not a text file.');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (query.start > lines.length) throw new SourceRequestError(416, 'Requested lines are outside this file.');
  return {
    repository: `${query.owner}/${query.repo}`,
    commit: query.commit,
    path: query.path,
    startLine: query.start,
    endLine: Math.min(query.end, lines.length),
    totalLines: lines.length,
    lines: lines.slice(query.start - 1, query.end),
    digest: await sha256Hex(bytes),
  };
}

/** HTTP wrapper: 200 compact JSON (like the server's `sendJson(…, false)`), errors as `{ error }`. */
export async function handleSourceRoute(
  slug: string,
  url: URL,
  resolveVersion: (version: string | null) => Promise<string | undefined>,
  deps: SourceDeps,
): Promise<Response> {
  try {
    const range = await sourceRange(slug, url.searchParams, resolveVersion, deps);
    return new Response(jsonText(range, false), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof SourceRequestError) return jsonResponse(error.status, { error: error.message });
    return jsonResponse(502, { error: SOURCE_UNAVAILABLE_ERROR });
  }
}
