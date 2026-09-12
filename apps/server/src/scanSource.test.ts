import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourceService, validSourcePath } from './scanSource.js';
const commit = 'a'.repeat(40);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'okie-source-'));
  mkdirSync(join(root, 'acme__demo'));
  writeFileSync(join(root, 'acme__demo/snapshot.json'), JSON.stringify({ repositoryId: 'repo:acme-demo', commitSha: commit, entities: [{ sourceRefs: [{ path: 'src/a.ts', commitSha: commit }] }] }));
  return root;
}
function params(extra: Record<string, string> = {}) {
  return new URLSearchParams({ owner: 'acme', repo: 'demo', commit, path: 'src/a.ts', start: '2', end: '4', ...extra });
}
test('loads exact immutable revision and caches a file across context ranges', async () => {
  const root = fixture();
  let calls = 0;
  const service = createSourceService(async (url, init) => {
    calls++;
    assert.equal(url, `https://raw.githubusercontent.com/acme/demo/${commit}/src/a.ts`);
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.headers, undefined);
    return new Response('one\ntwo\nthree\nfour\nfive');
  });
  try {
    const result = await service(root, '/scan/acme__demo/source.json', params());
    assert.deepEqual(result.lines, ['two', 'three', 'four']);
    assert.equal(result.totalLines, 5);
    assert.match(result.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual((await service(root, '/scan/acme__demo/source.json', params({ start: '1', end: '5' }))).lines, ['one', 'two', 'three', 'four', 'five']);
    assert.equal(calls, 1);
  } finally { rmSync(root, { recursive: true }); }
});
test('rejects mutable revisions, traversal, unknown paths, mismatched repos and excessive ranges before network', async () => {
  const root = fixture();
  const service = createSourceService(async () => { throw new Error('must not fetch'); });
  try {
    for (const extra of [{ commit: 'main' }, { commit: 'b'.repeat(40) }, { path: '../secret' }, { path: 'src/other.ts' }, { owner: 'other' }, { end: '502' }, { start: '0' }]) {
      await assert.rejects(service(root, '/scan/acme__demo/source.json', params(extra)), /Invalid|not recorded|does not match/);
    }
    for (const path of ['/etc/passwd', 'a\\b', 'a/%2e%2e/b', 'a//b', 'a/../b']) assert.equal(validSourcePath(path), false);
  } finally { rmSync(root, { recursive: true }); }
});
test('evicts immutable files beyond the sixteen-file cache bound', async () => {
  const root = fixture();
  const paths = Array.from({ length: 17 }, (_, index) => `src/file-${index}.ts`);
  writeFileSync(join(root, 'acme__demo/snapshot.json'), JSON.stringify({
    repositoryId: 'repo:acme-demo', commitSha: commit,
    entities: [{ sourceRefs: paths.map(path => ({ path, commitSha: commit })) }],
  }));
  const fetched: string[] = [];
  const service = createSourceService(async url => {
    fetched.push(String(url));
    return new Response('one\ntwo\nthree\nfour');
  });
  try {
    for (const path of paths) await service(root, '/scan/acme__demo/source.json', params({ path }));
    assert.equal(fetched.length, 17);
    for (const path of [paths[1]!, paths[16]!]) await service(root, '/scan/acme__demo/source.json', params({ path }));
    assert.equal(fetched.length, 17, 'retained files are served from cache');
    await service(root, '/scan/acme__demo/source.json', params({ path: paths[0]! }));
    assert.equal(fetched.length, 18, 'the oldest file is fetched again after eviction');
  } finally { rmSync(root, { recursive: true }); }
});
test('fails honestly for unavailable, binary and oversized historical files', async () => {
  const root = fixture();
  try {
    for (const response of [new Response('', { status: 404 }), new Response('a\0b'), new Response('x'.repeat(1024 * 1024 + 1))]) {
      await assert.rejects(createSourceService(async () => response)(root, '/scan/acme__demo/source.json', params()), /unavailable|text file|1 MiB/);
    }
  } finally { rmSync(root, { recursive: true }); }
});

test('legacy dogfood snapshot supports root and recognized repository alias only', async () => {
  const root = fixture();
  writeFileSync(join(root, 'snapshot.json'), JSON.stringify({ id: 'snapshot:okie:' + commit.slice(0, 12), repositoryId: 'repo:okie', commitSha: commit, entities: [{ sourceRefs: [{ path: 'src/a.ts', commitSha: commit }] }] }));
  let calls = 0;
  const service = createSourceService(async () => { calls++; return new Response('one\ntwo\nthree\nfour'); });
  try {
    for (const route of ['/scan/source.json', '/scan/thiss__okie/source.json']) {
      assert.deepEqual((await service(root, route, params({ owner: 'THISS', repo: 'okie' }))).lines, ['two', 'three', 'four']);
    }
    await assert.rejects(service(root, '/scan/thiss__okie/source.json', params({ owner: 'other', repo: 'okie' })), /does not match/);
    await assert.rejects(service(root, '/scan/thiss__okie/source.json', params({ owner: 'THISS', repo: 'okie', commit: 'b'.repeat(40) })), /not recorded/);
    await assert.rejects(service(root, '/scan/thiss__okie/source.json', params({ owner: 'THISS', repo: 'okie', path: 'unknown.ts' })), /not recorded/);
    assert.equal(calls, 1);
  } finally { rmSync(root, { recursive: true }); }
});
