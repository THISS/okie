import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DECLARATION_ONLY_LABEL, FACTS_UNAVAILABLE_LIMIT, formatDependencyConsumerReport, queryDependencyConsumers,
  type DependencyFacts,
} from './dependency-consumers.js';
import { parsePortableAtlas, serializePortableAtlas, type PortableAtlas } from './portable.js';

const SHA = 'a'.repeat(40);

function facts(): DependencyFacts {
  return {
    schemaVersion: 1, commitSha: SHA,
    packages: [
      { ecosystem: 'npm', name: 'root', manifestPath: 'package.json', directory: '' },
      { ecosystem: 'npm', name: '@x/web', manifestPath: 'apps/web/package.json', directory: 'apps/web' },
      { ecosystem: 'npm', name: '@x/lib', manifestPath: 'packages/lib/package.json', directory: 'packages/lib' },
      { ecosystem: 'cargo', name: 'gpu', manifestPath: 'crates/gpu/Cargo.toml', directory: 'crates/gpu' },
      { ecosystem: 'cargo', name: 'wasm', manifestPath: 'crates/wasm/Cargo.toml', directory: 'crates/wasm' },
    ],
    declarations: [
      { ecosystem: 'npm', dependency: 'react', declaringPackage: 'apps/web/package.json', section: 'dependencies', requested: '^18.0.0', local: false, resolution: 'resolved', resolvedVersions: ['18.2.0'], lockfilePath: 'pnpm-lock.yaml', source: { path: 'apps/web/package.json', line: 4 } },
      { ecosystem: 'npm', dependency: 'react', declaringPackage: 'packages/lib/package.json', section: 'peerDependencies', requested: '*', local: false, resolution: 'unresolved', resolvedVersions: [], reason: 'not in lockfile', source: { path: 'packages/lib/package.json', line: 3 } },
      { ecosystem: 'cargo', dependency: 'serde-json', alias: 'json', declaringPackage: 'crates/gpu/Cargo.toml', section: 'dependencies', requested: '1.0', local: false, resolution: 'resolved', resolvedVersions: ['1.0.1'], lockfilePath: 'Cargo.lock', source: { path: 'crates/gpu/Cargo.toml', line: 8 } },
      { ecosystem: 'cargo', dependency: 'serde-json', declaringPackage: 'crates/wasm/Cargo.toml', section: 'dev-dependencies', requested: '1.0', local: false, resolution: 'resolved', resolvedVersions: ['1.0.1'], lockfilePath: 'Cargo.lock', source: { path: 'crates/wasm/Cargo.toml', line: 9 } },
    ],
    imports: [
      { ecosystem: 'npm', dependency: 'react', specifier: 'react/jsx-runtime', path: 'apps/web/src/b.tsx', startLine: 2, endLine: 2, consumingPackage: 'apps/web/package.json', kind: 'static', typeOnly: true },
      { ecosystem: 'npm', dependency: 'react', specifier: 'react', path: 'apps/web/src/a.tsx', startLine: 1, endLine: 1, consumingPackage: 'apps/web/package.json', kind: 'static', typeOnly: false },
      { ecosystem: 'npm', dependency: 'react', specifier: 'react', path: 'package-scripts/x.ts', startLine: 1, endLine: 1, consumingPackage: 'package.json', kind: 'dynamic', typeOnly: false },
      { ecosystem: 'cargo', dependency: 'serde-json', specifier: 'json', path: 'crates/gpu/src/lib.rs', startLine: 3, endLine: 3, consumingPackage: 'crates/gpu/Cargo.toml', kind: 'use', typeOnly: false },
    ],
    symbolReferences: [
      { ecosystem: 'npm', dependency: 'react', path: 'apps/web/src/a.tsx', startLine: 5, endLine: 5, consumingPackage: 'apps/web/package.json', symbol: 'useState', kind: 'calls', analyzer: 'typescript@5.9.3', via: '@types/react' },
      { ecosystem: 'npm', dependency: 'react', path: 'apps/web/src/a.tsx', startLine: 3, endLine: 3, consumingPackage: 'apps/web/package.json', symbol: 'FC', kind: 'uses', analyzer: 'typescript@5.9.3', via: '@types/react' },
      { ecosystem: 'cargo', dependency: 'serde-json', path: 'crates/gpu/src/lib.rs', startLine: 9, endLine: 9, consumingPackage: 'crates/gpu/Cargo.toml', symbol: 'serde_json::to_string', kind: 'calls', analyzer: 'rust-analyzer@1.87.0', resolvedVersion: '1.0.1' },
    ],
    coverage: [
      { ecosystem: 'npm', evidence: 'symbolReferences', status: 'partial', limitations: ['Only where installed types were reused.'], dropped: 7, droppedByDependency: [{ dependency: 'react', dropped: 7 }] },
      { ecosystem: 'cargo', evidence: 'symbolReferences', status: 'unavailable', limitations: ['rust-analyzer not run (quick scan).'], dropped: 0, droppedByDependency: [] },
    ],
  };
}

