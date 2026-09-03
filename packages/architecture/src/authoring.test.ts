import assert from 'node:assert/strict';
import test from 'node:test';
import type { ArchitectureSnapshot } from './model.js';
import {
  applyArchitectureAuthoringCommand,
  createArchitectureAuthoringDocument,
  materializeArchitectureAuthoring,
  relationRouteOverrideId,
  serializeArchitectureAuthoringDocument,
  validateArchitectureAuthoringDocument,
  type ArchitectureAuthoringDocument,
  type RelationRouteOverride,
} from './authoring.js';

const snapshot: ArchitectureSnapshot = {
  schemaVersion: 1,
  id: 'snapshot:authoring',
  repositoryId: 'repo:authoring',
  commitSha: 'abc123',
  generatedAt: '2026-07-15T00:00:00.000Z',
  entities: [
    { id: 'system:test', kind: 'softwareSystem', name: 'Test', sourceRefs: [] },
    { id: 'container:a', kind: 'container', parentId: 'system:test', name: 'A', sourceRefs: [] },
    { id: 'container:b', kind: 'container', parentId: 'system:test', name: 'B', sourceRefs: [] },
    { id: 'container:c', kind: 'container', parentId: 'system:test', name: 'C', sourceRefs: [] },
  ],
  relations: [{
    id: 'relation:extracted',
    lineageId: 'lineage:extracted',
    fingerprint: 'fingerprint:extracted',
    from: 'container:a',
    to: 'container:b',
    kind: 'dependsOn',
    label: 'extracted label',
    evidence: [{ source: { path: 'src/a.ts', commitSha: 'abc123' }, reason: 'static import' }],
  }],
};

function routeOverride(relationId = 'relation:extracted'): RelationRouteOverride {
  const scope = { viewId: 'view:system', detail: 'container' as const, relationId };
  return {
    ...scope,
    id: relationRouteOverrideId(scope),
    intent: { sourcePort: 'bottom', targetPort: 'top', waypoints: [{ x: 42, y: 84 }] },
  };
}

test('pure relation commands create, reconnect, delete, and provide exact immutable undo values', () => {
  const empty = createArchitectureAuthoringDocument(snapshot.repositoryId);
  const created = applyArchitectureAuthoringCommand(empty, {
    type: 'put-relation',
    relation: {
      id: 'relation:user',
      from: 'container:a',
      to: 'container:b',
      kind: 'calls',
      label: 'sends command',
    },
  });
  assert.deepEqual(created.undo, empty);
  assert.notEqual(created.document, empty);
  assert.deepEqual(empty.relations, []);

  const routed = applyArchitectureAuthoringCommand(created.document, {
    type: 'put-route-override',
    override: routeOverride('relation:user'),
  });
  const reconnected = applyArchitectureAuthoringCommand(routed.document, {
    type: 'put-relation',
    relation: {
      id: 'relation:user',
      from: 'container:a',
      to: 'container:c',
      kind: 'calls',
      label: 'sends command',
    },
  });
  assert.equal(reconnected.document.relations.length, 1);
  assert.equal(reconnected.document.relations[0]!.to, 'container:c');
  assert.equal(reconnected.document.routeOverrides.length, 1, 'reconnecting keeps per-relation route intent');

  const deleted = applyArchitectureAuthoringCommand(reconnected.document, {
    type: 'delete-relation',
    relationId: 'relation:user',
  });
  assert.deepEqual(deleted.document.relations, []);
  assert.deepEqual(deleted.document.deletedRelationIds, ['relation:user']);
  assert.deepEqual(deleted.document.routeOverrides, [], 'deleting a relation removes its route overrides');
  assert.deepEqual(deleted.undo, reconnected.document);
});

test('materialization shadows extracted semantics but preserves extracted evidence and never mutates facts', () => {
  const empty = createArchitectureAuthoringDocument(snapshot.repositoryId);
  const shadow = applyArchitectureAuthoringCommand(empty, {
    type: 'put-relation',
    relation: {
      id: 'relation:extracted',
      from: 'container:a',
      to: 'container:c',
      kind: 'calls',
      label: 'corrected label',
    },
  }).document;
  const authored = applyArchitectureAuthoringCommand(shadow, {
    type: 'put-relation',
    relation: {
      id: 'relation:user',
      from: 'container:b',
      to: 'container:c',
      kind: 'reads',
    },
  }).document;
  const before = structuredClone(snapshot);
  const effective = materializeArchitectureAuthoring(snapshot, authored);

  assert.deepEqual(snapshot, before);
  assert.notEqual(effective, snapshot);
  assert.deepEqual(effective.relations.map(value => value.id), ['relation:extracted', 'relation:user']);
  const corrected = effective.relations.find(value => value.id === 'relation:extracted')!;
  assert.equal(corrected.to, 'container:c');
  assert.equal(corrected.label, 'corrected label');
  assert.equal(corrected.lineageId, 'lineage:extracted');
  assert.deepEqual(corrected.evidence, snapshot.relations[0]!.evidence);
  assert.notEqual(corrected.evidence, snapshot.relations[0]!.evidence);
  assert.deepEqual(effective.relations.find(value => value.id === 'relation:user')!.evidence, []);

  const deleted = applyArchitectureAuthoringCommand(authored, {
    type: 'delete-relation',
    relationId: 'relation:extracted',
  }).document;
  assert.equal(materializeArchitectureAuthoring(snapshot, deleted).relations.some(value => value.id === 'relation:extracted'), false);
});

