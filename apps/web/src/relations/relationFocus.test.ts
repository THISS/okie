import { describe, expect, it } from 'vitest';
import { createGoldenC4Scene } from '../renderer/goldenC4Scene';
import { selectedProjectedRelationForFocus, selectedRelationFocusPresentation } from './relationFocus';
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
