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

  it('fills missing responsibility with the honest no-summary placeholder (CLA-58)', () => {
    const protocol = toProtocolScene(scene([{
      id: 'external:react',
      name: 'react',
      kind: 'system',
      responsibility: '',
      x: 0,
      y: 0,
      width: 220,
      height: 130,
    }])) as {
      objects: Array<{ representations: Array<{ primitives: Array<{ kind: string; content?: string }> }> }>;
    };
    const texts = protocol.objects[0]!.representations[1]!.primitives
      .filter(primitive => primitive.kind === 'text')
      .map(primitive => primitive.content);
    expect(texts).toContain('No summary supplied.');
  });
});
