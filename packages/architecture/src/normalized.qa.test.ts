import assert from 'node:assert/strict';
import test from 'node:test';
import type { ArchitectureSnapshot, ArchitectureStory, ArchitectureView, SourceExcerpt, SourceRef } from './model.js';
import {
  buildNormalizedIndexes,
  normalizeArchitecture,
  selectArchitectureSnapshot,
  selectArchitectureStory,
  selectArchitectureView,
  selectScopedView,
} from './normalized.js';

const source = {
  path: 'src/orders.ts',
  commitSha: 'abc123',
  symbol: 'OrdersService',
  startLine: 10,
  endLine: 80,
};

const snapshot: ArchitectureSnapshot = {
  schemaVersion: 1,
  id: 'snapshot:a',
  repositoryId: 'repo:commerce',
  commitSha: 'abc123',
  generatedAt: '2026-07-14T00:00:00.000Z',
  entities: [
    { id: 'external:payments', kind: 'externalSystem', name: 'Payments', sourceRefs: [] },
    { id: 'component:orders', kind: 'component', parentId: 'container:api', name: 'Orders', sourceRefs: [source], tags: ['domain'], owners: ['@commerce/orders'] },
    { id: 'system:commerce', kind: 'softwareSystem', name: 'Commerce', sourceRefs: [] },
    { id: 'data:ledger', kind: 'dataStore', name: 'Ledger', sourceRefs: [] },
    { id: 'container:api', kind: 'container', parentId: 'system:commerce', name: 'API', sourceRefs: [] },
  ],
  relations: [
    {
      id: 'relation:b-payments-ledger',
      from: 'external:payments',
      to: 'data:ledger',
      kind: 'writes',
      evidence: [],
    },
    {
      id: 'relation:a-orders-payments',
      from: 'component:orders',
      to: 'external:payments',
      kind: 'calls',
      label: 'authorize',
      evidence: [{ source, reason: 'payment client call' }],
    },
  ],
};

const view: ArchitectureView = {
  schemaVersion: 1,
  id: 'view:components',
  snapshotId: snapshot.id,
  name: 'Components',
  rootEntityId: 'system:commerce',
  entityIds: ['external:payments', 'component:orders', 'system:commerce', 'data:ledger', 'container:api', 'component:orders'],
  relationIds: ['relation:b-payments-ledger', 'relation:a-orders-payments', 'relation:a-orders-payments'],
  layout: {
    nodes: {
      'external:payments': { x: 500, y: 0, width: 100, height: 80 },
      'component:orders': { x: 200, y: 0, width: 100, height: 80 },
      'system:commerce': { x: 0, y: 0, width: 700, height: 300 },
      'data:ledger': { x: 650, y: 0, width: 100, height: 80 },
      'container:api': { x: 100, y: 0, width: 300, height: 180 },
    },
    edges: {
      'relation:b-payments-ledger': { points: [{ x: 600, y: 40 }, { x: 650, y: 40 }] },
      'relation:a-orders-payments': { points: [{ x: 300, y: 40 }, { x: 500, y: 40 }] },
    },
  },
};

const story: ArchitectureStory = {
  schemaVersion: 1,
  id: 'story:checkout',
  snapshotId: snapshot.id,
  viewId: view.id,
  title: 'Checkout',
  steps: [
    {
      id: 'authorize',
      title: 'Authorize payment',
      focusEntityIds: ['external:payments', 'component:orders', 'component:orders'],
      traceRelationIds: ['relation:a-orders-payments', 'relation:a-orders-payments'],
      reveal: 'component',
      narration: 'Orders requests payment authorization.',
      sourceRefs: [source],
      durationMs: 1_200,
    },
    {
      id: 'persist',
      title: 'Persist the result',
      focusEntityIds: ['data:ledger', 'external:payments'],
      traceRelationIds: ['relation:b-payments-ledger'],
      narration: 'The provider records the result.',
    },
  ],
};

function normalizeFixture(
  snapshotValue = snapshot,
  viewValue = view,
  storyValue = story,
) {
  return normalizeArchitecture({ snapshot: snapshotValue, views: [viewValue], stories: [storyValue] });
}

