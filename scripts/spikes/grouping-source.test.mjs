import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSource } from './grouping-source.mjs';

test('omits complete URL templates and credentials without inventing replacement code', () => {
  const original = ['const x = 1;', 'return `https://github.com/${repo}/blob/${sha}#L${line}`;', 'const key = "secret-value";', 'return x;'].join('\n');
  const result = prepareSource(original, line => line.replaceAll('secret-value', '[redacted]'));
  assert.deepEqual(result.omittedLines, [2, 3]);
  assert.equal(result.source.split('\n').length, 4);
  assert.match(result.source, /^const x = 1;/);
  assert.match(result.source, /return x;$/);
  assert.doesNotMatch(result.source, /https|secret-value|github|\$\{/);
});

test('preserves source without sensitive data or URLs exactly', () => {
  const source = 'const endpoint = `/source.json?${params}`;\n';
  assert.deepEqual(prepareSource(source, value => value), { source, omittedLines: [] });
});
