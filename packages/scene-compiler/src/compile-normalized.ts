import {
  type NormalizedArchitecture,
  selectArchitectureSnapshot,
  selectArchitectureStory,
  selectArchitectureView,
  selectScopedView,
} from '@okie/architecture';
import { compileScene, type CompileSceneOptions } from './compile-scene.js';
import { compileStory, type CompileStoryOptions } from './compile-story.js';
import {
  RENDERER_PROTOCOL_VERSION,
  type Easing,
  type Rect,
  type SceneObject,
  type ScenePatch,
  type ScenePath,
  type SceneSnapshot,
  type Timeline,
} from './protocol.js';

export type CompileNormalizedSceneOptions = CompileSceneOptions & {
  rootEntityId?: string;
};

export type CompileNormalizedPatchOptions = Omit<CompileNormalizedSceneOptions, 'sceneId' | 'revision'> & {
  revision: number;
  transition?: { durationMs: number; easing: Easing };
};

function equalValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function compileNormalizedScene(
  state: NormalizedArchitecture,
  viewId: string,
  options: CompileNormalizedSceneOptions = {},
): SceneSnapshot {
  const view = options.rootEntityId
    ? selectScopedView(state, viewId, options.rootEntityId)
    : selectArchitectureView(state, viewId);
  const snapshot = selectArchitectureSnapshot(state, view.snapshotId);
  const { rootEntityId: _rootEntityId, ...sceneOptions } = options;
  return compileScene(snapshot, view, sceneOptions);
}

export function compileNormalizedTimeline(
  state: NormalizedArchitecture,
  storyId: string,
  scene: SceneSnapshot,
  options: CompileStoryOptions = {},
): Timeline {
  const story = selectArchitectureStory(state, storyId);
  const snapshot = selectArchitectureSnapshot(state, story.snapshotId);
  const view = selectArchitectureView(state, story.viewId);
  return compileStory(snapshot, view, story, scene, options);
}

export function diffSceneSnapshots(
  current: SceneSnapshot,
  target: SceneSnapshot,
  transition?: { durationMs: number; easing: Easing },
): ScenePatch {
  if (current.sceneId !== target.sceneId) throw new Error('Cannot diff snapshots from different scenes');
  if (target.revision <= current.revision) throw new Error('Target scene revision must be greater than the current revision');

  const currentObjects = new Map(current.objects.map(object => [object.id, object]));
  const currentPaths = new Map(current.paths.map(path => [path.id, path]));
  const targetObjectIds = new Set(target.objects.map(object => object.id));
  const targetPathIds = new Set(target.paths.map(path => path.id));
  const upsertObjects: SceneObject[] = target.objects.filter(object => !equalValue(currentObjects.get(object.id), object));
  const upsertPaths: ScenePath[] = target.paths.filter(path => !equalValue(currentPaths.get(path.id), path));

  return {
    protocolVersion: RENDERER_PROTOCOL_VERSION,
    sceneId: current.sceneId,
    baseRevision: current.revision,
    revision: target.revision,
    upsertObjects,
    removeObjectIds: current.objects.map(object => object.id).filter(id => !targetObjectIds.has(id)).sort(),
    upsertPaths,
    removePathIds: current.paths.map(path => path.id).filter(id => !targetPathIds.has(id)).sort(),
    ...(!equalValue(current.worldBounds, target.worldBounds) ? { worldBounds: { ...target.worldBounds } satisfies Rect } : {}),
    ...(transition ? { transition: { ...transition } } : {}),
  };
}

export function compileNormalizedPatch(
  state: NormalizedArchitecture,
  viewId: string,
  current: SceneSnapshot,
  options: CompileNormalizedPatchOptions,
): ScenePatch {
  const { transition, revision, ...sceneOptions } = options;
  const target = compileNormalizedScene(state, viewId, {
    ...sceneOptions,
    sceneId: current.sceneId,
    revision,
  });
  return diffSceneSnapshots(current, target, transition);
}
