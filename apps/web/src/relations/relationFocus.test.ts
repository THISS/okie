import { describe, expect, it } from 'vitest';
import { goldenSnapshot } from '@okie/scene-compiler';
import { createGoldenC4Scene } from '../renderer/goldenC4Scene';
import { relationOrSetFocusPresentation, relationSetFocusPresentation, selectedProjectedRelationForFocus, selectedRelationFocusPresentation } from './relationFocus';
import { idleSemanticLens, semanticLensSessionProjectionOverride } from '../semantic/semanticLens';
import { attachOrthogonalRouteEndpoints, authoringBoundsForDetail, orthogonalSegmentHandles } from '../editor/relationshipInteraction';

function ghostRelationFixture() {
  const scene = createGoldenC4Scene();
  const session = {
    baseDetail: 'context' as const,
    settled: [
      { targetId: 'system:okie', currentDetail: 'context' as const, nextDetail: 'container' as const },
      { targetId: 'container:architecture-model', currentDetail: 'container' as const, nextDetail: 'component' as const },
    ],
    active: idleSemanticLens(),
  };
  const projectionOverride = semanticLensSessionProjectionOverride(scene, session)!;
  const ghostPath = projectionOverride.paths.find(path => path.targetOpacity === .10)!;
  const projectedRelation = Object.values(scene.projection!.projectedRelationsByDetail).flat()
    .find(relation => relation.id === ghostPath.pathId)!;
  const relationId = projectedRelation.semanticIds?.[0] ?? projectedRelation.id;
  const relation = scene.relations.find(candidate => candidate.id === relationId)!;
  return { scene, session, projectionOverride, ghostPath, relation };
}