test('normalized tables and selectors are deterministic across input insertion order', () => {
  const first = normalizeFixture();
  const reversedSnapshot = {
    ...snapshot,
    entities: [...snapshot.entities].reverse(),
    relations: [...snapshot.relations].reverse(),
  };
  const reversedView = {
    ...view,
    entityIds: [...view.entityIds].reverse(),
    relationIds: [...view.relationIds].reverse(),
    layout: {
      nodes: Object.fromEntries(Object.entries(view.layout.nodes).reverse()),
      edges: Object.fromEntries(Object.entries(view.layout.edges ?? {}).reverse()),
    },
  };
  const second = normalizeFixture(reversedSnapshot, reversedView);

  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.deepEqual(selectArchitectureSnapshot(second, snapshot.id), selectArchitectureSnapshot(first, snapshot.id));
  assert.deepEqual(selectArchitectureView(second, view.id), selectArchitectureView(first, view.id));
  assert.deepEqual(selectArchitectureStory(second, story.id), selectArchitectureStory(first, story.id));
});

test('frozen excerpts serialize and round-trip in canonical order independent of insertion order', () => {
  const excerpt = (path: string, line: number, text: string): SourceExcerpt => ({
    path,
    symbol: 'OrdersService',
    language: 'typescript',
    startLine: line,
    endLine: line,
    highlightLine: line,
    frozenRevision: snapshot.commitSha,
    lines: [text],
    text,
  });
  const excerpts = [
    excerpt('src/orders-b.ts', 20, 'export const b = 2;'),
    excerpt('src/orders-a.ts', 10, 'export const a = 1;'),
  ];
  const refs: SourceRef[] = excerpts.map(value => ({
    path: value.path,
    ...(value.symbol ? { symbol: value.symbol } : {}),
    commitSha: value.frozenRevision,
    startLine: value.startLine,
    endLine: value.endLine,
  }));
  const withExcerpts: ArchitectureSnapshot = {
    ...snapshot,
    entities: snapshot.entities.map(entity => entity.id === 'component:orders' ? {
      ...entity,
      sourceRefs: refs,
      sourceExcerpts: excerpts,
    } : entity),
  };
  const reversed: ArchitectureSnapshot = {
    ...withExcerpts,
    entities: [...withExcerpts.entities].reverse().map(entity => entity.id === 'component:orders' ? {
      ...entity,
      sourceRefs: [...entity.sourceRefs].reverse(),
      sourceExcerpts: [...(entity.sourceExcerpts ?? [])].reverse(),
    } : entity),
  };
  const first = normalizeArchitecture({ snapshot: withExcerpts });
  const second = normalizeArchitecture({ snapshot: reversed });

  assert.deepEqual(second, first);
  const selected = selectArchitectureSnapshot(first, snapshot.id)
    .entities.find(entity => entity.id === 'component:orders')!;
  assert.deepEqual(selected.sourceExcerpts?.map(value => value.path), ['src/orders-a.ts', 'src/orders-b.ts']);
  assert.notEqual(selected.sourceExcerpts?.[0]?.lines, excerpts[1]!.lines, 'selectors must clone frozen line arrays');
});

test('snapshot-qualified row identities prevent logical IDs from crossing scan snapshots', () => {
  const first = normalizeFixture();
  const secondSnapshot = { ...snapshot, id: 'snapshot:b', commitSha: 'def456' };
  const secondView = { ...view, snapshotId: secondSnapshot.id };
  const secondStory = { ...story, snapshotId: secondSnapshot.id };
  const second = normalizeFixture(secondSnapshot, secondView, secondStory);

  assert.ok(first.entityById['snapshot:a::component:orders']);
  assert.equal(first.entityById['snapshot:b::component:orders'], undefined);
  assert.ok(second.entityById['snapshot:b::component:orders']);
  assert.equal(second.entityById['snapshot:a::component:orders'], undefined);
  assert.deepEqual(first.relationById['snapshot:a::relation:a-orders-payments']?.snapshot, ['snapshot', 'snapshot:a']);
  assert.deepEqual(second.relationById['snapshot:b::relation:a-orders-payments']?.snapshot, ['snapshot', 'snapshot:b']);
});

