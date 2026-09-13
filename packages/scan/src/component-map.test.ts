import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHITECTURE_EXTRACTION_LIMITS, validateArchitectureExtraction, type ArchitectureExtraction } from '@okie/architecture';
import { applyComponentMembership } from './component-map.js';

const documentFor = (paths: unknown[] = ['src/a.ts', 'src/b.ts'], extra = {}) => ({ version: 1, containers: [{ containerId: 'container:app', components: [{ id: 'component:app-core', name: 'Core', paths, ...extra }] }] });

test('malformed JSON input rejects without throwing or mutating the base', () => {
  for (const document of [null, false, 1, 'map', [], {}, { version: 1, containers: [null] },
    documentFor([null]), documentFor(['src/a.ts'], { tags: {} }),
    documentFor(['src/a.ts'], { tags: [null] }), documentFor(['src/a.ts'], { tags: [' okie:component-mapping'] }),
    documentFor(['missing.ts']), documentFor(['src/a.ts', 'src/a.ts']),
    documentFor(['src/a.ts'], { id: 'component:app-c-ts' })]) {
    const original = base();
    const result = applyComponentMembership(original, { document });
    assert.equal(result.report.accepted, false, JSON.stringify(document));
    assert.equal(result.extraction, original);
    assert.ok(result.report.reasons.length);
  }
});

test('aggregates component dependencies with full evidence and distinct labels while retaining calls', () => {
  const original = base();
  const evidence = (path: string, startLine: number) => [{ source: { path, startLine, endLine: startLine } }];
  original.relations.push(
    { id: 'relation:a:c:one', from: 'component:app-a-ts', to: 'component:app-c-ts', kind: 'uses', label: 'reads', evidence: evidence('src/a.ts', 9) },
    { id: 'relation:b:c:one', from: 'component:app-b-ts', to: 'component:app-c-ts', kind: 'uses', label: 'reads', evidence: evidence('src/b.ts', 4) },
    { id: 'relation:a:c:two', from: 'component:app-a-ts', to: 'component:app-c-ts', kind: 'uses', label: 'writes', evidence: evidence('src/a.ts', 10) },
  );
  const result = applyComponentMembership(original, { document: documentFor() });
  assert.equal(result.report.accepted, true, result.report.reasons.join('\n'));
  const calls = original.relations.find(r => r.kind === 'calls');
  assert.deepEqual(result.extraction.relations.find(r => r.kind === 'calls'), calls);
  const aggregated = result.extraction.relations.filter(r => r.from === 'component:app-core');
  assert.equal(aggregated.length, 2);
  assert.equal(aggregated.find(r => r.label === 'reads')?.evidence.length, 2);
  assert.equal(new Set(aggregated.map(r => r.id)).size, 2);
  const reversed = applyComponentMembership({ ...original, entities: [...original.entities].reverse(), relations: [...original.relations].reverse() }, { document: documentFor(['src/b.ts', 'src/a.ts']) });
  assert.deepEqual(reversed, result);
});

test('rejects shared ownership and files without retained declarations, preserving a partial fallback', () => {
  const doc = documentFor(['src/a.ts']);
  doc.containers[0]!.components.push({ id: 'component:app-other', name: 'Other', paths: ['src/a.ts'] });
  assert.equal(applyComponentMembership(base(), { document: doc }).report.accepted, false);
  const original = base();
  original.entities = original.entities.filter(entity => entity.id !== 'code:app-c-ts:view');
  assert.equal(applyComponentMembership(original, { document: documentFor(['src/c.ts']) }).report.accepted, false);
  const provenance = { kind: 'external' as const, path: 'component-map.json', sha256: 'a'.repeat(64) };
  const partial = applyComponentMembership(original, { document: documentFor(), provenance });
  assert.equal(partial.report.accepted, true);
  assert.deepEqual(partial.report.provenance, provenance);
  assert.deepEqual(partial.extraction.entities.find(entity => entity.id === 'component:app-c-ts'), original.entities.find(entity => entity.id === 'component:app-c-ts'));
});

test('rejects cross-container membership and oversized authoritative evidence without truncating', () => {
  const original = base();
  original.entities.push({ id: 'container:other', kind: 'container', name: 'Other', parentId: 'system:demo', sourceRefs: [] });
  const outside = documentFor(['src/a.ts']);
  outside.containers[0]!.containerId = 'container:other';
  assert.equal(applyComponentMembership(original, { document: outside }).report.accepted, false);
  const paths = Array.from({ length: ARCHITECTURE_EXTRACTION_LIMITS.maxSourceRefs + 1 }, (_, i) => `src/extra${i}.ts`);
  for (const [index, path] of paths.entries()) original.entities.push(
    { id: `component:extra${index}`, kind: 'component', name: path, parentId: 'container:app', sourceRefs: [{ path }] },
    { id: `code:extra${index}`, kind: 'code', name: 'run', parentId: `component:extra${index}`, sourceRefs: [{ path, startLine: 1, endLine: 2 }] },
  );
  const overPaths = applyComponentMembership(original, { document: documentFor(paths) });
  assert.equal(overPaths.report.accepted, false);
  assert.equal(overPaths.extraction, original);
  assert.ok(overPaths.report.reasons.some(reason => reason.includes('maximum is')));
  for (const [index, from] of ['component:app-a-ts', 'component:app-b-ts'].entries()) original.relations.push({
    id: `relation:many${index}`, from, to: 'component:app-c-ts', kind: 'uses',
    evidence: Array.from({ length: 33 }, (_, line) => ({ source: { path: index ? 'src/b.ts' : 'src/a.ts', startLine: line + 1, endLine: line + 1 } })),
  });
  const overEvidence = applyComponentMembership(original, { document: documentFor() });
  assert.equal(overEvidence.report.accepted, false);
  assert.equal(overEvidence.extraction, original);
  assert.ok(overEvidence.report.reasons.some(reason => reason.includes('66 evidence items')));
});

