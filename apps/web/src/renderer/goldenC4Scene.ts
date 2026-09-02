import {
  buildC4ProjectionBundle,
  materializeArchitectureAuthoring,
  selectC4BandProjection,
  validateStory,
  type C4ProjectionBundle,
  type ArchitectureSnapshot,
  type ArchitectureAuthoringDocument,
  type ArchitectureEntity,
  type ArchitectureStory,
  type ArchitectureView,
  type C4Band,
  type EntityKind,
  type SourceRef,
} from '@okie/architecture';
import {
  GOLDEN_WORKTREE_REVISION,
  compileAuthoredC4Scene,
  compileC4Scene,
  coverageRevealZoomWindow,
  diffSceneSnapshots,
  goldenSnapshot,
  goldenStory,
  goldenView,
  type SceneSnapshot,
} from '@okie/scene-compiler';
import type { AtlasScene, EntityKind as AtlasEntityKind, OmittedEdge, OmittedRelation, ScopedCompileInfo, SceneEntity, SceneRelation, SemanticDetail } from './types';

const bands: readonly C4Band[] = ['context', 'container', 'component', 'code'];

function atlasKind(kind: EntityKind): AtlasEntityKind {
  if (kind === 'person') return 'person';
  if (kind === 'container') return 'container';
  if (kind === 'dataStore') return 'store';
  if (kind === 'queue') return 'queue';
  if (kind === 'component' || kind === 'code') return 'component';
  return 'system';
}

function humanKind(kind: EntityKind): string {
  const labels: Record<EntityKind, string> = {
    person: 'Person',
    softwareSystem: 'Software system',
    externalSystem: 'External system',
    container: 'Container',
    dataStore: 'Data store',
    queue: 'Queue',
    component: 'Component',
    code: 'Source',
    boundary: 'Boundary',
  };
  return labels[kind];
}

function detailForKind(kind: EntityKind): SemanticDetail {
  if (kind === 'container' || kind === 'dataStore' || kind === 'queue') return 'container';
  if (kind === 'component') return 'component';
  if (kind === 'code') return 'code';
  return 'context';
}

function entityForScene(
  entity: ArchitectureEntity,
  boundsByBand: Partial<Record<C4Band, { x: number; y: number; width: number; height: number }>>,
): SceneEntity {
  const detail = detailForKind(entity.kind);
  const bounds = boundsByBand[detail]
    ?? bands.flatMap(band => boundsByBand[band] ? [boundsByBand[band]!] : [])[0]
    ?? { x: 0, y: 0, width: 1, height: 1 };
  const sourceRefs = entity.sourceRefs.map(source => ({
    path: source.path,
    ...(source.symbol ? { symbol: source.symbol } : {}),
    ...(source.startLine !== undefined ? { startLine: source.startLine } : {}),
    ...(source.endLine !== undefined ? { endLine: source.endLine } : {}),
    revision: source.commitSha,
  }));
  return {
    id: entity.id,
    ...(entity.parentId ? { parentId: entity.parentId } : {}),
    name: entity.name,
    kind: atlasKind(entity.kind),
    kindLabel: humanKind(entity.kind),
    detail,
    responsibility: entity.responsibility ?? 'No summary supplied.',
    ...(entity.technology?.length ? { technology: entity.technology.join(' · ') } : {}),
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    ...(sourceRefs[0] ? { source: sourceRefs[0].path } : {}),
    ...(sourceRefs.length ? { sourceRefs } : {}),
    ...(entity.sourceExcerpts?.length ? {
      sourceExcerpts: entity.sourceExcerpts.map(excerpt => ({
        ...excerpt,
        lines: [...excerpt.lines],
      })),
    } : {}),
    ...(entity.owners?.length ? { owners: [...entity.owners] } : {}),
    ...(entity.cyclomaticComplexity !== undefined ? { cyclomaticComplexity: entity.cyclomaticComplexity } : {}),
  };
}

export type AppStoryPlanStep = {
  id: string;
  title: string;
  narration: string;
  focusEntityIds: string[];
  traceRelationIds: string[];
  reveal: SemanticDetail;
  sourceRefs: SourceRef[];
  authoredHoldMs?: number;
};

export type AppStoryPlan = {
  id: string;
  snapshotId: string;
  viewId: string;
  title: string;
  steps: AppStoryPlanStep[];
};

