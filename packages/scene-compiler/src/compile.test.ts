import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { STORY_AUTHORING_LIMITS, type ArchitectureSnapshot, type ArchitectureStory, type ArchitectureView } from "@okie/architecture";
import { compileScene } from "./compile-scene.js";
import { compileStory, maximumNarrationHoldMs } from "./compile-story.js";
import { defaultTheme } from "./theme.js";

const fixture = (path: string): string => fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(fixture(path), "utf8")) as T;
}

test("compiles semantic fixtures into a coherent renderer protocol", async () => {
  const [snapshot, view, story] = await Promise.all([
    readJson<ArchitectureSnapshot>("architecture/demo-snapshot.json"),
    readJson<ArchitectureView>("architecture/demo-view.json"),
    readJson<ArchitectureStory>("architecture/demo-story.json"),
  ]);
  const scene = compileScene(snapshot, view);
  const timeline = compileStory(snapshot, view, story, scene);
  assert.equal(scene.objects.filter(object => !object.id.startsWith('relation-label:')).length, snapshot.entities.length);
  assert.equal(scene.paths.length, snapshot.relations.length);
  assert.equal(timeline.sceneId, scene.sceneId);
  assert.equal(timeline.keyframes.length, story.steps.length * 2);
});

test("compilation is independent of input array order", async () => {
  const [snapshot, view] = await Promise.all([
    readJson<ArchitectureSnapshot>("architecture/demo-snapshot.json"),
    readJson<ArchitectureView>("architecture/demo-view.json"),
  ]);
  const compiled = compileScene(snapshot, view);
  const reversed = compileScene(
    { ...snapshot, entities: [...snapshot.entities].reverse(), relations: [...snapshot.relations].reverse() },
    { ...view, entityIds: [...view.entityIds].reverse(), relationIds: [...view.relationIds].reverse() },
  );
  assert.deepEqual(reversed, compiled);
});

test("emits deterministic non-pickable relation label objects without changing paths", async () => {
  const [snapshot, view] = await Promise.all([
    readJson<ArchitectureSnapshot>("architecture/demo-snapshot.json"),
    readJson<ArchitectureView>("architecture/demo-view.json"),
  ]);
  const scene = compileScene(snapshot, view);
  const labelObjects = scene.objects.filter((object) => object.id.startsWith("relation-label:"));
  assert.equal(labelObjects.length, snapshot.relations.filter((relation) => relation.label).length);
  assert.ok(labelObjects.every((object) => !object.pickable));

  const relation = snapshot.relations.find(candidate => candidate.id === 'relation:web-controls-renderer')!;
  const path = scene.paths.find((candidate) => candidate.id === relation.id);
  assert.ok(path);
  assert.equal(path.points.length, 2);
  const label = labelObjects.find((object) => object.id === `relation-label:${relation.id}`);
  assert.ok(label);
  assert.equal(label.pickable, false);
  assert.deepEqual(label.representations[0]?.lod, path.lod);
  assert.ok(label.representations[0]?.primitives.some(primitive => primitive.kind === 'text' && primitive.content === relation.label));
});

test("rejects non-finite compiler options and theme colors", async () => {
  const [snapshot, view, story] = await Promise.all([
    readJson<ArchitectureSnapshot>("architecture/demo-snapshot.json"),
    readJson<ArchitectureView>("architecture/demo-view.json"),
    readJson<ArchitectureStory>("architecture/demo-story.json"),
  ]);
  assert.throws(() => compileScene(snapshot, view, { worldPadding: Number.NaN }));
  assert.throws(() => compileScene(snapshot, view, { revision: Number.POSITIVE_INFINITY }));
  assert.throws(() =>
    compileScene(snapshot, view, {
      theme: { ...defaultTheme, edge: [0, Number.NEGATIVE_INFINITY, 0, 1] },
    }),
  );
  assert.throws(() =>
    compileScene(snapshot, view, {
      theme: { ...defaultTheme, edgeLabel: [0, 0, Number.NaN, 1] },
    }),
  );
  const scene = compileScene(snapshot, view);
  assert.throws(() => compileStory(snapshot, view, story, scene, { maximumZoom: Number.POSITIVE_INFINITY }));
  assert.throws(() => compileStory(snapshot, view, story, scene, { padding: Number.NaN }));
});

test("uses authoritative authored holds and reading-time fallback only when absent", async () => {
  const [snapshot, view, story] = await Promise.all([
    readJson<ArchitectureSnapshot>("architecture/demo-snapshot.json"),
    readJson<ArchitectureView>("architecture/demo-view.json"),
    readJson<ArchitectureStory>("architecture/demo-story.json"),
  ]);
  const scene = compileScene(snapshot, view);
  const firstStep = story.steps[0];
  assert.ok(firstStep);
  const authored = compileStory(snapshot, view, story, scene);
  const authoredArrival = authored.keyframes[0];
  const authoredHold = authored.keyframes[1];
  assert.ok(authoredArrival && authoredHold && firstStep.durationMs);
  assert.equal(authoredHold.atMs - authoredArrival.atMs, 150 + firstStep.durationMs);

  const { durationMs: _durationMs, ...withoutDuration } = firstStep;
  const fallbackStory: ArchitectureStory = {
    ...story,
    steps: [{
      ...withoutDuration,
      narration: Array.from({ length: 18 }, () => "word").join(" "),
    }, ...story.steps.slice(1)],
  };
  const fallback = compileStory(snapshot, view, fallbackStory, scene);
  const fallbackArrival = fallback.keyframes[0];
  const fallbackHold = fallback.keyframes[1];
  assert.ok(fallbackArrival && fallbackHold);
  assert.equal(fallbackHold.atMs - fallbackArrival.atMs, 150 + 7_200);
});

test("narration hold cap stays within the validator's authored duration ceiling", () => {
  // Cross-package invariant: the compiler auto-hold must never exceed what the
  // validator (@okie/architecture) will accept as an authored step.durationMs,
  // so a fallback hold cannot outlast an explicit one. Catches drift if either moves.
  assert.ok(maximumNarrationHoldMs <= STORY_AUTHORING_LIMITS.maxStepDurationMs);
});
