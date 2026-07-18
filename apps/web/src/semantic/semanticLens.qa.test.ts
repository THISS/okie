import { describe, expect, it } from 'vitest';
import {
  SEMANTIC_LENS_POLICY,
  composeSemanticZoomCamera,
  containSemanticOwnerCamera,
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
import type { AtlasScene, SceneEntity } from '../renderer/types';
import { createGoldenC4Scene } from '../renderer/goldenC4Scene';

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

  // Sanctioned product-feel change (task #32, direct user feedback): a wheel/pinch
  // zoom must scale around the pointer and NEVER recentre on an owner mid-gesture.
  // The previous behaviour pulled an oversized owner to the viewport centre while the
  // gesture was live (felt as "snap to the parent, then snap back to the child").
  // Owner containment is now a settle-frame landing only; the lens still arms/reveals.
  it('holds the cursor anchor through a live zoom and lands owner containment only at settle', () => {
    const viewport = { width: 1_000, height: 800 };
    const safeArea = { left: 100, right: 150, top: 50, bottom: 100 };
    const owner = { x: 0, y: 0, width: 10, height: 10 };
    // Camera whose zoom makes the owner overflow the right+bottom safe edges (would recentre).
    const cursor = { x: (viewport.width / 2 - 760) / 10, y: (viewport.height / 2 - 620) / 10, zoom: 10 };

    // Live gesture: the rendered camera IS the cursor-anchored camera — no recentre.
    expect(composeSemanticZoomCamera(cursor, false, { ownerBounds: owner }, viewport, safeArea)).toBe(cursor);
    // Settle: containment lands the owner back inside the safe viewport (a one-time landing).
    const landed = composeSemanticZoomCamera(cursor, true, { ownerBounds: owner }, viewport, safeArea);
    expect(landed).toEqual(containSemanticOwnerCamera(cursor, owner, viewport, safeArea));
    expect(landed).not.toEqual(cursor);
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

  // Task #37 O3 (sanctioned scan product-feel change): under aspect packing an owner shell can
  // dwarf its children, so a wheel zoom often lands the cursor in the PADDING between children —
  // no child contains it and the band used to stall (blank zoom). On scan (scene.targetAspect
  // set) the lens now SNAPS to the nearest child when the pointer sits within the children's
  // collective extent (the owner interior). It never reaches across empty space, and the golden
  // (no-targetAspect) path is byte-identical: a padding pointer still yields no target.
  it('scan snap-to-nearest: a padding pointer advances toward the nearest child; golden path unchanged', () => {
    const entities = [
      entity('system:root'),
      entity('container:c', 'system:root'),
      entity('component:a', 'container:c'),
      entity('component:b', 'container:c'),
      entity('code:a1', 'component:a'),
      entity('code:b1', 'component:b'),
    ];
    const projection = {
      semanticToVisualEntityId: {},
      visualToSemanticEntityId: {},
      semanticToVisualRelationIds: {},
      visualToSemanticRelationIds: {},
      boundsByEntityIdAndDetail: {
        // Persistent owner shells: a component keeps identical bounds at its component and code bands.
        'component:a': { component: { x: 0, y: 0, width: 100, height: 100 }, code: { x: 0, y: 0, width: 100, height: 100 } },
        'component:b': { component: { x: 300, y: 0, width: 100, height: 100 }, code: { x: 300, y: 0, width: 100, height: 100 } },
        'code:a1': { code: { x: 20, y: 20, width: 20, height: 20 } },
        'code:b1': { code: { x: 320, y: 20, width: 20, height: 20 } },
      },
      entityIdsByDetail: {
        context: ['system:root'],
        container: ['system:root', 'container:c'],
        component: ['system:root', 'container:c', 'component:a', 'component:b'],
        code: ['code:a1', 'code:b1'],
      },
      relationIdsByDetail: { context: [], container: [], component: [], code: [] },
      projectedRelationsByDetail: { context: [], container: [], component: [], code: [] },
    };
    const viewport = { width: 1_000, height: 800 };
    const safeArea = { top: 0, right: 0, bottom: 0, left: 0 };
    const camera = { x: 200, y: 50, zoom: 2 };
    // Screen: component:a x∈[100,300], component:b x∈[700,900], y∈[300,500]. This pointer sits
    // in the gap between them (inside the union) and is nearer a's right edge than b's left edge.
    const paddingPointer = { x: 450, y: 400 };

    const scan: AtlasScene = { id: 's', title: 's', subtitle: 's', entities, relations: [], regions: [], targetAspect: 1.6, projection };
    const snapped = findSemanticLensTarget(scan, 'component', camera, viewport, safeArea, paddingPointer);
    expect(snapped?.id).toBe('component:a');
    // The snapped child reports at least the inset containment so armEligible/resolveRetarget accept it.
    expect(snapped!.containmentPx).toBeGreaterThanOrEqual(SEMANTIC_LENS_POLICY.retargetContainmentPx);
    // Never reach across empty space to a distant child: a pointer outside the children's extent snaps to nothing.
    expect(findSemanticLensTarget(scan, 'component', camera, viewport, safeArea, { x: 990, y: 790 })).toBeUndefined();
    // Golden/demo (no targetAspect): the same padding pointer yields no target — byte-identical legacy behaviour.
    const golden: AtlasScene = { ...scan, targetAspect: undefined };
    expect(findSemanticLensTarget(golden, 'component', camera, viewport, safeArea, paddingPointer)).toBeUndefined();
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
