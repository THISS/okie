import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_LENS_POLICY,
  findSemanticLensTarget,
  idleSemanticLens,
  reduceSemanticLens,
  semanticLensBranchEntityIds,
  semanticLensProjectionOverride,
  semanticLensScopeIds,
  semanticLensUrl,
  type SemanticLensSample,
  type SemanticLensState,
  type SemanticLensTarget,
} from './semanticLens';
import type { AtlasScene, SceneEntity } from './renderer/types';
import { createGoldenC4Scene } from './renderer/goldenC4Scene';

const target = (
  major: number,
  minor: number,
  overrides: Partial<SemanticLensTarget> = {},
): SemanticLensTarget => ({
  id: 'container:target',
  currentDetail: 'container',
  nextDetail: 'component',
  enterZoom: 0.92,
  coverage: { major, minor },
  containmentPx: 40,
  ...overrides,
});

const entity = (id: string, parentId?: string): SceneEntity => ({
  id,
  ...(parentId ? { parentId } : {}),
  name: id,
  kind: 'component',
  responsibility: id,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
});

describe('semantic lens acceptance contract', () => {
  it('pins every authored threshold and assist bound', () => {
    expect(SEMANTIC_LENS_POLICY).toEqual({
      armCoverage: { major: 0.42, minor: 0.18 },
      commitCoverage: { major: 0.46, minor: 0.20 },
      fullCoverage: { major: 0.52, minor: 0.24 },
      reverseCoverage: { major: 0.34, minor: 0.14 },
      dwellMs: 90,
      retargetDwellMs: 80,
      retargetContainmentPx: 24,
      retargetProgressLimit: 0.5,
      reverseZoomDelta: 0.04,
      desktopAssistMs: 260,
      mobileAssistMs: 320,
      maxCenterBlend: 0.68,
      maxSettledZoomCorrection: 0.06,
      mobileIntentRatio: 0.12,
    });
  });

  it('arms only on inward intent with at least 24px target containment', () => {
    const eligible = target(0.62, 0.28);
    expect(reduceSemanticLens(idleSemanticLens(), {
      nowMs: 0,
      zoom: 0.92,
      direction: 'none',
      target: eligible,
    }).phase).toBe('idle');
    expect(reduceSemanticLens(idleSemanticLens(), {
      nowMs: 0,
      zoom: 0.92,
      direction: 'outward',
      target: eligible,
    }).phase).toBe('idle');
    expect(reduceSemanticLens(idleSemanticLens(), {
      nowMs: 0,
      zoom: 0.92,
      direction: 'inward',
      target: { ...eligible, containmentPx: 23.999 },
    }).phase).toBe('idle');
    expect(reduceSemanticLens(idleSemanticLens(), {
      nowMs: 0,
      zoom: 0.92,
      direction: 'inward',
      target: { ...eligible, containmentPx: 24 },
    }).phase).toBe('armed');
  });

  it('requires 90ms of uninterrupted inward intent before commit', () => {
    const armed = reduceSemanticLens(idleSemanticLens(), {
      nowMs: 0,
      zoom: 0.92,
      direction: 'inward',
      target: target(0.62, 0.28),
    });
    const interrupted = reduceSemanticLens(armed, {
      nowMs: 50,
      zoom: 0.98,
      direction: 'outward',
      target: target(0.70, 0.34),
    });
    expect(interrupted).toEqual(idleSemanticLens());
    const rearmed = reduceSemanticLens(interrupted, {
      nowMs: 90,
      zoom: 1.02,
      direction: 'inward',
      target: target(0.78, 0.39),
    });
    expect(rearmed.phase).toBe('armed');
    expect(reduceSemanticLens(rearmed, {
      nowMs: 179,
      zoom: 1.02,
      direction: 'inward',
      target: target(0.78, 0.39),
    }).phase).toBe('armed');
    expect(reduceSemanticLens(rearmed, {
      nowMs: 180,
      zoom: 1.02,
      direction: 'inward',
      target: target(0.49, 0.22),
    }).phase).toBe('revealing');
  });

  it('waits for gesture settle before the reduced-motion threshold swap', () => {
    const armed = reduceSemanticLens(idleSemanticLens(), {
      nowMs: 0,
      zoom: 0.92,
      direction: 'inward',
      target: target(0.62, 0.28),
      reducedMotion: true,
    });
    const moving = {
      nowMs: 100,
      zoom: 1.04,
      direction: 'inward' as const,
      target: target(0.82, 0.42),
      reducedMotion: true,
      gestureSettled: false,
    } satisfies SemanticLensSample & { gestureSettled: boolean };
    expect(reduceSemanticLens(armed, moving).phase).toBe('armed');
    const settled = {
      ...moving,
      nowMs: 101,
      direction: 'none' as const,
      gestureSettled: true,
    } satisfies SemanticLensSample & { gestureSettled: boolean };
    expect(reduceSemanticLens(armed, settled)).toMatchObject({ phase: 'settled', progress: 1, assistBlend: 0 });
  });

  it('keeps mobile pinch idle below 12%, starts dwell at the crossing, and commits only later', () => {
    const gestureStartZoom = .82;
    const belowIntent = reduceSemanticLens(idleSemanticLens(), {
      nowMs: 0,
      zoom: .917,
      direction: 'inward',
      target: target(.82, .42),
      mobile: true,
      gestureStartZoom,
    });
    expect(belowIntent).toEqual(idleSemanticLens());

    const armed = reduceSemanticLens(belowIntent, {
      nowMs: 10,
      zoom: .92,
      direction: 'inward',
      target: target(.82, .42),
      mobile: true,
      gestureStartZoom,
    });
    expect(armed).toMatchObject({ phase: 'armed', armedAtMs: 10, progress: 0 });
    expect(reduceSemanticLens(armed, {
      nowMs: 99,
      zoom: .94,
      direction: 'inward',
      target: target(.82, .42),
      mobile: true,
      gestureStartZoom,
      reducedMotion: true,
      gestureSettled: true,
    }).phase).toBe('armed');
    expect(reduceSemanticLens(armed, {
      nowMs: 100,
      zoom: .94,
      direction: 'none',
      target: target(.82, .42),
      mobile: true,
      gestureStartZoom,
      reducedMotion: true,
      gestureSettled: true,
    })).toMatchObject({ phase: 'settled', progress: 1, assistBlend: 0 });
  });

  it('canonicalizes a transition to the nearest stable side at 50%', () => {
    const revealing: SemanticLensState = {
      phase: 'revealing',
      targetId: 'container:target',
      currentDetail: 'container',
      nextDetail: 'component',
      progress: 0.49,
      assistBlend: 0.2,
    };
    expect(semanticLensUrl('https://okie.test/?detail=container', revealing)).not.toContain('lens=');
    expect(semanticLensUrl('https://okie.test/?detail=container', { ...revealing, progress: 0.5 }))
      .toContain('lens=container%3Atarget');
  });

  it('clears immediately once either outward exit guard is crossed', () => {
    const settled: SemanticLensState = {
      phase: 'settled',
      targetId: 'container:target',
      currentDetail: 'container',
      nextDetail: 'component',
      progress: 1,
      assistBlend: 0.68,
    };
    expect(reduceSemanticLens(settled, {
      nowMs: 200,
      zoom: 1,
      direction: 'outward',
      target: target(0.33, 0.25),
    })).toEqual(idleSemanticLens());
  });

  it('cancels an armed lens before considering an outward pointer retarget', () => {
    const armed = reduceSemanticLens(idleSemanticLens(), {
      nowMs: 0,
      zoom: 0.92,
      direction: 'inward',
      target: target(0.62, 0.28),
    });
    expect(reduceSemanticLens(armed, {
      nowMs: 10,
      zoom: 0.94,
      direction: 'outward',
      target: target(0.70, 0.34, { id: 'container:candidate' }),
    })).toEqual(idleSemanticLens());
  });

  it('locks the active target at 50% while outward motion reverses it under another pointer candidate', () => {
    const revealing: SemanticLensState = {
      phase: 'revealing',
      targetId: 'container:target',
      currentDetail: 'container',
      nextDetail: 'component',
      progress: 0.5,
      assistBlend: 0.34,
    };
    expect(reduceSemanticLens(revealing, {
      nowMs: 100,
      zoom: 1.02,
      direction: 'outward',
      activeTarget: target(0.78, 0.39),
      candidateTarget: target(0.78, 0.39, { id: 'container:candidate' }),
    })).toMatchObject({
      phase: 'reversing',
      targetId: 'container:target',
      progress: 0.5,
    });
  });

  it('keeps external relation endpoints out of the revealed branch scope', () => {
    const entities = [
      entity('system:root'),
      entity('container:parent', 'system:root'),
      entity('component:target', 'container:parent'),
      entity('code:target-child', 'component:target'),
      entity('component:sibling', 'container:parent'),
      entity('code:external-child', 'component:sibling'),
    ];
    const scene: AtlasScene = {
      id: 'scope-fixture',
      title: 'scope',
      subtitle: 'scope',
      entities,
      relations: [],
      regions: [],
      projection: {
        semanticToVisualEntityId: {},
        visualToSemanticEntityId: {},
        semanticToVisualRelationIds: {},
        visualToSemanticRelationIds: {},
        boundsByEntityIdAndDetail: {},
        entityIdsByDetail: {
          context: ['system:root'],
          container: ['system:root', 'container:parent'],
          component: ['system:root', 'container:parent', 'component:target', 'component:sibling'],
          code: entities.map(value => value.id),
        },
        relationIdsByDetail: { context: [], container: [], component: [], code: ['relation:external'] },
        projectedRelationsByDetail: {
          context: [],
          container: [],
          component: [],
          code: [{ id: 'relation:external', from: 'code:target-child', to: 'code:external-child' }],
        },
      },
    };
    expect(semanticLensScopeIds(scene, 'component:target', 'code')).toEqual([
      'code:target-child',
      'component:target',
      'container:parent',
      'system:root',
    ]);
  });

  it('morphs only internal branch edges and labels while fading an external endpoint', () => {
    const scene = createGoldenC4Scene();
    const branch = new Set(semanticLensBranchEntityIds(scene, 'system:okie', 'container'));
    const sourceRelations = scene.projection!.projectedRelationsByDetail.context;
    const targetRelations = scene.projection!.projectedRelationsByDetail.container;
    const protocolObjectIds = new Set((scene.protocolSnapshot as { objects: Array<{ id: string }> }).objects
      .map(object => object.id));
    const hasLabel = (relation: { id: string }) => protocolObjectIds.has(`relation-label:${relation.id}`);
    const external = sourceRelations.find(relation => hasLabel(relation)
      && branch.has(relation.from) !== branch.has(relation.to));
    const internal = targetRelations.find(relation => branch.has(relation.from) && branch.has(relation.to));
    expect(external).toBeDefined();
    expect(internal).toBeDefined();

    const override = semanticLensProjectionOverride(scene, {
      phase: 'revealing',
      targetId: 'system:okie',
      currentDetail: 'context',
      nextDetail: 'container',
      progress: 0.5,
      assistBlend: 0.34,
    })!;
    expect(override.morph!.pathIds).toContain(internal!.id);
    expect(override.morph!.pathIds).not.toContain(external!.id);
    if (hasLabel(internal!)) expect(override.morph!.objectIds).toContain(`relation-label:${internal!.id}`);
    expect(override.morph!.objectIds).not.toContain(`relation-label:${external!.id}`);

    const externalEndpoint = branch.has(external!.from) ? external!.to : external!.from;
    const externalVisualId = scene.projection!.semanticToVisualEntityId[externalEndpoint]!;
    const endpoint = override.objects.find(object => object.objectId === externalVisualId)!;
    expect(endpoint.sourceRepresentationId).toBe(`${externalVisualId}:context`);
    expect(endpoint.targetRepresentationId).toBeUndefined();
    expect(override.morph!.objectIds).not.toContain(externalVisualId);

    const externalPath = override.paths.find(path => path.pathId === external!.id)!;
    expect(externalPath).toEqual({ pathId: external!.id, sourceOpacity: 1, targetOpacity: 0 });
  });

  it('cannot target a hidden sibling branch from its authored off-branch component geometry', () => {
    const scene = createGoldenC4Scene();
    const containers = scene.entities.filter(candidate => candidate.detail === 'container');
    const branches = containers.flatMap(container => {
      const component = scene.entities.find(candidate => candidate.parentId === container.id
        && candidate.detail === 'component'
        && scene.entities.some(child => child.parentId === candidate.id && child.detail === 'code'));
      return component ? [{ container, component }] : [];
    });
    expect(branches.length).toBeGreaterThanOrEqual(2);
    const [owned, hidden] = branches;
    const bounds = scene.projection!.boundsByEntityIdAndDetail[hidden!.component.id]!.component!;
    const viewport = { width: 1_000, height: 800 };
    const safeArea = { top: 0, right: 0, bottom: 0, left: 0 };
    const camera = {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
      zoom: 5.15,
    };
    const pointer = { x: viewport.width / 2, y: viewport.height / 2 };

    expect(findSemanticLensTarget(scene, 'component', camera, viewport, safeArea, pointer)?.id)
      .toBe(hidden!.component.id);
    const eligible = new Set(semanticLensBranchEntityIds(scene, owned!.container.id, 'component'));
    expect(findSemanticLensTarget(scene, 'component', camera, viewport, safeArea, pointer, [], eligible))
      .toBeUndefined();
  });
});