function storyReveal(snapshot: ArchitectureSnapshot, step: ArchitectureStory['steps'][number]): SemanticDetail {
  if (step.reveal) return step.reveal;
  const ranks = step.focusEntityIds.map(id => {
    const entity = snapshot.entities.find(candidate => candidate.id === id);
    return entity ? bands.indexOf(detailForKind(entity.kind)) : 0;
  });
  return bands[Math.max(0, ...ranks)]!;
}

/** Resolves semantic authoring into the complete host playback contract. */
export function compileAppStoryPlan(
  snapshot: ArchitectureSnapshot,
  view: ArchitectureView,
  story: ArchitectureStory,
): AppStoryPlan {
  const issues = validateStory(snapshot, view, story);
  if (issues.length) {
    throw new Error(`Cannot prepare invalid app story: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`);
  }
  return {
    id: story.id,
    snapshotId: story.snapshotId,
    viewId: story.viewId,
    title: story.title,
    steps: story.steps.map(step => ({
      id: step.id,
      title: step.title,
      narration: step.narration,
      focusEntityIds: [...step.focusEntityIds],
      traceRelationIds: [...(step.traceRelationIds ?? [])],
      reveal: storyReveal(snapshot, step),
      sourceRefs: (step.sourceRefs ?? []).map(source => ({ ...source })),
      ...(step.durationMs !== undefined ? { authoredHoldMs: step.durationMs } : {}),
    })),
  };
}

export const goldenAppStory = compileAppStoryPlan(goldenSnapshot, goldenView, goldenStory);

export type C4SceneOptions = {
  baseSnapshot: ArchitectureSnapshot;
  rootEntityId: string;
  focusEntityId: string;
  familyId: string;
  sceneId: string;
  title: string;
  subtitle: string;
  frozenRevision: string;
  previous?: AtlasScene;
  authoring?: ArchitectureAuthoringDocument;
  /** Scoped-compile options (scan mode); omitted for the golden fixture so its
   *  compile stays byte-identical. */
  maxBand?: C4Band;
  maxEdgesPerBand?: number;
  maxGridNodes?: number;
  /** Aspect-aware packing target (scan mode, task #30); omitted for the golden fixture
   *  so its compile stays byte-identical. Applied at all repo sizes (a per-mode opt-in,
   *  independent of the scoped-compile size gates). */
  targetAspect?: number;
  /** Size gate value for the dev diagnostics line (scan mode); display-only. */
  bandDepthThreshold?: number;
};

/**
 * Resolves the relations dropped from routing under an edge budget into an
 * enumerable "+N more" list (from/to names + unioned evidence paths). Empty when
 * no band carries omittedEdgeIds (the golden fixture and any unbounded scope).
 */
export function resolveOmittedRelations(bundle: C4ProjectionBundle, snapshot: ArchitectureSnapshot): OmittedRelation[] {
  const omittedEdgeIds = [...new Set(Object.values(bundle.projectionById).flatMap(projection => projection.omittedEdgeIds ?? []))].sort();
  if (!omittedEdgeIds.length) return [];
  const nameById = new Map(snapshot.entities.map(entity => [entity.id, entity.name]));
  const relationById = new Map(snapshot.relations.map(relation => [relation.id, relation]));
  const byRelationId = new Map<string, OmittedRelation>();
  for (const edgeId of omittedEdgeIds) {
    const edge = bundle.visualEdgeById[edgeId];
    for (const relationId of bundle.index.relationIdsByVisualEdgeId[edgeId] ?? []) {
      if (byRelationId.has(relationId)) continue;
      const relation = relationById.get(relationId);
      const fromId = (edge && bundle.index.entityIdByVisualNodeId[edge.fromVisualId]) ?? relation?.from ?? '';
      const toId = (edge && bundle.index.entityIdByVisualNodeId[edge.toVisualId]) ?? relation?.to ?? '';
      byRelationId.set(relationId, {
        relationId,
        fromName: nameById.get(fromId) ?? fromId,
        toName: nameById.get(toId) ?? toId,
        label: relation?.label ?? edge?.label ?? relation?.kind ?? 'relates to',
        evidencePaths: [...new Set((relation?.evidence ?? []).map(evidence => evidence.source.path))].sort(),
      });
    }
  }
  return [...byRelationId.values()].sort((left, right) => left.relationId.localeCompare(right.relationId));
}

/**
 * Resolves the same drop as {@link resolveOmittedRelations}, keyed by visual edge
 * and band instead of by relation. The inspector needs the projected endpoint IDs
 * to attribute "+N more" to the selected card; the relation-keyed list only carries
 * display names and collapses an edge omitted in several bands into one row.
 */