describe('temporary selected-relation focus', () => {
  it('promotes an already-retained ghost path and both semantic endpoints without changing lens ownership', () => {
    const { scene, session, projectionOverride, ghostPath, relation } = ghostRelationFixture();
    const original = structuredClone(projectionOverride);

    const presentation = selectedRelationFocusPresentation(scene, relation.id, projectionOverride);
    const promoted = presentation.projectionOverride!;

    expect(presentation.endpointIds).toEqual(new Set([relation.from, relation.to]));
    expect(presentation.relationIds).toEqual(new Set([relation.id]));
    expect(promoted.id).toBe(`${projectionOverride.id}:relation-focus:${relation.id}`);
    expect(promoted.paths.find(path => path.pathId === ghostPath.pathId)).toMatchObject({
      sourceOpacity: 1,
      targetOpacity: 1,
    });

    const visualEndpointIds = [relation.from, relation.to]
      .map(id => scene.projection!.semanticToVisualEntityId[id]);
    for (const visualId of visualEndpointIds) {
      const before = projectionOverride.objects.find(object => object.objectId === visualId)!;
      const after = promoted.objects.find(object => object.objectId === visualId)!;
      expect(after.sourceRepresentationId).toBe(before.sourceRepresentationId);
      expect(after.targetRepresentationId).toBe(before.targetRepresentationId);
      if (before.sourceRepresentationId && (before.sourceOpacity ?? 1) > .001) {
        expect(after.sourceOpacity).toBe(1);
        expect(after.sourceContentOpacity).toBe(1);
      }
      if (before.targetRepresentationId && (before.targetOpacity ?? 1) > .001) {
        expect(after.targetOpacity).toBe(1);
        expect(after.targetContentOpacity).toBe(1);
      }
    }

    expect(projectionOverride).toEqual(original);
    expect(session.settled.map(entry => entry.targetId)).toEqual([
      'system:okie',
      'container:architecture-model',
    ]);
  });

  it('does not resurrect zero-owned path slots or create focus for an unknown relation', () => {
    const { scene, projectionOverride, relation } = ghostRelationFixture();
    const presentation = selectedRelationFocusPresentation(scene, relation.id, projectionOverride);
    const promoted = presentation.projectionOverride!;
    const selectedVisualPaths = new Set(scene.projection!.semanticToVisualRelationIds[relation.id]);

    for (const before of projectionOverride.paths.filter(path => selectedVisualPaths.has(path.pathId))) {
      const after = promoted.paths.find(path => path.pathId === before.pathId)!;
      if (before.sourceOpacity === 0) expect(after.sourceOpacity).toBe(0);
      if (before.targetOpacity === 0) expect(after.targetOpacity).toBe(0);
    }

    const unknown = selectedRelationFocusPresentation(scene, 'relation:missing', projectionOverride);
    expect(unknown.endpointIds.size).toBe(0);
    expect(unknown.relationIds.size).toBe(0);
    expect(unknown.projectionOverride).toBe(projectionOverride);
  });

  it('resolves the retained ghost visual route for a semantic relation outside the active detail', () => {
    const scene = createGoldenC4Scene();
    const session = {
      baseDetail: 'context' as const,
      settled: [
        { targetId: 'system:okie', currentDetail: 'context' as const, nextDetail: 'container' as const },
        { targetId: 'container:web-app', currentDetail: 'container' as const, nextDetail: 'component' as const },
      ],
      active: idleSemanticLens(),
    };
    const lensOverride = semanticLensSessionProjectionOverride(scene, session)!;
    const focus = selectedRelationFocusPresentation(scene, 'relation:model-to-compiler', lensOverride);
    const projected = selectedProjectedRelationForFocus(
      scene,
      'relation:model-to-compiler',
      focus.projectionOverride,
      'component',
    );

    expect(projected).toMatchObject({ detail: 'container', opacity: 1 });
    expect(projected?.relation.semanticIds).toContain('relation:model-to-compiler');
    expect(projected?.relation.routePoints?.length).toBeGreaterThanOrEqual(4);
    expect(scene.projection!.semanticToVisualRelationIds['relation:model-to-compiler'])
      .toContain(projected?.relation.id);
    const source = authoringBoundsForDetail(scene, projected!.relation.from, projected!.detail)!;
    const target = authoringBoundsForDetail(scene, projected!.relation.to, projected!.detail)!;
    const attached = attachOrthogonalRouteEndpoints(projected!.relation.routePoints!, { source, target })!;
    expect(orthogonalSegmentHandles(attached).length).toBeGreaterThan(0);
  });

  it('resolves relation:code-wasm-engine to its concrete L4 code cards before a stronger component ghost', () => {
    const scene = createGoldenC4Scene();
    const relationId = 'relation:code-wasm-engine';
    const code = scene.projection!.projectedRelationsByDetail.code
      .find(relation => relation.semanticIds?.includes(relationId))!;
    const component = scene.projection!.projectedRelationsByDetail.component
      .find(relation => relation.semanticIds?.includes(relationId))!;
    const projectionOverride = {
      id: 'projection:test:code-endpoints',
      progress: 1,
      objects: [],
      paths: [
        { pathId: component.id, sourceOpacity: 1, targetOpacity: 1 },
        { pathId: code.id, sourceOpacity: .1, targetOpacity: .1 },
      ],
    };

    const selected = selectedProjectedRelationForFocus(scene, relationId, projectionOverride, 'code');

    expect(selected).toMatchObject({ detail: 'code', relation: { id: code.id } });
    expect(selected?.relation.from).toBe('code:renderer-wasm:atlas-renderer');
    expect(selected?.relation.to).toBe('code:renderer-engine:protocol-engine');
    expect(component.from).toBe('component:renderer-wasm');
    expect(component.to).toBe('component:renderer-engine');

    const source = authoringBoundsForDetail(scene, selected!.relation.from, 'code')!;
    const target = authoringBoundsForDetail(scene, selected!.relation.to, 'code')!;
    const attached = attachOrthogonalRouteEndpoints(selected!.relation.routePoints!, { source, target })!;
    const onBoundary = (point: { x: number; y: number }, bounds: typeof source) => (
      (Math.abs(point.x - bounds.x) < 1e-9 || Math.abs(point.x - bounds.x - bounds.width) < 1e-9)
        && point.y >= bounds.y && point.y <= bounds.y + bounds.height
    ) || (
      (Math.abs(point.y - bounds.y) < 1e-9 || Math.abs(point.y - bounds.y - bounds.height) < 1e-9)
        && point.x >= bounds.x && point.x <= bounds.x + bounds.width
    );
    expect(onBoundary(attached[0]!, source)).toBe(true);
    expect(onBoundary(attached.at(-1)!, target)).toBe(true);
    const sourceShell = authoringBoundsForDetail(scene, 'component:renderer-wasm', 'code')!;
    const targetShell = authoringBoundsForDetail(scene, 'component:renderer-engine', 'code')!;
    expect(onBoundary(attached[0]!, sourceShell)).toBe(false);
    expect(onBoundary(attached.at(-1)!, targetShell)).toBe(false);
  });

  it('keeps component endpoints as the L4 fallback for a genuinely component-level relation', () => {
    const scene = createGoldenC4Scene();
    const selected = selectedProjectedRelationForFocus(
      scene,
      'relation:renderer-wasm-engine',
      undefined,
      'code',
    );

    expect(selected).toMatchObject({
      detail: 'component',
      relation: {
        from: 'component:renderer-wasm',
        to: 'component:renderer-engine',
      },
    });
  });
});