test('normalized indexes return stable containment and directional relation order', () => {
  const normalized = normalizeFixture();
  const indexes = buildNormalizedIndexes(normalized);
  const apiId = 'snapshot:a::container:api';
  const ordersId = 'snapshot:a::component:orders';
  const paymentsId = 'snapshot:a::external:payments';

  assert.equal(indexes.entityBySnapshotAndLogicalId.get('snapshot:a\0component:orders')?.id, ordersId);
  assert.deepEqual(indexes.childrenByEntityId.get(apiId)?.map(entity => entity.id), [ordersId]);
  assert.deepEqual(indexes.outgoingByEntityId.get(ordersId)?.map(relation => relation.logicalId), ['relation:a-orders-payments']);
  assert.deepEqual(indexes.incomingByEntityId.get(paymentsId)?.map(relation => relation.logicalId), ['relation:a-orders-payments']);
});

test('round-trip selectors preserve evidence, layout, story step order, and dedupe set-like references', () => {
  const normalized = normalizeFixture();
  const selectedSnapshot = selectArchitectureSnapshot(normalized, snapshot.id);
  const selectedView = selectArchitectureView(normalized, view.id);
  const selectedStory = selectArchitectureStory(normalized, story.id);

  assert.deepEqual(selectedSnapshot.entities.map(entity => entity.id), [
    'component:orders', 'container:api', 'data:ledger', 'external:payments', 'system:commerce',
  ]);
  assert.deepEqual(selectedSnapshot.relations.map(relation => relation.id), [
    'relation:a-orders-payments', 'relation:b-payments-ledger',
  ]);
  assert.deepEqual(selectedSnapshot.relations[0]?.evidence, [{ source, reason: 'payment client call' }]);
  assert.deepEqual(
    selectedSnapshot.entities.find(entity => entity.id === 'component:orders')?.owners,
    ['@commerce/orders'],
  );
  assert.equal(selectedSnapshot.entities.find(entity => entity.id === 'component:orders')?.cyclomaticComplexity, undefined);
  assert.deepEqual(selectedView.entityIds, [
    'component:orders', 'container:api', 'data:ledger', 'external:payments', 'system:commerce',
  ]);
  assert.deepEqual(selectedView.relationIds, ['relation:a-orders-payments', 'relation:b-payments-ledger']);
  assert.deepEqual(selectedView.layout.edges?.['relation:a-orders-payments'], view.layout.edges?.['relation:a-orders-payments']);
  assert.deepEqual(selectedStory.steps.map(step => step.id), ['authorize', 'persist']);
  assert.deepEqual(selectedStory.steps.map(step => step.title), ['Authorize payment', 'Persist the result']);
  assert.deepEqual(selectedStory.steps[0]?.focusEntityIds, ['component:orders', 'external:payments']);
  assert.deepEqual(selectedStory.steps[0]?.traceRelationIds, ['relation:a-orders-payments']);
  assert.deepEqual(selectedStory.steps[0]?.sourceRefs, [source]);
  assert.equal(selectedStory.steps[0]?.durationMs, 1_200);
  assert.equal(selectedStory.steps[1]?.durationMs, undefined);
});

test('scoped selection is invariant to relation ID ordering and does not walk through a one-hop external neighbor', () => {
  const first = selectScopedView(normalizeFixture(), view.id, 'component:orders');

  const renamedSnapshot: ArchitectureSnapshot = {
    ...snapshot,
    relations: snapshot.relations.map(relation => relation.id === 'relation:a-orders-payments'
      ? { ...relation, id: 'relation:z-orders-payments' }
      : { ...relation, id: 'relation:a-payments-ledger' }),
  };
  const renamedView: ArchitectureView = {
    ...view,
    relationIds: ['relation:z-orders-payments', 'relation:a-payments-ledger'],
    layout: {
      ...view.layout,
      edges: {
        'relation:z-orders-payments': view.layout.edges!['relation:a-orders-payments']!,
        'relation:a-payments-ledger': view.layout.edges!['relation:b-payments-ledger']!,
      },
    },
  };
  const renamedStory: ArchitectureStory = {
    ...story,
    steps: story.steps.map(step => ({
      ...step,
      ...(step.traceRelationIds ? {
        traceRelationIds: step.traceRelationIds.map(id => id === 'relation:a-orders-payments'
          ? 'relation:z-orders-payments'
          : 'relation:a-payments-ledger'),
      } : {}),
    })),
  };
  const second = selectScopedView(normalizeFixture(renamedSnapshot, renamedView, renamedStory), view.id, 'component:orders');

  assert.deepEqual(second.entityIds, first.entityIds);
  assert.deepEqual(first.entityIds, ['component:orders', 'container:api', 'external:payments', 'system:commerce']);
  assert.equal(first.entityIds.includes('data:ledger'), false);
  assert.equal(second.entityIds.includes('data:ledger'), false);
});

