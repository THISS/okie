import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ASPECT_PRESET_TARGET,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
  type EntityKind,
} from '@okie/architecture';
import { BAND_COST_HANG_GUARD_ENTITIES } from '@okie/scene-compiler';
import { createC4Scene } from './renderer/goldenC4Scene';
import {
  SCAN_BAND_DEPTH_MIN_ENTITIES,
  SCAN_NEIGHBORHOOD_TARGET_ASPECT,
  scanScopeCompileOptions,
} from './renderer/scanFixture';

function entity(id: string, kind: EntityKind, parentId?: string, name = id): ArchitectureEntity {
  return { id, name, kind, sourceRefs: [], ...(parentId ? { parentId } : {}) };
}

/** ~79 file-components under one container — the @okie/web L3 skyscraper case. */
function denseWebNeighborhood(componentCount = 79): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    entity('system:okie', 'softwareSystem', undefined, 'Okie'),
    entity('container:web', 'container', 'system:okie', '@okie/web'),
    entity('container:server', 'container', 'system:okie', '@okie/server'),
  ];
  for (let index = 0; index < componentCount; index += 1) {
    const id = `component:web-${String(index).padStart(2, '0')}`;
    entities.push(entity(id, 'component', 'container:web', `File${index}`));
  }
  for (let index = 0; index < 4; index += 1) {
    entities.push(entity(`component:server-${index}`, 'component', 'container:server', `Srv${index}`));
  }
  return {
    schemaVersion: 1,
    id: 'snapshot:cla-118',
    repositoryId: 'repo:cla-118',
    commitSha: 'c'.repeat(40),
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities,
    relations: [],
  };
}

function childCountsFrom(snapshot: ArchitectureSnapshot): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of snapshot.entities) {
    if (!item.parentId) continue;
    counts[item.parentId] = (counts[item.parentId] ?? 0) + 1;
  }
  return counts;
}

function uniqueColumns(boxes: readonly { x: number }[]): number {
  return new Set(boxes.map(box => Math.round(box.x * 100) / 100)).size;
}

function componentBoxes(scene: ReturnType<typeof createC4Scene>, parentId: string) {
  return scene.entities
    .filter(item => item.parentId === parentId && item.detail === 'component')
    .map(item => scene.projection?.boundsByEntityIdAndDetail[item.id]?.component)
    .filter((box): box is { x: number; y: number; width: number; height: number } => Boolean(box));
}

describe('CLA-118: container-focus neighborhood packs landscape ~1.6, not a 3-col skyscraper', () => {
  const fixtureSource = readFileSync(new URL('./renderer/scanFixture.ts', import.meta.url), 'utf8');

  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(BAND_COST_HANG_GUARD_ENTITIES).toBe(2000);
    expect(fixtureSource).toContain('export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;');
  });

  it('container-focus scoped compile applies landscape 1.6 without a mode-level option', () => {
    expect(SCAN_NEIGHBORHOOD_TARGET_ASPECT).toBe(ASPECT_PRESET_TARGET.landscape);
    expect(SCAN_NEIGHBORHOOD_TARGET_ASPECT).toBe(1.6);
    const snapshot = denseWebNeighborhood();
    const scoped = scanScopeCompileOptions(snapshot, 'container:web');
    expect(scoped.targetAspect).toBe(ASPECT_PRESET_TARGET.landscape);
    expect(scoped.maxBand).toBe('component');
    const system = scanScopeCompileOptions(snapshot, 'system:okie');
    expect(system.targetAspect).toBeUndefined();
  });

  it('~79 @okie/web children pack into 6–8 landscape columns on the scan neighborhood seam', () => {
    const snapshot = denseWebNeighborhood(79);
    const scoped = scanScopeCompileOptions(snapshot, 'container:web');
    const scene = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: 'system:okie',
      focusEntityId: 'container:web',
      familyId: 'view-family:cla-118:web',
      sceneId: 'scan:cla-118:c4',
      title: 'CLA-118',
      subtitle: 'container-focus neighborhood',
      frozenRevision: snapshot.commitSha,
      childCounts: childCountsFrom(snapshot),
      ...scoped,
    });
    expect(scene.targetAspect).toBe(ASPECT_PRESET_TARGET.landscape);
    const box = scene.projection?.boundsByEntityIdAndDetail['container:web']?.component;
    expect(box).toBeDefined();
    const children = componentBoxes(scene, 'container:web');
    expect(children).toHaveLength(79);
    const columns = uniqueColumns(children);
    expect(columns).toBeGreaterThanOrEqual(6);
    expect(columns).toBeLessThanOrEqual(8);
    const aspect = box!.width / box!.height;
    expect(aspect).toBeGreaterThanOrEqual(1.2);
    expect(Math.abs(aspect - ASPECT_PRESET_TARGET.landscape)).toBeLessThan(0.45);
  });

  it('omitting targetAspect on a container-focus compile still yields the 3-col skyscraper', () => {
    const snapshot = denseWebNeighborhood(79);
    const scene = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: 'system:okie',
      focusEntityId: 'container:web',
      familyId: 'view-family:cla-118:tall',
      sceneId: 'scan:cla-118:tall',
      title: 'CLA-118 tall',
      subtitle: 'no targetAspect',
      frozenRevision: snapshot.commitSha,
      childCounts: childCountsFrom(snapshot),
      maxBand: 'component',
    });
    expect(scene.targetAspect).toBeUndefined();
    const box = scene.projection?.boundsByEntityIdAndDetail['container:web']?.component;
    expect(box).toBeDefined();
    const children = componentBoxes(scene, 'container:web');
    expect(uniqueColumns(children)).toBe(3);
    expect(box!.width / box!.height).toBeLessThan(0.6);
  });
});