const base = (): ArchitectureExtraction => ({ schemaVersion: 1, entities: [
  { id: 'system:demo', kind: 'softwareSystem', name: 'Demo', sourceRefs: [{ path: 'README.md' }] },
  { id: 'container:app', kind: 'container', parentId: 'system:demo', name: 'App', sourceRefs: [{ path: 'package.json' }] },
  { id: 'component:app-a-ts', kind: 'component', parentId: 'container:app', name: 'a.ts', sourceRefs: [{ path: 'src/a.ts' }] },
  { id: 'component:app-b-ts', kind: 'component', parentId: 'container:app', name: 'b.ts', sourceRefs: [{ path: 'src/b.ts' }] },
  { id: 'component:app-c-ts', kind: 'component', parentId: 'container:app', name: 'c.ts', sourceRefs: [{ path: 'src/c.ts' }] },
  { id: 'code:app-a-ts:run', kind: 'code', parentId: 'component:app-a-ts', name: 'run', sourceRefs: [{ path: 'src/a.ts', symbol: 'run', startLine: 1, endLine: 2 }] },
  { id: 'code:app-b-ts:save', kind: 'code', parentId: 'component:app-b-ts', name: 'save', sourceRefs: [{ path: 'src/b.ts', symbol: 'save', startLine: 1, endLine: 2 }] },
  { id: 'code:app-c-ts:view', kind: 'code', parentId: 'component:app-c-ts', name: 'view', sourceRefs: [{ path: 'src/c.ts', symbol: 'view', startLine: 1, endLine: 2 }] },
], relations: [
  { id: 'relation:app-a-ts:app-b-ts', from: 'component:app-a-ts', to: 'component:app-b-ts', kind: 'uses', evidence: [{ source: { path: 'src/a.ts', startLine: 4, endLine: 4 } }] },
  { id: 'relation:app-a-ts-run:app-b-ts-save', from: 'code:app-a-ts:run', to: 'code:app-b-ts:save', kind: 'calls', evidence: [{ source: { path: 'src/a.ts', startLine: 5, endLine: 5 } }] },
] });

test('partial membership maps multi-file ownership without changing unassigned file components or code anchors', () => {
  const input = { document: { version: 1, containers: [{ containerId: 'container:app', components: [{ id: 'component:app-core', name: 'Core', paths: ['src/b.ts', 'src/a.ts'] }] }] } };
  const outcome = applyComponentMembership(base(), input);
  assert.equal(outcome.report.accepted, true);
  assert.equal(outcome.report.mappedPaths, 2);
  assert.ok(outcome.extraction.entities.some(entity => entity.id === 'component:app-c-ts'));
  assert.ok(!outcome.extraction.entities.some(entity => entity.id === 'component:app-a-ts'));
  assert.deepEqual(outcome.extraction.entities.find(entity => entity.id === 'component:app-core')?.sourceRefs, [{ path: 'src/a.ts' }, { path: 'src/b.ts' }]);
  assert.equal(outcome.extraction.entities.find(entity => entity.id === 'code:app-a-ts:run')?.parentId, 'component:app-core');
  assert.deepEqual(outcome.extraction.entities.find(entity => entity.id === 'code:app-a-ts:run')?.sourceRefs, base().entities[5]!.sourceRefs);
  assert.ok(outcome.extraction.relations.some(relation => relation.from === 'code:app-a-ts:run' && relation.to === 'code:app-b-ts:save'));
  assert.deepEqual(validateArchitectureExtraction(outcome.extraction), []);
});

test('map validation is atomic and deterministic', () => {
  const invalid = applyComponentMembership(base(), { document: { version: 1, containers: [{ containerId: 'container:app', components: [{ id: 'component:app-core', name: 'Core', paths: ['src/a.ts', 'src/a.ts'] }] }] } });
  assert.equal(invalid.report.accepted, false);
  assert.deepEqual(invalid.extraction, base());
  const forward = applyComponentMembership(base(), { document: { version: 1, containers: [{ containerId: 'container:app', components: [{ id: 'component:app-core', name: 'Core', paths: ['src/a.ts', 'src/b.ts'] }] }] } });
  const reverse = applyComponentMembership(base(), { document: { containers: [{ components: [{ paths: ['src/b.ts', 'src/a.ts'], name: 'Core', id: 'component:app-core' }], containerId: 'container:app' }], version: 1 } });
  assert.deepEqual(forward, reverse);
});