describe('path relation-set focus (CLA-208)', () => {
  const pathRelationId = 'relation:code-app-navigation-url';

  it('lifts path entities to the current band and includes aggregated routes containing hop relations', () => {
    const scene = createGoldenC4Scene();
    const projection = scene.projection!;
    const focus = { key: 'test', relationIds: [pathRelationId], entityIds: ['code:web-shell:app', 'code:web-navigation:history-controller'] };
    const aggregated = Object.values(projection.projectedRelationsByDetail).flat()
      .filter(route => route.id === pathRelationId || route.semanticIds?.includes(pathRelationId));
    expect(aggregated.length).toBeGreaterThan(0);

    const component = relationSetFocusPresentation(scene, focus, undefined, 'component');
    expect(component.endpointIds.has('component:web-shell')).toBe(true);
    expect(component.endpointIds.has('component:web-navigation')).toBe(true);
    expect(component.relationIds.has(pathRelationId)).toBe(true);
    for (const route of aggregated) expect(component.relationIds.has(route.id)).toBe(true);

    const code = relationSetFocusPresentation(scene, focus, undefined, 'code');
    expect(code.endpointIds.has('code:web-shell:app')).toBe(true);
    expect(code.endpointIds.has('component:web-shell')).toBe(false);
  });

  it('lifts through snapshot parentage when a neighborhood scene omits the visited leaves', () => {
    const full = createGoldenC4Scene();
    const scene = { ...full, entities: full.entities.filter(entity => entity.detail !== 'code') };
    const parents = new Map(goldenSnapshot.entities.map(entity => [entity.id, entity.parentId]));
    const focus = { key: 'leafless', relationIds: [pathRelationId], entityIds: ['code:web-shell:app', 'code:web-navigation:history-controller'] };
    expect(scene.entities.some(entity => entity.id === 'code:web-shell:app')).toBe(false);
    const component = relationSetFocusPresentation(scene, focus, undefined, 'component', parents);
    expect(component.endpointIds.has('component:web-shell')).toBe(true);
    expect(component.endpointIds.has('component:web-navigation')).toBe(true);
    const container = relationSetFocusPresentation(scene, focus, undefined, 'container', parents);
    expect(container.endpointIds.has('container:web-app')).toBe(true);
    expect(container.endpointIds.has('component:web-shell')).toBe(false);
  });

  it('only includes routes whose id or semanticIds present a hop relation', () => {
    const scene = createGoldenC4Scene();
    const projection = scene.projection!;
    const presenting = new Set(Object.values(projection.projectedRelationsByDetail).flat()
      .filter(route => route.id === pathRelationId || route.semanticIds?.includes(pathRelationId))
      .map(route => route.id));
    const visual = new Set(projection.semanticToVisualRelationIds[pathRelationId] ?? []);
    const focus = { key: 'strict', relationIds: [pathRelationId], entityIds: [] };
    const presentation = relationSetFocusPresentation(scene, focus, undefined, 'component');
    for (const id of presentation.relationIds) {
      expect(id === pathRelationId || presenting.has(id) || visual.has(id)).toBe(true);
    }
  });

  it('promotes retained paths without changing lens ownership and defers to a picked relation', () => {
    const { scene, projectionOverride, ghostPath, relation } = ghostRelationFixture();
    const focus = { key: 'k', relationIds: [relation.id], entityIds: [relation.from, relation.to] };
    const presentation = relationSetFocusPresentation(scene, focus, projectionOverride, 'component');
    expect(presentation.projectionOverride!.id).toBe(`${projectionOverride.id}:path-focus:k`);
    // The ghosted hop route really reaches full opacity.
    expect(ghostPath.targetOpacity).toBeLessThan(1);
    expect(presentation.projectionOverride!.paths.find(path => path.pathId === ghostPath.pathId)).toMatchObject({ targetOpacity: 1 });
    // At least one retained, previously dimmed endpoint object is promoted to full weight.
    const endpointVisualIds = new Set([relation.from, relation.to].map(id => scene.projection!.semanticToVisualEntityId[id]));
    const promotedEndpoints = presentation.projectionOverride!.objects.filter(object => {
      if (!endpointVisualIds.has(object.objectId)) return false;
      const before = projectionOverride.objects.find(candidate => candidate.objectId === object.objectId)!;
      return (before.targetRepresentationId && (before.targetOpacity ?? 1) > .001 && (before.targetOpacity ?? 1) < 1 && object.targetOpacity === 1)
        || (before.sourceRepresentationId && (before.sourceOpacity ?? 1) > .001 && (before.sourceOpacity ?? 1) < 1 && object.sourceOpacity === 1)
        || (before.targetContentOpacity !== undefined && before.targetContentOpacity < 1 && object.targetContentOpacity === 1);
    });
    expect(promotedEndpoints.length).toBeGreaterThan(0);
    for (const path of presentation.projectionOverride!.paths) {
      const before = projectionOverride.paths.find(candidate => candidate.pathId === path.pathId)!;
      if (before.sourceOpacity === 0) expect(path.sourceOpacity).toBe(0);
      if (before.targetOpacity === 0) expect(path.targetOpacity).toBe(0);
    }
    expect(presentation.projectionOverride!.objects.map(object => object.sourceRepresentationId))
      .toEqual(projectionOverride.objects.map(object => object.sourceRepresentationId));
    const picked = relationOrSetFocusPresentation(scene, relation.id, focus, projectionOverride, 'component');
    expect(picked.projectionOverride!.id).toBe(`${projectionOverride.id}:relation-focus:${relation.id}`);
    const empty = relationOrSetFocusPresentation(scene, undefined, undefined, projectionOverride, 'component');
    expect(empty.relationIds.size).toBe(0);
    expect(empty.projectionOverride).toBe(projectionOverride);
  });
});
