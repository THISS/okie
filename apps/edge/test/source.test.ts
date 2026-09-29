import { describe, expect, it } from 'vitest';
import { MAX_SOURCE_BYTES, SOURCE_UNAVAILABLE_ERROR } from '../src/source';
import { edgeFetch, memoryCache, recordingBackend, seedAtlas } from './helpers';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const FILE = 'line one\r\nline two\nline three\n';

/** A fake GitHub raw origin: records URLs + init, answers from `files` (path after the sha). */
function fakeGithub(files: Record<string, BodyInit | Response | (() => Response | Promise<Response>)>) {
  const calls: Array<{ url: string; redirect?: string; hasSignal: boolean }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init?.redirect ? { redirect: init.redirect } : {}), hasSignal: init?.signal instanceof AbortSignal });
    const path = decodeURIComponent(url.split(`/${SHA}/`)[1] ?? '');
    const entry = files[path];
    if (entry === undefined) return new Response('404: Not Found', { status: 404 });
    if (typeof entry === 'function') return entry();
    if (entry instanceof Response) return entry;
    return new Response(entry);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

async function seedSource(slug: string, versionId: string, paths: string[], options: { owner?: string; repo?: string; commitSha?: string; latest?: boolean } = {}) {
  await seedAtlas({
    slug,
    versionId,
    files: { 'snapshot.json': '{}' },
    sourcePaths: { owner: options.owner ?? 'Acme', repo: options.repo ?? 'src-app', commitSha: options.commitSha ?? SHA, paths },
    ...(options.latest === false ? { latest: false } : {}),
  });
}

function sourceUrl(slug: string, params: Record<string, string>): string {
  return `/scan/${slug}/source.json?${new URLSearchParams(params)}`;
}

const BASE = { owner: 'Acme', repo: 'src-app', commit: SHA, path: 'src/a.ts', start: '1', end: '2' };

