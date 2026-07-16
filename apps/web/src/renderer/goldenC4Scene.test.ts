import { describe, expect, it } from 'vitest';
import { applyArchitectureAuthoringCommand, createArchitectureAuthoringDocument, relationRouteOverrideId } from '@okie/architecture';
import { goldenSnapshot } from '@okie/scene-compiler';
import { createGoldenC4Scene, goldenAppStory, semanticBounds } from './goldenC4Scene';

describe('golden C4 app scene', () => {
  it('keeps semantic navigation IDs separate from renderer lineage IDs', () => {
    const scene = createGoldenC4Scene();
    expect(scene.rootEntityId).toBe('system:okie');
    const system = scene.entities.find(entity => entity.id === 'system:okie');
    expect(system).toMatchObject({ kindLabel: 'Software system' });
    expect(system).not.toHaveProperty('confidence');
    expect(scene.projection?.semanticToVisualEntityId['system:okie']).toBe('visual-node:lineage:system:okie');
    expect(scene.projection?.visualToSemanticEntityId['visual-node:lineage:system:okie']).toBe('system:okie');
    expect(scene.projection?.entityIdsByDetail.context).toHaveLength(4);
    expect(scene.projection?.entityIdsByDetail.container).toHaveLength(9);
  });

  it('builds a stable-ID patch only when an explicit drill changes root', () => {
    const system = createGoldenC4Scene();
    const drilled = createGoldenC4Scene('container:architecture-model', system);
    expect(drilled.rootEntityId).toBe('container:architecture-model');
    expect((drilled.protocolSnapshot as { sceneId: string; revision: number }).sceneId)
      .toBe((system.protocolSnapshot as { sceneId: string }).sceneId);
    expect((drilled.protocolSnapshot as { revision: number }).revision).toBe(2);
    expect(drilled.protocolPatch).toMatchObject({ baseRevision: 1, revision: 2 });
    expect(semanticBounds(drilled, 'container:architecture-model', 'component')).toBeDefined();
  });

  it('uses the frozen Okie context-to-source story and worktree evidence', () => {
    const scene = createGoldenC4Scene();
    expect(goldenAppStory.title).toBe('From Okie to selectScopedView()');
    expect(goldenAppStory.steps.at(-1)).toMatchObject({
      id: 'step:code',
      title: 'Read selectScopedView()',
      reveal: 'code',
      focusEntityIds: ['code:model-scoping:select-scoped-view'],
      authoredHoldMs: 2_000,
    });
    expect(goldenAppStory.steps.at(-1)?.sourceRefs[0]).toMatchObject({
      path: 'packages/architecture/src/normalized.ts',
      symbol: 'selectScopedView',
    });
    expect(scene.entities.find(entity => entity.id === 'code:model-scoping:select-scoped-view')?.sourceRefs?.[0])
      .toMatchObject({ path: 'packages/architecture/src/normalized.ts', symbol: 'selectScopedView' });
    expect(scene.frozenRevision).toContain('golden-worktree');
  });

  it('deep-copies a portable frozen excerpt onto golden L4 scene entities', () => {
    const scene = createGoldenC4Scene();
    const sourceEntity = scene.entities.find(entity => entity.id === 'code:model-scoping:select-scoped-view')!;
    const authoredEntity = goldenSnapshot.entities.find(entity => entity.id === sourceEntity.id)!;
    const excerpt = sourceEntity.sourceExcerpts?.[0];
    expect(excerpt).toMatchObject({
      path: 'packages/architecture/src/normalized.ts',
      symbol: 'selectScopedView',
      language: 'typescript',
      frozenRevision: scene.frozenRevision,
    });
    expect(excerpt?.text).toBe(excerpt?.lines.join('\n'));
    expect(excerpt?.lines).not.toBe(authoredEntity.sourceExcerpts?.[0]?.lines);
  });

  it('compiles authored relationships and route intent into the shared backend scene', () => {
    const relationId = 'relation:user:test';
    const relationChange = applyArchitectureAuthoringCommand(
      createArchitectureAuthoringDocument(goldenSnapshot.repositoryId),
      {
        type: 'put-relation',
        relation: {
          id: relationId,
          from: 'actor:developer',
          to: 'external:source-repository',
          kind: 'uses',
          label: 'opens',
        },
      },
    );
    const automatic = createGoldenC4Scene('system:okie', undefined, relationChange.document);
    const familyId = automatic.projection!.familyId!;
    const scope = { viewId: familyId, detail: 'context' as const, relationId };
    const guidedChange = applyArchitectureAuthoringCommand(relationChange.document, {
      type: 'put-route-override',
      override: {
        ...scope,
        id: relationRouteOverrideId(scope),
        intent: { sourcePort: 'bottom', targetPort: 'bottom', waypoints: [] },
      },
    });
    const guided = createGoldenC4Scene('system:okie', automatic, guidedChange.document);
    const automaticRoute = automatic.projection!.projectedRelationsByDetail.context
      .find(relation => relation.semanticIds?.includes(relationId))?.routePoints;
    const guidedRoute = guided.projection!.projectedRelationsByDetail.context
      .find(relation => relation.semanticIds?.includes(relationId))?.routePoints;
    expect(guided.projection!.projectedRelationsByDetail.context.map(relation => relation.semanticIds)).toContainEqual(expect.arrayContaining([relationId]));

    expect(guided.relations.find(relation => relation.id === relationId)).toMatchObject({
      from: 'actor:developer',
      to: 'external:source-repository',
      label: 'opens',
    });
    expect(guidedRoute).toBeDefined();
    expect(guidedRoute).not.toEqual(automaticRoute);
    expect((guided.protocolSnapshot as { revision: number }).revision).toBe(2);
    expect(guided.protocolPatch).toBeDefined();
  });
});