test('query groups consumers by package then file then line and labels type-only evidence', () => {
  const report = queryDependencyConsumers(facts(), 'react');
  assert.deepEqual(report.consumers.map(row => row.package.manifestPath), ['apps/web/package.json', 'package.json']);
  const web = report.consumers[0]!;
  assert.deepEqual(web.files.map(file => file.path), ['apps/web/src/a.tsx', 'apps/web/src/b.tsx']);
  assert.deepEqual(web.files[0]!.symbolReferences.map(row => row.startLine), [3, 5]);
  assert.equal(web.files[1]!.typeOnly, true);
  assert.equal(web.files[0]!.typeOnly, false);
  assert.equal(web.undeclared, false);
  assert.equal(report.consumers[1]!.undeclared, true);
  assert.equal(report.summary.typeOnlyImports, 1);
  assert.equal(report.summary.calls, 1);
  assert.ok(report.coverage.some(line => line.includes('7 fact(s) for react dropped')), report.coverage.join('\n'));
  const text = formatDependencyConsumerReport(report);
  assert.match(text, /apps\/web\/src\/b\.tsx:2 {2}import {2}'react\/jsx-runtime' \(type-only\)/);
  assert.match(text, /apps\/web\/src\/a\.tsx:5 {2}calls useState/);
  assert.deepEqual(queryDependencyConsumers(facts(), 'react'), report, 'pure and deterministic');
});

test('declaration alone never makes a consumer', () => {
  const report = queryDependencyConsumers(facts(), 'react');
  assert.ok(!report.consumers.some(row => row.package.manifestPath === 'packages/lib/package.json'));
  assert.deepEqual(report.declaredWithoutObservedUse.map(row => [row.package.manifestPath, row.label]), [['packages/lib/package.json', DECLARATION_ONLY_LABEL]]);
  assert.match(formatDependencyConsumerReport(report), /Declared without observed use\n {2}@x\/lib \(packages\/lib\/package\.json\) — declaration only — not evidence of use/);
});

test('runtime-only query excludes type-only imports but keeps the package out of the declaration-only list', () => {
  const report = queryDependencyConsumers(facts(), 'react', { includeTypeOnly: false });
  assert.deepEqual(report.consumers[0]!.files.map(file => file.path), ['apps/web/src/a.tsx']);
  assert.equal(report.summary.excludedTypeOnlyImports, 1);
  assert.ok(report.coverage.some(line => line.includes('type-only import(s) excluded')));
});

test('cargo matches ident form and renames; ecosystem filter applies', () => {
  for (const name of ['serde_json', 'serde-json']) {
    const report = queryDependencyConsumers(facts(), name);
    assert.deepEqual(report.matchedNames, ['serde-json']);
    assert.deepEqual(report.consumers.map(row => row.package.name), ['gpu']);
    assert.deepEqual(report.declaredWithoutObservedUse.map(row => row.package.name), ['wasm']);
    assert.ok(report.coverage.some(line => line.includes('quick scan')));
  }
  assert.deepEqual(queryDependencyConsumers(facts(), 'json').matchedNames, ['serde-json'], 'rename key');
  assert.equal(queryDependencyConsumers(facts(), 'react', { ecosystem: 'cargo' }).consumers.length, 0);
  assert.equal(queryDependencyConsumers(facts(), '@types/react').consumers.length, 2);
});

