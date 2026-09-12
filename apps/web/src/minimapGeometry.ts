import type { AtlasScene, ProjectionOverride, SemanticDetail } from './renderer/types';

export type MinimapRect = { x: number; y: number; width: number; height: number };
export type MinimapEntityRect = { id?: string; detail: SemanticDetail; rect: MinimapRect; opacity?: number };

const sceneEntities = new WeakMap<AtlasScene, Map<string, AtlasScene['entities'][number]>>();
function entityIndex(scene: AtlasScene) {
  let index = sceneEntities.get(scene);
  if (!index) {
    index = new Map(scene.entities.map(entity => [entity.id, entity]));
    sceneEntities.set(scene, index);
  }
  return index;
}

function representationDetail(id?: string): SemanticDetail | undefined {
  const suffix = id?.split(':').at(-1);
  return suffix === 'context' || suffix === 'container' || suffix === 'component' || suffix === 'code' ? suffix : undefined;
}

function interpolate(from: MinimapRect, to: MinimapRect, progress: number): MinimapRect {
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
    width: from.width + (to.width - from.width) * progress,
    height: from.height + (to.height - from.height) * progress,
  };
}

/** World geometry follows Canvas2DRenderer.activeEntities, including semantic boundary morphs. */
export function minimapEntityRects(
  scene: AtlasScene,
  projectionOverride?: ProjectionOverride,
  activeDetail: SemanticDetail = 'context',
  reduceMotion = false,
): MinimapEntityRect[] {
  const projection = scene.projection;
  if (!projection) return scene.entities
    .filter(entity => entity.detail === 'context' || entity.detail === 'container')
    .map(entity => ({ id: entity.id, detail: entity.detail as SemanticDetail,
      rect: { x: entity.x, y: entity.y, width: entity.width, height: entity.height } }));
  const entities = entityIndex(scene);
  const base = projection.entityIdsByDetail[activeDetail].flatMap(id => {
    const rect = projection.boundsByEntityIdAndDetail[id]?.[activeDetail];
    return entities.has(id) && rect ? [{ id, detail: activeDetail, rect }] : [];
  });
  if (!projectionOverride) return base;
  const semanticId = (id: string) => projection.visualToSemanticEntityId[id] ?? id;
  const rawProgress = Math.max(0, Math.min(1, projectionOverride.progress));
  const progress = reduceMotion ? Number(rawProgress >= .5) : rawProgress;
  const bounds = (id: string, representation?: string) => {
    const detail = representationDetail(representation);
    return detail ? projection.boundsByEntityIdAndDetail[id]?.[detail] : undefined;
  };
  const morph = projectionOverride.morph;
  const boundary = morph && projectionOverride.objects.find(object => object.objectId === morph.boundaryObjectId);
  const morphSource = boundary && bounds(semanticId(boundary.objectId), boundary.sourceRepresentationId);
  const morphTarget = boundary && bounds(semanticId(boundary.objectId), boundary.targetRepresentationId);
  const morphCurrent = morphSource && morphTarget && interpolate(morphSource, morphTarget, progress);
  const overridden = new Set(projectionOverride.objects.map(object => semanticId(object.objectId)));
  const projected = projectionOverride.objects.flatMap(object => {
    const id = semanticId(object.objectId);
    if (!entities.has(id)) return [];
    const source = bounds(id, object.sourceRepresentationId);
    const target = bounds(id, object.targetRepresentationId);
    if (!source && !target) return [];
    const sourceOpacity = object.sourceOpacity ?? Number(Boolean(object.sourceRepresentationId));
    const targetOpacity = object.targetOpacity ?? Number(Boolean(object.targetRepresentationId));
    const opacity = sourceOpacity + (targetOpacity - sourceOpacity) * progress;
    if (opacity <= .001) return [];
    let rect = interpolate(source ?? target!, target ?? source!, progress);
    if (morph && morphCurrent && morph.objectIds.includes(object.objectId) && object.objectId !== morph.boundaryObjectId) {
      const basis = target ? morphTarget! : morphSource!;
      const original = target ?? source!;
      const scaleX = basis.width ? morphCurrent.width / basis.width : 1;
      const scaleY = basis.height ? morphCurrent.height / basis.height : 1;
      rect = {
        x: morphCurrent.x + (original.x - basis.x) * scaleX,
        y: morphCurrent.y + (original.y - basis.y) * scaleY,
        width: original.width * scaleX,
        height: original.height * scaleY,
      };
    }
    const detail = representationDetail(progress >= .5 ? object.targetRepresentationId : object.sourceRepresentationId)
      ?? representationDetail(object.targetRepresentationId ?? object.sourceRepresentationId) ?? activeDetail;
    return [{ id, detail, rect, opacity }];
  });
  return [...base.filter(entity => !overridden.has(entity.id)), ...projected];
}

function envelope(rects: MinimapRect[]): MinimapRect | undefined {
  if (!rects.length) return undefined;
  const x = Math.min(...rects.map(rect => rect.x));
  const y = Math.min(...rects.map(rect => rect.y));
  return { x, y,
    width: Math.max(...rects.map(rect => rect.x + rect.width)) - x,
    height: Math.max(...rects.map(rect => rect.y + rect.height)) - y };
}

/** Semantic primary objects share the highest authored pick priority; ghosts and ancestor shells are lower. */
function scopeEnvelope(scene: AtlasScene, projection: ProjectionOverride, detail: SemanticDetail, endpoint: 'source' | 'target') {
  const entries = minimapEntityRects(scene, projection, detail);
  const visibleIds = new Set(entries.map(entry => entry.id));
  const priorities = new Map(projection.objects.map(object => [
    scene.projection?.visualToSemanticEntityId[object.objectId] ?? object.objectId,
    (endpoint === 'source' ? object.sourcePickPriority : object.targetPickPriority) ?? 0,
  ]));
  let primaryPriority = 0;
  for (const [id, priority] of priorities) if (visibleIds.has(id)) primaryPriority = Math.max(primaryPriority, priority);
  // Non-semantic/story overrides need not author ownership priorities and retain their full visible extent.
  const primary = primaryPriority > 0 ? entries.filter(entry => priorities.get(entry.id!) === primaryPriority) : entries;
  return envelope(primary.map(entry => entry.rect));
}

/** Fit only this semantic scope; endpoint interpolation avoids a jump when an incoming object becomes visible. */
export function minimapWorldRect(
  scene: AtlasScene,
  projectionOverride?: ProjectionOverride,
  activeDetail: SemanticDetail = 'context',
  reduceMotion = false,
): MinimapRect | undefined {
  if (!projectionOverride) return envelope(minimapEntityRects(scene, undefined, activeDetail).map(entry => entry.rect));
  const source = scopeEnvelope(scene, { ...projectionOverride, progress: 0 }, activeDetail, 'source');
  const target = scopeEnvelope(scene, { ...projectionOverride, progress: 1 }, activeDetail, 'target');
  if (!source || !target) return source ?? target;
  const progress = Math.max(0, Math.min(1, projectionOverride.progress));
  return interpolate(source, target, reduceMotion ? Number(progress >= .5) : progress);
}
