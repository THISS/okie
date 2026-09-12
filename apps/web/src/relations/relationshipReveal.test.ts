import { expect, it } from 'vitest';
import type { AtlasScene, SceneEntity } from '../renderer/types';
import { idleSemanticLensSession } from '../semantic/semanticLens';
import { canonicalRelationForInspection, resolveRelationshipReveal } from './relationshipReveal';
import { canonicalRelationshipGroupsForEntity } from './canonicalRelationshipInventory';

const snapshot = { entities: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], relations: [{ id: 'r', from: 'a', to: 'b', kind: 'calls', evidence: [{ explanation: 'captured' }] }] } as never;
const entity = (id: string, x: number): SceneEntity => ({ id, name: id, responsibility: '', kind: 'component', detail: 'component', x, y: 0, width: 100, height: 80 });
const scene = { entities: [entity('a', 0), entity('b', 200)], relations: [{ id: 'r', from: 'a', to: 'b', routePoints: [{ x: 100, y: 40 }, { x: 150, y: -400 }, { x: 200, y: 40 }] }] } as AtlasScene;
const input = { snapshot, scene, relationId: 'r', session: idleSemanticLensSession('component'), viewport: { width: 1000, height: 800 }, safeArea: { top: 0, bottom: 0, left: 0, right: 0 } };
it('recompiles an absent neighborhood and frames both endpoints and the route excursion without changing inspector intent', () => {
  const sessionBefore = JSON.stringify(input.session);
  const calls: string[] = [];
  const result = resolveRelationshipReveal({ ...input, scene: { ...scene, relations: [], entities: [] }, compileScope: id => { calls.push(id); return scene; } });
  expect(calls).toEqual(['a']);
  expect(result.status).toBe('ready');
  if (result.status === 'ready') {
    expect(result.representation).toBe('individual');
    expect(result.framing.bounds).toEqual({ x: 0, y: -400, width: 300, height: 480 });
    expect(result).not.toHaveProperty('selectedId');
    expect(result).not.toHaveProperty('inspectorTab');
  }
  expect(JSON.stringify(input.session)).toBe(sessionBefore);
});
it('keeps canonical inspection available and reports unsupported routes honestly', () => {
  expect(canonicalRelationForInspection(snapshot, 'r')).toMatchObject({ from: 'a', to: 'b', kindLabel: 'calls' });
  expect(resolveRelationshipReveal({ ...input, scene: { ...scene, relations: [] }, compileScope: () => ({ ...scene, relations: [] }) })).toMatchObject({ status: 'unavailable' });
});
it('distinguishes aggregate membership from individual and isolation-hidden routes', () => {
  const aggregateScene = { ...scene, entities: [entity('ownerA', 0), entity('ownerB', 200)], relations: [{ ...scene.relations[0]!, id: 'aggregate', from: 'ownerA', to: 'ownerB', semanticIds: ['r'] }] };
  const shown = canonicalRelationshipGroupsForEntity(snapshot, aggregateScene, new Set(['aggregate']), 'a', new Set(['ownerA', 'ownerB']));
  expect(shown[0]?.rows[0]?.mapStatus).toBe('aggregated');
  expect(canonicalRelationshipGroupsForEntity(snapshot, aggregateScene, new Set(['aggregate']), 'a', new Set(['ownerA']))[0]?.rows[0]?.mapStatus).toBe('hidden');
  expect(resolveRelationshipReveal({ ...input, scene: aggregateScene })).toMatchObject({ status: 'ready', representation: 'aggregate' });
});
it('keeps calls and generic uses directional, recursive once, and deduplicates identity', () => {
  const relations = [
    { id: 'out', from: 'a', to: 'b', kind: 'calls' },
    { id: 'in', from: 'b', to: 'a', kind: 'uses' },
    { id: 'self', from: 'a', to: 'a', kind: 'calls' },
    { id: 'self', from: 'a', to: 'a', kind: 'calls' },
  ];
  const groups = canonicalRelationshipGroupsForEntity({ entities: [], relations } as never, scene, new Set(), 'a');
  expect(groups.map(group => group.label)).toEqual(['Calls', 'Used by', 'Recursive relationships']);
  expect(groups.flatMap(group => group.rows).map(row => row.direction)).toEqual(['outbound', 'inbound', 'recursive']);
});
