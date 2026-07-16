export const RENDERER_PROTOCOL_VERSION = 1 as const;

export type Color = readonly [number, number, number, number];

export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  width: number;
  height: number;
}

export interface Stroke {
  color: Color;
  width: number;
}

export interface LodRange {
  minZoom: number;
  maxZoom: number | null;
  fadeWidth: number;
  hysteresis: number;
}

export type Primitive =
  | { kind: "roundedRect"; rect: Rect; radius: number; fill: Color; stroke?: Stroke }
  | { kind: "circle"; center: Point; radius: number; fill: Color; stroke?: Stroke }
  | {
      kind: "text";
      position: Point;
      maxWidth: number;
      content: string;
      fontFamily: string;
      fontSize: number;
      color: Color;
      align: "start" | "center" | "end";
    }
  | { kind: "icon"; position: Point; size: number; name: string; color: Color };

export interface Representation {
  id: string;
  lod: LodRange;
  /** Band-specific culling and hit-test geometry; defaults to the object bounds. */
  bounds?: Rect;
  primitives: Primitive[];
}

export interface SceneObject {
  id: string;
  parentId?: string;
  zIndex: number;
  bounds: Rect;
  pickable: boolean;
  representations: Representation[];
}

export interface ScenePath {
  id: string;
  fromObjectId: string;
  toObjectId: string;
  points: Point[];
  stroke: Color;
  width: number;
  arrow: "none" | "end" | "both";
  optional: boolean;
  pickable: boolean;
  lod: LodRange;
}

export interface SceneSnapshot {
  protocolVersion: typeof RENDERER_PROTOCOL_VERSION;
  sceneId: string;
  revision: number;
  worldBounds: Rect;
  objects: SceneObject[];
  paths: ScenePath[];
}

export interface ScenePatch {
  protocolVersion: typeof RENDERER_PROTOCOL_VERSION;
  sceneId: string;
  baseRevision: number;
  revision: number;
  worldBounds?: Rect;
  upsertObjects: SceneObject[];
  removeObjectIds: string[];
  upsertPaths: ScenePath[];
  removePathIds: string[];
  transition?: { durationMs: number; easing: Easing };
}

export type Easing = "linear" | "easeInOut" | "easeOut";

export interface TimelineObjectState {
  objectIds: string[];
  opacity: number;
  emphasis: number;
}

export interface TimelinePathState {
  pathIds: string[];
  opacity: number;
  emphasis: number;
  flowSpeed: number;
  color?: Color;
}

export interface TimelineKeyframe {
  id: string;
  atMs: number;
  easing: Easing;
  camera?: { center: Point; zoom: number };
  objectStates: TimelineObjectState[];
  pathStates: TimelinePathState[];
}

export interface Timeline {
  protocolVersion: typeof RENDERER_PROTOCOL_VERSION;
  timelineVersion: 2;
  id: string;
  sceneId: string;
  durationMs: number;
  looped: boolean;
  keyframes: TimelineKeyframe[];
}