export function resolveOmittedEdges(bundle: C4ProjectionBundle, snapshot: ArchitectureSnapshot): OmittedEdge[] {
  const nameById = new Map(snapshot.entities.map(entity => [entity.id, entity.name]));
  const relationById = new Map(snapshot.relations.map(relation => [relation.id, relation]));
  return bands.flatMap(band => {
    const projection = bundle.projectionById[bundle.family.projectionIds[band]];
    return [...(projection?.omittedEdgeIds ?? [])].sort().flatMap(edgeId => {
      const edge = bundle.visualEdgeById[edgeId];
      if (!edge) return [];
      const relationIds = bundle.index.relationIdsByVisualEdgeId[edgeId] ?? [];
      const fromId = bundle.index.entityIdByVisualNodeId[edge.fromVisualId] ?? '';
      const toId = bundle.index.entityIdByVisualNodeId[edge.toVisualId] ?? '';
      return [{
        edgeId,
        detail: band as SemanticDetail,
        fromId,
        toId,
        fromName: nameById.get(fromId) ?? fromId,
        toName: nameById.get(toId) ?? toId,
        label: edge.label || relationById.get(relationIds[0] ?? '')?.kind || 'relates to',
        relationCount: relationIds.length,
        ...(relationIds.length ? { semanticIds: [...relationIds] } : {}),
      }];
    });
  });
}

/**
 * Compiles an architecture snapshot into the renderer scene + projection bundle.
 * Shared by the golden fixture and any live-loaded fixture (e.g. scanned
 * snapshots); fixture-specific labels/ids arrive through options so the compile
 * path (buildC4ProjectionBundle → compileC4Scene) stays identical for both.
 */
