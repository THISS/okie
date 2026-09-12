import { describe, expect, it } from 'vitest';
import type { AtlasScene, ProjectionOverride } from './renderer/types';
import { minimapEntityRects, minimapWorldRect } from './minimapGeometry';
import { minimapProjector } from './minimap';

const scene = {
  entities: [
    { id: 'system', detail: 'context', x: -999, y: -999, width: 1, height: 1 },
    { id: 'child', detail: 'component', x: -999, y: -999, width: 1, height: 1 },
    { id: 'code', detail: 'code', x: -999, y: -999, width: 1, height: 1 },
  ],
  projection: {
    visualToSemanticEntityId: { 'visual-system': 'system', 'visual-child': 'child', 'visual-code': 'code' },
    entityIdsByDetail: { context: ['system'], container: ['system'], component: ['system', 'child'], code: ['system', 'child', 'code'] },
    boundsByEntityIdAndDetail: {
      system: { context: { x: 0, y: 0, width: 100, height: 100 }, container: { x: 200, y: 100, width: 200, height: 200 } },
      child: { component: { x: 220, y: 120, width: 40, height: 40 } },
      code: { code: { x: 280, y: 180, width: 20, height: 20 } },
    },
  },
} as unknown as AtlasScene;
const override: ProjectionOverride = {
  id: 'scope', progress: .5,
  objects: [
    { objectId: 'visual-system', sourceRepresentationId: 'system:context', targetRepresentationId: 'system:container' },
    { objectId: 'visual-child', targetRepresentationId: 'child:component' },
    { objectId: 'visual-code', targetRepresentationId: 'code:code' },
  ], paths: [],
  morph: { boundaryObjectId: 'visual-system', objectIds: ['visual-system', 'visual-child', 'visual-code'], pathIds: [] },
};

describe('minimap rendered projection geometry', () => {
  it('uses representation bounds instead of legacy entity coordinates', () => {
    expect(minimapEntityRects(scene)).toEqual([{ id: 'system', detail: 'context', rect: { x: 0, y: 0, width: 100, height: 100 } }]);
  });

  it('moves the boundary and affinely nests L3 and L4 in that same morphed boundary', () => {
    const entries = minimapEntityRects(scene, override);
    expect(entries.map(entry => entry.id)).toEqual(['system', 'child', 'code']);
    expect(entries[0]!.rect).toEqual({ x: 100, y: 50, width: 150, height: 150 });
    expect(entries[1]!.rect).toEqual({ x: 115, y: 65, width: 30, height: 30 });
    expect(entries[2]!.rect).toEqual({ x: 160, y: 110, width: 15, height: 15 });
    expect(entries[1]!.opacity).toBe(.5);
  });

  it('removes hidden objects from the selected scope and snaps reduced motion consistently', () => {
    const hidden = { ...override, objects: override.objects.map(object => ({ ...object, sourceOpacity: 0, targetOpacity: 0 })) };
    expect(minimapEntityRects(scene, hidden)).toEqual([]);
    const early = minimapEntityRects(scene, { ...override, progress: .49 }, 'context', true);
    expect(early.map(entry => entry.id)).toEqual(['system']);
    expect(early[0]!.rect).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(minimapEntityRects(scene, override, 'context', true)[1]!.rect).toEqual({ x: 220, y: 120, width: 40, height: 40 });
  });

  it('fits the visible scope throughout a reveal without including unrelated deep representations', () => {
    const expanded = { ...scene, projection: { ...scene.projection!, boundsByEntityIdAndDetail: {
      ...scene.projection!.boundsByEntityIdAndDetail,
      unrelated: { code: { x: 10000, y: 10000, width: 9000, height: 9000 } },
    } } };
    for (const progress of [0, .00001, .25, .5, .75, 1]) {
      const world = minimapWorldRect(expanded, { ...override, progress })!;
      expect(world.x).toBeCloseTo(progress * 200);
      expect(world.y).toBeCloseTo(progress * 100);
      expect(world.width).toBeCloseTo(100 + progress * 100);
      const project = minimapProjector(world, 160, 120);
      const boundary = minimapEntityRects(expanded, { ...override, progress }).find(entry => entry.id === 'system')!;
      expect(project(boundary.rect).width).toBeCloseTo(120);
    }
  });

  it('fits the owned settled branch while retaining dim ancestors, ghost siblings and silhouettes for drawing', () => {
    const scopedScene = {
      ...scene,
      entities: [...scene.entities, { id: 'ghost', detail: 'container', x: 0, y: 0, width: 1, height: 1 },
        { id: 'silhouette', detail: 'component', x: 0, y: 0, width: 1, height: 1 }],
      projection: { ...scene.projection!, boundsByEntityIdAndDetail: {
        ...scene.projection!.boundsByEntityIdAndDetail,
        ghost: { component: { x: -2000, y: -2000, width: 6000, height: 6000 } },
        silhouette: { component: { x: -1900, y: -1900, width: 100, height: 100 } },
      } },
    } as AtlasScene;
    const objects = [
      { objectId: 'visual-system', representation: 'system:container', opacity: .32, priority: 0 },
      { objectId: 'visual-child', representation: 'child:component', opacity: 1, priority: 1200 },
      { objectId: 'ghost', representation: 'ghost:component', opacity: .24, priority: 701 },
      { objectId: 'silhouette', representation: 'silhouette:component', opacity: .14, priority: 0 },
    ].map(object => ({ objectId: object.objectId,
      sourceRepresentationId: object.representation, targetRepresentationId: object.representation,
      sourceOpacity: object.opacity, targetOpacity: object.opacity,
      sourcePickPriority: object.priority, targetPickPriority: object.priority }));
    const settled: ProjectionOverride = { id: 'settled', progress: 1, objects, paths: [] };
    expect(minimapEntityRects(scopedScene, settled).map(entry => entry.id)).toEqual(['system', 'child', 'ghost', 'silhouette']);
    expect(minimapWorldRect(scopedScene, settled)).toEqual({ x: 220, y: 120, width: 40, height: 40 });
    // A source primary fading into context must interpolate its former extent into the new owned scope.
    const transition = { ...settled, objects: objects.map(object => ({ ...object,
      sourcePickPriority: object.objectId === 'visual-system' ? 1100 : 0,
      sourceOpacity: object.objectId === 'visual-system' ? 1 : object.sourceOpacity,
    })) };
    for (const progress of [0, .25, .5, .75, 1]) {
      const world = minimapWorldRect(scopedScene, { ...transition, progress })!;
      expect(world.x).toBeCloseTo(200 + 20 * progress);
      expect(world.width).toBeCloseTo(200 - 160 * progress);
    }
  });

  it('fits an unoverridden detail using only its visible representation bounds', () => {
    expect(minimapWorldRect(scene, undefined, 'component')).toEqual({ x: 220, y: 120, width: 40, height: 40 });
  });
});
