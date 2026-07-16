import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ArchitectureSnapshot, ArchitectureStory, ArchitectureView } from './model.js';
import {
  buildNormalizedIndexes,
  normalizeArchitecture,
  selectArchitectureSnapshot,
  selectArchitectureStory,
  selectArchitectureView,
  selectScopedView,
} from './normalized.js';

const fixture = (path: string): string => fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(fixture(path), 'utf8')) as T;
}

async function semanticFixtures() {
  return Promise.all([
    readJson<ArchitectureSnapshot>('architecture/demo-snapshot.json'),
    readJson<ArchitectureView>('architecture/demo-view.json'),
    readJson<ArchitectureStory>('architecture/demo-story.json'),
  ]);
}

test('normalizes semantic fixtures deterministically with stable version-qualified refs', async () => {
  const [snapshot, view, story] = await semanticFixtures();
  const normalized = normalizeArchitecture({ snapshot, views: [view], stories: [story] });
  const reordered = normalizeArchitecture({
    snapshot: {
      ...snapshot,
      entities: [...snapshot.entities].reverse(),
      relations: [...snapshot.relations].reverse(),
    },
    views: [{ ...view, entityIds: [...view.entityIds].reverse(), relationIds: [...view.relationIds].reverse() }],
    stories: [story],
  });

  assert.deepEqual(reordered, normalized);
  assert.deepEqual(normalized.repositoryById[snapshot.repositoryId]?.latestSnapshot, ['snapshot', snapshot.id]);
  assert.deepEqual(normalized.entityById[`${snapshot.id}::container:web-app`]?.snapshot, ['snapshot', snapshot.id]);
  assert.deepEqual(normalized.relationById[`${snapshot.id}::relation:web-controls-renderer`]?.from, [
    'entity',
    `${snapshot.id}::container:web-app`,
  ]);
  assert.ok(Object.keys(normalized.sourceRefById).length > 0);
  const evidenceState = normalizeArchitecture({
    snapshot: {
      ...snapshot,
      relations: snapshot.relations.map((relation, index) => index === 0 ? {
        ...relation,
        evidence: [{
          source: { path: 'src/index.ts', commitSha: snapshot.commitSha, startLine: 2, endLine: 4 },
          reason: 'Direct call site',
        }],
      } : relation),
    },
  });
  const evidence = Object.values(evidenceState.evidenceById).find(value => value.reason === 'Direct call site');
  assert.equal(evidence?.reason, 'Direct call site');
  assert.equal(evidence?.source[0], 'sourceRef');
});

test('pure selectors denormalize canonical snapshot, view, story, and indexes', async () => {
  const [snapshot, view, story] = await semanticFixtures();
  const normalized = normalizeArchitecture({ snapshot, views: [view], stories: [story] });
  const selectedSnapshot = selectArchitectureSnapshot(normalized, snapshot.id);
  const selectedView = selectArchitectureView(normalized, view.id);
  const selectedStory = selectArchitectureStory(normalized, story.id);
  const indexes = buildNormalizedIndexes(normalized);

  assert.deepEqual(selectedSnapshot.entities.map(entity => entity.id), [...view.entityIds].sort());
  assert.deepEqual(selectedSnapshot.relations.map(relation => relation.id), [...view.relationIds].sort());
  assert.deepEqual(selectedView.entityIds, [...view.entityIds].sort());
  assert.deepEqual(selectedView.relationIds, [...view.relationIds].sort());
  assert.deepEqual(
    normalizeArchitecture({ snapshot: selectedSnapshot, views: [selectedView], stories: [selectedStory] }),
    normalized,
  );
  assert.equal(
    indexes.entityBySnapshotAndLogicalId.get(`${snapshot.id}\u0000container:web-app`)?.logicalId,
    'container:web-app',
  );
  assert.deepEqual(
    indexes.childrenByEntityId.get(`${snapshot.id}::system:okie`)?.map(entity => entity.logicalId),
    [
      'container:architecture-model',
      'container:rust-renderer',
      'container:scene-compiler',
      'container:tooling',
      'container:web-app',
    ],
  );
});

test('scoped view contains the root, descendants, ancestors, and directly connected context', async () => {
  const [snapshot, view, story] = await semanticFixtures();
  const normalized = normalizeArchitecture({ snapshot, views: [view], stories: [story] });
  const scoped = selectScopedView(normalized, view.id, 'container:architecture-model');

  assert.equal(scoped.rootEntityId, 'container:architecture-model');
  assert.ok(scoped.entityIds.includes('system:okie'));
  assert.ok(scoped.entityIds.includes('component:model-scoping'));
  assert.ok(scoped.entityIds.includes('code:model-scoping:select-scoped-view'));
  assert.ok(scoped.entityIds.includes('container:scene-compiler'));
  assert.ok(scoped.relationIds.includes('relation:model-to-compiler'));
  assert.deepEqual(Object.keys(scoped.layout.nodes).sort(), scoped.entityIds);
  assert.ok(Object.keys(scoped.layout.edges ?? {}).every(id => scoped.relationIds.includes(id)));
});
