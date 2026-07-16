import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type ArchitectureSnapshot,
  type ArchitectureStory,
  type ArchitectureView,
  normalizeArchitecture,
} from '@okie/architecture';
import { compileNormalizedPatch, compileNormalizedScene, compileNormalizedTimeline } from './compile-normalized.js';
import { compileScene } from './compile-scene.js';
import { compileStory } from './compile-story.js';

const fixture = (path: string): string => fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(fixture(path), 'utf8')) as T;
}

test('normalized selectors compile the same generic scene and timeline as direct inputs', async () => {
  const [snapshot, view, story] = await Promise.all([
    readJson<ArchitectureSnapshot>('architecture/demo-snapshot.json'),
    readJson<ArchitectureView>('architecture/demo-view.json'),
    readJson<ArchitectureStory>('architecture/demo-story.json'),
  ]);
  const state = normalizeArchitecture({ snapshot, views: [view], stories: [story] });
  const scene = compileNormalizedScene(state, view.id);
  const timeline = compileNormalizedTimeline(state, story.id, scene);

  assert.deepEqual(scene, compileScene(snapshot, view));
  assert.deepEqual(timeline, compileStory(snapshot, view, story, scene));
});

test('normalized scene patches are minimal, sorted, revision-safe, and scope-aware', async () => {
  const [snapshot, view, story] = await Promise.all([
    readJson<ArchitectureSnapshot>('architecture/demo-snapshot.json'),
    readJson<ArchitectureView>('architecture/demo-view.json'),
    readJson<ArchitectureStory>('architecture/demo-story.json'),
  ]);
  const state = normalizeArchitecture({ snapshot, views: [view], stories: [story] });
  const scene = compileNormalizedScene(state, view.id);
  const unchanged = compileNormalizedPatch(state, view.id, scene, { revision: 2 });
  assert.deepEqual(unchanged, {
    protocolVersion: 1,
    sceneId: scene.sceneId,
    baseRevision: 1,
    revision: 2,
    upsertObjects: [],
    removeObjectIds: [],
    upsertPaths: [],
    removePathIds: [],
  });

  const scoped = compileNormalizedPatch(state, view.id, scene, {
    revision: 3,
    rootEntityId: 'container:architecture-model',
    transition: { durationMs: 280, easing: 'easeOut' },
  });
  assert.ok(scoped.removeObjectIds.length > 0);
  assert.ok(scoped.removePathIds.length > 0);
  assert.ok(!scoped.removeObjectIds.includes('container:architecture-model'));
  assert.deepEqual(scoped.upsertObjects, []);
  assert.deepEqual(scoped.upsertPaths, []);
  assert.deepEqual(scoped.transition, { durationMs: 280, easing: 'easeOut' });
  assert.throws(() => compileNormalizedPatch(state, view.id, scene, { revision: 1 }));
});