test('route reset is a pure removal and canonical serialization is insertion-order stable', () => {
  const empty = createArchitectureAuthoringDocument(snapshot.repositoryId);
  const first = routeOverride();
  const secondScope = { viewId: 'view:other', detail: 'component' as const, relationId: 'relation:extracted' };
  const second: RelationRouteOverride = {
    ...secondScope,
    id: relationRouteOverrideId(secondScope),
    intent: { targetPort: 'right', waypoints: [] },
  };
  const document: ArchitectureAuthoringDocument = {
    ...empty,
    relations: [
      { id: 'relation:z', from: 'container:a', to: 'container:b', kind: 'uses' },
      { id: 'relation:a', from: 'container:b', to: 'container:c', kind: 'calls' },
    ],
    deletedRelationIds: ['relation:z', 'relation:a'],
    routeOverrides: [second, first],
  };
  const reversed: ArchitectureAuthoringDocument = {
    ...document,
    relations: [...document.relations].reverse(),
    deletedRelationIds: [...document.deletedRelationIds].reverse(),
    routeOverrides: [...document.routeOverrides].reverse(),
  };
  assert.equal(serializeArchitectureAuthoringDocument(reversed), serializeArchitectureAuthoringDocument(document));

  const reset = applyArchitectureAuthoringCommand({ ...empty, routeOverrides: [first] }, {
    type: 'reset-route-override',
    overrideId: first.id,
  });
  assert.deepEqual(reset.document.routeOverrides, []);
  assert.equal(reset.undo.routeOverrides[0]!.id, first.id);
});

test('validation rejects stale endpoints, ambiguous empty intent, malformed scopes, and unsafe guides', () => {
  const empty = createArchitectureAuthoringDocument(snapshot.repositoryId);
  const invalidScope = { viewId: 'view:system', detail: 'container' as const, relationId: 'relation:missing' };
  const invalid: ArchitectureAuthoringDocument = {
    ...empty,
    relations: [{ id: 'relation:bad', from: 'container:missing', to: 'container:a', kind: 'uses' }],
    routeOverrides: [{
      ...invalidScope,
      id: 'not-canonical',
      intent: {
        sourcePort: 'diagonal' as 'top',
        waypoints: Array.from({ length: 9 }, (_, index) => ({ x: index === 0 ? Number.NaN : index, y: index })),
      },
    }, {
      viewId: 'view:system',
      detail: 'container',
      relationId: 'relation:extracted',
      id: relationRouteOverrideId({ viewId: 'view:system', detail: 'container', relationId: 'relation:extracted' }),
      intent: { waypoints: [] },
    }],
  };
  const messages = validateArchitectureAuthoringDocument(snapshot, invalid).map(issue => `${issue.path}: ${issue.message}`);
  assert.ok(messages.some(value => value.includes('relations[0].from: unknown entity')));
  assert.ok(messages.some(value => value.includes('routeOverrides[0].id: must equal the canonical scope id')));
  assert.ok(messages.some(value => value.includes('routeOverrides[0].relationId: unknown effective relation')));
  assert.ok(messages.some(value => value.includes('routeOverrides[0].intent.sourcePort: must be a valid orthogonal side')));
  assert.ok(messages.some(value => value.includes('must contain at most 8 guides')));
  assert.ok(messages.some(value => value.includes('must be finite')));
  assert.ok(messages.some(value => value.includes('routeOverrides[1].intent: must specify a preferred port or waypoint')));
});

test('authoring rejects scan-time duplicates relations', () => {
  const document = createArchitectureAuthoringDocument(snapshot.repositoryId);
  document.relations = [{
    id: 'relation:authored-dup',
    from: 'container:a',
    to: 'container:b',
    kind: 'duplicates',
  }];
  const issues = validateArchitectureAuthoringDocument(snapshot, document);
  assert.ok(issues.some(issue => issue.path === 'relations[0].kind' && issue.message === 'unsupported relation kind'));
});
