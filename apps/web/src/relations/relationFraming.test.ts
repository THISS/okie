import { describe, expect, it } from 'vitest';
import { createGoldenC4Scene } from '../renderer/goldenC4Scene';
import { entityScreenRect } from './selectedEntityFraming';
import { relationContainment, relationFramingPlan, unionBounds } from './relationFraming';
import type { AtlasScene, SceneEntity, SceneRelation } from '../renderer/types';

const viewport = { width: 1_000, height: 700 };
const safeArea = { top: 40, right: 40, bottom: 40, left: 40 };

function entity(id: string, parentId: string | undefined, box: { x: number; y: number; width: number; height: number }): SceneEntity {
  return {
    id,
    ...(parentId ? { parentId } : {}),
    name: id,
    kind: 'component',
    responsibility: '',
    ...box,
  };
}

function relation(id: string, from: string, to: string): SceneRelation {
  return { id, from, to };
}

/**
 * Synthetic containment tree (no projection → geometry fallback):
 *   sys
 *   ├─ containerA ── compA1 (0,0)      compA2 (200,0)
 *   └─ containerB ── compB1 (1500,0)
 */
function syntheticScene(): AtlasScene {
  const entities = [
    entity('sys', undefined, { x: 0, y: 0, width: 2_000, height: 1_000 }),
    entity('containerA', 'sys', { x: 0, y: 0, width: 400, height: 200 }),
    entity('containerB', 'sys', { x: 1_500, y: 0, width: 400, height: 200 }),
    entity('compA1', 'containerA', { x: 0, y: 0, width: 100, height: 100 }),
    entity('compA2', 'containerA', { x: 200, y: 0, width: 100, height: 100 }),
    entity('compB1', 'containerB', { x: 1_500, y: 0, width: 100, height: 100 }),
  ];
  const relations = [
    relation('rel-siblings', 'compA1', 'compA2'),
    relation('rel-cross', 'compA1', 'compB1'),
    relation('rel-nested', 'containerA', 'compA1'),
    relation('rel-self', 'compA1', 'compA1'),
  ];
  return { entities, relations } as unknown as AtlasScene;
}

describe('relation containment classification', () => {
  const scene = syntheticScene();

  it('classifies same-parent siblings and resolves their shared LCA', () => {
    expect(relationContainment(scene, relation('rel-siblings', 'compA1', 'compA2'))).toEqual({
      kind: 'same-parent',
      lcaId: 'containerA',
      depthFromSource: 1,
      depthFromTarget: 1,
      divergence: 1,
    });
  });

  it('classifies cross-container endpoints and measures the divergence to the LCA', () => {
    expect(relationContainment(scene, relation('rel-cross', 'compA1', 'compB1'))).toEqual({
      kind: 'cross-container',
      lcaId: 'sys',
      depthFromSource: 2,
      depthFromTarget: 2,
      divergence: 2,
    });
  });

  it('treats a parent→child (nested) relation as cross-container', () => {
    const containment = relationContainment(scene, relation('rel-nested', 'containerA', 'compA1'));
    expect(containment.kind).toBe('cross-container');
    expect(containment.lcaId).toBe('containerA');
    expect(containment.depthFromSource).toBe(0);
    expect(containment.depthFromTarget).toBe(1);
  });

  it('keeps a self-relation local and returns no shared ancestor for root-level endpoints', () => {
    expect(relationContainment(scene, relation('rel-self', 'compA1', 'compA1')).kind).toBe('same-parent');
    const rootPair = relationContainment(scene, relation('rel-root', 'containerA', 'containerB'));
    expect(rootPair.kind).toBe('same-parent'); // siblings under sys
    const orphanScene = {
      entities: [entity('x', undefined, { x: 0, y: 0, width: 10, height: 10 }), entity('y', undefined, { x: 100, y: 0, width: 10, height: 10 })],
      relations: [],
    } as unknown as AtlasScene;
    expect(relationContainment(orphanScene, relation('rel-orphan', 'x', 'y'))).toMatchObject({ kind: 'cross-container', lcaId: undefined });
  });
});

describe('union bounds', () => {
  it('spans both endpoint boxes', () => {
    expect(unionBounds({ x: 0, y: 0, width: 100, height: 100 }, { x: 200, y: 50, width: 100, height: 100 }))
      .toEqual({ x: 0, y: 0, width: 300, height: 150 });
  });
});

