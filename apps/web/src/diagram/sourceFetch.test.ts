import { describe, it, expect } from 'vitest';
import { createSourceFetcher, immutableFileUrl } from './sourceFetch';
const context = { scanBasePath: '/scan/acme__demo', owner: 'acme', repo: 'demo' };
const commit = 'a'.repeat(40);
const packet = { repository: 'acme/demo', commit, path: 'a.ts', startLine: 1, endLine: 2, totalLines: 3, lines: ['a', 'b'], digest: 'hash' };
describe('immutable source transport', () => {
  it('binds requests and cache to repository commit path and range', async () => {
    const urls: string[] = [];
    const get = createSourceFetcher(async url => { urls.push(String(url)); return new Response(JSON.stringify(packet)); });
    await get(context, commit, 'a.ts', 1, 2);
    await get(context, commit, 'a.ts', 1, 2);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`commit=${commit}`);
    expect(urls[0]).toContain('start=1&end=2');
    await expect(get(context, 'b'.repeat(40), 'a.ts', 1, 2)).rejects.toThrow('does not match');
    expect(urls).toHaveLength(2);
  });
  it('rejects response from another selected file and preserves server error', async () => {
    await expect(createSourceFetcher(async () => new Response(JSON.stringify(packet)))(context, commit, 'other.ts', 1, 2)).rejects.toThrow('does not match');
    await expect(createSourceFetcher(async () => new Response(JSON.stringify({ error: 'Historical source unavailable' }), { status: 502 }))(context, commit, 'a.ts', 1, 2)).rejects.toThrow('Historical source unavailable');
  });
  it('full file is commit pinned, never a mutable revision', () => {
    expect(immutableFileUrl(context, commit, 'src/a b.ts')).toBe(`https://github.com/acme/demo/blob/${commit}/src/a%20b.ts`);
    expect(immutableFileUrl(context, 'main', 'a.ts')).toBeUndefined();
  });
});

it('bounds immutable range cache to 32 entries and refetches the evicted oldest range', async () => {
  const requested: number[] = [];
  const get = createSourceFetcher(async url => {
    const start = Number(new URL(String(url), 'http://fixture.test').searchParams.get('start'));
    requested.push(start);
    return new Response(JSON.stringify({ ...packet, startLine: start, endLine: start, totalLines: 100, lines: [`line ${start}`] }));
  });
  for (let start = 1; start <= 33; start++) await get(context, commit, 'a.ts', start, start);
  await get(context, commit, 'a.ts', 2, 2);
  await get(context, commit, 'a.ts', 33, 33);
  expect(requested).toHaveLength(33);
  await get(context, commit, 'a.ts', 1, 1);
  expect(requested).toHaveLength(34);
  expect(requested.at(-1)).toBe(1);
});
