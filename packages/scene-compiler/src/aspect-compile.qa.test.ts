import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ASPECT_PRESET_TARGET,
  buildC4ProjectionBundle,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
} from '@okie/architecture';
import { compileC4Scene } from './compile-c4.js';

// End-to-end aspect-aware packing (task #30). The targetAspect option threads
// architecture (buildC4ProjectionBundle) → compiler (compileC4Scene) through BOTH layout
// stages, so a dense owner stops stacking into one very tall column. It must reach the
// final intrinsic geometry: the owner size is max(stage-1 baseline, stage-2 grid), so
// passing the target to only one stage would leave the tall stage-1 baseline dominating.
//
// Note on width: an owner box never shrinks below its readable baseline card width, so
// the aspect is driven by column count → row count → height. For a genuinely tall owner
// (the reported 50–139-component case) this is exactly the fix; the box goes from very
// tall to landscape. These assertions target that real case (n = 139).

function denseContainer(componentCount: number): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    { id: 'system:d', kind: 'softwareSystem', name: 'D', sourceRefs: [] },
    { id: 'container:c', kind: 'container', parentId: 'system:d', name: 'C', sourceRefs: [] },
  ];
  for (let index = 0; index < componentCount; index += 1) {
    const cid = `component:m${String(index).padStart(3, '0')}`;
    entities.push({ id: cid, kind: 'component', parentId: 'container:c', name: `m${index}`, sourceRefs: [] });
    entities.push({ id: `code:${cid}`, kind: 'code', parentId: cid, name: 'k', sourceRefs: [] });
  }
  return {
    schemaVersion: 1,
    id: 'snapshot:d',
    repositoryId: 'repo:d',
    commitSha: 'c',
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities,
    relations: [],
  };
}

const build = (snapshot: ArchitectureSnapshot, targetAspect?: number) =>
  buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:d',
    focusEntityId: 'system:d',
    familyId: 'f',
    ...(targetAspect !== undefined ? { targetAspect } : {}),
  });

const containerBox = (snapshot: ArchitectureSnapshot, targetAspect?: number) =>
  compileC4Scene(snapshot, build(snapshot, targetAspect), targetAspect !== undefined ? { targetAspect } : {})
    .projections.index.boundsByEntityIdAndBand['container:c']!.component!;

const logDistance = (aspect: number, target: number) => Math.abs(Math.log(aspect / target));

test('default compile (no targetAspect) is deterministic and leaves a 139-component container very tall', () => {
  const snapshot = denseContainer(139);
  const first = compileC4Scene(snapshot, build(snapshot));
  const second = compileC4Scene(snapshot, build(snapshot));
  assert.equal(JSON.stringify(first.scene), JSON.stringify(second.scene), 'default compile must be byte-stable');
  const box = first.projections.index.boundsByEntityIdAndBand['container:c']!.component!;
  assert.ok(box.width / box.height < 0.6, `default packing leaves the container very tall (${(box.width / box.height).toFixed(3)})`);
});

test('a landscape target repacks a 139-component container from very tall to ~16:10', () => {
  const snapshot = denseContainer(139);
  const target = ASPECT_PRESET_TARGET.landscape;
  const tall = containerBox(snapshot);
  const wide = containerBox(snapshot, target);
  const tallAspect = tall.width / tall.height;
  const wideAspect = wide.width / wide.height;
  assert.ok(wide.height < tall.height * 0.5, `aspect target must at least halve the container height (${wide.height.toFixed(1)} vs ${tall.height.toFixed(1)})`);
  assert.ok(wideAspect >= 1.2, `repacked container must no longer be tall (${wideAspect.toFixed(3)})`);
  assert.ok(logDistance(wideAspect, target) < logDistance(tallAspect, target), 'repacked box must be far closer to the landscape target than the default');
});

test('aspect packing stays deterministic under reversed entity order', () => {
  const snapshot = denseContainer(139);
  const target = ASPECT_PRESET_TARGET.landscape;
  const forward = compileC4Scene(snapshot, build(snapshot, target), { targetAspect: target }).scene;
  const reversedSnapshot = { ...snapshot, entities: [...snapshot.entities].reverse() };
  const reversed = compileC4Scene(reversedSnapshot, build(reversedSnapshot, target), { targetAspect: target }).scene;
  assert.equal(JSON.stringify(forward), JSON.stringify(reversed), 'aspect packing must be insertion-order invariant');
});

test('portrait packs a taller container than landscape from the same snapshot', () => {
  const snapshot = denseContainer(139);
  const landscape = containerBox(snapshot, ASPECT_PRESET_TARGET.landscape);
  const portrait = containerBox(snapshot, ASPECT_PRESET_TARGET.portrait);
  assert.ok(portrait.height > landscape.height, `portrait orientation must pack taller than landscape (${portrait.height.toFixed(1)} vs ${landscape.height.toFixed(1)})`);
});