describe('relation framing plan', () => {
  const scene = syntheticScene();

  it('frames a same-parent pair to local union bounds with a gentle (zoomed-in) fit', () => {
    const plan = relationFramingPlan(scene, relation('rel-siblings', 'compA1', 'compA2'), 'component', viewport, safeArea)!;
    expect(plan.containment).toBe('same-parent');
    expect(plan.lcaId).toBe('containerA');
    // Union of compA1 (0..100) and compA2 (200..300) — stays inside the LCA (containerA: 0..400).
    expect(plan.bounds).toEqual({ x: 0, y: 0, width: 300, height: 100 });
    expect(plan.camera.zoom).toBeGreaterThan(1);
  });

  it('zooms OUT to contain a cross-container pair across their diverging scopes', () => {
    const local = relationFramingPlan(scene, relation('rel-siblings', 'compA1', 'compA2'), 'component', viewport, safeArea)!;
    const cross = relationFramingPlan(scene, relation('rel-cross', 'compA1', 'compB1'), 'component', viewport, safeArea)!;
    expect(cross.containment).toBe('cross-container');
    expect(cross.lcaId).toBe('sys');
    // Cross-container union spans compA1 (0..100) and compB1 (1500..1600) — the wide scope forces a far lower zoom.
    expect(cross.bounds.width).toBe(1_600);
    expect(cross.camera.zoom).toBeLessThan(local.camera.zoom);
  });

  it('contains and centers both endpoints inside the safe viewport (same-parent and cross-container)', () => {
    for (const rel of [relation('rel-siblings', 'compA1', 'compA2'), relation('rel-cross', 'compA1', 'compB1')]) {
      const plan = relationFramingPlan(scene, rel, 'component', viewport, safeArea)!;
      const source = entityScreenRect(plan.sourceBounds, plan.camera, viewport);
      const target = entityScreenRect(plan.targetBounds, plan.camera, viewport);
      for (const rect of [source, target]) {
        expect(rect.left).toBeGreaterThanOrEqual(safeArea.left - 1e-6);
        expect(rect.right).toBeLessThanOrEqual(viewport.width - safeArea.right + 1e-6);
        expect(rect.top).toBeGreaterThanOrEqual(safeArea.top - 1e-6);
        expect(rect.bottom).toBeLessThanOrEqual(viewport.height - safeArea.bottom + 1e-6);
      }
      // Union center lands on the safe-area center — the frame is anchored on the flow, not one endpoint.
      const unionRect = entityScreenRect(plan.bounds, plan.camera, viewport);
      expect((unionRect.left + unionRect.right) / 2).toBeCloseTo((safeArea.left + viewport.width - safeArea.right) / 2);
      expect((unionRect.top + unionRect.bottom) / 2).toBeCloseTo((safeArea.top + viewport.height - safeArea.bottom) / 2);
    }
  });

  it('is deterministic — identical inputs yield an identical camera (framing invariance)', () => {
    const rel = relation('rel-cross', 'compA1', 'compB1');
    const a = relationFramingPlan(scene, rel, 'component', viewport, safeArea)!;
    const b = relationFramingPlan(scene, rel, 'component', viewport, safeArea)!;
    expect(a.camera).toEqual(b.camera);
  });

  it('returns undefined when an endpoint has no resolvable bounds', () => {
    const orphan = { entities: [entity('only', undefined, { x: 0, y: 0, width: 10, height: 10 })], relations: [] } as unknown as AtlasScene;
    expect(relationFramingPlan(orphan, relation('rel', 'only', 'missing'), 'component', viewport, safeArea)).toBeUndefined();
  });
});

describe('relation framing over the golden projection', () => {
  it('frames a real same-parent component relation using compiled projection bounds', () => {
    const scene = createGoldenC4Scene();
    const rel = scene.relations.find(candidate => candidate.id === 'relation:web-shell-navigation')!;
    const plan = relationFramingPlan(scene, rel, 'component', viewport, safeArea)!;

    expect(plan.containment).toBe('same-parent');
    expect(plan.lcaId).toBe('container:web-app');
    // Both endpoints land inside the safe viewport under the planned camera.
    for (const bounds of [plan.sourceBounds, plan.targetBounds]) {
      const rect = entityScreenRect(bounds, plan.camera, viewport);
      expect(rect.left).toBeGreaterThanOrEqual(safeArea.left - 1e-6);
      expect(rect.right).toBeLessThanOrEqual(viewport.width - safeArea.right + 1e-6);
    }
  });
});
