import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test from 'node:test';
import { analyzeTypeScript } from './analyze-typescript.js';
import { dependencyContext } from './dependency-context.js';

test('committed analysis reads installed types without substituting dirty repository source', () => {
  const directory = mkdtempSync(join(tmpdir(), 'okie-dependencies-'));
  const root = join(directory, 'committed'); const installed = join(directory, 'working');
  const put = (base: string, path: string, content: string) => { mkdirSync(dirname(join(base, path)), { recursive: true }); writeFileSync(join(base, path), content); };
  try {
    for (const base of [root, installed]) {
      put(base, 'package.json', '{"name":"app","dependencies":{"example":"1.0.0"}}');
      put(base, 'tsconfig.json', '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"},"include":["main.ts"]}');
    }
    put(root, 'main.ts', 'import { value } from "example"; export const captured: number = value;');
    put(root, 'src/dirty.ts', 'export const value: number = 1;');
    put(installed, 'src/dirty.ts', 'export const value: string = "must not enter graph";');
    put(installed, 'node_modules/example/package.json', '{"name":"example","version":"1.0.0","types":"index.d.ts"}');
    put(installed, 'node_modules/example/index.d.ts', 'export { value } from "../../src/dirty";');
    const before = analyzeTypeScript(root, ['main.ts']);
    assert.ok(before.coverage[0]!.limitations.some(value => value.includes('TS2307')));
    const after = analyzeTypeScript(root, ['main.ts'], installed);
    assert.ok(!after.coverage[0]!.limitations.some(value => value.includes('TS2307')));
    assert.ok(!after.coverage[0]!.limitations.some(value => value.includes('TS2322')));
    assert.ok(!after.coverage[0]!.limitations.some(value => value.includes('TS2318') || value.includes('Cannot find global type')));
    assert.ok(after.definitions.some(value => value.name === 'captured'));
    assert.ok(!after.definitions.some(value => value.name === 'dirty'));
    assert.ok(after.definitions.every(value => value.path === 'main.ts'));
    put(installed, 'package.json', '{"name":"app","dependencies":{"example":"2.0.0"}}');
    const mismatched = analyzeTypeScript(root, ['main.ts'], installed);
    assert.ok(mismatched.coverage[0]!.limitations.some(value => value.includes('TS2307')));
    assert.ok(mismatched.coverage[0]!.limitations.some(value => value.includes('manifests or lockfiles differ')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('dependency context rejects workspace, external symlink, and physical relative source escapes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'okie-dependency-links-'));
  const root = join(directory, 'committed'); const installed = join(directory, 'working');
  try {
    mkdirSync(root); mkdirSync(join(installed, 'node_modules'), { recursive: true });
    mkdirSync(join(installed, 'src')); writeFileSync(join(installed, 'src/index.ts'), 'export const dirty = true;');
    symlinkSync(join(installed, 'src'), join(installed, 'node_modules/workspace'));
    symlinkSync(root, join(installed, 'node_modules/external'));
    const reader = dependencyContext(root, installed);
    for (const name of ['workspace', 'external']) {
      const path = join(root, 'node_modules', name);
      assert.match(reader.path(path), /\.okie-unavailable-dependency$/);
    }
    assert.equal(reader.path(join(root, 'src/index.ts')), join(root, 'src/index.ts'));
    assert.equal(reader.path(join(installed, 'src/index.ts')), join(root, 'src/index.ts'));
    assert.match(reader.path(join(directory, 'external-source.ts')), /\.okie-unavailable-dependency$/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
