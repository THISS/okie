import { describe, expect, it } from 'vitest';
import { toProtocolScene } from './protocolScene';
import type { AtlasScene, SceneEntity } from './types';

type ProtocolPrimitive = { kind: string; radius?: number; rect?: { width: number; height: number } };
type ProtocolScene = { objects: Array<{ representations: Array<{ primitives: ProtocolPrimitive[] }> }> };

function entity(id: string, width: number, height: number): SceneEntity {
  return { id, name: id, kind: 'component', responsibility: 'r', x: 0, y: 0, width, height };
}

function scene(entities: SceneEntity[]): AtlasScene {
  return { id: 'test', title: 'Test', subtitle: '', entities, relations: [], regions: [] };
}

function roundedRects(atlasScene: AtlasScene): ProtocolPrimitive[] {
  const protocol = toProtocolScene(atlasScene) as ProtocolScene;
  return protocol.objects
    .flatMap(object => object.representations.flatMap(representation => representation.primitives))
    .filter(primitive => primitive.kind === 'roundedRect');
}

describe('protocol scene roundedRect radius', () => {
  it('clamps radius to <= min(width, height) / 2 for tiny entities', () => {
    const rects = roundedRects(scene([entity('tiny', 10, 6), entity('sliver', 4, 2)]));
    expect(rects.length).toBeGreaterThan(0);
    for (const rect of rects) {
      expect(rect.radius!).toBeGreaterThanOrEqual(0);
      expect(rect.radius!).toBeLessThanOrEqual(Math.min(rect.rect!.width, rect.rect!.height) / 2);
    }
    expect(rects.map(rect => rect.radius)).toContain(3); // 10x6 -> min(13, 5, 3) = 3
    expect(rects.map(rect => rect.radius)).toContain(1); // 4x2 -> min(13, 2, 1) = 1
  });

  it('keeps the default radius 13 for large (golden-sized) entities', () => {
    const rects = roundedRects(scene([entity('big', 220, 130)]));
    expect(rects.length).toBeGreaterThan(0);
    for (const rect of rects) expect(rect.radius).toBe(13);
  });
});
