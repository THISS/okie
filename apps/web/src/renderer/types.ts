export type EntityKind = 'person' | 'system' | 'container' | 'component' | 'store' | 'queue';

export type SemanticDetail = 'context' | 'container' | 'component' | 'code';

export type SceneSourceRef = {
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  revision: string;
};

export type SceneSourceExcerpt = {
  path: string;
  symbol?: string;
  language: 'typescript' | 'tsx' | 'javascript' | 'rust' | 'json' | 'markdown' | 'text';
  startLine: number;
  endLine: number;
  highlightLine: number;
  frozenRevision: string;
  lines: string[];
  text: string;
};

export type SceneEntity = {
  id: string;
  parentId?: string;
  name: string;
  kind: EntityKind;
  kindLabel?: string;
  detail?: SemanticDetail;
  responsibility: string;
  technology?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number;
  source?: string;
  sourceRefs?: SceneSourceRef[];
  sourceExcerpts?: SceneSourceExcerpt[];
  tags?: string[];
};

export type SceneRelation = {
  id: string;
  from: string;
  to: string;
  arrow?: 'none' | 'end' | 'both';
  /** Canonical band-specific world-space polyline, copied from the compiled projection route. */
  routePoints?: Array<{ x: number; y: number }>;
  label?: string;
  kindLabel?: string;
  semanticIds?: string[];
  protocol?: string;
};

