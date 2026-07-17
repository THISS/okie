import {
  type ArchitectureSnapshot,
  type ArchitectureStory,
  type ArchitectureView,
  validateStory,
} from "@okie/architecture";
import type { Rect, SceneSnapshot, Timeline } from "./protocol.js";
import { RENDERER_PROTOCOL_VERSION } from "./protocol.js";
import { defaultTheme } from "./theme.js";

export interface CompileStoryOptions {
  viewportWidth?: number;
  viewportHeight?: number;
  padding?: number;
  defaultStepDurationMs?: number;
  maximumZoom?: number;
  arrivalSettleMs?: number;
}

type StoryCamera = { center: { x: number; y: number }; zoom: number };

const maximumFlightMs = 1_100;
const minimumNarrationHoldMs = 4_200;
export const maximumNarrationHoldMs = 12_000; // Mirror of STORY_AUTHORING_LIMITS.maxStepDurationMs (@okie/architecture); keep in sync.

function narrationHoldDurationMs(narration: string): number {
  const words = narration.trim() ? narration.trim().split(/\s+/u).length : 0;
  const readingTimeMs = Math.round(1_200 + words / 3 * 1_000);
  return Math.max(minimumNarrationHoldMs, Math.min(maximumNarrationHoldMs, readingTimeMs));
}

function validateOptions(options: CompileStoryOptions): void {
  const positiveFinite = (value: number | undefined, name: string): void => {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`${name} must be finite and greater than 0`);
  };
  positiveFinite(options.viewportWidth, "viewportWidth");
  positiveFinite(options.viewportHeight, "viewportHeight");
  positiveFinite(options.maximumZoom, "maximumZoom");
  if (options.padding !== undefined && (!Number.isFinite(options.padding) || options.padding < 0)) {
    throw new Error("padding must be finite and non-negative");
  }
  if (
    options.defaultStepDurationMs !== undefined &&
    (!Number.isSafeInteger(options.defaultStepDurationMs) || options.defaultStepDurationMs <= 0)
  ) {
    throw new Error("defaultStepDurationMs must be a finite positive integer");
  }
  if (
    options.arrivalSettleMs !== undefined &&
    (!Number.isSafeInteger(options.arrivalSettleMs) || options.arrivalSettleMs < 0)
  ) {
    throw new Error("arrivalSettleMs must be a finite non-negative integer");
  }
}

function focusBounds(scene: SceneSnapshot, ids: readonly string[]): Rect {
  const byId = new Map(scene.objects.map((object) => [object.id, object]));
  const bounds = ids.map((id) => byId.get(id)?.bounds).filter((rect): rect is Rect => rect !== undefined);
  if (!bounds.length) throw new Error("A story step must focus at least one scene object");
  const left = Math.min(...bounds.map((rect) => rect.x));
  const top = Math.min(...bounds.map((rect) => rect.y));
  const right = Math.max(...bounds.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...bounds.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function flightDurationMs(source: StoryCamera, target: StoryCamera, width: number, height: number): number {
  const anchorDistance = Math.hypot(target.center.x - source.center.x, target.center.y - source.center.y) * target.zoom;
  if (anchorDistance <= 0.5 && Math.abs(target.zoom - source.zoom) <= 0.001) return 0;
  const diagonal = Math.max(1, Math.hypot(width, height));
  const travel = Math.hypot(target.center.x - source.center.x, target.center.y - source.center.y)
    * Math.min(source.zoom, target.zoom) / diagonal;
  const zoomStops = Math.abs(Math.log2(target.zoom / source.zoom));
  return Math.max(480, Math.min(
    maximumFlightMs,
    Math.round(520 + 180 * Math.min(2, travel) + 140 * Math.min(2, zoomStops)),
  ));
}

export function compileStory(
  snapshot: ArchitectureSnapshot,
  view: ArchitectureView,
  story: ArchitectureStory,
  scene: SceneSnapshot,
  options: CompileStoryOptions = {},
): Timeline {
  validateOptions(options);
  const issues = validateStory(snapshot, view, story);
  if (issues.length) throw new Error(`Cannot compile invalid story: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);

  const viewportWidth = options.viewportWidth ?? 1280;
  const viewportHeight = options.viewportHeight ?? 720;
  const padding = options.padding ?? 100;
  const maximumZoom = options.maximumZoom ?? 6;
  const arrivalSettleMs = options.arrivalSettleMs ?? 150;
  let atMs = 0;
  const world = scene.worldBounds;
  let previousCamera: StoryCamera = {
    center: { x: world.x + world.width / 2, y: world.y + world.height / 2 },
    zoom: Math.min(
      maximumZoom,
      viewportWidth / Math.max(1, world.width + padding * 2),
      viewportHeight / Math.max(1, world.height + padding * 2),
    ),
  };
  const keyframes = story.steps.flatMap((step) => {
    const bounds = focusBounds(scene, step.focusEntityIds);
    const holdDurationMs = step.durationMs ?? options.defaultStepDurationMs ?? narrationHoldDurationMs(step.narration);
    const zoom = Math.min(
      maximumZoom,
      viewportWidth / (bounds.width + padding * 2),
      viewportHeight / (bounds.height + padding * 2),
    );
    const camera: StoryCamera = {
      center: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 },
      zoom,
    };
    const transitionDurationMs = flightDurationMs(previousCamera, camera, viewportWidth, viewportHeight);
    atMs += transitionDurationMs;
    const objectStates = [{ objectIds: [...step.focusEntityIds].sort(), opacity: 1, emphasis: 1 }];
    const pathStates = step.traceRelationIds?.length
      ? [
          {
            pathIds: [...step.traceRelationIds].sort(),
            opacity: 1,
            color: defaultTheme.selection,
            flowSpeed: 0,
            emphasis: 1,
          },
        ]
      : [];
    const arrival = {
      id: `${step.id}:arrival`,
      atMs,
      easing: "easeInOut" as const,
      camera,
      objectStates,
      pathStates,
    };
    atMs += arrivalSettleMs + holdDurationMs;
    const hold = {
      id: `${step.id}:hold`,
      atMs,
      easing: "linear" as const,
      camera,
      objectStates,
      pathStates: pathStates.map(state => ({ ...state, flowSpeed: 1 })),
    };
    previousCamera = camera;
    return [arrival, hold];
  });

  return {
    protocolVersion: RENDERER_PROTOCOL_VERSION,
    timelineVersion: 2,
    id: `timeline:${story.id}`,
    sceneId: scene.sceneId,
    durationMs: atMs,
    looped: false,
    keyframes,
  };
}
