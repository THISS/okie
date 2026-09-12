import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ASPECT_PRESET_TARGET,
  C4_SCAN_L2_RESIDENT_PREVIEW_PILLS,
  c4ScanContainerPeerTile,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
  type EntityKind,
} from '@okie/architecture';
import { BAND_COST_HANG_GUARD_ENTITIES } from '@okie/scene-compiler';
import { createC4Scene } from './renderer/goldenC4Scene';
import {
  SCAN_BAND_DEPTH_MIN_ENTITIES,
  SCAN_L2_RESIDENT_PREVIEW_PILLS,
  scanScopeCompileOptions,
} from './renderer/scanFixture';

function entity(id: string, kind: EntityKind, parentId?: string, name = id): ArchitectureEntity {
  return { id, name, kind, sourceRefs: [], ...(parentId ? { parentId } : {}) };
}

/** CLA-65 pair: fat `@okie/web` + thinner `@okie/server`. */
function webServerNeighborhood(webCount = 79, serverCount = 8): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    entity('system:okie', 'softwareSystem', undefined, 'Okie'),
    entity('container:apps-web', 'container', 'system:okie', '@okie/web'),
    entity('container:apps-server', 'container', 'system:okie', '@okie/server'),
  ];
  for (let index = 0; index < webCount; index += 1) {
    const id = `component:web-${String(index).padStart(2, '0')}`;
    entities.push(entity(id, 'component', 'container:apps-web', `File${index}.ts`));
    entities.push(entity(`code:${id}`, 'code', id, 'k'));
  }
  for (let index = 0; index < serverCount; index += 1) {
    const id = `component:server-${index}`;
    entities.push(entity(id, 'component', 'container:apps-server', `srv${index}.ts`));
    entities.push(entity(`code:${id}`, 'code', id, 'k'));
  }
  return {
    schemaVersion: 1,
    id: 'snapshot:cla-120',
    repositoryId: 'repo:cla-120',
    commitSha: 'c'.repeat(40),
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities,
    relations: [],
  };
}

describe('CLA-120: cap L2 resident preview pills +N more', () => {
  const fixtureSource = readFileSync(new URL('./renderer/scanFixture.ts', import.meta.url), 'utf8');
  const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(BAND_COST_HANG_GUARD_ENTITIES).toBe(2000);
    expect(SCAN_L2_RESIDENT_PREVIEW_PILLS).toBe(10);
    expect(C4_SCAN_L2_RESIDENT_PREVIEW_PILLS).toBe(10);
    expect(fixtureSource).toContain('export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;');
    expect(fixtureSource).toContain('maxL2PreviewPillsPerOwner');
    expect(appSource).toContain('`Show all ${inspectorChildren.length}`');
    expect(appSource).toContain("aria-expanded={expandedDetailLists.has('children')}");
  });

  it('scan L2 options cap preview pills; Open inside does not inherit the cap', () => {
    const snapshot = webServerNeighborhood();
    expect(scanScopeCompileOptions(snapshot, 'system:okie').maxL2PreviewPillsPerOwner)
      .toBe(SCAN_L2_RESIDENT_PREVIEW_PILLS);
    expect(scanScopeCompileOptions(snapshot, 'container:apps-web').maxL2PreviewPillsPerOwner)
      .toBeUndefined();
  });

  it('L2 @okie/web shows ~10 landmark pills and +N more; @okie/server keeps its handful', () => {
    const snapshot = webServerNeighborhood();
    const l2 = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: 'system:okie',
      focusEntityId: 'system:okie',
      familyId: 'f',
      sceneId: 's',
      title: 't',
      subtitle: 's',
      frozenRevision: 'c',
      maxBand: 'code',
      maxNodesPerBand: 50,
      pageCodeLandmarks: true,
      maxL2PreviewPillsPerOwner: SCAN_L2_RESIDENT_PREVIEW_PILLS,
      targetAspect: ASPECT_PRESET_TARGET.landscape,
    });
    const web = l2.projection?.boundsByEntityIdAndDetail['container:apps-web']?.container;
    const server = l2.projection?.boundsByEntityIdAndDetail['container:apps-server']?.container;
    expect(web?.width).toBeCloseTo(c4ScanContainerPeerTile(79).width, 5);
    expect(server?.width).toBeCloseTo(c4ScanContainerPeerTile(8).width, 5);

    const webPills = snapshot.entities
      .filter(item => item.parentId === 'container:apps-web' && item.kind === 'component')
      .filter(item => l2.projection?.boundsByEntityIdAndDetail[item.id]?.component);
    const serverPills = snapshot.entities
      .filter(item => item.parentId === 'container:apps-server' && item.kind === 'component')
      .filter(item => l2.projection?.boundsByEntityIdAndDetail[item.id]?.component);
    expect(webPills).toHaveLength(SCAN_L2_RESIDENT_PREVIEW_PILLS);
    expect(serverPills).toHaveLength(8);
    expect((l2.omittedNodes ?? []).filter(node => node.parentId === 'container:apps-web' && node.detail === 'component'))
      .toHaveLength(79 - SCAN_L2_RESIDENT_PREVIEW_PILLS);

    const protocol = l2.protocolSnapshot as { objects: Array<{ representations: Array<{ primitives: Array<{ kind: string; content?: string }> }> }> };
    const labels = protocol.objects.flatMap(object => object.representations)
      .flatMap(representation => representation.primitives)
      .filter(primitive => primitive.kind === 'text')
      .map(primitive => primitive.content ?? '');
    expect(labels.some(content => content.includes('+69 more'))).toBe(true);
  });

  it('Open inside @okie/web still lands on the full L3 file set', () => {
    const snapshot = webServerNeighborhood();
    const l3 = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: 'system:okie',
      focusEntityId: 'container:apps-web',
      familyId: 'f',
      sceneId: 's',
      title: 't',
      subtitle: 's',
      frozenRevision: 'c',
      maxBand: 'component',
      targetAspect: ASPECT_PRESET_TARGET.landscape,
    });
    expect(l3.rootEntityId).toBe('container:apps-web');
    expect(scanScopeCompileOptions(snapshot, 'container:apps-web').maxL2PreviewPillsPerOwner).toBeUndefined();
    const cards = snapshot.entities
      .filter(item => item.parentId === 'container:apps-web' && item.kind === 'component')
      .filter(item => l3.projection?.boundsByEntityIdAndDetail[item.id]?.component);
    expect(cards).toHaveLength(79);
  });
});
