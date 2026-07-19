import { describe, expect, it } from 'vitest';
import { ASPECT_PRESET_TARGET, applyArchitectureAuthoringCommand, createArchitectureAuthoringDocument, relationRouteOverrideId } from '@okie/architecture';
import { coverageRevealZoomWindow, goldenSnapshot } from '@okie/scene-compiler';
import { createC4Scene, createGoldenC4Scene, goldenAppStory, semanticBounds } from './goldenC4Scene';

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

describe('scan-mode semantic transition reveal runway', () => {
  const scanAspect = ASPECT_PRESET_TARGET.landscape;
  const scanScene = () => createC4Scene({
    baseSnapshot: goldenSnapshot,
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
    familyId: 'view-family:test-scan:system:okie',
    sceneId: 'test-scan-c4',
    title: 'test scan',
    subtitle: 'test',
    frozenRevision: 'test',
    targetAspect: scanAspect,
  });

  it('authors every lens runway from the shared coverage window of the owner shell', () => {
    const scene = scanScene();
    const transition = scene.projection!.semanticTransitionsByEntityId!['system:okie']!.container!;
    const shellBounds = scene.projection!.boundsByEntityIdAndDetail['system:okie']!.container!;
    const window = coverageRevealZoomWindow(shellBounds, 'container', scanAspect);
    expect(transition.minZoom).toBe(window.minZoom);
    expect(transition.fullZoom).toBe(window.fullZoom);
    expect(transition.minZoom!).toBeLessThan(transition.fullZoom!);
  });

  it('completes a big scanned owner reveal BELOW the fixed band runway (children visible before the owner outgrows the screen)', () => {
    // A dense owner whose persistent shell outgrows the nominal viewport (the same
    // geometry the compiler coverage-reveal QA proves reveals early). The golden
    // self-map is too small to exercise this: its shells clamp to the band runway.
    const entities = [
      { id: 'system:d', kind: 'softwareSystem' as const, name: 'D', sourceRefs: [] },
      { id: 'container:c', kind: 'container' as const, parentId: 'system:d', name: 'C', sourceRefs: [] },
      ...Array.from({ length: 40 }, (_, index) => {
        const cid = `component:m${String(index).padStart(3, '0')}`;
        return [
          { id: cid, kind: 'component' as const, parentId: 'container:c', name: `m${index}`, sourceRefs: [] },
          { id: `code:${cid}`, kind: 'code' as const, parentId: cid, name: 'k', sourceRefs: [] },
        ];
      }).flat(),
    ];
    const scene = createC4Scene({
      baseSnapshot: {
        schemaVersion: 1,
        id: 'snapshot:d',
        repositoryId: 'repo:d',
        commitSha: 'c',
        generatedAt: '2026-01-01T00:00:00.000Z',
        entities,
        relations: [],
      },
      rootEntityId: 'system:d',
      focusEntityId: 'system:d',
      familyId: 'view-family:test-dense:system:d',
      sceneId: 'test-dense-c4',
      title: 'dense',
      subtitle: 'test',
      frozenRevision: 'test',
      targetAspect: scanAspect,
    });
    const transition = scene.projection!.semanticTransitionsByEntityId!['container:c']!.component!;
    const bandEnterZoom = scene.projection!.zoomPolicy!.bands.find(band => band.detail === 'component')!.enterZoom;
    expect(transition.fullZoom!).toBeLessThan(bandEnterZoom);
    expect(transition.minZoom!).toBeLessThan(transition.fullZoom!);
    // And the runway equals the coverage window of the same shell the native LOD uses.
    const shellBounds = scene.projection!.boundsByEntityIdAndDetail['container:c']!.component!;
    expect(transition.minZoom).toBe(coverageRevealZoomWindow(shellBounds, 'component', scanAspect).minZoom);
  });

  it('keeps every scan transition runway no later than its band enter/fade window', () => {
    const scene = scanScene();
    const bands = scene.projection!.zoomPolicy!.bands;
    for (const transitions of Object.values(scene.projection!.semanticTransitionsByEntityId!)) {
      for (const transition of Object.values(transitions)) {
        if (!transition) continue;
        const band = bands.find(candidate => candidate.detail === transition.nextDetail)!;
        expect(transition.minZoom).toBeLessThanOrEqual(band.enterZoom + 1e-9);
        expect(transition.fullZoom).toBeLessThanOrEqual(band.enterZoom + band.fadeWidth + 1e-9);
        expect(transition.minZoom).toBeLessThan(transition.fullZoom);
      }
    }
  });

  it('keeps the golden (no targetAspect) runway on the fixed band window byte-identically', () => {
    const golden = createGoldenC4Scene();
    const bands = golden.projection!.zoomPolicy!.bands;
    for (const transitions of Object.values(golden.projection!.semanticTransitionsByEntityId!)) {
      for (const transition of Object.values(transitions)) {
        if (!transition) continue;
        const band = bands.find(candidate => candidate.detail === transition.nextDetail)!;
        expect(transition.minZoom).toBe(band.enterZoom);
        expect(transition.fullZoom).toBe(Math.min(golden.projection!.zoomPolicy!.maxZoom, band.enterZoom + band.fadeWidth));
      }
    }
  });
});