test('first-party packages explain where symbol-level use lives instead of claiming unresolved references', () => {
  const value = facts();
  value.imports.push({ ecosystem: 'npm', dependency: '@x/lib', specifier: '@x/lib', path: 'apps/web/src/a.tsx', startLine: 9, endLine: 9, consumingPackage: 'apps/web/package.json', kind: 'static', typeOnly: false });
  const report = queryDependencyConsumers(value, '@x/lib');
  assert.equal(report.consumers.length, 1);
  assert.ok(report.coverage.some(line => line.includes('first-party package (packages/lib/package.json)')), report.coverage.join('\n'));
  assert.ok(!report.coverage.some(line => line.startsWith('No npm symbol references')), report.coverage.join('\n'));
});

test('old bundle without facts reports a limit; unknown names suggest close declarations', () => {
  const old = queryDependencyConsumers(undefined, 'react');
  assert.equal(old.factsAvailable, false);
  assert.deepEqual(old.coverage, [FACTS_UNAVAILABLE_LIMIT]);
  assert.match(formatDependencyConsumerReport(old), /predates dependency capture/);
  const unknown = queryDependencyConsumers(facts(), 'reakt');
  assert.equal(unknown.consumers.length, 0);
  assert.deepEqual(unknown.suggestions, ['react']);
});

test('npm symbol references without imports-only coverage mention unresolved analyzer visibility', () => {
  const value = facts();
  value.symbolReferences = value.symbolReferences.filter(row => row.ecosystem !== 'npm');
  const report = queryDependencyConsumers(value, 'react');
  assert.ok(report.coverage.some(line => line.startsWith('No npm symbol references resolved for react')), report.coverage.join('\n'));
});

function bundle(): PortableAtlas {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/architecture/demo-${name}.json`, import.meta.url), 'utf8')
    .replaceAll('golden-worktree-okie-2026-07-14-v1', SHA));
  return { format: 'okie-atlas', version: 1, repository: { commitSha: SHA, treeHash: 'b'.repeat(40) },
    snapshot: read('snapshot'), view: read('view'), story: read('story'), stories: [],
    analysis: { mode: 'quick', adapters: [] } };
}

test('portable bundles load with or without facts and reject malformed facts', () => {
  const plain = bundle();
  assert.equal(parsePortableAtlas(serializePortableAtlas(plain)).dependencies, undefined);
  const withFacts = { ...bundle(), dependencies: facts() };
  assert.deepEqual(parsePortableAtlas(serializePortableAtlas(withFacts)).dependencies, facts());
  const broken: Array<[string, (value: DependencyFacts) => void, RegExp]> = [
    ['revision', value => { value.commitSha = 'c'.repeat(40); }, /revision/],
    ['absolute path', value => { value.imports[0]!.path = '/etc/passwd'; }, /repository-relative/],
    ['traversal', value => { value.declarations[0]!.source.path = '../x/package.json'; }, /repository-relative/],
    ['unknown owner', value => { value.imports[0]!.consumingPackage = 'nope/package.json'; }, /manifest listed/],
    ['kind', value => { Object.assign(value.imports[0]!, { kind: 'magic' }); }, /kind/],
    ['typeOnly', value => { Object.assign(value.imports[0]!, { typeOnly: 'no' }); }, /typeOnly/],
    ['lines', value => { value.symbolReferences[0]!.endLine = 1; }, /line range/],
    ['schema', value => { Object.assign(value, { schemaVersion: 2 }); }, /schemaVersion/],
    ['coverage', value => { value.coverage[0]!.dropped = -1; }, /dropped/],
  ];
  for (const [label, mutate, pattern] of broken) {
    const value = facts();
    mutate(value);
    assert.throws(() => parsePortableAtlas(JSON.stringify({ ...bundle(), dependencies: value })), pattern, label);
    assert.throws(() => parsePortableAtlas(JSON.stringify({ ...bundle(), dependencies: value })), /Invalid dependency facts/, label);
  }
});