test('selectors fail explicitly for unknown snapshot, view, story, and out-of-view roots', () => {
  const normalized = normalizeFixture();
  assert.throws(() => selectArchitectureSnapshot(normalized, 'snapshot:missing'), /Unknown normalized snapshot/);
  assert.throws(() => selectArchitectureView(normalized, 'view:missing'), /Unknown normalized view/);
  assert.throws(() => selectArchitectureStory(normalized, 'story:missing'), /Unknown normalized story/);
  assert.throws(() => selectScopedView(normalized, view.id, 'component:missing'), /outside normalized view/);
});

test('normalize round-trip preserves observed cyclomatic on a code entity', () => {
  const local: ArchitectureSnapshot = {
    schemaVersion: 1,
    id: 'snapshot:cyc',
    repositoryId: 'repo:cyc',
    commitSha: 'abc123',
    generatedAt: '2026-07-14T00:00:00.000Z',
    entities: [
      { id: 'system:cyc', kind: 'softwareSystem', name: 'Cyc', sourceRefs: [] },
      { id: 'container:lib', kind: 'container', parentId: 'system:cyc', name: 'Lib', sourceRefs: [] },
      { id: 'component:lib-src', kind: 'component', parentId: 'container:lib', name: 'src', sourceRefs: [source] },
      {
        id: 'code:lib-src:handler',
        kind: 'code',
        parentId: 'component:lib-src',
        name: 'handler',
        sourceRefs: [source],
        cyclomaticComplexity: 7,
      },
    ],
    relations: [],
  };
  const selected = selectArchitectureSnapshot(normalizeArchitecture({ snapshot: local }), local.id);
  assert.equal(selected.entities.find(entity => entity.id === 'code:lib-src:handler')?.cyclomaticComplexity, 7);
  assert.equal(selected.entities.find(entity => entity.id === 'component:lib-src')?.cyclomaticComplexity, undefined);
});

test('normalize round-trip preserves observed lcov coverage on a code entity and omits it elsewhere', () => {
  const local: ArchitectureSnapshot = {
    schemaVersion: 1,
    id: 'snapshot:cov',
    repositoryId: 'repo:cov',
    commitSha: 'abc123',
    generatedAt: '2026-07-14T00:00:00.000Z',
    entities: [
      { id: 'system:cov', kind: 'softwareSystem', name: 'Cov', sourceRefs: [] },
      { id: 'container:lib', kind: 'container', parentId: 'system:cov', name: 'Lib', sourceRefs: [] },
      { id: 'component:lib-src', kind: 'component', parentId: 'container:lib', name: 'src', sourceRefs: [source] },
      {
        id: 'code:lib-src:handler',
        kind: 'code',
        parentId: 'component:lib-src',
        name: 'handler',
        sourceRefs: [source],
        coverageFileHitRate: 0.3,
        coverageUntestedRanges: [{ startLine: 12, endLine: 14 }],
      },
    ],
    relations: [],
  };
  const selected = selectArchitectureSnapshot(normalizeArchitecture({ snapshot: local }), local.id);
  const handler = selected.entities.find(entity => entity.id === 'code:lib-src:handler');
  assert.equal(handler?.coverageFileHitRate, 0.3);
  assert.deepEqual(handler?.coverageUntestedRanges, [{ startLine: 12, endLine: 14 }]);
  assert.equal(selected.entities.find(entity => entity.id === 'component:lib-src')?.coverageFileHitRate, undefined);
  assert.equal(selected.entities.find(entity => entity.id === 'component:lib-src')?.coverageUntestedRanges, undefined);
});