export function createC4Scene(options: C4SceneOptions): AtlasScene {
  const { baseSnapshot, authoring, previous } = options;
  const snapshot = authoring
    ? materializeArchitectureAuthoring(baseSnapshot, authoring)
    : baseSnapshot;
  const buildOptions = {
    rootEntityId: options.rootEntityId,
    focusEntityId: options.focusEntityId,
    familyId: options.familyId,
    ...(options.maxBand ? { maxBand: options.maxBand } : {}),
    ...(options.maxEdgesPerBand !== undefined ? { maxEdgesPerBand: options.maxEdgesPerBand } : {}),
    ...(options.maxGridNodes !== undefined ? { maxGridNodes: options.maxGridNodes } : {}),
    ...(options.targetAspect !== undefined ? { targetAspect: options.targetAspect } : {}),
  };
  const authoredProjections = buildC4ProjectionBundle(snapshot, buildOptions);
  const previousSnapshot = previous?.protocolSnapshot as SceneSnapshot | undefined;
  const revision = previousSnapshot && previousSnapshot.sceneId === `scene:${baseSnapshot.repositoryId}:c4`
    ? previousSnapshot.revision + 1
    : 1;
  const scoped = options.maxBand !== undefined || options.maxEdgesPerBand !== undefined || options.maxGridNodes !== undefined;
  const compileOptions = {
    revision,
    ...(options.maxGridNodes !== undefined ? { maxGridNodes: options.maxGridNodes } : {}),
    ...(options.targetAspect !== undefined ? { targetAspect: options.targetAspect } : {}),
  };
  const compiled = authoring
    ? compileAuthoredC4Scene(baseSnapshot, authoring, buildOptions, compileOptions)
    // routeOverrides:[] is a no-op for routing but makes compileC4Scene return route
    // diagnostics, so the scan diagnostics line can surface the direct-fallback count.
    : compileC4Scene(snapshot, authoredProjections, scoped ? { ...compileOptions, routeOverrides: [] } : compileOptions);
  const directFallbackCount = (compiled.routeDiagnostics ?? [])
    .filter(diagnostic => diagnostic.routerDiagnostic === 'direct-fallback').length;
  const projections = compiled.projections;
  const semanticToVisualEntityId = Object.fromEntries(Object.entries(projections.index.visualNodeIdsByEntityId)
    .flatMap(([entityId, visualIds]) => visualIds[0] ? [[entityId, visualIds[0]]] : []));
  const visualToSemanticEntityId = { ...projections.index.entityIdByVisualNodeId };
  const visualToSemanticRelationIds = { ...projections.index.relationIdsByVisualEdgeId };
  const semanticToVisualRelationIds = { ...projections.index.visualEdgeIdsByRelationId };
  const entityIdsByDetail = Object.fromEntries(bands.map(band => {
    const projection = selectC4BandProjection(projections, band);
    return [band, projection.nodes.map(node => node.entity.logicalId)];
  })) as Record<SemanticDetail, string[]>;
  const relationIdsByDetail = Object.fromEntries(bands.map(band => {
    const projection = selectC4BandProjection(projections, band);
    return [band, projection.edges.map(edge => edge.id)];
  })) as Record<SemanticDetail, string[]>;
  const protocolPathById = new Map(compiled.scene.paths.map(path => [path.id, path]));
  const projectedRelationsByDetail = Object.fromEntries(bands.map(band => {
    const projection = selectC4BandProjection(projections, band);
    const relations: SceneRelation[] = projection.edges.map(edge => ({
      id: edge.id,
      from: projections.index.entityIdByVisualNodeId[edge.fromVisualId]!,
      to: projections.index.entityIdByVisualNodeId[edge.toVisualId]!,
      arrow: protocolPathById.get(edge.id)?.arrow ?? 'end',
      routePoints: edge.route.points.map(point => ({ ...point })),
      label: edge.label,
      kindLabel: edge.kind,
      semanticIds: edge.relations.map(relation => relation.logicalId),
    }));
    return [band, relations];
  })) as Record<SemanticDetail, SceneRelation[]>;
  const entities = snapshot.entities.map(entity => entityForScene(
    entity,
    projections.index.boundsByEntityIdAndBand[entity.id] ?? {},
  ));
  const semanticTransitionsByEntityId = Object.fromEntries(entities.map(entity => {
    const visualId = semanticToVisualEntityId[entity.id];
    const object = compiled.scene.objects.find(candidate => candidate.id === visualId);
    const transitions = bands.slice(1).flatMap((nextDetail, index) => {
      const currentDetail = bands[index]!;
      const source = object?.representations.find(representation => representation.id === `${visualId}:${currentDetail}`);
      const target = object?.representations.find(representation => representation.id === `${visualId}:${nextDetail}`);
      const currentBounds = projections.index.boundsByEntityIdAndBand[entity.id]?.[currentDetail];
      const nextBounds = projections.index.boundsByEntityIdAndBand[entity.id]?.[nextDetail];
      if (!source || !target || !currentBounds || !nextBounds) return [];
      const nextBand = compiled.zoomPolicy.bands.find(band => band.detail === nextDetail)!;
      const largestTargetText = target.primitives.reduce((largest, primitive) =>
        primitive.kind === 'text' ? Math.max(largest, primitive.fontSize) : largest, 0);
      // Scan mode (targetAspect set): the reveal runway follows the coverage contract —
      // children start revealing when the owner's expanded box would cover
      // COVERAGE_REVEAL.start of the nominal viewport, never later than the band's own
      // enter/fade window. A large scanned owner otherwise outgrows the screen long
      // before the fixed band runway begins (user report: "empty node past full screen").
      // Same box and math as the compiler's coverageRevealLod → one reveal moment.
      // Golden/demo (no targetAspect) keeps the band runway byte-identically.
      const revealWindow = options.targetAspect !== undefined
        ? coverageRevealZoomWindow(nextBounds, nextDetail, options.targetAspect)
        : undefined;
      return [[nextDetail, {
        currentDetail,
        nextDetail,
        sourceRepresentationId: source.id,
        targetRepresentationId: target.id,
        enterCoverage: { major: 0.72, minor: 0.42 },
        commitCoverage: { major: 0.78, minor: 0.46 },
        fullCoverage: { major: 0.84, minor: 0.50 },
        leaveCoverage: { major: 0.58, minor: 0.30 },
        minimumCssSize: {
          width: Math.max(320, largestTargetText * 10),
          height: Math.max(180, largestTargetText * 4),
        },
        minZoom: revealWindow?.minZoom ?? nextBand.enterZoom,
        fullZoom: Math.min(
          compiled.zoomPolicy.maxZoom,
          revealWindow?.fullZoom ?? nextBand.enterZoom + nextBand.fadeWidth,
        ),
        hysteresis: nextBand.hysteresis,
        transitionMs: 180,
        dwellMs: 80,
        pointerInsetPx: 24,
      }]];
    });
    return [entity.id, Object.fromEntries(transitions)];
  }));
  const omittedRelations = resolveOmittedRelations(authoredProjections, snapshot);
  const omittedEdges = resolveOmittedEdges(authoredProjections, snapshot);
  const scopedCompile: ScopedCompileInfo | undefined = scoped ? {
    ...(options.maxBand !== undefined ? { maxBand: options.maxBand } : {}),
    ...(options.maxEdgesPerBand !== undefined ? { maxEdgesPerBand: options.maxEdgesPerBand } : {}),
    ...(options.maxGridNodes !== undefined ? { maxGridNodes: options.maxGridNodes } : {}),
    entityCount: snapshot.entities.length,
    bandDepthThreshold: options.bandDepthThreshold ?? 0,
    directFallbackCount,
  } : undefined;
  const scene: AtlasScene = {
    id: options.sceneId,
    title: options.title,
    subtitle: options.subtitle,
    rootEntityId: options.focusEntityId,
    frozenRevision: options.frozenRevision,
    ...(omittedRelations.length ? { omittedRelations } : {}),
    ...(omittedEdges.length ? { omittedEdges } : {}),
    ...(scopedCompile ? { scopedCompile } : {}),
    ...(options.targetAspect !== undefined ? { targetAspect: options.targetAspect } : {}),
    entities,
    relations: snapshot.relations.map(relation => ({
      id: relation.id,
      from: relation.from,
      to: relation.to,
      ...(relation.label ? { label: relation.label } : {}),
      kindLabel: relation.kind,
      ...(relation.technology ? { protocol: relation.technology } : {}),
    })),
    regions: [],
    protocolSnapshot: compiled.scene,
    projection: {
      familyId: projections.family.id,
      semanticToVisualEntityId,
      visualToSemanticEntityId,
      semanticToVisualRelationIds,
      visualToSemanticRelationIds,
      boundsByEntityIdAndDetail: projections.index.boundsByEntityIdAndBand,
      entityIdsByDetail,
      relationIdsByDetail,
      projectedRelationsByDetail,
      semanticTransitionsByEntityId,
      zoomPolicy: {
        minZoom: compiled.zoomPolicy.minZoom,
        maxZoom: compiled.zoomPolicy.maxZoom,
        bands: compiled.zoomPolicy.bands.map(band => ({ ...band })),
      },
    },
  };
  if (previousSnapshot && previousSnapshot.sceneId === compiled.scene.sceneId) {
    // Root changes are paired with camera motion in the shell. Geometry is
    // patched once; keeping interpolation out of the static scene avoids a
    // full WebGPU/WebGL2 mesh rebuild on every animation frame.
    scene.protocolPatch = diffSceneSnapshots(previousSnapshot, compiled.scene);
  }
  return scene;
}

