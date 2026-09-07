import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ArchitectureSnapshot } from './model.js';
import { buildC4ProjectionBundle, C4_BANDS, selectC4BandProjection } from './c4.js';

const fixture = fileURLToPath(new URL('../../../fixtures/architecture/demo-snapshot.json', import.meta.url));

async function snapshot() {
  return JSON.parse(await readFile(fixture, 'utf8')) as ArchitectureSnapshot;
}

test('golden hierarchy projects genuine deterministic C4 membership', async () => {
  const source = await snapshot();
  const options = { rootEntityId: 'system:okie', focusEntityId: 'system:okie' } as const;
  const bundle = buildC4ProjectionBundle(source, options);
  const reordered = buildC4ProjectionBundle({
    ...source,
    entities: [...source.entities].reverse(),
    relations: [...source.relations].reverse(),
  }, options);

  assert.deepEqual(reordered, bundle);
  assert.deepEqual(C4_BANDS.map(band => {
    const projection = bundle.projectionById[bundle.family.projectionIds[band]]!;
    return [band, projection.visualNodeIds.length, projection.visualEdgeIds.length];
  }), [
    ['context', 4, 3],
    ['container', 9, 5],
    ['component', 29, 23],
    ['code', 70, 12],
  ]);
  assert.equal(bundle.index.entityIdByVisualNodeId['visual-node:lineage:component:model-scoping'], 'component:model-scoping');
  assert.ok(bundle.index.boundsByEntityIdAndBand['system:okie']?.context);
  assert.notDeepEqual(
    bundle.index.boundsByEntityIdAndBand['system:okie']?.context,
    bundle.index.boundsByEntityIdAndBand['system:okie']?.code,
  );
});

test('visual IDs retain lineage across explicit drill families', async () => {
  const source = await snapshot();
  const system = buildC4ProjectionBundle(source, { rootEntityId: 'system:okie', focusEntityId: 'system:okie' });
  const container = buildC4ProjectionBundle(source, { rootEntityId: 'system:okie', focusEntityId: 'container:architecture-model' });
  const component = buildC4ProjectionBundle(source, { rootEntityId: 'system:okie', focusEntityId: 'component:model-scoping' });
  const sharedId = 'visual-node:lineage:component:model-scoping';

  assert.ok(system.visualNodeById[sharedId]);
  assert.ok(container.visualNodeById[sharedId]);
  assert.ok(component.visualNodeById[sharedId]);
  assert.equal(system.index.entityIdByVisualNodeId[sharedId], container.index.entityIdByVisualNodeId[sharedId]);
  assert.equal(container.index.entityIdByVisualNodeId[sharedId], component.index.entityIdByVisualNodeId[sharedId]);
});

test('projected relations suppress self edges and aggregate by endpoints and kind only', async () => {
  const source = await snapshot();
  const base = source.relations.find(relation => relation.id === 'relation:code-app-navigation-url')!;
  const bundle = buildC4ProjectionBundle({
    ...source,
    relations: [...source.relations, {
      ...base,
      id: 'relation:code-app-navigation-url-optional-copy',
      lineageId: 'lineage:relation:code-app-navigation-url-optional-copy',
      fingerprint: 'golden:relation:code-app-navigation-url-optional-copy:v1',
      optional: true,
      technology: 'in-process TypeScript',
      label: 'records navigation history',
    }],
  }, { rootEntityId: 'system:okie', focusEntityId: 'system:okie' });
  const code = selectC4BandProjection(bundle, 'code');
  const aggregate = code.edges.find(edge => edge.relations.some(relation => relation.logicalId === base.id));

  assert.equal(aggregate?.aggregate.count, 2);
  assert.equal(aggregate?.aggregate.optionalCount, 1);
  assert.deepEqual(aggregate?.relations.map(relation => relation.logicalId), [
    'relation:code-app-navigation-url',
    'relation:code-app-navigation-url-optional-copy',
  ]);
  assert.equal(aggregate?.label, '2 calls');
  assert.ok(code.edges.every(edge => edge.fromVisualId !== edge.toVisualId));
});

test('materialized projections are sorted, laid out and export-ready', async () => {
  const source = await snapshot();
  const bundle = buildC4ProjectionBundle(source, { rootEntityId: 'system:okie', focusEntityId: 'container:architecture-model' });
  const component = selectC4BandProjection(bundle, 'component');

  assert.equal(component.focusEntity.logicalId, 'container:architecture-model');
  assert.deepEqual(component.nodes.map(node => node.id), [...component.nodes.map(node => node.id)].sort());
  assert.deepEqual(component.edges.map(edge => edge.id), [...component.edges.map(edge => edge.id)].sort());
  assert.ok(component.nodes.some(node => node.entity.logicalId === 'component:model-scoping'));
  assert.ok(component.nodes.every(node => node.bounds.width > 0 && node.bounds.height > 0));
  assert.ok(component.edges.every(edge => edge.route.points.length >= 2));
});

test('CLA-106: container focus keeps sibling containers, not their L3 children', async () => {
  const source = await snapshot();
  const bundle = buildC4ProjectionBundle(source, {
    rootEntityId: 'system:okie',
    focusEntityId: 'container:web-app',
  });
  const component = selectC4BandProjection(bundle, 'component');
  const ids = new Set(component.nodes.map(node => node.entity.logicalId));
  assert.equal(ids.has('container:web-app'), true);
  assert.equal(ids.has('container:architecture-model'), true, 'peer container stays in the L3 neighborhood');
  assert.equal(ids.has('container:scene-compiler'), true);
  assert.equal(ids.has('component:model-scoping'), false, 'CLA-107: do not pre-place sibling L3 children');
  const focusBounds = bundle.index.boundsByEntityIdAndBand['container:web-app']?.component;
  const peerBounds = bundle.index.boundsByEntityIdAndBand['container:architecture-model']?.component;
  assert.ok(focusBounds && peerBounds, 'focus and peer both have component-band bounds');
  assert.notDeepEqual(focusBounds, peerBounds, 'peer occupies distinct world space');
});

test('duplicates relations stay on the code band and do not lift to L1–L3', async () => {
  const source = await snapshot();
  const from = source.entities.find(entity => entity.kind === 'code')!;
  const to = source.entities.find(entity => entity.kind === 'code' && entity.id !== from.id)!;
  const bundle = buildC4ProjectionBundle({
    ...source,
    relations: [...source.relations, {
      id: 'relation:dup:code-pair',
      from: from.id,
      to: to.id,
      kind: 'duplicates',
      label: 'duplicates',
      evidence: [{ source: { path: 'src/a.ts', commitSha: source.commitSha } }],
    }],
  }, { rootEntityId: 'system:okie', focusEntityId: 'system:okie' });

  const kindsOn = (band: typeof C4_BANDS[number]) =>
    selectC4BandProjection(bundle, band).edges.flatMap(edge => edge.aggregate.kinds);
  assert.equal(kindsOn('context').includes('duplicates'), false);
  assert.equal(kindsOn('container').includes('duplicates'), false);
  assert.equal(kindsOn('component').includes('duplicates'), false);
  assert.equal(kindsOn('code').includes('duplicates'), true);
});