describe('/scan/<slug>/source.json at the edge', () => {
  it('serves a line range like apps/server (shape, CRLF normalisation, sha256 of the raw bytes), never waking the container', async () => {
    await seedSource('acme__src-app', 'v1', ['src/a.ts']);
    const { fetchImpl, calls } = fakeGithub({ 'src/a.ts': FILE });
    const { backend, seen } = recordingBackend();
    const response = await edgeFetch(sourceUrl('acme__src-app', BASE), { backend, fetch: fetchImpl, cache: memoryCache() });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const bytes = new TextEncoder().encode(FILE);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    expect(await response.text()).toBe(`${JSON.stringify({
      repository: 'Acme/src-app', commit: SHA, path: 'src/a.ts', startLine: 1, endLine: 2, totalLines: 4, lines: ['line one', 'line two'], digest,
    })}\n`);
    expect(calls).toEqual([{ url: `https://raw.githubusercontent.com/Acme/src-app/${SHA}/src/a.ts`, redirect: 'manual', hasSignal: true }]);
    expect(seen).toHaveLength(0);

    // Past the end clamps endLine; a start past the end is 416.
    const tail = await edgeFetch(sourceUrl('acme__src-app', { ...BASE, start: '3', end: '10' }), { fetch: fetchImpl, cache: memoryCache() });
    expect(await tail.json()).toMatchObject({ startLine: 3, endLine: 4, lines: ['line three', ''] });
    const outside = await edgeFetch(sourceUrl('acme__src-app', { ...BASE, start: '5', end: '6' }), { fetch: fetchImpl, cache: memoryCache() });
    expect(outside.status).toBe(416);
    expect(await outside.json()).toEqual({ error: 'Requested lines are outside this file.' });
  });

  it('caches the raw file (not the range) by repo + commit + path, so GitHub is fetched once', async () => {
    await seedSource('acme__src-app', 'v1', ['src/a.ts']);
    const { fetchImpl, calls } = fakeGithub({ 'src/a.ts': FILE });
    const cache = memoryCache();
    await edgeFetch(sourceUrl('acme__src-app', BASE), { fetch: fetchImpl, cache });
    await edgeFetch(sourceUrl('acme__src-app', { ...BASE, start: '2', end: '3' }), { fetch: fetchImpl, cache });
    const pinned = await edgeFetch(sourceUrl('acme__src-app', { ...BASE, owner: 'acme', version: 'v1' }), { fetch: fetchImpl, cache });
    expect(pinned.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(cache.keys).toEqual([`http://127.0.0.1:4196/__source-cache/acme/src-app/${SHA}/src/a.ts`]);
    // GitHub down afterwards: the cached file still answers.
    const down = (async () => { throw new Error('offline'); }) as typeof fetch;
    expect((await edgeFetch(sourceUrl('acme__src-app', BASE), { fetch: down, cache })).status).toBe(200);
  });

  it('validates the query exactly like the server (400)', async () => {
    await seedSource('acme__src-app', 'v1', ['src/a.ts']);
    const { fetchImpl, calls } = fakeGithub({ 'src/a.ts': FILE });
    for (const bad of [
      { ...BASE, owner: 'ac_me' },
      { ...BASE, repo: 'src app' },
      { ...BASE, commit: SHA.toUpperCase() },
      { ...BASE, commit: 'abc' },
      { ...BASE, path: '../etc/passwd' },
      { ...BASE, path: 'src//a.ts' },
      { ...BASE, path: 'src/a%2e.ts' },
      { ...BASE, path: 'C:/x' },
      { ...BASE, version: '../v1' },
      { ...BASE, start: '0' },
      { ...BASE, start: '3', end: '2' },
      { ...BASE, start: '1', end: '501' },
      { ...BASE, start: 'x' },
    ]) {
      const response = await edgeFetch(sourceUrl('acme__src-app', bad), { fetch: fetchImpl, cache: memoryCache() });
      expect(response.status, JSON.stringify(bad)).toBe(400);
      expect(await response.json()).toEqual({ error: 'Invalid immutable source request.' });
    }
    expect(calls).toHaveLength(0);
  });

  it('404s outside the published allowlist: wrong slug, unknown version, other commit, unrecorded path, no source-paths', async () => {
    await seedSource('acme__src-app', 'v1', ['src/a.ts']);
    await seedSource('acme__other-owner', 'v1', ['src/a.ts'], { owner: 'someone', repo: 'else' });
    await seedAtlas({ slug: 'acme__no-paths', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    const { fetchImpl, calls } = fakeGithub({ 'src/a.ts': FILE, 'src/b.ts': FILE });
    const cases: Array<[string, Record<string, string>, string]> = [
      ['acme__other', BASE, 'Repository does not match this published atlas.'],
      ['acme__src-app', { ...BASE, owner: 'evil', repo: 'src-app' }, 'Repository does not match this published atlas.'],
      ['acme__src-app', { ...BASE, version: 'v9' }, 'Published snapshot unavailable.'],
      ['nobody__here', { ...BASE, owner: 'nobody', repo: 'here' }, 'Published snapshot unavailable.'],
      ['acme__no-paths', { ...BASE, repo: 'no-paths' }, 'Published snapshot unavailable.'],
      ['acme__src-app', { ...BASE, commit: 'f'.repeat(40) }, 'Source is not recorded at this published revision.'],
      ['acme__src-app', { ...BASE, path: 'src/b.ts' }, 'Source is not recorded at this published revision.'],
      ['acme__other-owner', { ...BASE, repo: 'other-owner' }, 'Source is not recorded at this published revision.'],
    ];
    for (const [slug, params, error] of cases) {
      const response = await edgeFetch(sourceUrl(slug, params), { fetch: fetchImpl, cache: memoryCache() });
      expect(response.status, `${slug} ${JSON.stringify(params)}`).toBe(404);
      expect(await response.json()).toEqual({ error });
    }
    expect(calls).toHaveLength(0);
  });

  it('413 past 1 MiB (declared or streamed), 422 for non-UTF-8 or NUL, 502 with a clear message when GitHub fails', async () => {
    await seedSource('acme__src-app', 'v1', ['big.txt', 'streamed.txt', 'latin1.txt', 'nul.txt', 'missing.txt', 'limited.txt', 'redirect.txt', 'timeout.txt']);
    const big = 'x'.repeat(MAX_SOURCE_BYTES + 1);
    const { fetchImpl } = fakeGithub({
      'big.txt': () => new Response(big, { headers: { 'content-length': String(big.length) } }),
      'streamed.txt': () => new Response(new Blob([big]).stream()),
      'latin1.txt': new Uint8Array([0x63, 0x61, 0x66, 0xe9]),
      'nul.txt': 'a\u0000b',
      'limited.txt': () => new Response('rate limited', { status: 429 }),
      'redirect.txt': () => new Response(null, { status: 302, headers: { location: 'https://evil.example/x' } }),
      'timeout.txt': () => { throw new DOMException('timed out', 'TimeoutError'); },
    });
    const expectations: Array<[string, number, string]> = [
      ['big.txt', 413, 'File exceeds the 1 MiB source limit.'],
      ['streamed.txt', 413, 'File exceeds the 1 MiB source limit.'],
      ['latin1.txt', 422, 'Source is not UTF-8 text.'],
      ['nul.txt', 422, 'Source is not a text file.'],
      ['missing.txt', 502, SOURCE_UNAVAILABLE_ERROR],
      ['limited.txt', 502, SOURCE_UNAVAILABLE_ERROR],
      ['redirect.txt', 502, SOURCE_UNAVAILABLE_ERROR],
      ['timeout.txt', 502, SOURCE_UNAVAILABLE_ERROR],
    ];
    for (const [path, status, error] of expectations) {
      const response = await edgeFetch(sourceUrl('acme__src-app', { ...BASE, path }), { fetch: fetchImpl, cache: memoryCache() });
      expect(response.status, path).toBe(status);
      expect(await response.json(), path).toEqual({ error });
    }
    expect(SOURCE_UNAVAILABLE_ERROR).toBe('Historical source is unavailable right now. The saved excerpt remains available.');
  });

  it('never caches a failed upstream fetch', async () => {
    await seedSource('acme__src-app', 'v1', ['src/a.ts']);
    const cache = memoryCache();
    let up = false;
    const { fetchImpl, calls } = fakeGithub({ 'src/a.ts': () => (up ? new Response(FILE) : new Response('busy', { status: 503 })) });
    expect((await edgeFetch(sourceUrl('acme__src-app', BASE), { fetch: fetchImpl, cache })).status).toBe(502);
    up = true;
    expect((await edgeFetch(sourceUrl('acme__src-app', BASE), { fetch: fetchImpl, cache })).status).toBe(200);
    expect(calls).toHaveLength(2);
    expect(cache.keys).toHaveLength(1);
  });

  it('works through the real Cache API (caches.default)', async () => {
    await seedSource('acme__real-cache', 'v1', ['src/a.ts'], { repo: 'real-cache' });
    const { fetchImpl, calls } = fakeGithub({ 'src/a.ts': FILE });
    const params = { ...BASE, repo: 'real-cache' };
    expect((await edgeFetch(sourceUrl('acme__real-cache', params), { fetch: fetchImpl })).status).toBe(200);
    const again = await edgeFetch(sourceUrl('acme__real-cache', { ...params, start: '2', end: '2' }), { fetch: fetchImpl });
    expect(await again.json()).toMatchObject({ lines: ['line two'] });
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});