export function createGoldenC4Scene(
  focusEntityId = 'system:okie',
  previous?: AtlasScene,
  authoring?: ArchitectureAuthoringDocument,
): AtlasScene {
  return createC4Scene({
    baseSnapshot: goldenSnapshot,
    rootEntityId: 'system:okie',
    focusEntityId,
    familyId: `view-family:okie-golden:${focusEntityId}`,
    sceneId: 'okie-golden-c4',
    title: 'Okie architecture atlas',
    subtitle: `frozen worktree fixture · ${GOLDEN_WORKTREE_REVISION}`,
    frozenRevision: GOLDEN_WORKTREE_REVISION,
    previous,
    authoring,
  });
}

export function semanticBounds(scene: AtlasScene, entityId: string, detail: SemanticDetail) {
  return scene.projection?.boundsByEntityIdAndDetail[entityId]?.[detail];
}

/**
 * The band a scan-mode "Open inside" must recompile into when the target's deeper
 * scope was scoped OUT of the current scene, or undefined when a plain lens drill
 * suffices. Returns undefined for a leaf (no deeper band), a childless target, or a
 * target whose deeper band is ALREADY laid out — so below the size gate (full
 * compile, every band present) it is always undefined and the drill stays the
 * signature uninterrupted lens zoom (Okie/golden untouched). Pure — reads only the
 * scene's entities + projection bounds, never compiles.
 */
export function scanDrillDeeperDetail(scene: AtlasScene, target: SceneEntity): SemanticDetail | undefined {
  const deeper = bands[bands.indexOf(target.detail ?? 'context') + 1];
  if (!deeper) return undefined;
  if (!scene.entities.some(entity => entity.parentId === target.id)) return undefined;
  return semanticBounds(scene, target.id, deeper) ? undefined : deeper;
}