export type SceneRegion = {
  id: string;
  name: string;
  showLabel?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type AtlasScene = {
  id: string;
  title: string;
  subtitle: string;
  entities: SceneEntity[];
  relations: SceneRelation[];
  regions: SceneRegion[];
  /** Precompiled protocol payloads (for example stress fixtures) pass through to WASM unchanged. */
  protocolSnapshot?: unknown;
  /** Optional stable-ID patch used when an explicit drill changes the projection family. */
  protocolPatch?: unknown;
  rootEntityId?: string;
  frozenRevision?: string;
  projection?: {
    /** Compiler projection-family identifier used to scope durable route intent. */
    familyId?: string;
    semanticToVisualEntityId: Record<string, string>;
    visualToSemanticEntityId: Record<string, string>;
    semanticToVisualRelationIds: Record<string, string[]>;
    visualToSemanticRelationIds: Record<string, string[]>;
    boundsByEntityIdAndDetail: Record<string, Partial<Record<SemanticDetail, { x: number; y: number; width: number; height: number }>>>;
    entityIdsByDetail: Record<SemanticDetail, string[]>;
    relationIdsByDetail: Record<SemanticDetail, string[]>;
    projectedRelationsByDetail: Record<SemanticDetail, SceneRelation[]>;
    zoomPolicy?: {
      minZoom: number;
      maxZoom: number;
      bands: Array<{
        detail: SemanticDetail;
        enterZoom: number;
        exitZoom: number | null;
        focusZoom: number;
        fadeWidth: number;
        hysteresis: number;
      }>;
    };
    semanticTransitionsByEntityId?: Record<string, Partial<Record<Exclude<SemanticDetail, 'context'>, {
      currentDetail: SemanticDetail;
      nextDetail: Exclude<SemanticDetail, 'context'>;
      sourceRepresentationId: string;
      targetRepresentationId: string;
      enterCoverage: { major: number; minor: number };
      commitCoverage: { major: number; minor: number };
      fullCoverage: { major: number; minor: number };
      leaveCoverage: { major: number; minor: number };
      minimumCssSize: { width: number; height: number };
      minZoom: number;
      /** Authored camera zoom where the incoming representation owns the branch completely. */
      fullZoom: number;
      hysteresis: number;
      transitionMs: number;
      dwellMs: number;
      pointerInsetPx: number;
    }>>>;
  };
};

export type Camera = {
  x: number;
  y: number;
  zoom: number;
};

export type RenderState = {
  selectedId?: string;
  focusedIds: Set<string>;
  /** Temporary endpoint emphasis for a selected/route-edited relation; not semantic-lens ownership. */
  relationFocusIds?: Set<string>;
  activeRelationIds: Set<string>;
  /** Semantic relationships that receive animated flow particles independently of emphasis. */
  flowRelationIds: Set<string>;
  reduceMotion: boolean;
  animate: boolean;
  visibilityMode: 'all' | 'dim' | 'isolate';
  projectionOverride?: ProjectionOverride;
  cinematicTransition?: {
    id: string;
    positionMs: number;
    durationMs: number;
    visualProgress: number;
    departureProgress: number;
    sourceFocusedIds: readonly string[];
    targetFocusedIds: readonly string[];
    sourceRelationIds: readonly string[];
    targetRelationIds: readonly string[];
  };
};

export type ProjectionOverride = {
  id: string;
  progress: number;
  objects: ProjectionObjectOverride[];
  paths: ProjectionPathOverride[];
  morph?: ProjectionMorphOverride;
};

export type ProjectionObjectOverride = {
  objectId: string;
  sourceRepresentationId?: string;
  targetRepresentationId?: string;
  /** Projection-local opacity, independent of story/selection visibility. */
  sourceOpacity?: number;
  targetOpacity?: number;
  /** Text/icon content weight. Defaults to the matching object opacity. */
  sourceContentOpacity?: number;
  targetContentOpacity?: number;
  /** Projection-local hit policy. Ghost context can remain visible without stealing ancestor picks. */
  sourcePickable?: boolean;
  targetPickable?: boolean;
  /** Higher values win overlapping projection-local picks. */
  sourcePickPriority?: number;
  targetPickPriority?: number;
};

export type ProjectionPathOverride = {
  pathId: string;
  sourceOpacity: number;
  targetOpacity: number;
};

export type ProjectionMorphOverride = {
  boundaryObjectId: string;
  objectIds: string[];
  pathIds: string[];
};

export type VisibleSceneState = {
  objectIds: string[];
  relationIds: string[];
};

export type RendererLodState = {
  objectId: string;
  current: string;
  previous?: string;
  progress: number;
  currentWeight: number;
  previousWeight: number;
  transitioning: boolean;
  durationMs: number;
};

export type RendererDiagnostics = {
  requestedBackend: string;
  activeBackend: string;
  gpuAccelerated: boolean;
  entityCount: number;
  relationCount: number;
  lastFrameMs: number;
  message: string;
  visibleEntities?: number;
  visibleRelations?: number;
  candidateEntities?: number;
  candidateRelations?: number;
  culledEntities?: number;
  culledRelations?: number;
  drawCalls?: number;
  meshRebuilt?: boolean;
  meshBuildMs?: number;
  geometryUploadBytes?: number;
  geometryBufferUploads?: number;
  glyphQuads?: number;
  deferredTextPrimitives?: number;
  deferredIconPrimitives?: number;
  frameP50Ms?: number;
  frameP95Ms?: number;
  frameP99Ms?: number;
  frameSampleCount?: number;
  totalFrameCount?: number;
  frameWindowIncludesInitialBuild?: boolean;
  staticMeshRevision?: number;
  staticGeometryUploadBytes?: number;
  staticGeometryBufferUploads?: number;
  cumulativeStaticGeometryUploadBytes?: number;
  cumulativeStaticGeometryBufferUploads?: number;
  dynamicIndexUploadBytes?: number;
  dynamicIndexBufferUploads?: number;
  cumulativeDynamicIndexUploadBytes?: number;
  cumulativeDynamicIndexBufferUploads?: number;
  dynamicStyleUploadBytes?: number;
  dynamicStyleBufferUploads?: number;
  cumulativeDynamicStyleUploadBytes?: number;
  cumulativeDynamicStyleBufferUploads?: number;
  flowUploadBytes?: number;
  cumulativeFlowUploadBytes?: number;
  uniformUploadBytes?: number;
  cumulativeUniformUploadBytes?: number;
  lodUniformUploadBytes?: number;
  cumulativeLodUniformUploadBytes?: number;
  residentPartitionTotal?: number;
  residentPartitionActive?: number;
  residentPartitionDrawn?: number;
  residentObjectCount?: number;
  residentPathCount?: number;
  partitionCacheHits?: number;
  partitionCacheMisses?: number;
  partitionCacheEvictions?: number;
  drawRangeCount?: number;
};

export type PickResult =
  | { kind: 'entity'; id: string }
  | { kind: 'relation'; id: string };

export interface AtlasRenderer {
  readonly kind: string;
  setScene(scene: AtlasScene): void;
  setCamera(camera: Camera): void;
  setRenderState(state: RenderState): void;
  resize(width: number, height: number, devicePixelRatio: number): void;
  render(timeMs: number): void;
  pick(screenX: number, screenY: number): PickResult | undefined;
  visibleScene(): VisibleSceneState;
  lodState(): RendererLodState | undefined;
  diagnostics(): RendererDiagnostics;
  dispose(): void;
}
