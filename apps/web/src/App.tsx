import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  applyArchitectureAuthoringCommand,
  buildC4ProjectionBundle,
  createArchitectureAuthoringDocument,
  relationRouteOverrideId,
  validateC4NotationCompleteness,
  type ArchitectureStory,
  type ArchitectureAuthoringCommand,
  type ArchitectureAuthoringDocument,
  type RelationRouteOverride,
} from '@okie/architecture';
import {
  compileC4DynamicFlowArtifact,
  goldenSnapshot,
  goldenView,
  serializeDynamicFlowMermaid,
} from '@okie/scene-compiler';
import {
  ActivityIcon, ArrowIcon, CheckIcon, ChevronIcon, CloseIcon, CodeIcon, FileIcon, FitIcon,
  ImageIcon, InfoIcon, LayersIcon, PanelIcon, PauseIcon, PlayIcon, RestartIcon, SearchIcon, ShareIcon,
  SparkIcon, ZoomInIcon, ZoomOutIcon,
} from './icons';
import { captureSceneBlob, downloadBlob, screenshotFilename } from './renderer/sceneScreenshot';
import { Minimap } from './minimap';
import { publishLiveCamera } from './liveCameraBridge';
import { copyViewLink } from './diagram/copyViewLink';
import {
  MAIN_DIAGRAM_SURFACE_ID,
  activateDiagramSurface,
  closeDiagramSurface,
  createDiagramWorkspace,
  diagramWorkspaceSurfaces,
  openDerivedDiagramSurface,
  updateDiagramSurfaceSession,
  type DerivedDiagramKind,
  type DiagramSurface,
  type DiagramSurfaceSession,
  type DerivedDiagramSurface,
} from './diagram/diagramWorkspace';
import { SemanticDiagramSurface } from './diagram/SemanticDiagramSurface';
import { createNavigationHistoryController, type NavigationHistoryController } from './navigation/historyController';
import {
  canonicalNavigationState,
  navigationStateFromUrl,
  serializeNavigationState,
  type NavigationDefaults,
  type NavigationState,
  type SemanticDetail,
} from './navigation/navigationState';
import { createGoldenC4Scene, goldenAppStory, scanDrillDeeperDetail, semanticBounds, type AppStoryPlanStep } from './renderer/goldenC4Scene';
import { getActiveScanFixture } from './renderer/fixtureBundle';
import { createRenderer, recoverRenderer, type RendererSession } from './renderer/createRenderer';
import { createCameraPublisher, panCamera, shouldAdoptExternalCameraAsRaw, zoomCameraAt, type CameraPublisher } from './renderer/cameraController';
import {
  ATLAS_CAMERA_BOUNDS,
  clampAtlasCameraZoom,
  semanticLevelAtZoom,
} from './renderer/cameraBounds';
import { createDemandFrameScheduler, type DemandFrameScheduler } from './renderer/demandFrameScheduler';
import { listenForWebGlContextLoss } from './renderer/gpuLoss';
import { listenForWheel } from './renderer/wheelInput';
import { presentBackend } from './renderer/backendPresentation';
import { presentClaimProvenance } from './provenance/presentation';
import { selectedProjectedRelationForFocus, selectedRelationFocusPresentation } from './relations/relationFocus';
import { SourceViewer, type LocalWorkspaceContext } from './diagram/SourceViewer';
import { clampInspectorWidth, defaultInspectorWidth, inspectorTabForEntity, inspectorWidthRange, inspectorWidthStorageKey, selectedEntityReframePlan, selectedRelationPresentation, visibleSemanticRelationsForEntity } from './inspector/inspectorSupport';
import { inspectorHistoryRestorePlan, popInspectorHistory, pushInspectorHistory, type InspectorHistorySubject } from './inspector/inspectorHistory';
import { readDemoQuery } from './renderer/query';
import { loadStressFixture } from './renderer/stressFixture';
import type { AtlasRenderer, AtlasScene, Camera, PickResult, RendererDiagnostics, RendererLodState, SceneEntity, SceneRelation } from './renderer/types';
import type { ProjectionOverride } from './renderer/types';
import {
  composeSemanticZoomCamera, type SemanticZoomFraming,
  containSemanticOwnerCamera,
  advanceSemanticLensFocusTransfer,
  findSemanticLensTarget,
  idleSemanticLens,
  idleSemanticLensSession,
  interpolateSemanticOwnerBounds,
  measureSemanticLensTarget,
  reduceSemanticLensSession,
  semanticLensBranchEntityIds,
  semanticLensCanonicalPathIds,
  semanticLensSessionDetail,
  semanticLensSessionPresentationState,
  semanticLensSessionProjectionOverride,
  semanticLensSessionVisibleEntityIds,
  semanticLensSessionVisibleRelationIds,
  stabilizeSemanticLensSessionForPan,
  validateSemanticLensPath,
  type LensPoint,
  type SemanticLensSession,
  type SemanticLensState,
} from './semantic/semanticLens';
import { defaultSearchSuggestions } from './searchSuggestions';
import { shouldOpenAskAtlas, shouldToggleDevMode } from './shortcuts';
import { relationshipFlowPolicy } from './relations/relationshipFlow';
import { canvasAnimationPolicy, type CanvasPointerInteraction } from './canvasAnimationPolicy';
import { createCameraFlightController, reconcileRenderedCamera, type CameraFlightController, type CameraFlightSample } from './cameraFlightController';
import { storyFocusPresentation } from './storyFocus';
import { RelationshipAuthoringOverlay } from './editor/RelationshipAuthoringOverlay';
import { commitGesture, createGestureHistory, redoGesture, undoGesture, type GestureHistory } from './editor/gestureHistory';
import {
  automaticRelationshipRoute,
  attachOrthogonalRouteEndpoints,
  authoringBoundsForDetail,
  closestSegmentHandle,
  connectionPortPoint,
  nearestConnectionPort,
  previewOrthogonalSegmentGuide,
  relationshipRouteGeometryForScene,
  routeIsObstacleSafe,
  routingObstaclesForEndpoints,
  screenToWorld,
  worldToScreen,
  type AuthoringPoint,
  type ConnectionPort,
  type GuidedRelationshipRouteIntent,
  type GuidedRoutePreview,
  type RelationshipRouteGeometry,
} from './editor/relationshipInteraction';
import { frameEntities, frameSemanticEntities, measuredStorySafeArea, storySafeArea, type SafeArea, type ViewportSize } from './storyFraming';
import {
  compensateSemanticInspectorFlightCamera,
  frameProjectionScope,
  levels,
  retargetCameraForSemanticBand,
  scopeFitsSafeViewport,
  semanticDetails,
  semanticInspectorFlightKind,
  semanticInspectorFlightProgress,
  semanticInspectorFlightSession,
  semanticInspectorHierarchyPlan,
  semanticInspectorRawCameraTarget,
  semanticLevelSession,
  semanticOpenNextLayer,
  semanticPanFocusPlan,
  semanticSourceSession,
  type SemanticInspectorFlightKind,
} from './semantic/semanticLensEngine';
import {
  STORY_ARRIVAL_SETTLE_MS,
  STORY_MAX_FLIGHT_DURATION_MS,
  createStoryFlight,
  cumulativeStoryStepOffsets,
  decodeStoryCinematicPosition,
  estimateStoryDuration,
  formatStoryDuration,
  resolveStoryHoldDuration,
  resumeStoryFlight,
  sampleStoryFlight,
  storyCinematicPosition,
  type StoryFlight,
  type StoryFlightSample,
} from './storyPlayback';

// A scanned snapshot (fixture=scan) is fetched, validated and compiled before App
// is imported (see main.tsx); when present it drives the app through the same
// slots as the golden fixture. Undefined for the golden/stress fixtures.
const scanFixture = getActiveScanFixture();
const activeSnapshot = scanFixture?.snapshot ?? goldenSnapshot;
const activeView = scanFixture?.view ?? goldenView;
const story = scanFixture?.story ?? goldenAppStory;

// Recompiles the active fixture for a new focus/root (drill-in, restore). Scanned
// snapshots are read-only in R1, so the dev-mode authoring overlay stays golden-only.
function activeCreateScene(focusEntityId: string, previous?: AtlasScene, authoring?: ArchitectureAuthoringDocument): AtlasScene {
  return scanFixture
    ? scanFixture.createScene(focusEntityId, previous)
    : createGoldenC4Scene(focusEntityId, previous, authoring);
}

const defaultCamera: Camera = { x: 1_080, y: 375, zoom: levels[0]!.zoom };
const storyId = story.id;
const configuredRepositoryRoot = import.meta.env.VITE_OKIE_REPOSITORY_ROOT?.trim() || undefined;

function diagramTabDomId(surfaceId: string) {
  return `diagram-tab-${surfaceId.replace(/[^a-z0-9_-]+/gi, '-')}`;
}

const preservedNavigationParams = ['backend', 'fixture', 'seed'] as const;

const storyHoldDurations = story.steps.map(step => resolveStoryHoldDuration(step.narration, step.authoredHoldMs));
const storyStepOffsets = cumulativeStoryStepOffsets(storyHoldDurations);
const storyDurationLabel = formatStoryDuration(estimateStoryDuration(storyHoldDurations));

function storyStepDuration(step: number) {
  const bounded = Math.max(0, Math.min(story.steps.length - 1, step));
  return storyHoldDurations[bounded];
}

function storyStepOffset(step: number) {
  const bounded = Math.max(0, Math.min(story.steps.length - 1, step));
  return storyStepOffsets[bounded];
}

function encodeStoryPosition(
  step: number,
  phase: 'flight' | 'arrival' | 'hold',
  elapsedMs: number,
  flightDurationMs = STORY_MAX_FLIGHT_DURATION_MS,
) {
  return storyCinematicPosition(
    step,
    phase,
    elapsedMs,
    flightDurationMs,
    storyStepDuration(step),
    storyStepOffset(step),
  );
}

function decodeStoryPosition(step: number, positionMs: number) {
  return decodeStoryCinematicPosition(step, positionMs, storyStepDuration(step), storyStepOffset(step));
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function getLevel(zoom: number, previous?: number) {
  return semanticLevelAtZoom(zoom, previous);
}

function summarizeIds(ids: readonly string[], maximumInlineIds = 48) {
  let hash = 2_166_136_261;
  for (const id of ids) {
    for (let index = 0; index < id.length; index += 1) {
      hash = Math.imul(hash ^ id.charCodeAt(index), 16_777_619) >>> 0;
    }
    hash = Math.imul(hash ^ 31, 16_777_619) >>> 0;
  }
  return ids.length <= maximumInlineIds
    ? { count: ids.length, hash: hash.toString(16).padStart(8, '0'), ids }
    : { count: ids.length, hash: hash.toString(16).padStart(8, '0'), sample: ids.slice(0, 8) };
}

function stressLoadingScene(): AtlasScene {
  return {
    id: 'stress-loading',
    title: 'Loading stress fixture…',
    subtitle: 'deterministic · lazy renderer payload',
    entities: [{ id: 'stress-loading', name: 'Preparing 5k scene', kind: 'system', responsibility: 'Loading the generated renderer stress fixture', x: -110, y: -65, width: 220, height: 130, confidence: 1 }],
    relations: [],
    regions: [],
  };
}

function browserSafeAreaInsets(): SafeArea {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;pointer-events:none;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const insets = {
    top: Number.parseFloat(style.paddingTop) || 0,
    right: Number.parseFloat(style.paddingRight) || 0,
    bottom: Number.parseFloat(style.paddingBottom) || 0,
    left: Number.parseFloat(style.paddingLeft) || 0,
  };
  probe.remove();
  return insets;
}

type StoryPhase = 'idle' | 'flight' | 'arrival' | 'hold' | 'paused' | 'interrupted';
type StoryCanonicalPhase = 'flight' | 'arrival' | 'hold';
type ActiveStoryFlight = {
  id: string;
  step: number;
  flight: StoryFlight;
  sourceFocusedIds: string[];
  targetFocusedIds: string[];
  sourceRelationIds: string[];
  targetRelationIds: string[];
  sourceSession: SemanticLensSession;
  targetSession: SemanticLensSession;
  playAfterArrival: boolean;
};

type PendingInspectorCameraFlight = {
  sourceSession: SemanticLensSession;
  targetSession: SemanticLensSession;
  targetId: string;
  kind: SemanticInspectorFlightKind;
  semanticProgress: number;
  navigation: NavigationState;
  historyMode: 'replace';
};

type CanvasViewportProps = {
  scene: AtlasScene;
  camera: Camera;
  setCamera: (updater: (camera: Camera) => Camera) => void;
  selectedId?: string;
  onPick: (result: PickResult) => void;
  onOpenInside: (entityId: string) => void;
  focusedIds: Set<string>;
  relationFocusIds: Set<string>;
  activeRelationIds: Set<string>;
  flowRelationIds: Set<string>;
  requestedBackend: string;
  reduceMotion: boolean;
  animationActive: boolean;
  onDiagnostics: (diagnostics: RendererDiagnostics) => void;
  onViewportChange: (viewport: ViewportSize) => void;
  onCameraSettled: (camera: Camera) => void;
  onNavigationFlush: (camera: Camera) => void;
  onInteractionStart: (reason: string, camera: Camera) => void;
  onCameraFlightCancel: () => void;
  onLensCancel: (reason: string, camera: Camera) => void;
  onLensPan: (camera: Camera) => void;
  onSemanticZoomBurstStart: (camera: Camera) => Camera;
  onLodState: (state: RendererLodState | undefined) => void;
  visibilityMode: 'all' | 'dim' | 'isolate';
  flowActive: boolean;
  projectionOverride?: ProjectionOverride;
  onSemanticZoom: (sample: { camera: Camera; renderedCamera?: Camera; pointer: LensPoint; direction: 'inward' | 'outward' | 'none'; gestureSettled: boolean; mobile: boolean; gestureStartZoom?: number }) => Camera;
  cinematicTransition?: NonNullable<import('./renderer/types').RenderState['cinematicTransition']>;
  authoringTool: 'select' | 'connect';
  authoringEnabled: boolean;
  authoringDetail: SemanticDetail;
  authoringEntityIds: ReadonlySet<string>;
  selectedRelationId?: string;
  onCreateRelationship: (gesture: {
    from: string;
    to: string;
    sourcePort: ConnectionPort;
    targetPort: ConnectionPort;
    routePoints: AuthoringPoint[];
  }) => void;
  onGuideRelationship: (gesture: {
    relationId: string;
    visualRelationId: string;
    detail: SemanticDetail;
    intent: GuidedRelationshipRouteIntent;
  }) => void;
};

function CanvasViewport({ scene, camera, setCamera, selectedId, onPick, onOpenInside, focusedIds, relationFocusIds, activeRelationIds, flowRelationIds, requestedBackend, reduceMotion, animationActive, flowActive, projectionOverride, onSemanticZoom, cinematicTransition, onDiagnostics, onViewportChange, onCameraSettled, onNavigationFlush, onInteractionStart, onCameraFlightCancel, onLensCancel, onLensPan, onSemanticZoomBurstStart, onLodState, visibilityMode, authoringTool, authoringEnabled, authoringDetail, authoringEntityIds, selectedRelationId, onCreateRelationship, onGuideRelationship }: CanvasViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<AtlasRenderer | undefined>(undefined);
  const liveCameraRef = useRef(camera);
  const rawCameraRef = useRef(camera);
  const stateRef = useRef({ scene, selectedId, focusedIds, relationFocusIds, activeRelationIds, flowRelationIds, reduceMotion, animationActive, flowActive, projectionOverride, cinematicTransition, visibilityMode });
  const pointerRef = useRef<{ id: number; startX: number; startY: number; x: number; y: number; moved: boolean } | undefined>(undefined);
  const authoringPointerRef = useRef<
    | { kind: 'connection'; id: number; from: string; sourcePort: ConnectionPort }
    | { kind: 'guide'; id: number; relationId: string; visualRelationId: string; detail: SemanticDetail; segmentIndex: number; originalPoints: AuthoringPoint[]; from: string; to: string; routing: RelationshipRouteGeometry }
    | undefined
  >(undefined);
  const touchPointersRef = useRef(new Map<number, LensPoint>());
  const pinchRef = useRef<{ distance: number; centroid: LensPoint; startZoom: number; moved: boolean } | undefined>(undefined);
  const pinchSettleTimerRef = useRef<number | undefined>(undefined);
  const panSettleTimerRef = useRef<number | undefined>(undefined);
  const semanticAssistRafRef = useRef<number | undefined>(undefined);
  const semanticAssistUntilRef = useRef(0);
  const semanticAssistSampleRef = useRef<{ pointer: LensPoint; mobile: boolean; gestureStartZoom?: number } | undefined>(undefined);
  const semanticZoomBurstActiveRef = useRef(false);
  const sizeRef = useRef({ width: 1, height: 1 });
  const [overlaySize, setOverlaySize] = useState({ width: 1, height: 1 });
  const [hoveredPick, setHoveredPick] = useState<PickResult>();
  const [connectionDraft, setConnectionDraft] = useState<{
    from: string;
    sourcePort: ConnectionPort;
    to?: string;
    targetPort?: ConnectionPort;
    points: AuthoringPoint[];
    safe: boolean;
  }>();
  const [guideDraft, setGuideDraft] = useState<(GuidedRoutePreview & { relationId: string; segmentIndex: number })>();
  const connectionDraftRef = useRef(connectionDraft);
  const guideDraftRef = useRef(guideDraft);
  const updateConnectionDraft = (next: typeof connectionDraft) => {
    connectionDraftRef.current = next;
    setConnectionDraft(next);
  };
  const updateGuideDraft = (next: typeof guideDraft) => {
    guideDraftRef.current = next;
    setGuideDraft(next);
  };
  const selectedProjectedRelation = useMemo(
    () => selectedProjectedRelationForFocus(scene, selectedRelationId, projectionOverride, authoringDetail),
    [authoringDetail, projectionOverride, scene, selectedRelationId],
  );
  const selectedProjectedRoute = useMemo(() => {
    const projected = selectedProjectedRelation?.relation;
    const detail = selectedProjectedRelation?.detail;
    if (!projected?.routePoints || !detail) return undefined;
    const sourceBounds = authoringBoundsForDetail(scene, projected.from, detail);
    const targetBounds = authoringBoundsForDetail(scene, projected.to, detail);
    return sourceBounds && targetBounds
      ? attachOrthogonalRouteEndpoints(projected.routePoints, { source: sourceBounds, target: targetBounds })
      : projected.routePoints.map(point => ({ ...point }));
  }, [scene, selectedProjectedRelation]);
  const schedulerRef = useRef<DemandFrameScheduler | undefined>(undefined);
  useEffect(() => {
    if (authoringEnabled) return;
    authoringPointerRef.current = undefined;
    updateConnectionDraft(undefined);
    updateGuideDraft(undefined);
    syncContinuousRendering();
    schedulerRef.current?.wake();
  }, [authoringEnabled]);
  const cameraPublisherRef = useRef<CameraPublisher | undefined>(undefined);
  const applyLiveCameraRef = useRef<(camera: Camera) => void>(next => { liveCameraRef.current = next; });
  const syncExternalCameraRef = useRef<(camera: Camera) => void>(next => { liveCameraRef.current = next; });
  const setCameraRef = useRef(setCamera);
  const onCameraSettledRef = useRef(onCameraSettled);
  const onNavigationFlushRef = useRef(onNavigationFlush);
  const onInteractionStartRef = useRef(onInteractionStart);
  const onCameraFlightCancelRef = useRef(onCameraFlightCancel);
  const onLensCancelRef = useRef(onLensCancel);
  const onLensPanRef = useRef(onLensPan);
  const onSemanticZoomBurstStartRef = useRef(onSemanticZoomBurstStart);
  const onLodStateRef = useRef(onLodState);
  const onSemanticZoomRef = useRef(onSemanticZoom);
  stateRef.current = { scene, selectedId, focusedIds, relationFocusIds, activeRelationIds, flowRelationIds, reduceMotion, animationActive, flowActive, projectionOverride, cinematicTransition, visibilityMode };
  setCameraRef.current = setCamera;
  onCameraSettledRef.current = onCameraSettled;
  onNavigationFlushRef.current = onNavigationFlush;
  onInteractionStartRef.current = onInteractionStart;
  onCameraFlightCancelRef.current = onCameraFlightCancel;
  onLensCancelRef.current = onLensCancel;
  onLensPanRef.current = onLensPan;
  onSemanticZoomBurstStartRef.current = onSemanticZoomBurstStart;
  onLodStateRef.current = onLodState;
  onSemanticZoomRef.current = onSemanticZoom;

  function syncContinuousRendering() {
    const current = stateRef.current;
    schedulerRef.current?.setContinuous(canvasAnimationPolicy({
      reducedMotion: current.reduceMotion,
      animationActive: current.animationActive,
      flowActive: current.flowActive,
      pointerInteraction: currentPointerInteraction(),
    }).continuous);
  }

  function currentPointerInteraction(): CanvasPointerInteraction {
    if (authoringPointerRef.current) return 'authoring-drag';
    return pointerRef.current?.moved ? 'camera-pan' : 'idle';
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: AtlasRenderer | undefined;
    let disposed = false;
    let recovering = false;
    const abortController = new AbortController();
    let detachLossListener = () => {};
    let detachWheelListener = () => {};
    let semanticZoomSettleTimer: number | undefined;
    let lastSemanticPointer: LensPoint | undefined;
    let lastResize = { width: 0, height: 0, physicalWidth: 0, physicalHeight: 0 };
    let lastDiagnostics = '';
    const publisher = createCameraPublisher(next => {
      setCameraRef.current(() => next);
      onCameraSettledRef.current(next);
    });
    cameraPublisherRef.current = publisher;

    const resizeRenderer = () => {
      renderer?.resize(sizeRef.current.width, sizeRef.current.height, window.devicePixelRatio);
    };

    const scheduler = createDemandFrameScheduler(time => {
      if (disposed || !renderer) return;
      const current = stateRef.current;
      const animation = canvasAnimationPolicy({
        reducedMotion: current.reduceMotion,
        animationActive: current.animationActive,
        flowActive: current.flowActive,
        pointerInteraction: currentPointerInteraction(),
      });
      try {
        renderer.setScene(current.scene);
        renderer.setCamera(liveCameraRef.current);
        renderer.setRenderState({
          selectedId: current.selectedId,
          focusedIds: current.focusedIds,
          relationFocusIds: current.relationFocusIds,
          activeRelationIds: current.activeRelationIds,
          flowRelationIds: current.flowRelationIds,
          reduceMotion: current.reduceMotion,
          animate: animation.animateFlow,
          visibilityMode: current.visibilityMode,
          ...(current.projectionOverride ? { projectionOverride: current.projectionOverride } : {}),
          ...(current.cinematicTransition ? { cinematicTransition: current.cinematicTransition } : {}),
        });
        renderer.render(time);
        publishLiveCamera(liveCameraRef.current);
        const lodState = renderer.lodState();
        onLodStateRef.current(lodState);
        if (lodState?.transitioning && !current.reduceMotion) schedulerRef.current?.wake();
      } catch (error) {
        void recoverFromLoss(error);
      }
    });
    schedulerRef.current = scheduler;

    const updateSize = (width: number, height: number) => {
      width = Math.max(1, width);
      height = Math.max(1, height);
      const dpr = Math.min(Math.max(window.devicePixelRatio, 1), 2);
      const physicalWidth = Math.max(1, Math.round(width * dpr));
      const physicalHeight = Math.max(1, Math.round(height * dpr));
      if (
        width === lastResize.width
        && height === lastResize.height
        && physicalWidth === lastResize.physicalWidth
        && physicalHeight === lastResize.physicalHeight
      ) return;
      const viewportChanged = width !== lastResize.width || height !== lastResize.height;
      lastResize = { width, height, physicalWidth, physicalHeight };
      sizeRef.current = { width, height };
      setOverlaySize({ width, height });
      if (viewportChanged) onViewportChange({ width, height });
      resizeRenderer();
      scheduler.wake();
    };

    const publishDiagnostics = (force = false) => {
      if (!renderer) return;
      try {
        const next = renderer.diagnostics();
        const snapshot = JSON.stringify(next);
        if (!force && snapshot === lastDiagnostics) return;
        lastDiagnostics = snapshot;
        onDiagnostics(next);
      } catch (error) {
        void recoverFromLoss(error);
      }
    };

    const observer = new ResizeObserver(([entry]) => {
      updateSize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(host);

    const installSession = (session: RendererSession) => {
      detachLossListener();
      detachWheelListener();
      renderer = session.renderer;
      rendererRef.current = renderer;
      detachLossListener = listenForWebGlContextLoss(session.canvas, message => { void recoverFromLoss(message); });
      detachWheelListener = listenForWheel(session.canvas, event => {
        if (panSettleTimerRef.current !== undefined) {
          window.clearTimeout(panSettleTimerRef.current);
          panSettleTimerRef.current = undefined;
        }
        if (semanticZoomSettleTimer === undefined) {
          onCameraFlightCancelRef.current();
          cancelAssistAnimation();
          semanticZoomBurstActiveRef.current = true;
          rawCameraRef.current = onSemanticZoomBurstStartRef.current(liveCameraRef.current);
        }
        onInteractionStartRef.current('Zoomed the map', liveCameraRef.current);
        const bounds = session.canvas.getBoundingClientRect();
        const pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        const zoomed = zoomCameraAt(
          rawCameraRef.current,
          pointer.x,
          pointer.y,
          sizeRef.current,
          event.deltaY,
        );
        const direction = event.deltaY < 0 ? 'inward' : 'outward';
        const next = onSemanticZoomRef.current({ camera: zoomed, renderedCamera: liveCameraRef.current, pointer, direction, gestureSettled: false, mobile: false });
        rawCameraRef.current = zoomed;
        applyLiveCameraRef.current(next);
        animateSemanticAssist(pointer, false);
        lastSemanticPointer = pointer;
        if (semanticZoomSettleTimer !== undefined) window.clearTimeout(semanticZoomSettleTimer);
        semanticZoomSettleTimer = window.setTimeout(() => {
          if (!lastSemanticPointer) return;
          const settled = onSemanticZoomRef.current({
            camera: rawCameraRef.current,
            renderedCamera: liveCameraRef.current,
            pointer: lastSemanticPointer,
            direction: 'none',
            gestureSettled: true,
            mobile: false,
          });
          applyLiveCameraRef.current(settled);
          semanticZoomSettleTimer = undefined;
        }, 120);
      });
      resizeRenderer();
      syncContinuousRendering();
      scheduler.wake();
      publishDiagnostics(true);
    };

    const recoverFromLoss = async (error: unknown) => {
      if (recovering || disposed || !host.isConnected) return;
      recovering = true;
      const reason = error instanceof Error ? error.message : String(error);
      const failedBackend = renderer?.kind ?? requestedBackend;
      const previousRenderer = renderer;
      detachLossListener();
      detachWheelListener();
      detachLossListener = () => {};
      detachWheelListener = () => {};
      renderer = undefined;
      rendererRef.current = undefined;
      lastDiagnostics = '';
      onDiagnostics({
        requestedBackend,
        activeBackend: 'recovering',
        gpuAccelerated: false,
        entityCount: stateRef.current.scene.entities.length,
        relationCount: stateRef.current.scene.relations.length,
        lastFrameMs: 0,
        message: `${failedBackend} surface lost: ${reason} Replacing the canvas and restoring renderer state.`,
      });
      try { previousRenderer?.dispose(); } catch { /* A lost device may reject disposal; the canvas is replaced regardless. */ }
      try {
        const session = await recoverRenderer(host, requestedBackend, failedBackend, reason, abortController.signal);
        if (disposed) {
          session.renderer.dispose();
          return;
        }
        installSession(session);
      } catch (recoveryError) {
        if (!disposed) {
          onDiagnostics({
            requestedBackend,
            activeBackend: 'unsupported',
            gpuAccelerated: false,
            entityCount: stateRef.current.scene.entities.length,
            relationCount: stateRef.current.scene.relations.length,
            lastFrameMs: 0,
            message: `Renderer recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
          });
        }
      } finally {
        recovering = false;
      }
    };

    const applyLiveCamera = (next: Camera) => {
      const zoomChanged = Math.abs(next.zoom - liveCameraRef.current.zoom) > Number.EPSILON;
      liveCameraRef.current = { ...next };
      try {
        renderer?.setCamera(liveCameraRef.current);
      } catch (error) {
        void recoverFromLoss(error);
      }
      if (zoomChanged && !stateRef.current.reduceMotion) scheduler.animateUntil(performance.now() + 220);
      else scheduler.wake();
      publisher.schedule(liveCameraRef.current);
    };
    applyLiveCameraRef.current = applyLiveCamera;
    syncExternalCameraRef.current = next => {
      publisher.cancel();
      const zoomChanged = Math.abs(next.zoom - liveCameraRef.current.zoom) > Number.EPSILON;
      liveCameraRef.current = { ...next };
      if (shouldAdoptExternalCameraAsRaw(
        stateRef.current.projectionOverride?.id,
        semanticZoomBurstActiveRef.current,
      )) rawCameraRef.current = { ...next };
      try {
        renderer?.setCamera(liveCameraRef.current);
      } catch (error) {
        void recoverFromLoss(error);
      }
      if (zoomChanged && !stateRef.current.reduceMotion) scheduler.animateUntil(performance.now() + 220);
      else scheduler.wake();
    };

    const diagnosticsTimer = window.setInterval(() => {
      if (disposed) return;
      publishDiagnostics();
    }, 500);
    const flushNavigation = () => {
      const flushed = publisher.flush();
      if (!flushed) onNavigationFlushRef.current(liveCameraRef.current);
    };
    window.addEventListener('atlas:flush-navigation', flushNavigation);

    void createRenderer(host, requestedBackend, abortController.signal).then(session => {
      if (disposed) {
        session.renderer.dispose();
        return;
      }
      const bounds = host.getBoundingClientRect();
      updateSize(bounds.width, bounds.height);
      installSession(session);
    }).catch(error => {
      if (disposed) return;
      void recoverFromLoss(error);
    });

    return () => {
      disposed = true;
      abortController.abort();
      window.clearInterval(diagnosticsTimer);
      if (semanticZoomSettleTimer !== undefined) window.clearTimeout(semanticZoomSettleTimer);
      window.removeEventListener('atlas:flush-navigation', flushNavigation);
      scheduler.dispose();
      publisher.cancel();
      observer.disconnect();
      detachLossListener();
      detachWheelListener();
      renderer?.dispose();
      rendererRef.current = undefined;
      if (schedulerRef.current === scheduler) schedulerRef.current = undefined;
      if (cameraPublisherRef.current === publisher) cameraPublisherRef.current = undefined;
      host.replaceChildren();
    };
  }, [requestedBackend, onDiagnostics, onViewportChange]);

  useEffect(() => {
    syncExternalCameraRef.current(camera);
  }, [camera]);

  useEffect(() => () => {
    if (pinchSettleTimerRef.current !== undefined) window.clearTimeout(pinchSettleTimerRef.current);
    if (panSettleTimerRef.current !== undefined) window.clearTimeout(panSettleTimerRef.current);
    if (semanticAssistRafRef.current !== undefined) window.cancelAnimationFrame(semanticAssistRafRef.current);
  }, []);

  useEffect(() => {
    syncContinuousRendering();
    schedulerRef.current?.wake();
    if (projectionOverride?.id.endsWith(':base') && !semanticZoomBurstActiveRef.current) cancelAssistAnimation();
  }, [scene, selectedId, focusedIds, relationFocusIds, activeRelationIds, flowRelationIds, animationActive, flowActive, projectionOverride, cinematicTransition, reduceMotion, visibilityMode]);

  function cancelAssistAnimation() {
    if (semanticAssistRafRef.current !== undefined) window.cancelAnimationFrame(semanticAssistRafRef.current);
    semanticAssistRafRef.current = undefined;
    semanticAssistUntilRef.current = 0;
    semanticAssistSampleRef.current = undefined;
    semanticZoomBurstActiveRef.current = false;
  }

  function animateSemanticAssist(pointer: LensPoint, mobile: boolean, gestureStartZoom?: number) {
    semanticAssistSampleRef.current = { pointer, mobile, ...(gestureStartZoom !== undefined ? { gestureStartZoom } : {}) };
    semanticAssistUntilRef.current = Math.max(semanticAssistUntilRef.current, performance.now() + (mobile ? 320 : 260));
    if (semanticAssistRafRef.current !== undefined) return;
    const tick = (now: number) => {
      const sample = semanticAssistSampleRef.current;
      if (!sample || now > semanticAssistUntilRef.current) {
        rawCameraRef.current = { ...liveCameraRef.current };
        semanticZoomBurstActiveRef.current = false;
        semanticAssistRafRef.current = undefined;
        return;
      }
      const next = onSemanticZoomRef.current({
        camera: rawCameraRef.current,
        renderedCamera: liveCameraRef.current,
        pointer: sample.pointer,
        direction: 'none',
        gestureSettled: false,
        mobile: sample.mobile,
        ...(sample.gestureStartZoom !== undefined ? { gestureStartZoom: sample.gestureStartZoom } : {}),
      });
      applyLiveCameraRef.current(next);
      semanticAssistRafRef.current = window.requestAnimationFrame(tick);
    };
    semanticAssistRafRef.current = window.requestAnimationFrame(tick);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (panSettleTimerRef.current !== undefined) {
      window.clearTimeout(panSettleTimerRef.current);
      panSettleTimerRef.current = undefined;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const viewportBounds = event.currentTarget.getBoundingClientRect();
    const screenPoint = { x: event.clientX - viewportBounds.left, y: event.clientY - viewportBounds.top };
    rendererRef.current?.pick(screenPoint.x, screenPoint.y);
    if (authoringEnabled && event.pointerType !== 'touch') {
      if (authoringTool === 'connect') {
        const portHit = [...authoringEntityIds].flatMap(entityId => {
          const bounds = authoringBoundsForDetail(scene, entityId, authoringDetail);
          if (!bounds) return [];
          return (['top', 'right', 'bottom', 'left'] as const).map(port => {
            const portScreen = worldToScreen(connectionPortPoint(bounds, port), liveCameraRef.current, sizeRef.current);
            return { entityId, bounds, port, distance: Math.hypot(portScreen.x - screenPoint.x, portScreen.y - screenPoint.y) };
          });
        }).filter(value => value.distance <= 16)
          .sort((left, right) => left.distance - right.distance || `${left.entityId}:${left.port}`.localeCompare(`${right.entityId}:${right.port}`))[0];
        if (portHit) {
          const start = connectionPortPoint(portHit.bounds, portHit.port);
          authoringPointerRef.current = { kind: 'connection', id: event.pointerId, from: portHit.entityId, sourcePort: portHit.port };
          syncContinuousRendering();
          pointerRef.current = undefined;
          updateConnectionDraft({ from: portHit.entityId, sourcePort: portHit.port, points: [start, start], safe: true });
          onInteractionStartRef.current('Created a relationship', liveCameraRef.current);
          return;
        }
      }
      if (authoringTool === 'select' && selectedRelationId) {
        const projected = selectedProjectedRelation?.relation;
        const detail = selectedProjectedRelation?.detail;
        const routing = projected && detail ? relationshipRouteGeometryForScene(scene, projected, detail) : undefined;
        const handle = selectedProjectedRoute && closestSegmentHandle(selectedProjectedRoute, screenPoint, liveCameraRef.current, sizeRef.current);
        if (projected && detail && routing && selectedProjectedRoute && handle) {
          authoringPointerRef.current = {
            kind: 'guide',
            id: event.pointerId,
            relationId: selectedRelationId,
            visualRelationId: projected.id,
            detail,
            segmentIndex: handle.segmentIndex,
            originalPoints: selectedProjectedRoute,
            from: projected.from,
            to: projected.to,
            routing,
          };
          syncContinuousRendering();
          pointerRef.current = undefined;
          updateGuideDraft({
            relationId: selectedRelationId,
            segmentIndex: handle.segmentIndex,
            points: selectedProjectedRoute.map(point => ({ ...point })),
            applied: false,
            diagnostic: 'applied',
          });
          onInteractionStartRef.current('Guided a relationship route', liveCameraRef.current);
          return;
        }
      }
    }
    if (event.pointerType === 'touch') {
      touchPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchPointersRef.current.size >= 2) {
        const [first, second] = [...touchPointersRef.current.values()];
        if (pinchSettleTimerRef.current !== undefined) {
          window.clearTimeout(pinchSettleTimerRef.current);
          pinchSettleTimerRef.current = undefined;
        }
        cancelAssistAnimation();
        semanticZoomBurstActiveRef.current = true;
        rawCameraRef.current = onSemanticZoomBurstStartRef.current(liveCameraRef.current);
        pinchRef.current = {
          distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
          centroid: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
          startZoom: rawCameraRef.current.zoom,
          moved: false,
        };
        pointerRef.current = undefined;
        return;
      }
    }
    pointerRef.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const authoringPointer = authoringPointerRef.current;
    if (authoringPointer && authoringPointer.id === event.pointerId) {
      const viewportBounds = event.currentTarget.getBoundingClientRect();
      const screenPoint = { x: event.clientX - viewportBounds.left, y: event.clientY - viewportBounds.top };
      const world = screenToWorld(screenPoint, liveCameraRef.current, sizeRef.current);
      const interactionDetail = authoringPointer.kind === 'guide' ? authoringPointer.detail : authoringDetail;
      const activeBounds = (scene.projection?.entityIdsByDetail[interactionDetail] ?? [])
        .flatMap(entityId => {
          const bounds = authoringBoundsForDetail(scene, entityId, interactionDetail);
          return bounds ? [{ id: entityId, bounds }] : [];
        });
      if (authoringPointer.kind === 'connection') {
        const picked = rendererRef.current?.pick(screenPoint.x, screenPoint.y);
        const targetPortHit = [...authoringEntityIds]
          .filter(entityId => entityId !== authoringPointer.from)
          .flatMap(entityId => {
            const bounds = authoringBoundsForDetail(scene, entityId, authoringDetail);
            if (!bounds) return [];
            return (['top', 'right', 'bottom', 'left'] as const).map(port => {
              const portScreen = worldToScreen(connectionPortPoint(bounds, port), liveCameraRef.current, sizeRef.current);
              return { entityId, port, distance: Math.hypot(portScreen.x - screenPoint.x, portScreen.y - screenPoint.y) };
            });
          }).filter(value => value.distance <= 16)
          .sort((left, right) => left.distance - right.distance || `${left.entityId}:${left.port}`.localeCompare(`${right.entityId}:${right.port}`))[0];
        const targetId = targetPortHit?.entityId
          ?? (picked?.kind === 'entity' && picked.id !== authoringPointer.from && authoringEntityIds.has(picked.id)
            ? picked.id
            : undefined);
        const sourceBounds = authoringBoundsForDetail(scene, authoringPointer.from, authoringDetail)!;
        if (targetId) {
          const targetBounds = authoringBoundsForDetail(scene, targetId, authoringDetail)!;
          const targetPort = targetPortHit?.port ?? nearestConnectionPort(targetBounds, world);
          try {
            const points = automaticRelationshipRoute(
              sourceBounds,
              targetBounds,
              routingObstaclesForEndpoints(activeBounds, authoringPointer.from, targetId),
              { sourcePort: authoringPointer.sourcePort, targetPort },
              8 / (scene.projection?.zoomPolicy?.bands.find(band => band.detail === authoringDetail)?.focusZoom ?? 1),
            );
            updateConnectionDraft({
              from: authoringPointer.from,
              sourcePort: authoringPointer.sourcePort,
              to: targetId,
              targetPort,
              points,
              safe: true,
            });
          } catch {
            const current = connectionDraftRef.current;
            if (current) updateConnectionDraft({ ...current, to: undefined, targetPort: undefined, safe: false });
          }
        } else {
          const start = connectionPortPoint(sourceBounds, authoringPointer.sourcePort);
          const elbow = Math.abs(world.x - start.x) >= Math.abs(world.y - start.y)
            ? { x: world.x, y: start.y }
            : { x: start.x, y: world.y };
          const candidate = [start, elbow, world];
          const safe = routeIsObstacleSafe(
            candidate,
            routingObstaclesForEndpoints(activeBounds, authoringPointer.from).map(value => value.bounds),
          );
          updateConnectionDraft({ from: authoringPointer.from, sourcePort: authoringPointer.sourcePort, points: candidate, safe });
        }
        return;
      }
      const preview = previewOrthogonalSegmentGuide(
        authoringPointer.originalPoints,
        authoringPointer.segmentIndex,
        world,
        authoringPointer.routing.obstacles.map(value => value.bounds),
        { source: authoringPointer.routing.source, target: authoringPointer.routing.target },
        authoringPointer.routing,
      );
      updateGuideDraft({ ...preview, relationId: authoringPointer.relationId, segmentIndex: authoringPointer.segmentIndex });
      return;
    }
    if (event.pointerType === 'touch' && touchPointersRef.current.has(event.pointerId)) {
      touchPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchPointersRef.current.size >= 2) {
        const [first, second] = [...touchPointersRef.current.values()];
        const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
        const centroid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
        const previous = pinchRef.current ?? { distance, centroid, startZoom: rawCameraRef.current.zoom, moved: false };
        const ratio = distance / previous.distance;
        const bounds = event.currentTarget.getBoundingClientRect();
        const pointer = { x: centroid.x - bounds.left, y: centroid.y - bounds.top };
        const zoomed = zoomCameraAt(rawCameraRef.current, pointer.x, pointer.y, sizeRef.current, -Math.log(ratio) / 0.0012);
        const direction = ratio > 1 ? 'inward' : ratio < 1 ? 'outward' : 'none';
        if (!previous.moved && Math.abs(Math.log(ratio)) > .002) {
          onCameraFlightCancelRef.current();
          onInteractionStartRef.current('Pinched the map', liveCameraRef.current);
        }
        const next = onSemanticZoomRef.current({ camera: zoomed, renderedCamera: liveCameraRef.current, pointer, direction, gestureSettled: false, mobile: true, gestureStartZoom: previous.startZoom });
        rawCameraRef.current = zoomed;
        applyLiveCameraRef.current(next);
        animateSemanticAssist(pointer, true, previous.startZoom);
        pinchRef.current = { distance, centroid, startZoom: previous.startZoom, moved: previous.moved || Math.abs(Math.log(ratio)) > .002 };
        return;
      }
    }
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) {
      if (authoringEnabled) {
        const bounds = event.currentTarget.getBoundingClientRect();
        setHoveredPick(rendererRef.current?.pick(event.clientX - bounds.left, event.clientY - bounds.top));
      }
      return;
    }
    let dx = event.clientX - pointer.x;
    let dy = event.clientY - pointer.y;
    if (!pointer.moved) {
      if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) <= 3) return;
      pointer.moved = true;
      rawCameraRef.current = { ...liveCameraRef.current };
      cancelAssistAnimation();
      onCameraFlightCancelRef.current();
      syncContinuousRendering();
      dx = event.clientX - pointer.startX;
      dy = event.clientY - pointer.startY;
    }
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    const next = panCamera(liveCameraRef.current, dx, dy);
    rawCameraRef.current = next;
    applyLiveCameraRef.current(next);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const authoringPointer = authoringPointerRef.current;
    if (authoringPointer && authoringPointer.id === event.pointerId) {
      const committedConnectionDraft = connectionDraftRef.current;
      const committedGuideDraft = guideDraftRef.current;
      if (authoringPointer.kind === 'connection' && committedConnectionDraft?.to && committedConnectionDraft.targetPort && committedConnectionDraft.safe) {
        onCreateRelationship({
          from: authoringPointer.from,
          to: committedConnectionDraft.to,
          sourcePort: authoringPointer.sourcePort,
          targetPort: committedConnectionDraft.targetPort,
          routePoints: committedConnectionDraft.points.map(point => ({ ...point })),
        });
      } else if (authoringPointer.kind === 'guide' && committedGuideDraft?.applied && committedGuideDraft.intent) {
        onGuideRelationship({
          relationId: authoringPointer.relationId,
          visualRelationId: authoringPointer.visualRelationId,
          detail: authoringPointer.detail,
          intent: committedGuideDraft.intent,
        });
      }
      authoringPointerRef.current = undefined;
      updateConnectionDraft(undefined);
      updateGuideDraft(undefined);
      syncContinuousRendering();
      schedulerRef.current?.wake();
      return;
    }
    if (event.pointerType === 'touch') {
      const wasPinching = pinchRef.current;
      touchPointersRef.current.delete(event.pointerId);
      if (wasPinching) {
        if (touchPointersRef.current.size < 2) {
          const bounds = event.currentTarget.getBoundingClientRect();
          const pointer = { x: wasPinching.centroid.x - bounds.left, y: wasPinching.centroid.y - bounds.top };
          if (pinchSettleTimerRef.current !== undefined) window.clearTimeout(pinchSettleTimerRef.current);
          pinchSettleTimerRef.current = window.setTimeout(() => {
            const next = onSemanticZoomRef.current({ camera: rawCameraRef.current, renderedCamera: liveCameraRef.current, pointer, direction: 'none', gestureSettled: true, mobile: true, gestureStartZoom: wasPinching.startZoom });
            applyLiveCameraRef.current(next);
            cameraPublisherRef.current?.flush();
            pinchSettleTimerRef.current = undefined;
          }, 120);
          pinchRef.current = undefined;
        }
        return;
      }
    }
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    if (!pointer.moved) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const picked = rendererRef.current?.pick(event.clientX - bounds.left, event.clientY - bounds.top);
      if (picked) onPick(picked);
    } else {
      const settledCamera = { ...liveCameraRef.current };
      panSettleTimerRef.current = window.setTimeout(() => {
        onLensPanRef.current(settledCamera);
        panSettleTimerRef.current = undefined;
      }, 160);
    }
    pointerRef.current = undefined;
    syncContinuousRendering();
    schedulerRef.current?.wake();
    cameraPublisherRef.current?.flush();
  }

  function pickAt(event: { currentTarget: HTMLDivElement; clientX: number; clientY: number }) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return rendererRef.current?.pick(event.clientX - bounds.left, event.clientY - bounds.top);
  }

  return (
    <div
      aria-label="Interactive architecture map. Double-click a node or press Enter on the selected node to open inside. Use the entity explorer after the canvas for keyboard navigation."
      className={`atlas-canvas ${authoringEnabled && authoringTool === 'connect' ? 'authoring-connect' : ''}`}
      data-testid="atlas-canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={event => { const picked = pickAt(event); if (picked?.kind === 'entity') { onPick(picked); onOpenInside(picked.id); } }}
      onKeyDown={event => {
        if (event.key === 'Escape') { cancelAssistAnimation(); onLensCancelRef.current('escape', liveCameraRef.current); return; }
        if (event.key === 'Enter' && selectedId) { event.preventDefault(); onOpenInside(selectedId); }
      }}
      onPointerCancel={event => {
        if (panSettleTimerRef.current !== undefined) window.clearTimeout(panSettleTimerRef.current);
        panSettleTimerRef.current = undefined;
        touchPointersRef.current.delete(event.pointerId);
        pinchRef.current = undefined;
        pointerRef.current = undefined;
        authoringPointerRef.current = undefined;
        updateConnectionDraft(undefined);
        updateGuideDraft(undefined);
        syncContinuousRendering();
        schedulerRef.current?.wake();
        cameraPublisherRef.current?.flush();
      }}
      role="img"
      tabIndex={0}
    >
      <div className="atlas-renderer-host" ref={hostRef}/>
      {authoringEnabled && <RelationshipAuthoringOverlay
        boundsByEntityId={Object.fromEntries((scene.projection?.entityIdsByDetail[authoringDetail] ?? scene.entities.map(entity => entity.id)).flatMap(entityId => {
          const bounds = authoringBoundsForDetail(scene, entityId, authoringDetail);
          return bounds ? [[entityId, bounds]] : [];
        }))}
        camera={liveCameraRef.current}
        draft={connectionDraft
          ? { points: connectionDraft.points, safe: connectionDraft.safe }
          : guideDraft ? { points: guideDraft.points, safe: guideDraft.applied } : undefined}
        portEntityIds={[...new Set([
          ...(authoringTool === 'connect' && hoveredPick?.kind === 'entity' && authoringEntityIds.has(hoveredPick.id) ? [hoveredPick.id] : []),
          ...(authoringTool === 'connect' && selectedId && authoringEntityIds.has(selectedId) ? [selectedId] : []),
          ...(connectionDraft ? [connectionDraft.from, ...(connectionDraft.to ? [connectionDraft.to] : [])] : []),
        ])]}
        selectedRoute={authoringTool === 'select'
          ? guideDraft ? undefined : selectedProjectedRoute
          : undefined}
        viewport={overlaySize}
      />}
    </div>
  );
}

export function App() {
  const query = useMemo(() => readDemoQuery(window.location.search), []);
  const initialCameraExplicit = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.has('cx') || params.has('cy') || params.has('z');
  }, []);
  const goldenScene = useMemo(() => activeCreateScene(scanFixture?.navigation.rootEntityId ?? 'system:okie'), []);
  const navigationDefaults = useMemo<NavigationDefaults>(() => {
    const identity = query.fixture === 'stress'
      ? { repositoryId: 'repo:renderer-stress', snapshotId: `snapshot:stress:${query.seed}`, viewId: 'view:stress:overview', rootEntityId: 'stress-loading' }
      : scanFixture?.navigation ?? { repositoryId: 'repo:okie-golden', snapshotId: 'snapshot:okie-golden-worktree-v1', viewId: 'view:okie-golden-hierarchy', rootEntityId: 'system:okie' };
    return {
      ...identity,
      selectedId: identity.rootEntityId,
      camera: defaultCamera,
      detail: semanticDetails[getLevel(defaultCamera.zoom)],
      minZoom: ATLAS_CAMERA_BOUNDS.minZoom,
      maxZoom: ATLAS_CAMERA_BOUNDS.maxZoom,
    };
  }, [query.fixture, query.seed]);
  const navigationUrlOptions = useMemo(() => {
    const demoEntityIds = query.fixture === 'stress'
      ? undefined
      : new Set(goldenScene.entities.map(entity => entity.id));
    return {
      preserveParams: preservedNavigationParams,
      references: {
        hasSnapshot: (id: string) => id === navigationDefaults.snapshotId,
        hasView: (id: string) => id === navigationDefaults.viewId,
        hasEntity: (id: string) => demoEntityIds?.has(id) ?? true,
        hasStory: (id: string) => id === storyId,
      },
    };
  }, [goldenScene.entities, navigationDefaults, query.fixture]);
  const initialNavigation = useMemo(() => navigationStateFromUrl(
    window.location.href,
    navigationDefaults,
    navigationUrlOptions,
  ).state, [navigationDefaults, navigationUrlOptions]);
  const [scene, setScene] = useState<AtlasScene>(() => query.fixture === 'stress' ? stressLoadingScene() : goldenScene);
  const [fixtureError, setFixtureError] = useState<string>();
  const reduceMotion = useReducedMotion();
  const detailsOpenerRef = useRef<HTMLButtonElement | null>(null);
  const detailsPanelRef = useRef<HTMLElement | null>(null);
  const diagramAddMenuRef = useRef<HTMLDetailsElement | null>(null);
  const screenshotMenuRef = useRef<HTMLDetailsElement | null>(null);
  const sourceTabRef = useRef<HTMLButtonElement | null>(null);
  const detailsTabRef = useRef<HTMLButtonElement | null>(null);
  const inspectorSelectionRef = useRef(initialNavigation.selectedId);
  const inspectorReframeGenerationRef = useRef(0);
  const askButtonRef = useRef<HTMLButtonElement | null>(null);
  const askInputRef = useRef<HTMLTextAreaElement | null>(null);
  const shareButtonRef = useRef<HTMLButtonElement | null>(null);
  const visibilityControlRef = useRef<HTMLButtonElement | null>(null);
  const shareFallbackRef = useRef<HTMLInputElement | null>(null);
  const shareFeedbackTimerRef = useRef<number | undefined>(undefined);
  const historyControllerRef = useRef<NavigationHistoryController | undefined>(undefined);
  const semanticControlTimerRef = useRef<number | undefined>(undefined);
  const initialMapFitAppliedRef = useRef(initialCameraExplicit);
  const navigationRestoreGenerationRef = useRef(0);
  const restoringNavigationRef = useRef(false);
  const storyOriginAvailableRef = useRef(false);
  const isolationOriginRef = useRef<{
    camera: Camera;
    selectedId: string;
    pickedRelationId?: string;
    visibilityMode: 'all' | 'dim';
  } | undefined>(undefined);
  const lodReplayRef = useRef<RendererLodState | undefined>(undefined);
  const [camera, updateCamera] = useState<Camera>(initialNavigation.camera);
  const renderedCameraRef = useRef(camera);
  const pendingInspectorCameraFlightRef = useRef<PendingInspectorCameraFlight | undefined>(undefined);
  const inspectorCameraFlightControllerRef = useRef<CameraFlightController | undefined>(undefined);
  const [inspectorFlightActive, setInspectorFlightActive] = useState(false);
  inspectorCameraFlightControllerRef.current ??= createCameraFlightController(
    () => renderedCameraRef.current,
    next => {
      renderedCameraRef.current = next;
      updateCamera(next);
    },
  );
  renderedCameraRef.current = reconcileRenderedCamera(
    renderedCameraRef.current,
    camera,
    inspectorCameraFlightControllerRef.current.isActive(),
  );
  const [selectedId, setSelectedId] = useState(initialNavigation.selectedId);
  const [navigationIdentity, setNavigationIdentity] = useState(() => ({
    repositoryId: initialNavigation.repositoryId,
    snapshotId: initialNavigation.snapshotId,
    viewId: initialNavigation.viewId,
    rootEntityId: initialNavigation.rootEntityId,
    filterId: initialNavigation.filterId,
  }));
  const [detailsOpen, setDetailsOpen] = useState(() => window.innerWidth > 780);
  const [inspectorTab, setInspectorTab] = useState<'source' | 'details'>('details');
  const [inspectorHistory, setInspectorHistory] = useState<InspectorHistorySubject[]>([]);
  const [detailsWidth, setDetailsWidth] = useState(() => {
    let stored = Number.NaN;
    try {
      stored = Number.parseFloat(localStorage.getItem(inspectorWidthStorageKey(initialNavigation.repositoryId)) ?? '');
    } catch {
      // Storage can be unavailable in privacy modes; use the repository default.
    }
    return clampInspectorWidth(Number.isFinite(stored) ? stored : defaultInspectorWidth(window.innerWidth), window.innerWidth);
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  // Diagnostics/dev mode: hidden by default, toggled with Shift+Alt+D, persisted across
  // reloads. When off, the shell hides the renderer pill/diagnostics, the Edit/View mode
  // toggle (authoring stays view-only), and the Create-diagram menu.
  const [devMode, setDevMode] = useState(() => {
    try { return localStorage.getItem('okie.devMode') === '1'; } catch { return false; }
  });
  const [diagnostics, setDiagnostics] = useState<RendererDiagnostics>({ requestedBackend: query.backend, activeBackend: 'initializing', gpuAccelerated: false, entityCount: 0, relationCount: 0, lastFrameMs: 0, message: 'Renderer is initializing.' });
  const [storyStep, setStoryStep] = useState(() => initialNavigation.story?.id === storyId
    ? Math.min(story.steps.length - 1, initialNavigation.story.step)
    : -1);
  const [storyPlaying, setStoryPlaying] = useState(false);
  const initialCinematicPosition = initialNavigation.story?.id === storyId
    ? decodeStoryPosition(initialNavigation.story.step, initialNavigation.story.positionMs)
    : { phase: 'hold' as const, elapsedMs: 0 };
  const initialStoryElapsed = initialCinematicPosition.phase === 'hold'
    ? initialCinematicPosition.elapsedMs
    : 0;
  const [storyElapsedMs, setStoryElapsedMs] = useState(initialStoryElapsed);
  const storyElapsedRef = useRef(initialStoryElapsed);
  const storyStartedAtRef = useRef<number | undefined>(undefined);
  const [storyPhase, setStoryPhase] = useState<StoryPhase>(initialNavigation.story?.id === storyId ? 'paused' : 'idle');
  const pausedStoryPhaseRef = useRef<StoryCanonicalPhase>(initialCinematicPosition.phase);
  const pausedStoryPhaseElapsedRef = useRef(initialCinematicPosition.elapsedMs);
  const [storyFlightSample, setStoryFlightSample] = useState<StoryFlightSample>();
  const storyFlightRef = useRef<ActiveStoryFlight | undefined>(undefined);
  const [storyFlightEpoch, setStoryFlightEpoch] = useState(0);
  const arrivalStartedAtRef = useRef<number | undefined>(undefined);
  const arrivalPlayAfterRef = useRef(false);
  const [arrivalElapsedMs, setArrivalElapsedMs] = useState(0);
  const [returnToStoryFrameRequired, setReturnToStoryFrameRequired] = useState(false);
  const [storyInterruption, setStoryInterruption] = useState<string>();
  const [storySelectionOverride, setStorySelectionOverride] = useState(false);
  const [visibilityMode, setVisibilityMode] = useState<'all' | 'dim' | 'isolate'>('all');
  const [liveMessage, setLiveMessage] = useState('Okie architecture atlas loaded. Okie selected.');
  const [askOpen, setAskOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [viewport, setViewport] = useState<ViewportSize>(() => ({ width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight - 68) }));
  const [measuredSafeArea, setMeasuredSafeArea] = useState<SafeArea>(() => storySafeArea({ width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight - 68) }));
  const [safeAreaEpoch, setSafeAreaEpoch] = useState(0);
  const [pickedRelationId, setPickedRelationId] = useState<string>();
  const [diagramWorkspace, setDiagramWorkspace] = useState(() => createDiagramWorkspace({
    camera: { ...initialNavigation.camera },
    selectedId: initialNavigation.selectedId,
    inspector: {
      open: window.innerWidth > 780,
      tab: 'details',
      subjectId: initialNavigation.selectedId,
    },
  }));
  const diagramSurfaces = useMemo(() => diagramWorkspaceSurfaces(diagramWorkspace), [diagramWorkspace]);
  const activeDiagramSurface = diagramWorkspace.surfaces[diagramWorkspace.activeSurfaceId]!;
  const mainDiagramActive = activeDiagramSurface.kind === 'main';
  const [interactionMode, setInteractionMode] = useState<'view' | 'edit'>('view');
  useEffect(() => {
    try { localStorage.setItem('okie.devMode', devMode ? '1' : '0'); } catch { /* storage unavailable */ }
    if (!devMode) { setInteractionMode('view'); setDiagnosticsOpen(false); }
  }, [devMode]);
  const [authoringTool, setAuthoringTool] = useState<'select' | 'connect'>('select');
  const [authoringHistory, setAuthoringHistory] = useState<GestureHistory<ArchitectureAuthoringDocument>>(
    () => createGestureHistory(createArchitectureAuthoringDocument(initialNavigation.repositoryId)),
  );
  const authoringHistoryRef = useRef(authoringHistory);
  authoringHistoryRef.current = authoringHistory;
  const authoredRelationSequenceRef = useRef(1);
  const [shareFeedback, setShareFeedback] = useState<{ tone: 'success' | 'error'; message: string; url: string }>();
  const [settledNavigation, setSettledNavigation] = useState(initialNavigation);
  const [cameraSettledEpoch, setCameraSettledEpoch] = useState(0);
  const [semanticLensSession, setSemanticLensSession] = useState<SemanticLensSession>(() => {
    const baseIndex = initialNavigation.detail ? semanticDetails.indexOf(initialNavigation.detail) : -1;
    const baseDetail = baseIndex >= 0 ? semanticDetails[baseIndex] : 'context';
    const lensScene = query.fixture === 'stress'
      ? goldenScene
      : activeCreateScene(initialNavigation.rootEntityId, goldenScene);
    const settled = validateSemanticLensPath(lensScene, baseDetail, initialNavigation.lensPath ?? []).entries;
    return { baseDetail, settled, active: idleSemanticLens() };
  });
  const semanticLensSessionRef = useRef(semanticLensSession);
  semanticLensSessionRef.current = semanticLensSession;
  const semanticFocusTransferRafRef = useRef<number | undefined>(undefined);
  const semanticMorphStateRef = useRef<SemanticLensState | undefined>(undefined);
  const semanticMorphBaselineRef = useRef(0);
  const semanticLens = semanticLensSessionPresentationState(semanticLensSession);

  const selected = useMemo(() => scene.entities.find(entity => entity.id === selectedId) ?? scene.entities[0], [scene.entities, selectedId]);
  const pickedRelation = useMemo(() => pickedRelationId ? scene.relations.find(relation => relation.id === pickedRelationId) : undefined, [pickedRelationId, scene.relations]);
  const pickedRelationPresentation = useMemo(() => pickedRelation ? selectedRelationPresentation(scene, pickedRelation, pickedRelation.from) : undefined, [pickedRelation, scene]);
  const selectedExcerpt = selected.sourceExcerpts?.[0];
  const sourceAvailable = !pickedRelation && selected.detail === 'code' && Boolean(selectedExcerpt);
  const localWorkspace = useMemo<LocalWorkspaceContext | undefined>(() => {
    const injected = (window as Window & { __OKIE_LOCAL_WORKSPACE__?: LocalWorkspaceContext }).__OKIE_LOCAL_WORKSPACE__;
    return injected ?? (configuredRepositoryRoot ? { repositoryRoot: configuredRepositoryRoot } : undefined);
  }, []);
  const selectedProvenance = useMemo(() => presentClaimProvenance({
    origin: 'inferred',
    evidenceCount: selected.sourceRefs?.length ?? 0,
    ...(selected.confidence !== undefined ? { confidence: selected.confidence } : {}),
  }), [selected.confidence, selected.sourceRefs]);
  const selectedChildren = useMemo(
    () => scene.entities.filter(entity => entity.parentId === selected.id),
    [scene.entities, selected.id],
  );
  const selectedParent = useMemo(
    () => selected.parentId ? scene.entities.find(entity => entity.id === selected.parentId) : undefined,
    [scene.entities, selected.parentId],
  );
  const selectedHasChildren = selectedChildren.length > 0;
  const selectedLevel = Math.max(0, semanticDetails.indexOf(selected.detail ?? 'context'));
  const selectedLevelLabel = `${levels[selectedLevel]?.short ?? 'L1'} · ${(selected.kindLabel ?? selected.detail ?? selected.kind).toUpperCase()}`;
  const detailsWidthRange = inspectorWidthRange(window.innerWidth);
  useEffect(() => {
    if (inspectorSelectionRef.current === selected.id) return;
    inspectorSelectionRef.current = selected.id;
    setInspectorTab(selected.detail === 'code' && selected.sourceExcerpts?.length ? 'source' : 'details');
  }, [selected.detail, selected.id, selected.sourceExcerpts]);
  useEffect(() => () => inspectorCameraFlightControllerRef.current?.dispose(), []);
  useEffect(() => {
    setDetailsWidth(current => clampInspectorWidth(current, window.innerWidth));
  }, [viewport.width]);
  useEffect(() => {
    try {
      localStorage.setItem(inspectorWidthStorageKey(navigationIdentity.repositoryId), String(detailsWidth));
    } catch {
      // Storage can be unavailable in privacy modes; resizing still works for the session.
    }
  }, [detailsWidth, navigationIdentity.repositoryId]);
  const currentStory = storyStep >= 0 ? story.steps[storyStep] : undefined;
  const activeStoryFlight = storyFlightRef.current;
  const storyCanonicalPhase: StoryCanonicalPhase = storyPhase === 'flight' || storyPhase === 'arrival' || storyPhase === 'hold'
    ? storyPhase
    : pausedStoryPhaseRef.current;
  const storyPhaseElapsedMs = storyCanonicalPhase === 'flight'
    ? storyFlightSample?.elapsedMs ?? pausedStoryPhaseElapsedRef.current
    : storyCanonicalPhase === 'arrival'
      ? arrivalElapsedMs
      : storyElapsedMs;
  const storyPositionMs = storyStep < 0
    ? 0
    : encodeStoryPosition(
        storyStep,
        storyCanonicalPhase,
        storyPhaseElapsedMs,
        activeStoryFlight?.flight.canonicalDurationMs,
      );
  const storyTraveling = Boolean(activeStoryFlight && storyCanonicalPhase === 'flight' && !storySelectionOverride);
  const activeLevelRef = useRef(initialNavigation.detail
    ? Math.max(0, semanticDetails.indexOf(initialNavigation.detail))
    : getLevel(initialNavigation.camera.zoom));
  const activeLevel = Math.max(0, semanticDetails.indexOf(semanticLensSessionDetail(semanticLensSession)));
  const baseDetail = semanticLensSession.baseDetail;
  const activeDetail = semanticDetails[activeLevel];
  const activeDerivedScopeId = activeDiagramSurface.kind === 'main'
    ? undefined
    : activeDiagramSurface.entityIds[0];
  const activeDerivedScope = activeDerivedScopeId
    ? scene.entities.find(entity => entity.id === activeDerivedScopeId)
    : undefined;
  const activeDiagramDetail = activeDiagramSurface.kind === 'code'
    ? 'code'
    : activeDerivedScope?.detail ?? activeDetail;
  const activeDiagramScopeId = activeDerivedScope
    ? activeDiagramSurface.kind === 'code'
      ? activeDerivedScope.detail === 'component'
        ? activeDerivedScope.id
        : activeDerivedScope.parentId ?? navigationIdentity.rootEntityId
      : activeDiagramDetail === 'component' || activeDiagramDetail === 'code'
      ? activeDerivedScope.parentId ?? navigationIdentity.rootEntityId
      : activeDiagramDetail === 'container' || activeDerivedScope.id !== navigationIdentity.rootEntityId
        ? navigationIdentity.rootEntityId
        : activeDerivedScope.id
    : semanticLensSession.settled.at(-1)?.targetId ?? navigationIdentity.rootEntityId;
  const notationDiagnostics = useMemo(() => query.fixture === 'stress' ? [] : validateC4NotationCompleteness({
    snapshot: activeSnapshot,
    view: activeView,
    diagramType: activeDiagramDetail,
    title: activeDiagramSurface.kind === 'main' ? scene.title : activeDiagramSurface.title,
    scopeEntityId: activeDiagramScopeId,
  }), [activeDiagramDetail, activeDiagramScopeId, activeDiagramSurface.kind, activeDiagramSurface.title, query.fixture, scene.title]);
  const activeDynamicFlowArtifact = useMemo(() => {
    if (query.fixture === 'stress' || activeDiagramSurface.kind === 'main' || activeDiagramSurface.kind === 'code') return undefined;
    const scopeEntityId = activeDiagramSurface.entityIds[0];
    const scopeEntity = activeSnapshot.entities.find(entity => entity.id === scopeEntityId);
    if (!scopeEntity) return undefined;
    const traceRelationIds = activeSnapshot.relations
      .filter(relation => relation.from === scopeEntityId || relation.to === scopeEntityId)
      .map(relation => relation.id);
    const dynamicStory: ArchitectureStory = {
      schemaVersion: 1,
      id: `story:dynamic:${scopeEntityId}`,
      snapshotId: activeSnapshot.id,
      viewId: activeView.id,
      title: `${scopeEntity.name} dynamic flow`,
      steps: [{
        id: `step:dynamic:${scopeEntityId}`,
        title: `Follow ${scopeEntity.name}`,
        focusEntityIds: [scopeEntityId],
        traceRelationIds,
        reveal: activeDiagramDetail,
        narration: `Evidence-backed interactions around ${scopeEntity.name}.`,
        sourceRefs: scopeEntity.sourceRefs,
      }],
    };
    // Derived flow/Mermaid projections build the bundle directly (not via the
    // scan createScene seam), so scope them through the same per-focus options —
    // {} below the gate (golden unchanged), bounded above it so this bypass path
    // can never compile the full graph either.
    const scoped = scanFixture?.scopeCompileOptions(scopeEntityId) ?? {};
    const projections = buildC4ProjectionBundle(activeSnapshot, {
      rootEntityId: activeView.rootEntityId,
      focusEntityId: scopeEntityId,
      familyId: `view-family:dynamic:${scopeEntityId}`,
      ...scoped,
    });
    return compileC4DynamicFlowArtifact(activeSnapshot, activeView, dynamicStory, projections);
  }, [activeDiagramDetail, activeDerivedScopeId, activeDiagramSurface.kind, query.fixture]);
  const activeMermaidSource = activeDiagramSurface.kind === 'mermaid' && activeDynamicFlowArtifact
    ? serializeDynamicFlowMermaid(activeDynamicFlowArtifact)
    : undefined;
  const lensTopologyKey = `${semanticLensSession.baseDetail}|${semanticLensSession.settled.map(entry => `${entry.targetId}:${entry.currentDetail}:${entry.nextDetail}`).join('>')}|${semanticLensSession.active.targetId ?? ''}:${semanticLensSession.active.currentDetail ?? ''}:${semanticLensSession.active.nextDetail ?? ''}|${semanticLensSession.focusTransfer?.sourceEntries.map(entry => entry.targetId).join('>') ?? ''}>${semanticLensSession.focusTransfer?.targetId ?? ''}:${semanticLensSession.focusTransfer?.depth ?? ''}`;
  const projectionTopology = useMemo(() => semanticLensSessionProjectionOverride(scene, {
    ...semanticLensSession,
    active: { ...semanticLensSession.active, progress: 0 },
  }), [lensTopologyKey, scene]);
  const projectionOverride = useMemo(() => projectionTopology ? {
    ...projectionTopology,
    progress: semanticLensSession.active.phase === 'idle'
      ? semanticLensSession.focusTransfer?.progress ?? 1
      : semanticLensSession.active.progress,
  } : undefined, [projectionTopology, semanticLensSession.active.phase, semanticLensSession.active.progress, semanticLensSession.focusTransfer?.progress]);
  const activeProjectionEntityIds = useMemo(
    () => semanticLensSessionVisibleEntityIds(scene, semanticLensSession),
    [scene, semanticLensSession],
  );
  const activeProjectionRelationIds = useMemo(
    () => semanticLensSessionVisibleRelationIds(scene, semanticLensSession),
    [scene, semanticLensSession],
  );
  const authoringEnabled = query.fixture !== 'stress'
    && semanticLensSession.active.phase === 'idle'
    && semanticLensSession.focusTransfer === undefined
    && !storyTraveling;
  const editingEnabled = interactionMode === 'edit' && authoringEnabled;
  const authoringEntityIds = useMemo(
    () => new Set(activeProjectionEntityIds),
    [activeProjectionEntityIds],
  );
  const authoringViewId = scene.projection?.familyId ?? navigationIdentity.viewId;
  const selectedProjectedRelation = useMemo(
    () => selectedProjectedRelationForFocus(scene, pickedRelationId, projectionOverride, activeDetail),
    [activeDetail, pickedRelationId, projectionOverride, scene],
  );
  const selectedAuthoringDetail = selectedProjectedRelation?.detail ?? activeDetail;
  const selectedRouteOverride = useMemo(() => pickedRelationId
    ? authoringHistory.present.routeOverrides.find(override => override.viewId === authoringViewId
      && override.detail === selectedAuthoringDetail
      && override.relationId === pickedRelationId)
    : undefined, [authoringHistory.present.routeOverrides, authoringViewId, pickedRelationId, selectedAuthoringDetail]);
  const backendPresentation = presentBackend(diagnostics);
  const storyFocus = useMemo(() => storyFocusPresentation(
    selected.id,
    currentStory?.focusEntityIds ?? [],
    currentStory?.traceRelationIds ?? [],
    {
      storyOpen: currentStory !== undefined && storyPhase !== 'idle',
      selectionOverride: storySelectionOverride,
      ...(pickedRelationId ? { pickedRelationId } : {}),
    },
  ), [currentStory, pickedRelationId, selected.id, storyPhase, storySelectionOverride]);
  const relationFocus = useMemo(
    () => selectedRelationFocusPresentation(
      scene,
      currentStory === undefined || storyPhase === 'idle' || storySelectionOverride ? pickedRelationId : undefined,
      projectionOverride,
    ),
    [currentStory, pickedRelationId, projectionOverride, scene, storyPhase, storySelectionOverride],
  );
  const rendererSelectedId = storyFocus.selectedId;
  const focusedIds = storyFocus.focusedIds;
  const activeRelationIds = useMemo(
    () => new Set([...storyFocus.relationIds, ...relationFocus.relationIds]),
    [relationFocus.relationIds, storyFocus.relationIds],
  );
  const related = useMemo(() => visibleSemanticRelationsForEntity(scene, activeProjectionRelationIds, selected.id), [activeProjectionRelationIds, scene, selected.id]);
  const breadcrumbState = useMemo(() => {
    const byId = new Map(scene.entities.map(entity => [entity.id, entity]));
    const chain: SceneEntity[] = [];
    const root = byId.get(navigationIdentity.rootEntityId) ?? selected;
    let current: SceneEntity | undefined = root;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      chain.unshift(current);
      visited.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    let descendant: SceneEntity | undefined;
    current = selected;
    visited.clear();
    while (current && !visited.has(current.id)) {
      if (current.id === root.id) {
        descendant = selected.id === root.id ? undefined : selected;
        break;
      }
      visited.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return { chain, descendant };
  }, [navigationIdentity.rootEntityId, scene.entities, selected]);
  const searchResults = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();
    return normalizedSearch
      ? scene.entities.filter(entity => `${entity.name} ${entity.kind} ${entity.responsibility} ${entity.source ?? ''}`.toLowerCase().includes(normalizedSearch)).slice(0, 7)
      : defaultSearchSuggestions(scene, {
        selectedId,
        rootId: navigationIdentity.rootEntityId,
        breadcrumbIds: breadcrumbState.chain.map(entity => entity.id),
      });
  }, [breadcrumbState, navigationIdentity.rootEntityId, scene, search, selectedId]);
  const explorerEntities = useMemo(() => {
    if (scene.entities.length > 200) {
      return [selected, ...searchResults].filter((entity, index, all) => all.findIndex(candidate => candidate.id === entity.id) === index);
    }
    const active = new Set(activeProjectionEntityIds);
    return scene.entities.filter(entity => active.has(entity.id));
  }, [activeProjectionEntityIds, scene.entities, searchResults, selected]);
  const visibilityFocusIds = useMemo(
    () => new Set([...storyFocus.requiredIds, ...relationFocus.endpointIds]),
    [relationFocus.endpointIds, storyFocus.requiredIds],
  );
  const isolatedEntityIds = useMemo(
    () => scene.entities.filter(entity => visibilityFocusIds.has(entity.id)).map(entity => entity.id),
    [scene.entities, visibilityFocusIds],
  );
  const isolatedEntityIdSet = useMemo(() => new Set(isolatedEntityIds), [isolatedEntityIds]);
  const isolatedRelationIds = useMemo(
    () => scene.relations
      .filter(relation => isolatedEntityIdSet.has(relation.from) && isolatedEntityIdSet.has(relation.to))
      .map(relation => relation.id),
    [scene.relations, isolatedEntityIdSet],
  );
  const isolatedRelationIdSet = useMemo(() => new Set(isolatedRelationIds), [isolatedRelationIds]);
  const visibleExplorerEntities = useMemo(
    () => visibilityMode === 'isolate' && !storyTraveling
      ? explorerEntities.filter(entity => isolatedEntityIdSet.has(entity.id))
      : explorerEntities,
    [explorerEntities, isolatedEntityIdSet, storyTraveling, visibilityMode],
  );
  const visibleRelated = useMemo(
    () => visibilityMode === 'isolate' && !storyTraveling
      ? related.filter(relation => isolatedRelationIdSet.has(relation.id))
      : related,
    [isolatedRelationIdSet, related, storyTraveling, visibilityMode],
  );
  const sceneObjectSummary = useMemo(
    () => summarizeIds(scene.entities.map(entity => entity.id)),
    [scene.entities],
  );
  const sceneRelationSummary = useMemo(
    () => summarizeIds(scene.relations.map(relation => relation.id)),
    [scene.relations],
  );
  const isolatedObjectSummary = useMemo(() => summarizeIds(isolatedEntityIds), [isolatedEntityIds]);
  const isolatedRelationSummary = useMemo(() => summarizeIds(isolatedRelationIds), [isolatedRelationIds]);
  const flightOwnsPresentation = storyTraveling;
  const effectiveVisibilityMode = flightOwnsPresentation ? 'dim' : visibilityMode;
  const animationActive = inspectorFlightActive || Boolean(currentStory && !reduceMotion && (
    (storyPhase === 'flight' && activeStoryFlight?.flight.running)
    || storyPhase === 'arrival'
    || (storyPhase === 'hold' && storyPlaying)
  ));
  const flowPresentation = useMemo(() => relationshipFlowPolicy({
    reducedMotion: reduceMotion,
    interactionMode,
    selectedRelationIds: relationFocus.relationIds,
    storyRelationIds: storyFocus.relationIds,
    storyHoldPlaying: storyPhase === 'hold' && storyPlaying,
  }), [interactionMode, reduceMotion, relationFocus.relationIds, storyFocus.relationIds, storyPhase, storyPlaying]);
  const flowRelationIds = flowPresentation.relationIds;
  const flowActive = flowPresentation.active;
  const cinematicTransition = flightOwnsPresentation && activeStoryFlight && storyFlightSample
    ? {
        id: activeStoryFlight.id,
        positionMs: storyFlightSample.elapsedMs,
        durationMs: activeStoryFlight.flight.canonicalDurationMs,
        visualProgress: storyFlightSample.visualProgress,
        departureProgress: storyFlightSample.departureProgress,
        sourceFocusedIds: activeStoryFlight.sourceFocusedIds,
        targetFocusedIds: activeStoryFlight.targetFocusedIds,
        sourceRelationIds: activeStoryFlight.sourceRelationIds,
        targetRelationIds: activeStoryFlight.targetRelationIds,
      }
    : undefined;
  const navigationState = canonicalNavigationState({
    ...navigationIdentity,
    selectedId,
    camera,
    detail: baseDetail,
    ...(semanticLensCanonicalPathIds(semanticLensSession).length ? { lensPath: semanticLensCanonicalPathIds(semanticLensSession) } : {}),
    ...(storyStep >= 0 ? {
      story: { id: storyId, step: storyStep, positionMs: storyPositionMs },
    } : {}),
  }, navigationDefaults);
  const navigationRef = useRef<NavigationState>(navigationState);
  navigationRef.current = navigationState;
  const rendererReplayState = JSON.stringify({
    timeline: {
      id: currentStory ? storyId : null,
      step: storyStep,
      positionMs: storyPositionMs,
      playbackState: storyPlaying ? 'playing' : 'paused',
      phase: storyPhase,
      canonicalPhase: storyCanonicalPhase,
      phaseElapsedMs: storyPhaseElapsedMs,
      holdElapsedMs: storyElapsedMs,
      holdDurationMs: currentStory ? storyStepDuration(storyStep) : 0,
      flightProgress: storyFlightSample?.progress ?? (storyCanonicalPhase === 'flight' ? initialCinematicPosition.progress ?? 0 : 1),
      flightDurationMs: activeStoryFlight?.flight.canonicalDurationMs ?? 0,
      sourceCamera: activeStoryFlight?.flight.source ?? null,
      targetCamera: activeStoryFlight?.flight.target ?? null,
      returnToStoryFrameRequired,
      interruption: storyInterruption ?? null,
      reducedMotion: reduceMotion,
    },
    lod: lodReplayRef.current ?? {
      objectId: scene.entities[0]?.id ?? null,
      current: `${scene.entities[0]?.id ?? 'scene'}:${camera.zoom >= 0.52 ? 'detail' : 'compact'}`,
      progress: 1,
      currentWeight: 1,
      previousWeight: 0,
      transitioning: false,
      durationMs: 200,
    },
    camera,
    focus: {
      selectedId: selected.id,
      objectIds: [...focusedIds].sort(),
      relationIds: [...activeRelationIds].sort(),
    },
    projection: {
      detail: activeDetail,
      rootEntityId: navigationIdentity.rootEntityId,
      entityIds: summarizeIds(activeProjectionEntityIds),
      relationIds: summarizeIds(activeProjectionRelationIds),
      lens: {
        phase: semanticLens.phase,
        targetId: semanticLens.targetId ?? null,
        progress: Math.round(semanticLens.progress * 1_000) / 1_000,
        assistBlend: Math.round(semanticLens.assistBlend * 1_000) / 1_000,
        overrideId: projectionOverride?.id ?? null,
        objectCount: projectionOverride?.objects.length ?? 0,
        pathCount: projectionOverride?.paths.length ?? 0,
      },
    },
    visibility: {
      mode: effectiveVisibilityMode,
      requestedMode: visibilityMode,
      objectIds: effectiveVisibilityMode === 'isolate' ? isolatedObjectSummary : sceneObjectSummary,
      relationIds: effectiveVisibilityMode === 'isolate' ? isolatedRelationSummary : sceneRelationSummary,
    },
    safeArea: measuredSafeArea,
    staticGeometry: {
      meshRebuilt: diagnostics.meshRebuilt ?? false,
      revision: diagnostics.staticMeshRevision ?? 0,
      uploadBytes: diagnostics.staticGeometryUploadBytes ?? diagnostics.geometryUploadBytes ?? 0,
      bufferUploads: diagnostics.staticGeometryBufferUploads ?? diagnostics.geometryBufferUploads ?? 0,
      cumulativeUploadBytes: diagnostics.cumulativeStaticGeometryUploadBytes ?? 0,
      cumulativeBufferUploads: diagnostics.cumulativeStaticGeometryBufferUploads ?? 0,
    },
    dynamicStreams: {
      indexUploadBytes: diagnostics.dynamicIndexUploadBytes ?? 0,
      cumulativeIndexUploadBytes: diagnostics.cumulativeDynamicIndexUploadBytes ?? 0,
      styleUploadBytes: diagnostics.dynamicStyleUploadBytes ?? 0,
      cumulativeStyleUploadBytes: diagnostics.cumulativeDynamicStyleUploadBytes ?? 0,
      flowUploadBytes: diagnostics.flowUploadBytes ?? 0,
      cumulativeFlowUploadBytes: diagnostics.cumulativeFlowUploadBytes ?? 0,
      uniformUploadBytes: diagnostics.uniformUploadBytes ?? 0,
      cumulativeUniformUploadBytes: diagnostics.cumulativeUniformUploadBytes ?? 0,
      lodUniformUploadBytes: diagnostics.lodUniformUploadBytes ?? 0,
      cumulativeLodUniformUploadBytes: diagnostics.cumulativeLodUniformUploadBytes ?? 0,
    },
    residency: {
      partitionTotal: diagnostics.residentPartitionTotal ?? 0,
      partitionActive: diagnostics.residentPartitionActive ?? 0,
      partitionDrawn: diagnostics.residentPartitionDrawn ?? 0,
      objectCount: diagnostics.residentObjectCount ?? 0,
      pathCount: diagnostics.residentPathCount ?? 0,
      cacheHits: diagnostics.partitionCacheHits ?? 0,
      cacheMisses: diagnostics.partitionCacheMisses ?? 0,
      cacheEvictions: diagnostics.partitionCacheEvictions ?? 0,
      drawRangeCount: diagnostics.drawRangeCount ?? 0,
    },
    scheduler: {
      rafActive: animationActive,
      frameSampleCount: diagnostics.frameSampleCount ?? 0,
      totalFrameCount: diagnostics.totalFrameCount ?? 0,
      frameWindowIncludesInitialBuild: diagnostics.frameWindowIncludesInitialBuild ?? false,
    },
  });

  function commitNavigation(next: NavigationState, mode: 'push' | 'replace') {
    const canonical = canonicalNavigationState(next, navigationDefaults);
    navigationRef.current = canonical;
    const controller = historyControllerRef.current;
    if (!controller) return;
    if (mode === 'push') controller.push(canonical);
    else controller.replace(canonical);
  }

  function installSemanticSession(session: SemanticLensSession) {
    semanticLensSessionRef.current = session;    semanticMorphStateRef.current = undefined;
    semanticMorphBaselineRef.current = 0;
    setSemanticLensSession(session);
  }

  function collapseInspectorFlightSession(session: SemanticLensSession) {
    if (session.focusTransfer) {
      return {
        ...session,
        settled: session.focusTransfer.progress < .5
          ? session.focusTransfer.sourceEntries
          : session.settled,
        active: idleSemanticLens(),
        focusTransfer: undefined,
      };
    }
    return stabilizeSemanticLensSessionForPan(session);
  }

  function startInspectorCameraFlight(input: {
    targetId: string;
    targetSession: SemanticLensSession;
    targetCamera: Camera;
    navigation: NavigationState;
    historyMode: 'replace';
  }) {
    const previous = pendingInspectorCameraFlightRef.current;
    const sourceSession = collapseInspectorFlightSession(previous
      ? previous.semanticProgress < .5 ? previous.sourceSession : previous.targetSession
      : semanticLensSessionRef.current);
    inspectorCameraFlightControllerRef.current?.cancel();
    installSemanticSession(sourceSession);
    const pending: PendingInspectorCameraFlight = {
      sourceSession,
      targetSession: input.targetSession,
      targetId: input.targetId,
      kind: semanticInspectorFlightKind(sourceSession, input.targetSession),
      semanticProgress: 0,
      navigation: canonicalNavigationState(input.navigation, navigationDefaults),
      historyMode: input.historyMode,
    };
    pendingInspectorCameraFlightRef.current = pending;
    const morphEntry = pending.kind === 'inward'
      ? pending.targetSession.settled.at(-1)
      : pending.kind === 'outward'
        ? pending.sourceSession.settled.at(-1)
        : undefined;
    const sourceBounds = morphEntry ? semanticBounds(scene, morphEntry.targetId, morphEntry.currentDetail) : undefined;
    const targetBounds = morphEntry ? semanticBounds(scene, morphEntry.targetId, morphEntry.nextDetail) : undefined;
    const morphKind = pending.kind === 'inward' || pending.kind === 'outward' ? pending.kind : undefined;
    const rawTarget = morphKind && sourceBounds && targetBounds && !reduceMotion
      ? semanticInspectorRawCameraTarget(input.targetCamera, sourceBounds, targetBounds, morphKind)
      : input.targetCamera;
    const installProgress = (easedCameraProgress: number) => {
      const semanticProgress = semanticInspectorFlightProgress(easedCameraProgress, pending.kind);
      pending.semanticProgress = semanticProgress;
      installSemanticSession(semanticInspectorFlightSession(
        pending.sourceSession,
        pending.targetSession,
        pending.targetId,
        semanticProgress,
      ));
    };
    installProgress(0);
    setInspectorFlightActive(true);
    inspectorCameraFlightControllerRef.current?.start({
      target: rawTarget,
      viewport,
      reducedMotion: reduceMotion,
      ...(morphKind && sourceBounds && targetBounds && !reduceMotion ? { transformCamera: (sample: CameraFlightSample) => {
        const semanticProgress = semanticInspectorFlightProgress(sample.easedProgress, pending.kind);
        return compensateSemanticInspectorFlightCamera(
          sample.camera,
          sourceBounds,
          targetBounds,
          morphKind,
          semanticProgress,
        );
      } } : {}),
      onUpdate: sample => {
        if (pendingInspectorCameraFlightRef.current !== pending) return;
        installProgress(sample.easedProgress);
      },
      onComplete: () => {
        if (pendingInspectorCameraFlightRef.current !== pending) return;
        pendingInspectorCameraFlightRef.current = undefined;
        installSemanticSession(pending.targetSession);
        activeLevelRef.current = semanticDetails.indexOf(semanticLensSessionDetail(pending.targetSession));
        renderedCameraRef.current = input.targetCamera;
        updateCamera(input.targetCamera);
        setInspectorFlightActive(false);
        commitNavigation(canonicalNavigationState({
          ...pending.navigation,
          camera: input.targetCamera,
          detail: pending.targetSession.baseDetail,
          lensPath: semanticLensCanonicalPathIds(pending.targetSession),
        }, navigationDefaults), pending.historyMode);
      },
    });
  }

  function cancelInspectorCameraFlight(): Camera {
    const liveCamera = { ...renderedCameraRef.current };
    const pending = pendingInspectorCameraFlightRef.current;
    if (!pending) return liveCamera;
    inspectorCameraFlightControllerRef.current?.cancel();
    renderedCameraRef.current = liveCamera;
    updateCamera(liveCamera);
    pendingInspectorCameraFlightRef.current = undefined;
    installSemanticSession(pending.targetSession);
    activeLevelRef.current = semanticDetails.indexOf(semanticLensSessionDetail(pending.targetSession));
    setInspectorFlightActive(false);
    commitNavigation(canonicalNavigationState({
      ...pending.navigation,
      camera: liveCamera,
      detail: pending.targetSession.baseDetail,
      lensPath: semanticLensCanonicalPathIds(pending.targetSession),
    }, navigationDefaults), pending.historyMode);
    return liveCamera;
  }

  function abortInspectorCameraFlight(): Camera {
    const liveCamera = { ...renderedCameraRef.current };
    const pending = pendingInspectorCameraFlightRef.current;
    if (!pending) return liveCamera;
    const liveSession = collapseInspectorFlightSession(semanticLensSessionRef.current);
    inspectorCameraFlightControllerRef.current?.cancel();
    pendingInspectorCameraFlightRef.current = undefined;
    renderedCameraRef.current = liveCamera;
    updateCamera(liveCamera);
    installSemanticSession(liveSession);
    activeLevelRef.current = semanticDetails.indexOf(semanticLensSessionDetail(liveSession));
    setInspectorFlightActive(false);
    return liveCamera;
  }

  useEffect(() => {
    const controller = createNavigationHistoryController({
      defaults: navigationDefaults,
      urlOptions: navigationUrlOptions,
      async restore(next, source) {
        abortInspectorCameraFlight();
        const restoreGeneration = navigationRestoreGenerationRef.current + 1;
        navigationRestoreGenerationRef.current = restoreGeneration;
        restoringNavigationRef.current = true;
        const restoredLevel = next.detail
          ? Math.max(0, semanticDetails.indexOf(next.detail))
          : getLevel(next.camera.zoom);
        activeLevelRef.current = restoredLevel;
        const restoredBaseDetail = semanticDetails[restoredLevel];
        const restoredScene = query.fixture === 'stress'
          ? goldenScene
          : activeCreateScene(next.rootEntityId, goldenScene, authoringHistoryRef.current.present);
        const validatedLensPath = validateSemanticLensPath(restoredScene, restoredBaseDetail, next.lensPath ?? []);
        const restoredSettled = validatedLensPath.entries;
        installSemanticSession({ baseDetail: restoredBaseDetail, settled: restoredSettled, active: idleSemanticLens() });
        if (validatedLensPath.truncated) {
          const corrected = canonicalNavigationState({
            ...next,
            lensPath: restoredSettled.map(entry => entry.targetId),
          }, navigationDefaults);
          navigationRef.current = corrected;
          window.queueMicrotask(() => controller.replace(corrected));
          setLiveMessage('Invalid or unrelated semantic lens path was truncated to the deepest valid branch.');
        }
        initialMapFitAppliedRef.current = source === 'popstate' || initialCameraExplicit;
        storyOriginAvailableRef.current = source === 'popstate' && Boolean(next.story);
        setNavigationIdentity({
          repositoryId: next.repositoryId,
          snapshotId: next.snapshotId,
          viewId: next.viewId,
          rootEntityId: next.rootEntityId,
          filterId: next.filterId,
        });
        if (query.fixture !== 'stress') setScene(restoredScene);
        setInspectorHistory([]);
        setSelectedId(next.selectedId);
        updateCamera(next.camera);
        const restoredStep = next.story?.id === storyId ? Math.min(story.steps.length - 1, next.story.step) : -1;
        setStoryStep(restoredStep);
        const restoredPosition = next.story?.id === storyId
          ? decodeStoryPosition(restoredStep, next.story.positionMs)
          : { phase: 'hold' as const, elapsedMs: 0 };
        const restoredElapsed = restoredPosition.phase === 'hold' ? restoredPosition.elapsedMs : 0;
        storyElapsedRef.current = restoredElapsed;
        setStoryElapsedMs(restoredElapsed);
        pausedStoryPhaseRef.current = restoredPosition.phase;
        pausedStoryPhaseElapsedRef.current = restoredPosition.elapsedMs;
        setStoryPhase(restoredStep >= 0 ? 'paused' : 'idle');
        setArrivalElapsedMs(restoredPosition.phase === 'arrival' ? restoredPosition.elapsedMs : 0);
        setReturnToStoryFrameRequired(false);
        setStorySelectionOverride(false);
        storyFlightRef.current = undefined;
        setStoryFlightSample(undefined);
        if (restoredStep >= 0 && restoredPosition.phase === 'flight') {
          const target = frameSemanticEntities(
            scene,
            story.steps[restoredStep].focusEntityIds,
            story.steps[restoredStep].reveal,
            viewport,
          ) ?? next.camera;
          const sourceStep = story.steps[(restoredStep - 1 + story.steps.length) % story.steps.length];
          const sourceSession = semanticStorySession(sourceStep);
          const targetSession = semanticStorySession(story.steps[restoredStep]);
          const now = performance.now();
          const canonicalDurationMs = 1_100;
          const canonicalElapsedMs = Math.round((restoredPosition.progress ?? 0) * canonicalDurationMs);
          const flight = createStoryFlight(next.camera, target, viewport, now, {
            durationMs: Math.max(1, canonicalDurationMs - canonicalElapsedMs),
            canonicalDurationMs,
            canonicalElapsedMs,
            running: false,
          });
          flight.frozenCamera = { ...next.camera };
          const restoredFlight: ActiveStoryFlight = {
            id: `restore:${restoredStep}:${canonicalElapsedMs}`,
            step: restoredStep,
            flight,
            sourceFocusedIds: [...sourceStep.focusEntityIds],
            targetFocusedIds: [...story.steps[restoredStep].focusEntityIds],
            sourceRelationIds: [...sourceStep.traceRelationIds],
            targetRelationIds: [...story.steps[restoredStep].traceRelationIds],
            sourceSession,
            targetSession,
            playAfterArrival: false,
          };
          storyFlightRef.current = restoredFlight;
          installStorySemanticProgress(restoredFlight, restoredPosition.progress ?? 0);
          setStoryFlightSample(sampleStoryFlight(flight, now));
          setStoryFlightEpoch(epoch => epoch + 1);
        }
        storyStartedAtRef.current = undefined;
        setStoryInterruption(undefined);
        setStoryPlaying(false);
        isolationOriginRef.current = undefined;
        setVisibilityMode('all');
        setPickedRelationId(undefined);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (navigationRestoreGenerationRef.current !== restoreGeneration) return;
        restoringNavigationRef.current = false;
        if (source === 'initialize' && !initialCameraExplicit) {
          initialMapFitAppliedRef.current = false;
          setSafeAreaEpoch(epoch => epoch + 1);
        }
      },
      onCommit(commit) {
        setSettledNavigation(commit.state);
        setCameraSettledEpoch(commit.settledEpoch);
      },
    });
    historyControllerRef.current = controller;
    void controller.start();
    return () => {
      controller.dispose();
      if (historyControllerRef.current === controller) historyControllerRef.current = undefined;
    };
  }, [goldenScene, initialCameraExplicit, navigationDefaults, navigationUrlOptions, query.fixture]);

  useEffect(() => {
    if (restoringNavigationRef.current) return;
    const controller = historyControllerRef.current;
    if (!controller) return;
    const currentStoryId = controller.current().story?.id;
    const currentStoryStep = controller.current().story?.step ?? -1;
    if (currentStoryId !== navigationRef.current.story?.id || currentStoryStep !== (navigationRef.current.story?.step ?? -1)) {
      controller.replace(navigationRef.current);
    }
  }, [storyStep]);

  useEffect(() => () => {
    if (shareFeedbackTimerRef.current !== undefined) window.clearTimeout(shareFeedbackTimerRef.current);
    if (semanticControlTimerRef.current !== undefined) window.clearTimeout(semanticControlTimerRef.current);
    if (semanticFocusTransferRafRef.current !== undefined) window.cancelAnimationFrame(semanticFocusTransferRafRef.current);
  }, []);

  useEffect(() => {
    if (shareFeedback?.tone === 'error') {
      shareFallbackRef.current?.focus();
      shareFallbackRef.current?.select();
    }
  }, [shareFeedback]);

  useEffect(() => {
    if (query.fixture !== 'stress') return;
    let current = true;
    void loadStressFixture().then(stressScene => {
      if (!current) return;
      setScene(stressScene);
      const requestedId = navigationRef.current.selectedId;
      const nextSelectedId = stressScene.entities.some(entity => entity.id === requestedId)
        ? requestedId
        : stressScene.entities[0]?.id ?? 'stress-loading';
      setSelectedId(nextSelectedId);
      if (nextSelectedId !== requestedId) {
        commitNavigation(canonicalNavigationState({
          ...navigationRef.current,
          selectedId: nextSelectedId,
          rootEntityId: nextSelectedId,
        }, navigationDefaults), 'replace');
        setNavigationIdentity(current => ({ ...current, rootEntityId: nextSelectedId }));
      }
      setFixtureError(undefined);
      setLiveMessage('Deterministic 5,000 node and 15,000 relation stress fixture loaded.');
    }).catch(error => {
      if (!current) return;
      const message = error instanceof Error ? error.message : String(error);
      setFixtureError(message);
      setLiveMessage(`Stress fixture failed to load: ${message}`);
    });
    return () => { current = false; };
  }, [query.fixture]);

  function currentStoryElapsed() {
    const duration = storyStepDuration(storyStep);
    if (!storyPlaying || storyStartedAtRef.current === undefined) return storyElapsedRef.current;
    return Math.min(duration, Math.max(0, Math.round(storyElapsedRef.current + performance.now() - storyStartedAtRef.current)));
  }

  function publishLodState(state: RendererLodState | undefined) {
    if (!state) return;
    const canonical = {
      ...state,
      progress: Math.round(state.progress * 1_000) / 1_000,
      currentWeight: Math.round(state.currentWeight * 1_000) / 1_000,
      previousWeight: Math.round(state.previousWeight * 1_000) / 1_000,
    };
    lodReplayRef.current = canonical;
    const shell = document.querySelector<HTMLElement>('[data-testid="atlas-app"]');
    if (!shell?.dataset.rendererReplayState) return;
    try {
      const replay = JSON.parse(shell.dataset.rendererReplayState) as Record<string, unknown>;
      replay.lod = canonical;
      shell.dataset.rendererReplayState = JSON.stringify(replay);
    } catch {
      // The declarative state will repopulate the hook on the next React commit.
    }
  }

  function interruptStory(reason: string, liveCamera: Camera = camera, directManipulation = true) {
    if (storyStep < 0) return;
    const now = performance.now();
    let canonicalPhase: StoryCanonicalPhase = storyCanonicalPhase;
    let elapsed = storyPhaseElapsedMs;
    if (storyPhase === 'flight' && storyFlightRef.current) {
      const committedSample = storyFlightSample
        ?? sampleStoryFlight(storyFlightRef.current.flight, storyFlightRef.current.flight.startedAtMs);
      const pausedFlight: StoryFlight = {
        ...storyFlightRef.current.flight,
        elapsedMs: committedSample.segmentElapsedMs,
        canonicalElapsedMs: committedSample.elapsedMs,
        startedAtMs: Math.round(now),
        running: false,
        frozenCamera: { ...liveCamera },
      };
      storyFlightRef.current = { ...storyFlightRef.current, flight: pausedFlight };
      const frozenSample = { ...committedSample, camera: { ...liveCamera } };
      setStoryFlightSample(frozenSample);
      pausedStoryPhaseRef.current = 'flight';
      pausedStoryPhaseElapsedRef.current = frozenSample.elapsedMs;
      canonicalPhase = 'flight';
      elapsed = frozenSample.elapsedMs;
      updateCamera(liveCamera);
    } else if (storyPhase === 'arrival') {
      pausedStoryPhaseRef.current = 'arrival';
      pausedStoryPhaseElapsedRef.current = arrivalElapsedMs;
      canonicalPhase = 'arrival';
      elapsed = arrivalElapsedMs;
    } else if (storyPhase === 'hold' && storyPlaying) {
      elapsed = currentStoryElapsed();
      storyElapsedRef.current = elapsed;
      setStoryElapsedMs(elapsed);
      pausedStoryPhaseRef.current = 'hold';
      pausedStoryPhaseElapsedRef.current = elapsed;
      canonicalPhase = 'hold';
    }
    storyStartedAtRef.current = undefined;
    setStoryPlaying(false);
    setStoryPhase(directManipulation ? 'interrupted' : 'paused');
    setReturnToStoryFrameRequired(directManipulation && canonicalPhase === 'flight');
    setStoryInterruption(reason);
    const next = canonicalNavigationState({
      ...navigationRef.current,
      camera: liveCamera,
      story: {
        id: storyId,
        step: storyStep,
        positionMs: encodeStoryPosition(
          storyStep,
          canonicalPhase,
          elapsed,
          storyFlightRef.current?.flight.canonicalDurationMs,
        ),
      },
    }, navigationDefaults);
    navigationRef.current = next;
    historyControllerRef.current?.replace(next);
    setLiveMessage(`${reason}. Guided explanation paused at ${Math.round(elapsed / 100) / 10} seconds.`);
  }

  function toggleStoryPlayback() {
    const liveCamera = abortInspectorCameraFlight();
    if (storyPlaying || storyPhase === 'flight' || storyPhase === 'arrival') {
      interruptStory('Paused by you', liveCamera, false);
      return;
    }
    if (pausedStoryPhaseRef.current === 'flight' && storyFlightRef.current) {
      if (returnToStoryFrameRequired) {
        setLiveMessage('The map was moved. Use Return to story frame to continue this flight.');
        return;
      }
      const resumed = resumeStoryFlight(storyFlightRef.current.flight, liveCamera, viewport, performance.now());
      storyFlightRef.current = { ...storyFlightRef.current, flight: resumed };
      setStoryFlightSample(sampleStoryFlight(resumed, resumed.startedAtMs));
      setStorySelectionOverride(false);
      setStoryPhase('flight');
      setStoryInterruption(undefined);
      setStoryFlightEpoch(epoch => epoch + 1);
      setLiveMessage(`Resumed camera flight to story step ${storyStep + 1}.`);
      return;
    }
    if (pausedStoryPhaseRef.current === 'arrival') {
      arrivalStartedAtRef.current = performance.now() - pausedStoryPhaseElapsedRef.current;
      arrivalPlayAfterRef.current = true;
      setStoryPhase('arrival');
      setStorySelectionOverride(false);
      setStoryInterruption(undefined);
      return;
    }
    storyStartedAtRef.current = performance.now();
    pausedStoryPhaseRef.current = 'hold';
    setStoryInterruption(undefined);
    setStoryPlaying(true);
    setStorySelectionOverride(false);
    setStoryPhase('hold');
    setLiveMessage(`Resumed story step ${storyStep + 1} with ${Math.ceil((storyStepDuration(storyStep) - storyElapsedRef.current) / 1000)} seconds remaining.`);
  }

  function returnToStoryFrame() {
    const liveCamera = abortInspectorCameraFlight();
    const active = storyFlightRef.current;
    if (!active || pausedStoryPhaseRef.current !== 'flight') return;
    const resumed = resumeStoryFlight(active.flight, liveCamera, viewport, performance.now());
    storyFlightRef.current = { ...active, flight: resumed };
    setStoryFlightSample(sampleStoryFlight(resumed, resumed.startedAtMs));
    setStorySelectionOverride(false);
    setReturnToStoryFrameRequired(false);
    setStoryInterruption(undefined);
    setStoryPhase('flight');
    setStoryFlightEpoch(epoch => epoch + 1);
    setLiveMessage(`Returning to story step ${storyStep + 1}.`);
  }

  function setCamera(updater: (camera: Camera) => Camera) {
    updateCamera(updater);
  }

  function cancelSemanticLens(reason: string) {
    cancelSemanticLensAt(reason, abortInspectorCameraFlight());
  }

  function cancelSemanticLensAt(reason: string, reachedCamera: Camera) {
    const current = semanticLensSessionRef.current;
    if (current.active.phase === 'idle' && current.settled.length === 0) return;
    const idle = idleSemanticLensSession(current.baseDetail);
    semanticLensSessionRef.current = idle;    setSemanticLensSession(idle);
    updateCamera(reachedCamera);
    const next = canonicalNavigationState({
      ...navigationRef.current,
      camera: reachedCamera,
      detail: current.baseDetail,
      lensPath: undefined,
    }, navigationDefaults);
    navigationRef.current = next;
    historyControllerRef.current?.replace(next);
    setLiveMessage(`Semantic lens cancelled by ${reason}.`);
  }

  function animateSemanticFocusTransfer(targetId: string) {
    const startedAt = performance.now();
    if (semanticFocusTransferRafRef.current !== undefined) window.cancelAnimationFrame(semanticFocusTransferRafRef.current);
    const tick = (now: number) => {
      const live = semanticLensSessionRef.current;
      if (live.focusTransfer?.targetId !== targetId) {
        semanticFocusTransferRafRef.current = undefined;
        return;
      }
      const progressed = advanceSemanticLensFocusTransfer(live, (now - startedAt) / 180);
      semanticLensSessionRef.current = progressed;
      setSemanticLensSession(progressed);
      if (progressed.focusTransfer) semanticFocusTransferRafRef.current = window.requestAnimationFrame(tick);
      else semanticFocusTransferRafRef.current = undefined;
    };
    semanticFocusTransferRafRef.current = window.requestAnimationFrame(tick);
  }

  function stabilizeSemanticLensForPan(reachedCamera: Camera) {
    const current = semanticLensSessionRef.current;
    const plan = semanticPanFocusPlan(
      scene,
      current,
      selected.id,
      reachedCamera,
      viewport,
      measureCurrentMapSafeArea(),
      160,
    );
    const nextSession = plan.session;
    semanticLensSessionRef.current = nextSession;    setSemanticLensSession(nextSession);
    const lensPath = semanticLensCanonicalPathIds(nextSession);
    const next = canonicalNavigationState({
      ...navigationRef.current,
      camera: reachedCamera,
      detail: nextSession.baseDetail,
      lensPath: lensPath.length ? lensPath : undefined,
    }, navigationDefaults);
    navigationRef.current = next;
    historyControllerRef.current?.replace(next);
    if (!nextSession.focusTransfer) return;
    animateSemanticFocusTransfer(nextSession.focusTransfer.targetId);
  }

  function beginSemanticZoomBurst(reachedCamera: Camera): Camera {    semanticMorphStateRef.current = undefined;
    semanticMorphBaselineRef.current = 0;
    return reachedCamera;
  }

  function handleSemanticZoom(sample: {
    camera: Camera;
    pointer: LensPoint;
    direction: 'inward' | 'outward' | 'none';
    gestureSettled: boolean;
    mobile: boolean;
    renderedCamera?: Camera;
    gestureStartZoom?: number;
  }): Camera {
    if (query.fixture === 'stress' || (sample.mobile && detailsOpen)) return sample.camera;
    const current = semanticLensSessionRef.current;
    const reversingEntry = current.active.phase === 'idle' && sample.direction === 'outward'
      ? current.settled.at(-1)
      : undefined;
    const activeState = current.active.phase !== 'idle' ? current.active : reversingEntry
      ? { phase: 'settled' as const, ...reversingEntry, progress: 1, assistBlend: 0 }
      : undefined;
    if (!semanticMorphStateRef.current && activeState) {
      semanticMorphStateRef.current = activeState;
      semanticMorphBaselineRef.current = activeState.progress;
    }
    const currentDetail = activeState?.currentDetail ?? semanticLensSessionDetail(current);
    const safeArea = measureCurrentMapSafeArea();
    // Eligibility belongs to the camera produced by this input sample. The rendered
    // camera is the pre-input/structurally compensated view and can lag one wheel tick.
    const targetingCamera = sample.camera;
    const deepest = current.settled.at(-1);
    const settledTargetIds = new Set(current.settled.map(entry => entry.targetId));
    const eligibleIds = deepest
      ? new Set(semanticLensBranchEntityIds(scene, deepest.targetId, semanticLensSessionDetail(current))
          .filter(id => id !== deepest.targetId && !settledTargetIds.has(id)))
      : undefined;
    const candidateTarget = findSemanticLensTarget(
      scene,
      currentDetail,
      targetingCamera,
      viewport,
      safeArea,
      sample.pointer,
      [selected.id, navigationIdentity.rootEntityId],
      eligibleIds,
      settledTargetIds,
    );
    const activeTarget = activeState?.targetId && activeState.currentDetail
      ? measureSemanticLensTarget(scene, activeState.targetId, activeState.currentDetail, targetingCamera, viewport, safeArea, sample.pointer)
      : undefined;
    const nowMs = performance.now();
    const nextSession = reduceSemanticLensSession(current, {
      nowMs,
      zoom: sample.camera.zoom,
      direction: sample.direction,
      activeTarget,
      candidateTarget,
      mobile: sample.mobile,
      reducedMotion: reduceMotion,
      gestureSettled: sample.gestureSettled,
      gestureStartZoom: sample.gestureStartZoom,
    });
    semanticLensSessionRef.current = nextSession;
    setSemanticLensSession(nextSession);
    const newlySettled = nextSession.settled.length > current.settled.length
      ? nextSession.settled.at(-1)
      : undefined;
    const trackedMorph = semanticMorphStateRef.current;
    if (nextSession.active.phase !== 'idle') {
      if (trackedMorph?.targetId !== nextSession.active.targetId) semanticMorphBaselineRef.current = 0;
      semanticMorphStateRef.current = nextSession.active;
    } else if (newlySettled) {
      if (trackedMorph?.targetId !== newlySettled.targetId) semanticMorphBaselineRef.current = 0;
      semanticMorphStateRef.current = {
        phase: 'settled',
        ...newlySettled,
        progress: 1,
        assistBlend: 0,
      };
    } else if (trackedMorph?.targetId && trackedMorph.currentDetail && trackedMorph.nextDetail) {
      const remainsSettled = nextSession.settled.some(entry => entry.targetId === trackedMorph.targetId);
      semanticMorphStateRef.current = {
        ...trackedMorph,
        phase: remainsSettled ? 'settled' : 'reversing',
        progress: remainsSettled ? 1 : 0,
        assistBlend: 0,
      };
    }
    const presentation = nextSession.active.phase !== 'idle'
      ? nextSession.active
      : semanticMorphStateRef.current;
    // Build the owner framing, then let composeSemanticZoomCamera decide how much of
    // it reaches the camera: a LIVE wheel/pinch gesture stays cursor-anchored (the
    // owner-morph reflow pin still applies, but safe-viewport containment — the
    // recentre the user reported as a "snap to the parent, then back" — is withheld
    // until the gesture settles). (task #32)
    let framing: SemanticZoomFraming | undefined;
    if (presentation?.targetId && presentation.currentDetail && presentation.nextDetail) {
      const sourceBounds = semanticBounds(scene, presentation.targetId, presentation.currentDetail);
      const targetBounds = semanticBounds(scene, presentation.targetId, presentation.nextDetail);
      if (sourceBounds && targetBounds) {
        framing = {
          ownerBounds: interpolateSemanticOwnerBounds(sourceBounds, targetBounds, presentation.progress),
          morph: { sourceBounds, targetBounds, progress: presentation.progress, baselineProgress: semanticMorphBaselineRef.current },
        };
      }
    }
    if (!framing) {
      const deepestOwner = nextSession.settled.at(-1);
      const ownerBounds = deepestOwner ? semanticBounds(scene, deepestOwner.targetId, deepestOwner.nextDetail) : undefined;
      if (ownerBounds) framing = { ownerBounds };
    }
    const renderedCamera = composeSemanticZoomCamera(sample.camera, sample.gestureSettled, framing, viewport, safeArea);    const navigation = canonicalNavigationState({
      ...navigationRef.current,
      camera: renderedCamera,
      detail: nextSession.baseDetail,
      lensPath: semanticLensCanonicalPathIds(nextSession),
    }, navigationDefaults);
    navigationRef.current = navigation;
    historyControllerRef.current?.replace(navigation);
    return renderedCamera;
  }

  function semanticZoomControl(direction: 'inward' | 'outward') {
    const safeArea = measureCurrentMapSafeArea();
    const pointer = {
      x: safeArea.left + (viewport.width - safeArea.left - safeArea.right) / 2,
      y: safeArea.top + (viewport.height - safeArea.top - safeArea.bottom) / 2,
    };
    const liveCamera = cancelInspectorCameraFlight();
    const burstCamera = beginSemanticZoomBurst(liveCamera);
    const raw = {
      ...burstCamera,
      zoom: clampAtlasCameraZoom(liveCamera.zoom * (direction === 'inward' ? 1.2 : 1 / 1.2)),
    };
    const first = handleSemanticZoom({ camera: raw, renderedCamera: liveCamera, pointer, direction, gestureSettled: false, mobile: false });
    updateCamera(first);
    if (semanticControlTimerRef.current !== undefined) window.clearTimeout(semanticControlTimerRef.current);
    semanticControlTimerRef.current = window.setTimeout(() => {
      const settled = handleSemanticZoom({ camera: raw, renderedCamera: first, pointer, direction: 'none', gestureSettled: true, mobile: false });
      updateCamera(settled);
      settleCamera(settled);
      semanticControlTimerRef.current = undefined;
    }, 100);
  }

  function settleCamera(next: Camera) {
    const base = canonicalNavigationState({
      ...navigationRef.current,
      camera: next,
      detail: baseDetail,
      lensPath: semanticLensCanonicalPathIds(semanticLensSessionRef.current),
    }, navigationDefaults);
    historyControllerRef.current?.commitSettledCamera(next, base);
  }

  function flushNavigation(next: Camera) {
    historyControllerRef.current?.flush(canonicalNavigationState({
      ...navigationRef.current,
      camera: next,
      detail: baseDetail,
      lensPath: semanticLensCanonicalPathIds(semanticLensSessionRef.current),
    }, navigationDefaults));
  }

  function navigateCamera(next: Camera, mode: 'push' | 'replace' = 'push', interruptionReason = 'Adjusted the map view') {
    const liveCamera = abortInspectorCameraFlight();
    interruptStory(interruptionReason, liveCamera);
    updateCamera(next);
    commitNavigation(canonicalNavigationState({
      ...navigationRef.current,
      camera: next,
      detail: baseDetail,
    }, navigationDefaults), mode);
  }

  function inspectorTabFor(entity: SceneEntity, intent: 'auto' | 'source' | 'details' = 'auto') {
    const canShowSource = entity.detail === 'code' && Boolean(entity.sourceExcerpts?.length);
    return inspectorTabForEntity(canShowSource, intent);
  }

  function selectInspectorTab(tab: 'source' | 'details', focus = true) {
    if (tab === 'source' && !sourceAvailable) {
      setLiveMessage('No portable source excerpt is available for this entity.');
      return;
    }
    setInspectorTab(tab);
    setSafeAreaEpoch(epoch => epoch + 1);
    if (focus) window.setTimeout(() => (tab === 'source' ? sourceTabRef : detailsTabRef).current?.focus({ preventScroll: true }), 0);
  }

  function navigateInspectorTabs(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home'
      ? (sourceAvailable ? 'source' : 'details')
      : event.key === 'End'
        ? 'details'
        : inspectorTab === 'source'
          ? 'details'
          : sourceAvailable
            ? 'source'
            : 'details';
    selectInspectorTab(next);
  }

  function reframeEntityAfterInspectorChange(entity: SceneEntity, force = false) {
    const generation = inspectorReframeGenerationRef.current + 1;
    inspectorReframeGenerationRef.current = generation;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (generation !== inspectorReframeGenerationRef.current) return;
      const canvas = document.querySelector<HTMLElement>('[data-testid="atlas-canvas"]');
      if (!canvas) return;
      const canvasRect = canvas.getBoundingClientRect();
      const nextViewport = { width: Math.max(1, canvasRect.width), height: Math.max(1, canvasRect.height) };
      const detail = semanticLensSessionDetail(semanticLensSessionRef.current);
      const bounds = semanticBounds(scene, entity.id, detail) ?? entity;
      const safeArea = measureCurrentMapSafeArea();
      const currentCamera = navigationRef.current.camera;
      const reframeCamera = force && entity.detail === 'code'
        ? { ...currentCamera, zoom: levels[3]!.zoom }
        : currentCamera;
      const plan = selectedEntityReframePlan({
        camera: reframeCamera,
        bounds,
        viewport: nextViewport,
        safeArea,
        forceCenter: force && entity.detail === 'code',
      });
      if (!plan.reframed && plan.camera === currentCamera) return;
      updateCamera(plan.camera);
      commitNavigation(canonicalNavigationState({
        ...navigationRef.current,
        camera: plan.camera,
        detail: baseDetail,
      }, navigationDefaults), 'replace');
    }));
  }

  function beginInspectorResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 900) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = detailsWidth;
    const move = (pointer: PointerEvent) => {
      setDetailsWidth(clampInspectorWidth(startWidth + startX - pointer.clientX, window.innerWidth));
      setSafeAreaEpoch(epoch => epoch + 1);
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      reframeEntityAfterInspectorChange(selected);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
  }

  function resizeInspectorWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const amount = event.shiftKey ? 64 : 16;
    setDetailsWidth(current => clampInspectorWidth(current + (event.key === 'ArrowLeft' ? amount : -amount), window.innerWidth));
    setSafeAreaEpoch(epoch => epoch + 1);
    window.setTimeout(() => reframeEntityAfterInspectorChange(selected), 0);
  }

  function currentInspectorHistorySubject(): InspectorHistorySubject {
    const currentNavigation = navigationRef.current;
    const navigation = {
      camera: { ...currentNavigation.camera },
      ...(currentNavigation.detail ? { detail: currentNavigation.detail } : {}),
      ...(currentNavigation.lensPath?.length ? { lensPath: [...currentNavigation.lensPath] } : {}),
    };
    return pickedRelationId
      ? { kind: 'relation', relationId: pickedRelationId, ownerEntityId: selected.id, tab: 'details', navigation }
      : { kind: 'entity', entityId: selected.id, tab: inspectorTab, navigation };
  }

  function updateInspectorHistoryForNavigation(origin: 'external' | 'panel' | 'history' | 'preserve') {
    if (origin === 'panel') {
      const subject = currentInspectorHistorySubject();
      setInspectorHistory(current => pushInspectorHistory(current, subject));
    } else if (origin === 'external') {
      setInspectorHistory([]);
    }
  }

  function focusEntity(
    entity: SceneEntity,
    historyMode: 'push' | 'replace' = 'replace',
    cameraIntent: 'preserve' | 'frame' = 'preserve',
    inspectorIntent: 'auto' | 'source' | 'details' = 'auto',
    inspectorNavigation: 'external' | 'panel' | 'history' | 'preserve' = 'external',
  ) {
    const liveCamera = abortInspectorCameraFlight();
    updateInspectorHistoryForNavigation(inspectorNavigation);
    if (!mainDiagramActive) activateDiagramView(MAIN_DIAGRAM_SURFACE_ID);
    interruptStory(`Selected ${entity.name}`);
    setStorySelectionOverride(storyStep >= 0);
    inspectorSelectionRef.current = entity.id;
    setSelectedId(entity.id);
    setPickedRelationId(undefined);
    setDetailsOpen(true);
    const nextInspectorTab = inspectorTabFor(entity, inspectorIntent);
    const currentSession = semanticLensSessionRef.current;
    const nextSession = nextInspectorTab === 'source'
      ? semanticSourceSession(scene, currentSession, entity.id)
      : currentSession;
    if (nextSession !== currentSession) {
      semanticLensSessionRef.current = nextSession;      semanticMorphStateRef.current = undefined;
      semanticMorphBaselineRef.current = 0;
      setSemanticLensSession(nextSession);
      activeLevelRef.current = semanticDetails.indexOf('code');
    }
    setInspectorTab(nextInspectorTab);
    setSafeAreaEpoch(epoch => epoch + 1);
    if (inspectorIntent === 'source' && nextInspectorTab === 'source') {
      window.setTimeout(() => sourceTabRef.current?.focus({ preventScroll: true }), 0);
    }
    setSearchOpen(false);
    setSearch('');
    const nextCamera = cameraIntent === 'frame'
      ? frameEntities(scene, [entity.id], viewport) ?? liveCamera
      : liveCamera;
    if (nextCamera !== liveCamera) updateCamera(nextCamera);
    commitNavigation(canonicalNavigationState({
      ...navigationRef.current,
      selectedId: entity.id,
      camera: nextCamera,
      detail: nextSession.baseDetail,
      lensPath: semanticLensCanonicalPathIds(nextSession),
    }, navigationDefaults), historyMode);
    setLiveMessage(`${entity.name} selected. ${entity.responsibility}`);
    reframeEntityAfterInspectorChange(entity, nextInspectorTab === 'source');
  }

  function navigateInspectorHierarchy(entity: SceneEntity) {
    const plan = semanticInspectorHierarchyPlan(
      scene,
      entity.id,
      viewport,
      measureCurrentMapSafeArea(),
      semanticLensSessionRef.current,
      renderedCameraRef.current,
    );
    if (!plan) {
      setLiveMessage(`${entity.name} is not available in its canonical C4 level.`);
      return;
    }
    if (!inspectorCameraFlightControllerRef.current?.isActive()) updateInspectorHistoryForNavigation('panel');
    inspectorReframeGenerationRef.current += 1;
    interruptStory(`Opened ${entity.name} at ${plan.detail} detail`, renderedCameraRef.current);
    setStorySelectionOverride(storyStep >= 0);
    inspectorSelectionRef.current = entity.id;
    setSelectedId(entity.id);
    setPickedRelationId(undefined);
    setInspectorTab(inspectorTabFor(entity));
    setDetailsOpen(true);
    setSafeAreaEpoch(epoch => epoch + 1);
    startInspectorCameraFlight({
      targetId: entity.id,
      targetSession: plan.session,
      targetCamera: plan.camera,
      navigation: canonicalNavigationState({
      ...navigationRef.current,
      selectedId: entity.id,
      camera: plan.camera,
      detail: plan.session.baseDetail,
      lensPath: semanticLensCanonicalPathIds(plan.session),
      }, navigationDefaults),
      historyMode: plan.historyMode,
    });
    setSearchOpen(false);
    setSearch('');
    setLiveMessage(`${entity.name} opened at its ${plan.detail} level.`);
  }

  function changeVisibility(next: 'all' | 'dim' | 'isolate') {
    if (next === visibilityMode) return;
    interruptStory(`Changed context visibility to ${next}`);
    if (next === 'isolate' && visibilityMode !== 'isolate') {
      isolationOriginRef.current = {
        camera: { ...camera },
        selectedId: selected.id,
        pickedRelationId,
        visibilityMode,
      };
    } else if (visibilityMode === 'isolate') {
      isolationOriginRef.current = undefined;
    }
    setVisibilityMode(next);
    const isolatedCount = scene.entities.filter(entity => visibilityFocusIds.has(entity.id)).length;
    setLiveMessage(next === 'dim'
      ? 'Other entities dimmed. They remain available for selection and keyboard navigation.'
      : next === 'isolate'
        ? `Showing ${isolatedCount} of ${scene.entities.length} entities in the focused context.`
        : 'Full architecture context restored.');
  }

  function restoreVisibility() {
    if (visibilityMode !== 'isolate') {
      changeVisibility('all');
      window.requestAnimationFrame(() => visibilityControlRef.current?.focus({ preventScroll: true }));
      return;
    }
    abortInspectorCameraFlight();
    interruptStory('Restored the full architecture context');
    const origin = isolationOriginRef.current;
    isolationOriginRef.current = undefined;
    if (!origin) {
      setVisibilityMode('all');
      setLiveMessage('Full architecture context restored.');
      window.requestAnimationFrame(() => visibilityControlRef.current?.focus({ preventScroll: true }));
      return;
    }
    setVisibilityMode(origin.visibilityMode);
    setInspectorHistory([]);
    setSelectedId(origin.selectedId);
    setPickedRelationId(origin.pickedRelationId);
    updateCamera(origin.camera);
    commitNavigation(canonicalNavigationState({
      ...navigationRef.current,
      selectedId: origin.selectedId,
      camera: origin.camera,
      detail: baseDetail,
    }, navigationDefaults), 'replace');
    const restored = scene.entities.find(entity => entity.id === origin.selectedId);
    setLiveMessage(`Full architecture context restored. ${restored?.name ?? origin.selectedId} selected.`);
    window.requestAnimationFrame(() => visibilityControlRef.current?.focus({ preventScroll: true }));
  }

  function authoredScene(document: ArchitectureAuthoringDocument, currentScene: AtlasScene) {
    return activeCreateScene(navigationIdentity.rootEntityId, currentScene, document);
  }

  function installAuthoringHistory(
    next: GestureHistory<ArchitectureAuthoringDocument>,
    message: string,
  ) {
    if (next === authoringHistoryRef.current) return;
    authoringHistoryRef.current = next;
    setAuthoringHistory(next);
    setScene(currentScene => authoredScene(next.present, currentScene));
    setLiveMessage(message);
  }

  function commitAuthoringCommands(
    commands: readonly ArchitectureAuthoringCommand[],
    message: string,
  ) {
    let document = authoringHistoryRef.current.present;
    for (const command of commands) {
      document = applyArchitectureAuthoringCommand(document, command).document;
    }
    installAuthoringHistory(commitGesture(authoringHistoryRef.current, document), message);
  }

  function changeInteractionMode(next: 'view' | 'edit') {
    setInteractionMode(next);
    if (next === 'view') setAuthoringTool('select');
    setLiveMessage(next === 'edit'
      ? 'Edit mode enabled. Relationship authoring tools are available.'
      : 'View mode enabled. Architecture inspection remains available; authoring controls are hidden.');
  }

  function createRelationship(gesture: {
    from: string;
    to: string;
    sourcePort: ConnectionPort;
    targetPort: ConnectionPort;
    routePoints: AuthoringPoint[];
  }) {
    if (!editingEnabled) return;
    const source = scene.entities.find(entity => entity.id === gesture.from);
    const target = scene.entities.find(entity => entity.id === gesture.to);
    if (!source || !target || source.id === target.id) return;
    let relationId: string;
    do {
      relationId = `relation:user:${authoredRelationSequenceRef.current++}`;
    } while (scene.relations.some(relation => relation.id === relationId));
    const scope = {
      viewId: authoringViewId,
      detail: activeDetail,
      relationId,
    };
    const override: RelationRouteOverride = {
      ...scope,
      id: relationRouteOverrideId(scope),
      intent: {
        sourcePort: gesture.sourcePort,
        targetPort: gesture.targetPort,
        waypoints: [],
      },
    };
    commitAuthoringCommands([
      {
        type: 'put-relation',
        relation: {
          id: relationId,
          from: source.id,
          to: target.id,
          kind: 'uses',
          label: 'Uses',
        },
      },
      { type: 'put-route-override', override },
    ], `Relationship created from ${source.name} to ${target.name}.`);
    setInspectorHistory([]);
    setPickedRelationId(relationId);
    setAuthoringTool('select');
  }

  function guideRelationship(gesture: {
    relationId: string;
    visualRelationId: string;
    detail: SemanticDetail;
    intent: GuidedRelationshipRouteIntent;
  }) {
    if (!editingEnabled) return;
    const document = authoringHistoryRef.current.present;
    const existing = document.routeOverrides.find(override => override.viewId === authoringViewId
      && override.detail === gesture.detail
      && override.relationId === gesture.relationId);
    const projected = scene.projection?.projectedRelationsByDetail[gesture.detail]
      .find(relation => relation.id === gesture.visualRelationId);
    const scope = existing
      ? {
          viewId: existing.viewId,
          detail: existing.detail,
          relationId: existing.relationId,
          ...(existing.visualEdgeId ? { visualEdgeId: existing.visualEdgeId } : {}),
        }
      : {
          viewId: authoringViewId,
          detail: gesture.detail,
          relationId: gesture.relationId,
          visualEdgeId: projected?.id ?? gesture.visualRelationId,
        };
    const override: RelationRouteOverride = {
      ...scope,
      id: existing?.id ?? relationRouteOverrideId(scope),
      intent: gesture.intent,
    };
    commitAuthoringCommands(
      [{ type: 'put-route-override', override }],
      'Relationship route guide applied.',
    );
  }

  function resetSelectedRelationshipRoute() {
    if (!editingEnabled || !pickedRelationId) return;
    const override = authoringHistoryRef.current.present.routeOverrides.find(candidate =>
      candidate.viewId === authoringViewId
      && candidate.detail === selectedAuthoringDetail
      && candidate.relationId === pickedRelationId);
    if (!override) return;
    commitAuthoringCommands(
      [{ type: 'reset-route-override', overrideId: override.id }],
      'Relationship route reset to automatic routing.',
    );
  }

  function deleteSelectedRelationship() {
    if (!editingEnabled || !pickedRelationId || !scene.relations.some(relation => relation.id === pickedRelationId)) return;
    const relation = scene.relations.find(candidate => candidate.id === pickedRelationId)!;
    commitAuthoringCommands(
      [{ type: 'delete-relation', relationId: pickedRelationId }],
      `Deleted ${relation.label ?? relation.kindLabel ?? 'selected'} relationship.`,
    );
    setInspectorHistory([]);
    setPickedRelationId(undefined);
  }

  function undoAuthoringGesture() {
    if (!editingEnabled) return;
    const next = undoGesture(authoringHistoryRef.current);
    if (next === authoringHistoryRef.current) return;
    if (pickedRelationId?.startsWith('relation:user:')
      && !next.present.relations.some(relation => relation.id === pickedRelationId)) {
      setPickedRelationId(undefined);
    }
    installAuthoringHistory(next, 'Undid relationship edit.');
  }

  function redoAuthoringGesture() {
    if (!editingEnabled) return;
    installAuthoringHistory(redoGesture(authoringHistoryRef.current), 'Redid relationship edit.');
  }

  function inspectRelation(
    relation: SceneRelation,
    inspectorNavigation: 'external' | 'panel' | 'history' | 'preserve' = 'external',
  ) {
    abortInspectorCameraFlight();
    updateInspectorHistoryForNavigation(inspectorNavigation);
    const relationName = relation.label ?? relation.kindLabel ?? 'relationship';
    const from = scene.entities.find(entity => entity.id === relation.from);
    const to = scene.entities.find(entity => entity.id === relation.to);
    const owner = selected.id === relation.from || selected.id === relation.to ? selected : from ?? to ?? selected;
    interruptStory(`Selected ${relationName}`);
    setStorySelectionOverride(storyStep >= 0);
    setPickedRelationId(relation.id);
    setInspectorTab('details');
    setDetailsOpen(true);
    setSafeAreaEpoch(epoch => epoch + 1);
    reframeEntityAfterInspectorChange(owner);
    const endpoints = from && to ? ` from ${from.name} to ${to.name}` : '';
    setLiveMessage(`${relationName} relationship selected${endpoints}.`);
  }

  function restoreInspectorHistoryNavigation(subject: InspectorHistorySubject) {
    inspectorReframeGenerationRef.current += 1;
    const plan = inspectorHistoryRestorePlan(navigationRef.current, subject);
    const restoredBaseDetail = plan.state.detail ?? semanticLensSessionRef.current.baseDetail;
    const restoredLens = validateSemanticLensPath(scene, restoredBaseDetail, plan.state.lensPath ?? []);
    const restoredSession: SemanticLensSession = {
      baseDetail: restoredBaseDetail,
      settled: restoredLens.entries,
      active: idleSemanticLens(),
    };
    startInspectorCameraFlight({
      targetId: subject.kind === 'entity' ? subject.entityId : subject.ownerEntityId,
      targetSession: restoredSession,
      targetCamera: plan.state.camera,
      navigation: canonicalNavigationState({
        ...plan.state,
        detail: restoredSession.baseDetail,
        lensPath: semanticLensCanonicalPathIds(restoredSession),
      }, navigationDefaults),
      historyMode: plan.mode,
    });
  }

  function navigateInspectorBack() {
    const popped = popInspectorHistory(inspectorHistory);
    const subject = popped.subject;
    if (!subject) return;
    setInspectorHistory(popped.history);
    if (!popped.history.length) {
      const restoredTab = subject.kind === 'entity' ? subject.tab : 'details';
      window.setTimeout(() => (restoredTab === 'source' ? sourceTabRef : detailsTabRef).current?.focus({ preventScroll: true }), 0);
    }
    if (subject.kind === 'entity') {
      const entity = scene.entities.find(candidate => candidate.id === subject.entityId);
      if (!entity) {
        setInspectorHistory([]);
        setLiveMessage('The previous inspector entity is no longer available.');
        return;
      }
      interruptStory(`Returned to ${entity.name}`, renderedCameraRef.current);
      setStorySelectionOverride(storyStep >= 0);
      inspectorSelectionRef.current = entity.id;
      setSelectedId(entity.id);
      setPickedRelationId(undefined);
      setInspectorTab(subject.tab);
      setDetailsOpen(true);
      setSafeAreaEpoch(epoch => epoch + 1);
      restoreInspectorHistoryNavigation(subject);
      setLiveMessage(`${entity.name} restored in the details panel.`);
      return;
    }
    const relation = scene.relations.find(candidate => candidate.id === subject.relationId);
    const owner = scene.entities.find(candidate => candidate.id === subject.ownerEntityId);
    if (!relation || !owner) {
      setInspectorHistory([]);
      setLiveMessage('The previous inspector relationship is no longer available.');
      return;
    }
    const relationName = relation.label ?? relation.kindLabel ?? 'relationship';
    interruptStory(`Returned to ${relationName}`, renderedCameraRef.current);
    setStorySelectionOverride(storyStep >= 0);
    inspectorSelectionRef.current = owner.id;
    setSelectedId(owner.id);
    setPickedRelationId(relation.id);
    setInspectorTab('details');
    setDetailsOpen(true);
    setSafeAreaEpoch(epoch => epoch + 1);
    restoreInspectorHistoryNavigation(subject);
    setLiveMessage(`${relationName} relationship restored in the details panel.`);
  }

  function handlePick(result: PickResult) {
    if (result.kind === 'entity') {
      const entity = scene.entities.find(candidate => candidate.id === result.id);
      if (entity) focusEntity(entity, 'replace', 'preserve', 'details');
      else setLiveMessage(`The renderer returned unknown entity ${result.id}.`);
      return;
    }

    const relation = scene.relations.find(candidate => candidate.id === result.id);
    if (!relation) {
      setLiveMessage(`The renderer returned unknown relation ${result.id}.`);
      return;
    }
    inspectRelation(relation);
  }

  function closeDetails() {
    // Move focus before the next render applies aria-hidden. This avoids hiding
    // the currently focused close/action control from assistive technology.
    detailsOpenerRef.current?.focus({ preventScroll: true });
    setDetailsOpen(false);
    setSafeAreaEpoch(epoch => epoch + 1);
    setLiveMessage('Inspector closed. Focus returned to the inspector button.');
  }

  function toggleDetails() {
    if (detailsOpen) closeDetails();
    else {
      setDetailsOpen(true);
      setInspectorTab(inspectorTabFor(selected));
      setSafeAreaEpoch(epoch => epoch + 1);
      window.setTimeout(() => reframeEntityAfterInspectorChange(selected), 0);
      setLiveMessage(`${selected.name} inspector opened.`);
    }
  }

  function selectLevel(index: number) {
    const liveCamera = abortInspectorCameraFlight();
    const level = levels[index];
    const detail = semanticDetails[index];
    const currentSession = semanticLensSessionRef.current;
    const previousDetail = semanticLensSessionDetail(currentSession);
    const preferredIds = [selected.id, ...currentSession.settled.map(entry => entry.targetId).reverse(), navigationIdentity.rootEntityId];
    const nextSession = semanticLevelSession(scene, detail, preferredIds);
    const previousAnchorId = currentSession.settled.at(-1)?.targetId
      ?? (semanticBounds(scene, selected.id, previousDetail) ? selected.id : navigationIdentity.rootEntityId);
    const targetAnchorId = nextSession.settled.at(-1)?.targetId
      ?? (semanticBounds(scene, selected.id, detail) ? selected.id : navigationIdentity.rootEntityId);
    const previousBounds = semanticBounds(scene, previousAnchorId, previousDetail);
    const targetBounds = semanticBounds(scene, targetAnchorId, detail)
      ?? semanticBounds(scene, navigationIdentity.rootEntityId, detail)
      ?? selected;
    semanticLensSessionRef.current = nextSession;    semanticMorphStateRef.current = undefined;
    semanticMorphBaselineRef.current = 0;
    setSemanticLensSession(nextSession);
    activeLevelRef.current = index;
    const anchored = retargetCameraForSemanticBand(liveCamera, previousBounds, targetBounds, level.zoom, viewport);
    const mapSafeArea = measureCurrentMapSafeArea();
    const framedCamera = index === 0 && !scopeFitsSafeViewport(
      scene,
      navigationIdentity.rootEntityId,
      detail,
      anchored,
      viewport,
      mapSafeArea,
    )
      ? frameProjectionScope(scene, navigationIdentity.rootEntityId, detail, viewport, mapSafeArea) ?? anchored
      : anchored;
    const nextCamera = containSemanticOwnerCamera(framedCamera, targetBounds, viewport, mapSafeArea);
    interruptStory(`Changed to ${level.name} detail`);
    updateCamera(nextCamera);
    commitNavigation(canonicalNavigationState({
      ...navigationRef.current,
      camera: nextCamera,
      detail: nextSession.baseDetail,
      lensPath: semanticLensCanonicalPathIds(nextSession),
    }, navigationDefaults), 'replace');
    setLiveMessage(`${level.name} detail level selected.`);
  }

  function openInside(entityId = selected.id, inspectorNavigation: 'external' | 'preserve' = 'external') {
    const liveCamera = abortInspectorCameraFlight();
    updateInspectorHistoryForNavigation(inspectorNavigation);
    if (query.fixture === 'stress') return;
    const target = scene.entities.find(entity => entity.id === entityId) ?? selected;
    if (target.detail === 'code') {
      focusEntity(target, 'replace', 'preserve', 'source', 'history');
      setLiveMessage(target.sourceExcerpts?.length
        ? `${target.name} source opened at its frozen evidence range.`
        : `${target.name} has no portable frozen source excerpt.`);
      return;
    }
    // Scan scoped compile: the top scene carries bands only down to its focus's
    // depth, so a deeper scope can be absent and a lens drill would dead-end. When
    // it is, re-enter the guarded compile seam (activeCreateScene → guardScanCompile)
    // for the target scope, reset the now-stale lens session, and frame in. Below
    // the gate every band is present so this never fires (Okie/golden untouched).
    // Inspector-history mode was already applied above, so 'preserve' survives.
    const drillDetail = scanFixture ? scanDrillDeeperDetail(scene, target) : undefined;
    if (drillDetail) {
      interruptStory(`Opened ${target.name}`);
      cancelSemanticLensAt('scan drill recompile', liveCamera);
      const nextScene = activeCreateScene(target.id, scene, authoringHistoryRef.current.present);
      const nextCamera = frameProjectionScope(nextScene, target.id, baseDetail, viewport, measureCurrentMapSafeArea())
        ?? (() => {
          const bounds = semanticBounds(nextScene, target.id, baseDetail) ?? target;
          return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom: levels[activeLevel].zoom };
        })();
      setScene({ ...nextScene, scanDrillRecompile: { targetId: target.id, deeperDetail: drillDetail } });
      setSelectedId(target.id);
      setNavigationIdentity(current => ({ ...current, rootEntityId: target.id }));
      updateCamera(nextCamera);
      commitNavigation(canonicalNavigationState({
        ...navigationRef.current,
        rootEntityId: target.id,
        selectedId: target.id,
        camera: nextCamera,
        detail: baseDetail,
      }, navigationDefaults), 'push');
      setLiveMessage(`${target.name} opened. Compiled its deeper ${levels[semanticDetails.indexOf(drillDetail)]?.name ?? drillDetail} scope.`);
      return;
    }
    const plan = semanticOpenNextLayer(
      scene,
      semanticLensSessionRef.current,
      target.id,
      viewport,
      measureCurrentMapSafeArea(),
      navigationIdentity.rootEntityId,
    );
    if (!plan) {
      setLiveMessage(target.source
        ? `Source viewer is not connected. Evidence path: ${target.source}.`
        : `${target.name} has no deeper curated scope.`);
      return;
    }
    interruptStory(`Opened ${target.name}`);
    setSelectedId(target.id);
    semanticLensSessionRef.current = plan.session;    semanticMorphStateRef.current = undefined;
    semanticMorphBaselineRef.current = 0;
    setSemanticLensSession(plan.session);
    if (plan.session.focusTransfer) animateSemanticFocusTransfer(plan.session.focusTransfer.targetId);
    activeLevelRef.current = semanticDetails.indexOf(plan.nextDetail);
    updateCamera(plan.camera);
    commitNavigation(canonicalNavigationState({
      ...navigationRef.current,
      rootEntityId: plan.rootEntityId,
      selectedId: target.id,
      camera: plan.camera,
      detail: plan.session.baseDetail,
      lensPath: semanticLensCanonicalPathIds(plan.session),
    }, navigationDefaults), plan.historyMode);
    setLiveMessage(`${target.name} opened. ${levels[semanticDetails.indexOf(plan.nextDetail)].name} detail is now in focus.`);
  }

  function navigateRoot(entityId: string) {
    if (query.fixture === 'stress' || entityId === navigationIdentity.rootEntityId) return;
    const liveCamera = abortInspectorCameraFlight();
    setInspectorHistory([]);
    cancelSemanticLensAt('breadcrumb navigation', liveCamera);
    const target = scene.entities.find(entity => entity.id === entityId);
    if (!target) return;
    interruptStory(`Returned to ${target.name}`);
    const nextScene = activeCreateScene(target.id, scene, authoringHistoryRef.current.present);
    const nextCamera = frameProjectionScope(nextScene, target.id, baseDetail, viewport, measureCurrentMapSafeArea())
      ?? (() => {
        const bounds = semanticBounds(nextScene, target.id, baseDetail) ?? target;
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom: levels[activeLevel].zoom };
      })();
    setScene(nextScene);
    setSelectedId(target.id);
    setNavigationIdentity(current => ({ ...current, rootEntityId: target.id }));
    updateCamera(nextCamera);
    commitNavigation(canonicalNavigationState({
      ...navigationRef.current,
      rootEntityId: target.id,
      selectedId: target.id,
      camera: nextCamera,
      detail: baseDetail,
    }, navigationDefaults), 'push');
    setLiveMessage(`${target.name} is now the map root.`);
  }

  function measureCurrentStorySafeArea() {
    const canvas = document.querySelector<HTMLElement>('[data-testid="atlas-canvas"]');
    if (!canvas) return storySafeArea(viewport);
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
    const player = rect('.story-player');
    const canvasRect = canvas.getBoundingClientRect();
    const overlays = [
      { rect: rect('.topbar'), edge: 'top' as const },
      { rect: rect('.render-status'), edge: 'bottom' as const },
      { rect: detailsOpen ? rect('.details-panel.open') : undefined, edge: 'right' as const },
      { rect: player, edge: 'bottom' as const },
      { rect: rect('.zoom-controls'), edge: 'bottom' as const },
      { rect: rect('.canvas-hint'), edge: 'bottom' as const },
      { rect: rect('.level-rail'), edge: 'left' as const },
    ].filter((overlay): overlay is { rect: DOMRect; edge: 'top' | 'right' | 'bottom' | 'left' } => overlay.rect !== undefined);
    const visual = window.visualViewport;
    const measured = measuredStorySafeArea(viewport, {
      canvas: canvasRect,
      overlays,
      ...(visual ? {
        visualViewport: {
          offsetTop: visual.offsetTop,
          offsetLeft: visual.offsetLeft,
          width: visual.width,
          height: visual.height,
        },
      } : {}),
      safeInsets: browserSafeAreaInsets(),
    });
    const safe = player ? measured : {
      ...measured,
      bottom: Math.max(measured.bottom, storySafeArea(viewport).bottom),
    };
    setMeasuredSafeArea(safe);
    return safe;
  }

  function measureCurrentMapSafeArea() {
    const canvas = document.querySelector<HTMLElement>('[data-testid="atlas-canvas"]');
    if (!canvas) return { top: 0, right: 0, bottom: 0, left: 0 };
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const overlays = [
      { rect: rect('.topbar'), edge: 'top' as const },
      { rect: rect('.map-heading'), edge: 'top' as const },
      { rect: detailsOpen ? rect('.details-panel.open') : undefined, edge: 'right' as const },
      { rect: rect('.details-toggle'), edge: 'right' as const },
      { rect: rect('.zoom-controls'), edge: 'bottom' as const },
      { rect: rect('.story-launcher'), edge: 'bottom' as const },
      { rect: rect('.ask-popover'), edge: 'bottom' as const },
      { rect: rect('.canvas-hint'), edge: 'bottom' as const },
      { rect: rect('.level-rail'), edge: 'left' as const },
    ].filter((overlay): overlay is { rect: DOMRect; edge: 'top' | 'right' | 'bottom' | 'left' } => overlay.rect !== undefined);
    const visual = window.visualViewport;
    const safe = measuredStorySafeArea(viewport, {
      canvas: canvasRect,
      overlays,
      overlayMargin: 0,
      ...(visual ? {
        visualViewport: {
          offsetTop: visual.offsetTop,
          offsetLeft: visual.offsetLeft,
          width: visual.width,
          height: visual.height,
        },
      } : {}),
      safeInsets: browserSafeAreaInsets(),
    });
    setMeasuredSafeArea(safe);
    return safe;
  }

  function semanticStorySession(step: AppStoryPlanStep): SemanticLensSession {
    return semanticLevelSession(scene, step.reveal, step.focusEntityIds);
  }

  function installStorySemanticProgress(active: ActiveStoryFlight, easedCameraProgress: number) {
    const kind = semanticInspectorFlightKind(active.sourceSession, active.targetSession);
    const progress = semanticInspectorFlightProgress(easedCameraProgress, kind);
    installSemanticSession(semanticInspectorFlightSession(
      active.sourceSession,
      active.targetSession,
      story.steps[active.step]?.focusEntityIds[0] ?? active.targetSession.settled.at(-1)?.targetId ?? 'story',
      progress,
    ));
  }

  function setStep(index: number, play = storyPlaying, historyMode: 'push' | 'replace' = 'replace') {
    const bounded = (index + story.steps.length) % story.steps.length;
    const step = story.steps[bounded];
    const liveCamera = abortInspectorCameraFlight();
    setInspectorHistory([]);
    const sourceSession = collapseInspectorFlightSession(semanticLensSessionRef.current);
    const targetSession = semanticStorySession(step);
    installSemanticSession(sourceSession);
    const existingFlight = storyFlightRef.current;
    const sourceFocusedIds = existingFlight && storyFlightSample
      ? storyFlightSample.visualProgress >= 1 - storyFlightSample.departureProgress
        ? existingFlight.targetFocusedIds
        : existingFlight.sourceFocusedIds
      : currentStory?.focusEntityIds ?? [];
    const sourceRelationIds = existingFlight && storyFlightSample
      ? storyFlightSample.visualProgress >= 1 - storyFlightSample.departureProgress
        ? existingFlight.targetRelationIds
        : existingFlight.sourceRelationIds
      : currentStory?.traceRelationIds ?? [];
    if (storyPlaying) {
      const elapsed = currentStoryElapsed();
      storyElapsedRef.current = elapsed;
      setStoryElapsedMs(elapsed);
    }
    setStoryStep(bounded);
    setStoryPlaying(false);
    storyElapsedRef.current = 0;
    setStoryElapsedMs(0);
    storyStartedAtRef.current = undefined;
    setStoryInterruption(undefined);
    setStorySelectionOverride(false);
    setReturnToStoryFrameRequired(false);
    const framing = frameSemanticEntities(scene, step.focusEntityIds, step.reveal, viewport, measureCurrentStorySafeArea());
    const nextCamera = framing ?? liveCamera;
    activeLevelRef.current = semanticDetails.indexOf(step.reveal);
    const now = performance.now();
    const flight = createStoryFlight(liveCamera, nextCamera, viewport, now, {
      ...(reduceMotion ? { durationMs: 0 } : {}),
    });
    const active: ActiveStoryFlight = {
      id: `step:${bounded}:${Math.round(now)}`,
      step: bounded,
      flight,
      sourceFocusedIds: [...sourceFocusedIds],
      targetFocusedIds: [...step.focusEntityIds],
      sourceRelationIds: [...sourceRelationIds],
      targetRelationIds: [...step.traceRelationIds],
      sourceSession,
      targetSession,
      playAfterArrival: play,
    };
    const initialSample = sampleStoryFlight(flight, now);
    arrivalPlayAfterRef.current = play;
    setArrivalElapsedMs(0);
    if (reduceMotion) {
      storyFlightRef.current = undefined;
      setStoryFlightSample(undefined);
      installSemanticSession(targetSession);
      updateCamera(nextCamera);
      pausedStoryPhaseRef.current = 'arrival';
      pausedStoryPhaseElapsedRef.current = 0;
      arrivalStartedAtRef.current = undefined;
      setStoryPhase('arrival');
    } else {
      storyFlightRef.current = active;
      setStoryFlightSample(initialSample);
      pausedStoryPhaseRef.current = 'flight';
      pausedStoryPhaseElapsedRef.current = 0;
      setStoryPhase('flight');
      setStoryFlightEpoch(epoch => epoch + 1);
    }
    if (historyMode === 'push' && !navigationRef.current.story) storyOriginAvailableRef.current = true;
    const canonicalSession = reduceMotion ? targetSession : sourceSession;
    commitNavigation(canonicalNavigationState({
      ...navigationRef.current,
      camera: reduceMotion ? nextCamera : liveCamera,
      detail: canonicalSession.baseDetail,
      lensPath: semanticLensCanonicalPathIds(canonicalSession),
      story: {
        id: storyId,
        step: bounded,
        positionMs: encodeStoryPosition(bounded, reduceMotion ? 'arrival' : 'flight', 0, flight.canonicalDurationMs),
      },
    }, navigationDefaults), historyMode);
    setLiveMessage(reduceMotion
      ? `Story step ${bounded + 1} of ${story.steps.length}: ${step.title}. Applying destination.`
      : `Moving to story step ${bounded + 1} of ${story.steps.length}: ${step.title}.`);
  }

  function closeStory() {
    abortInspectorCameraFlight();
    setStoryPlaying(false);
    storyElapsedRef.current = 0;
    storyStartedAtRef.current = undefined;
    setStoryElapsedMs(0);
    setStoryInterruption(undefined);
    storyFlightRef.current = undefined;
    setStoryFlightSample(undefined);
    setStoryPhase('idle');
    setStorySelectionOverride(false);
    setReturnToStoryFrameRequired(false);
    isolationOriginRef.current = undefined;
    setVisibilityMode('all');
    if (storyOriginAvailableRef.current) {
      storyOriginAvailableRef.current = false;
      window.history.back();
      return;
    }
    setStoryStep(-1);
  }

  useEffect(() => {
    if (query.fixture === 'stress' || storyStep >= 0 || restoringNavigationRef.current) return;
    const restoreGeneration = navigationRestoreGenerationRef.current;
    const frame = window.requestAnimationFrame(() => {
      if (restoringNavigationRef.current || navigationRestoreGenerationRef.current !== restoreGeneration) return;
      const safeArea = measureCurrentMapSafeArea();
      const requiresFit = !initialMapFitAppliedRef.current;
      initialMapFitAppliedRef.current = true;
      if (!requiresFit) return;
      const next = frameProjectionScope(scene, navigationIdentity.rootEntityId, activeDetail, viewport, safeArea, false, true);
      if (!next) return;
      updateCamera(next);
      commitNavigation(canonicalNavigationState({
        ...navigationRef.current,
        camera: next,
        detail: activeDetail,
      }, navigationDefaults), 'replace');
    });
    return () => window.cancelAnimationFrame(frame);
    // Readable framing may intentionally crop remote context. Resize/chrome changes
    // must preserve that map camera; only the initial load auto-frames.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailsOpen, navigationIdentity.rootEntityId, query.fixture, safeAreaEpoch, scene, storyStep, viewport.height, viewport.width]);

  useEffect(() => {
    if (storyStep < 0) return;
    const player = document.querySelector<HTMLElement>('.story-player');
    if (!player) return;
    const invalidate = () => setSafeAreaEpoch(epoch => epoch + 1);
    const observer = new ResizeObserver(invalidate);
    observer.observe(player);
    const visual = window.visualViewport;
    visual?.addEventListener('resize', invalidate);
    visual?.addEventListener('scroll', invalidate);
    return () => {
      observer.disconnect();
      visual?.removeEventListener('resize', invalidate);
      visual?.removeEventListener('scroll', invalidate);
    };
  }, [storyStep]);

  useEffect(() => {
    if (storyStep < 0 || (storyPhase !== 'flight' && storyPhase !== 'arrival')) return;
    const step = story.steps[storyStep];
    const target = frameSemanticEntities(scene, step.focusEntityIds, step.reveal, viewport, measureCurrentStorySafeArea());
    if (!target) return;
    const active = storyFlightRef.current;
    if (storyPhase === 'arrival' && !active) {
      updateCamera(target);
      return;
    }
    if (!active) return;
    const sample = storyFlightSample ?? sampleStoryFlight(active.flight, performance.now());
    const targetChanged = Math.hypot(target.x - active.flight.target.x, target.y - active.flight.target.y)
      * target.zoom > 0.5
      || Math.abs(target.zoom - active.flight.target.zoom) > 0.001;
    if (!targetChanged) return;
    const remainingMs = Math.max(1, active.flight.canonicalDurationMs - sample.elapsedMs);
    const retargeted = createStoryFlight(sample.camera, target, viewport, performance.now(), {
      durationMs: remainingMs,
      canonicalDurationMs: active.flight.canonicalDurationMs,
      canonicalElapsedMs: sample.elapsedMs,
    });
    storyFlightRef.current = { ...active, flight: retargeted };
    setStoryFlightSample(sampleStoryFlight(retargeted, retargeted.startedAtMs));
    setStoryFlightEpoch(epoch => epoch + 1);
  }, [detailsOpen, safeAreaEpoch, storyPhase, storyStep, viewport.height, viewport.width]);

  useEffect(() => {
    if (storyPhase !== 'flight') return;
    let frame = 0;
    let arrivalFrame = 0;
    const tick = (now: number) => {
      const active = storyFlightRef.current;
      if (!active || !active.flight.running) return;
      const sample = sampleStoryFlight(active.flight, now);
      setStoryFlightSample(sample);
      pausedStoryPhaseElapsedRef.current = sample.elapsedMs;
      installStorySemanticProgress(active, sample.easedProgress);
      updateCamera(sample.camera);
      if (!sample.arrived) {
        frame = window.requestAnimationFrame(tick);
        return;
      }
      installSemanticSession(active.targetSession);
      updateCamera(active.flight.target);
      setStoryFlightSample({ ...sample, camera: { ...active.flight.target } });
      // The exact target camera and destination focus/filter/trace state must
      // commit in a rendered frame before the 150 ms arrival barrier starts.
      arrivalFrame = window.requestAnimationFrame(arrivalNow => {
        arrivalStartedAtRef.current = arrivalNow;
        arrivalPlayAfterRef.current = active.playAfterArrival;
        pausedStoryPhaseRef.current = 'arrival';
        pausedStoryPhaseElapsedRef.current = 0;
        setArrivalElapsedMs(0);
        setStoryPhase('arrival');
        activeLevelRef.current = semanticDetails.indexOf(semanticLensSessionDetail(active.targetSession));
        const arrived = canonicalNavigationState({
          ...navigationRef.current,
          camera: active.flight.target,
          detail: active.targetSession.baseDetail,
          lensPath: semanticLensCanonicalPathIds(active.targetSession),
          story: {
            id: storyId,
            step: active.step,
            positionMs: encodeStoryPosition(active.step, 'arrival', 0, active.flight.canonicalDurationMs),
          },
        }, navigationDefaults);
        navigationRef.current = arrived;
        historyControllerRef.current?.replace(arrived);
      });
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(arrivalFrame);
    };
  }, [storyPhase, storyFlightEpoch]);

  useEffect(() => {
    if (storyPhase !== 'arrival') return;
    let frame = 0;
    const tick = (now: number) => {
      const started = arrivalStartedAtRef.current ?? now;
      arrivalStartedAtRef.current ??= started;
      const elapsed = Math.min(STORY_ARRIVAL_SETTLE_MS, Math.max(0, Math.round(now - started)));
      setArrivalElapsedMs(elapsed);
      pausedStoryPhaseElapsedRef.current = elapsed;
      if (elapsed < STORY_ARRIVAL_SETTLE_MS) {
        frame = window.requestAnimationFrame(tick);
        return;
      }
      const play = arrivalPlayAfterRef.current;
      const active = storyFlightRef.current;
      const arrivedCamera = active?.flight.target ?? camera;
      const holdElapsedMs = storyElapsedRef.current;
      pausedStoryPhaseRef.current = 'hold';
      pausedStoryPhaseElapsedRef.current = holdElapsedMs;
      storyFlightRef.current = undefined;
      setStoryFlightSample(undefined);
      setStoryPhase(play ? 'hold' : 'paused');
      setStoryPlaying(play);
      storyStartedAtRef.current = play ? now : undefined;
      const settled = canonicalNavigationState({
        ...navigationRef.current,
        camera: arrivedCamera,
        detail: active?.targetSession.baseDetail ?? semanticLensSessionRef.current.baseDetail,
        lensPath: semanticLensCanonicalPathIds(active?.targetSession ?? semanticLensSessionRef.current),
        story: {
          id: storyId,
          step: storyStep,
          positionMs: encodeStoryPosition(
            storyStep,
            'hold',
            holdElapsedMs,
            active?.flight.canonicalDurationMs,
          ),
        },
      }, navigationDefaults);
      navigationRef.current = settled;
      historyControllerRef.current?.replace(settled);
      setLiveMessage(`Arrived at story step ${storyStep + 1}: ${story.steps[storyStep]?.title ?? 'Story step'}. ${play ? 'Playing.' : 'Paused.'}`);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [storyPhase, storyStep]);

  useEffect(() => {
    if (!storyPlaying || storyStep < 0) return;
    const delay = Math.max(0, storyStepDuration(storyStep) - storyElapsedRef.current);
    storyStartedAtRef.current = performance.now();
    const timeout = window.setTimeout(() => {
      storyElapsedRef.current = 0;
      setStoryElapsedMs(0);
      storyStartedAtRef.current = undefined;
      if (storyStep === story.steps.length - 1) {
        setStoryPlaying(false);
        pausedStoryPhaseRef.current = 'hold';
        pausedStoryPhaseElapsedRef.current = storyStepDuration(storyStep);
        setStoryPhase('paused');
      }
      else setStep(storyStep + 1, true, 'replace');
    }, delay);
    return () => { window.clearTimeout(timeout); };
  }, [storyPlaying, storyStep]);

  useEffect(() => {
    const pauseWhenHidden = () => {
      if (document.visibilityState === 'hidden') interruptStory('Story paused because the tab was hidden', camera, false);
    };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => document.removeEventListener('visibilitychange', pauseWhenHidden);
  }, [arrivalElapsedMs, camera, storyFlightSample, storyPhase, storyPlaying, storyStep]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable);
      if (!typing && editingEnabled && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoAuthoringGesture();
        else undoAuthoringGesture();
        return;
      }
      if (!typing && editingEnabled && pickedRelationId && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        deleteSelectedRelationship();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => document.getElementById('atlas-search')?.focus(), 0);
      }
      if (!typing && shouldToggleDevMode(event)) {
        event.preventDefault();
        setDevMode(value => !value);
      }
      if (shouldOpenAskAtlas(event, storyStep >= 0)) {
        event.preventDefault();
        if (!mainDiagramActive) activateDiagramView(MAIN_DIAGRAM_SURFACE_ID);
        setAskOpen(true);
        window.setTimeout(() => askInputRef.current?.focus(), 0);
      }
      if (event.key === 'Escape') {
        const shouldCloseInspector = detailsOpen && !searchOpen && !askOpen && detailsPanelRef.current?.contains(document.activeElement);
        cancelSemanticLens('escape');
        setAuthoringTool('select');
        setSearchOpen(false);
        setAskOpen(false);
        if (askOpen) window.setTimeout(() => askButtonRef.current?.focus(), 0);
        if (shouldCloseInspector) closeDetails();
      }
      if (!typing && mainDiagramActive && (event.key === '+' || event.key === '=')) {
        event.preventDefault();
        semanticZoomControl('inward');
      }
      if (!typing && mainDiagramActive && (event.key === '-' || event.key === '_')) {
        event.preventDefault();
        semanticZoomControl('outward');
      }
      if (!typing && mainDiagramActive && editingEnabled && event.key.toLowerCase() === 'v') setAuthoringTool('select');
      if (!typing && mainDiagramActive && editingEnabled && event.key.toLowerCase() === 'c') setAuthoringTool('connect');
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [askOpen, camera, detailsOpen, editingEnabled, mainDiagramActive, navigationIdentity.rootEntityId, pickedRelationId, searchOpen, semanticLensSession, storyStep, viewport]);

  function submitQuestion(event: FormEvent) {
    event.preventDefault();
    if (!question.trim()) return;
    setQuestion('');
    setAskOpen(false);
    setStep(0, true, 'push');
    setLiveMessage('Playing the saved Okie context-to-source explanation. Live repository Q&A is not connected yet.');
  }

  async function copyCurrentView() {
    if (storyStep >= 0) {
      let phase = storyCanonicalPhase;
      let elapsed = storyPhaseElapsedMs;
      let sampledCamera = camera;
      if (storyPhase === 'flight' && storyFlightRef.current) {
        const sample = sampleStoryFlight(storyFlightRef.current.flight, performance.now());
        setStoryFlightSample(sample);
        sampledCamera = sample.camera;
        elapsed = sample.elapsedMs;
        phase = 'flight';
      } else if (storyPlaying) {
        elapsed = currentStoryElapsed();
        storyElapsedRef.current = elapsed;
        storyStartedAtRef.current = performance.now();
        setStoryElapsedMs(elapsed);
        phase = 'hold';
      }
      const next = canonicalNavigationState({
        ...navigationRef.current,
        camera: sampledCamera,
        story: {
          id: storyId,
          step: storyStep,
          positionMs: encodeStoryPosition(
            storyStep,
            phase,
            elapsed,
            storyFlightRef.current?.flight.canonicalDurationMs,
          ),
        },
      }, navigationDefaults);
      navigationRef.current = next;
      historyControllerRef.current?.replace(next);
    }
    // Story snapshots already replaced history with the exact sampled camera
    // and canonical phase. Flushing the canvas publisher here could overwrite
    // that sample with its previous RAF camera.
    if (storyStep < 0) window.dispatchEvent(new Event('atlas:flush-navigation'));
    const url = window.location.href;
    if (shareFeedbackTimerRef.current !== undefined) window.clearTimeout(shareFeedbackTimerRef.current);
    try {
      await copyViewLink(url, navigator.clipboard);
      const message = 'Current view link copied. Anyone with repository access can open it.';
      setShareFeedback({ tone: 'success', message, url });
      shareFeedbackTimerRef.current = window.setTimeout(() => setShareFeedback(undefined), 3200);
    } catch {
      setShareFeedback({ tone: 'error', message: 'Could not access the clipboard. Select and copy this link manually.', url });
    }
  }

  async function captureScreenshot(mode: 'copy' | 'save') {
    screenshotMenuRef.current?.removeAttribute('open');
    try {
      const blob = await captureSceneBlob({
        scene,
        camera,
        width: viewport.width,
        height: viewport.height,
        devicePixelRatio: window.devicePixelRatio,
        renderState: {
          selectedId: rendererSelectedId,
          focusedIds,
          relationFocusIds: relationFocus.endpointIds,
          activeRelationIds,
          flowRelationIds,
          reduceMotion: true,
          animate: false,
          visibilityMode: effectiveVisibilityMode,
          ...(relationFocus.projectionOverride ? { projectionOverride: relationFocus.projectionOverride } : {}),
        },
      });
      const canCopy = mode === 'copy' && typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';
      if (canCopy) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        setLiveMessage('Copied a PNG of the current view to the clipboard.');
      } else {
        downloadBlob(blob, screenshotFilename(activeDiagramSurface.title, Date.now()));
        setLiveMessage(mode === 'copy'
          ? 'Clipboard image copy is unavailable in this browser; saved a PNG instead.'
          : 'Saved a PNG of the current view.');
      }
    } catch (error) {
      setLiveMessage(`Could not capture the canvas: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function dismissShareFeedback() {
    setShareFeedback(undefined);
    window.setTimeout(() => shareButtonRef.current?.focus({ preventScroll: true }), 0);
  }

  function currentDiagramSurfaceSession(): DiagramSurfaceSession {
    if (activeDiagramSurface.kind !== 'main') return activeDiagramSurface.session;
    return {
      camera: { ...renderedCameraRef.current },
      selectedId: selected.id,
      ...(pickedRelationId ? { pickedRelationId } : {}),
      inspector: {
        open: detailsOpen,
        tab: inspectorTab,
        subjectId: pickedRelationId ?? selected.id,
      },
    };
  }

  function restoreDiagramSurface(surface: DiagramSurface) {
    const liveCamera = abortInspectorCameraFlight();
    setInspectorHistory([]);
    setSearchOpen(false);
    setAskOpen(false);
    setDiagnosticsOpen(false);
    if (surface.kind !== 'main') {
      interruptStory(`Opened ${surface.title}`, liveCamera, false);
      setPickedRelationId(undefined);
      setDetailsOpen(false);
      setInspectorTab('details');
      setSafeAreaEpoch(epoch => epoch + 1);
      setLiveMessage(`${surface.title} ${surface.kind} diagram opened.`);
      return;
    }
    const session = surface.session;
    if (session.camera) updateCamera(session.camera);
    if (session.selectedId) {
      inspectorSelectionRef.current = session.selectedId;
      setSelectedId(session.selectedId);
    }
    setPickedRelationId(session.pickedRelationId);
    setDetailsOpen(session.inspector.open);
    setInspectorTab(session.inspector.tab);
    setSafeAreaEpoch(epoch => epoch + 1);
    setLiveMessage('Main architecture diagram restored.');
  }

  function activateDiagramView(surfaceId: string) {
    if (surfaceId === diagramWorkspace.activeSurfaceId) return;
    const target = diagramWorkspace.surfaces[surfaceId];
    if (!target) return;
    abortInspectorCameraFlight();
    setDiagramWorkspace(activateDiagramSurface(diagramWorkspace, surfaceId, currentDiagramSurfaceSession()));
    restoreDiagramSurface(target);
  }

  function selectedDiagramEntityIds() {
    const connected = scene.relations
      .filter(relation => relation.from === selected.id || relation.to === selected.id)
      .flatMap(relation => [relation.from, relation.to]);
    return [...new Set([selected.id, ...connected, ...selectedChildren.map(child => child.id)])].slice(0, 12);
  }

  function openDerivedDiagram(kind: DerivedDiagramKind = 'flow') {
    abortInspectorCameraFlight();
    const id = `diagram:${kind}:${selected.id}`;
    const label = kind === 'flow' ? 'flow' : kind === 'mermaid' ? 'Mermaid' : 'code diagram';
    const surface: DerivedDiagramSurface = {
      id,
      kind,
      title: `${selected.name} ${label}`,
      closable: true,
      entityIds: selectedDiagramEntityIds(),
      session: {
        selectedElementId: selected.id,
        inspector: { open: false, tab: 'details', subjectId: selected.id },
      },
    };
    const next = openDerivedDiagramSurface(diagramWorkspace, surface, currentDiagramSurfaceSession());
    setDiagramWorkspace(next);
    diagramAddMenuRef.current?.removeAttribute('open');
    restoreDiagramSurface(next.surfaces[next.activeSurfaceId]!);
  }

  function closeDiagramView(surfaceId: string) {
    const next = closeDiagramSurface(diagramWorkspace, surfaceId, currentDiagramSurfaceSession());
    if (next === diagramWorkspace) return;
    const activeChanged = next.activeSurfaceId !== diagramWorkspace.activeSurfaceId;
    if (activeChanged) abortInspectorCameraFlight();
    setDiagramWorkspace(next);
    if (activeChanged) restoreDiagramSurface(next.surfaces[next.activeSurfaceId]!);
    window.requestAnimationFrame(() => document.getElementById(diagramTabDomId(next.activeSurfaceId))?.focus({ preventScroll: true }));
  }

  function updateActiveDiagramSession(session: DiagramSurfaceSession) {
    setDiagramWorkspace(current => updateDiagramSurfaceSession(current, current.activeSurfaceId, session));
  }

  function navigateDiagramTabs(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    if (!tabs.length) return;
    event.preventDefault();
    const currentIndex = Math.max(0, tabs.indexOf(document.activeElement as HTMLButtonElement));
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[nextIndex]!.focus();
    tabs[nextIndex]!.click();
  }

  const storyPlaybackStatus = storyPhase === 'flight'
    ? `Moving to ${currentStory?.title ?? 'story step'}`
    : storyPhase === 'arrival'
      ? 'Arriving…'
      : storyPlaying
        ? 'Playing'
        : storyInterruption
          ? 'Interrupted'
          : 'Paused';
  const storyControlLabel = storyPhase === 'flight'
    ? 'Pause camera flight'
    : storyPhase === 'arrival'
      ? 'Pause arrival settle'
      : returnToStoryFrameRequired
        ? 'Return to story frame to resume'
        : pausedStoryPhaseRef.current === 'flight'
          ? 'Resume camera flight'
          : storyPlaying
            ? 'Pause narration'
            : 'Resume narration';
  const storyControlActive = storyPlaying || storyPhase === 'flight' || storyPhase === 'arrival';

  return (
    <div className="app-shell" data-active-diagram-id={activeDiagramSurface.id} data-authoring-history-future={authoringHistory.future.length} data-authoring-history-past={authoringHistory.past.length} data-authoring-tool={authoringTool} data-backend={query.backend} data-camera-settled-epoch={cameraSettledEpoch} data-detail={activeDetail} data-dev-mode={devMode ? 'true' : 'false'} data-fixture={query.fixture} data-interaction-mode={interactionMode} data-lens-phase={semanticLens.phase} data-lens-progress={semanticLens.progress.toFixed(3)} data-lens-target={semanticLens.targetId ?? ''} data-navigation-state={serializeNavigationState(settledNavigation)} data-projection-entity-count={activeProjectionEntityIds.length} data-projection-override-id={projectionOverride?.id ?? ''} data-projection-override-object-count={projectionOverride?.objects.length ?? 0} data-projection-override-path-count={projectionOverride?.paths.length ?? 0} data-projection-relation-count={activeProjectionRelationIds.length} data-renderer-replay-state={rendererReplayState} data-root-entity-id={navigationIdentity.rootEntityId} data-seed={query.seed} data-selected-entity-id={selected.id} data-testid="atlas-app" data-visibility-mode={visibilityMode}>
      <a className="skip-link" href={mainDiagramActive ? '#entity-explorer' : '#derived-diagram-content'}>{mainDiagramActive ? 'Skip to entity explorer' : 'Skip to active diagram'}</a>
      <header className="topbar">
        <div className="brand-block" aria-label="Atlas home">
          <div className="brand-mark"><span /><span /><span /></div>
          <div>
            <div className="brand-line"><strong>Atlas</strong><span className="brand-product">PREVIEW</span></div>
          </div>
        </div>

        <div className="search-zone">
          <button aria-expanded={searchOpen} className="search-trigger" onClick={() => setSearchOpen(true)} type="button">
            <SearchIcon size={16}/><span>Find a system, flow, or source file…</span><kbd>⌘ K</kbd>
          </button>
          {searchOpen && (
            <div className="search-popover" role="dialog" aria-label="Search architecture">
              <div className="search-input-row"><SearchIcon/><input autoFocus id="atlas-search" onChange={event => setSearch(event.target.value)} placeholder="Search architecture and code" value={search}/><button aria-label="Close search" onClick={() => setSearchOpen(false)}><CloseIcon/></button></div>
              <p className="popover-label">{search ? `${searchResults.length} MATCHES` : 'ON THIS MAP'}</p>
              <div className="search-results" role="listbox">
                {searchResults.map(entity => <button aria-selected={entity.id === selectedId} key={entity.id} onClick={() => focusEntity(entity, 'push', 'frame')} role="option"><span className={`result-icon kind-${entity.kind}`}>{(entity.kindLabel ?? entity.kind).slice(0, 2).toUpperCase()}</span><span><strong>{entity.name}</strong><small>{entity.kindLabel ?? entity.kind} · {entity.source ?? entity.responsibility}</small></span><span className="result-enter">↵</span></button>)}
                {!searchResults.length && <p className="empty-state">No architecture entities match that query.</p>}
              </div>
            </div>
          )}
        </div>

        <div className="top-actions">
          <details className="diagram-add-menu screenshot-menu" ref={screenshotMenuRef}>
            <summary aria-label="Capture screenshot" title="Capture screenshot"><ImageIcon size={16}/></summary>
            <div>
              <button onClick={() => { void captureScreenshot('copy'); }} type="button">Copy image</button>
              <button onClick={() => { void captureScreenshot('save'); }} type="button">Save PNG</button>
            </div>
          </details>
          <button
            aria-describedby={shareFeedback ? 'share-view-feedback' : undefined}
            aria-label={shareFeedback?.tone === 'success' ? 'Current view link copied' : 'Copy current view link'}
            className={`icon-button share-view-button ${shareFeedback?.tone === 'success' ? 'copied' : ''}`}
            onClick={() => { void copyCurrentView(); }}
            ref={shareButtonRef}
            title="Copy current view"
            type="button"
          >
            {shareFeedback?.tone === 'success' ? <CheckIcon/> : <ShareIcon/>}
          </button>
          <button aria-label="Open source repository" className="icon-button"><CodeIcon/></button>
          <button aria-label="Open account menu" className="avatar-button">BC</button>
        </div>
      </header>

      {shareFeedback && (
        <div
          aria-atomic="true"
          aria-live={shareFeedback.tone === 'error' ? 'assertive' : 'polite'}
          className={`share-feedback ${shareFeedback.tone}`}
          id="share-view-feedback"
          role={shareFeedback.tone === 'error' ? 'alert' : 'status'}
        >
          <span className="share-feedback-icon">{shareFeedback.tone === 'success' ? <CheckIcon size={15}/> : <InfoIcon size={15}/>}</span>
          <div>
            <strong>{shareFeedback.tone === 'success' ? 'View link copied' : 'Copy link manually'}</strong>
            <p>{shareFeedback.message}</p>
            {shareFeedback.tone === 'error' && (
              <label className="share-fallback-field">
                <span className="sr-only">Current view link</span>
                <input onFocus={event => event.currentTarget.select()} readOnly ref={shareFallbackRef} value={shareFeedback.url}/>
              </label>
            )}
          </div>
          <button aria-label="Dismiss copy link message" onClick={dismissShareFeedback} type="button"><CloseIcon size={14}/></button>
        </div>
      )}

      <nav aria-label="Diagram views" className="diagram-view-bar">
        <div aria-label="Open diagrams" className="diagram-tabs" onKeyDown={navigateDiagramTabs} role="tablist">
          {diagramSurfaces.map(surface => <div className={`diagram-tab-shell ${surface.id === diagramWorkspace.activeSurfaceId ? 'active' : ''}`} key={surface.id}>
            <button aria-controls="diagram-workspace-panel" aria-label={surface.kind === 'main' ? 'Main diagram, pinned' : `${surface.title} ${surface.kind} diagram`} aria-selected={surface.id === diagramWorkspace.activeSurfaceId} className="diagram-tab" id={diagramTabDomId(surface.id)} onClick={() => activateDiagramView(surface.id)} role="tab" tabIndex={surface.id === diagramWorkspace.activeSurfaceId ? 0 : -1} type="button">{surface.kind !== 'main' && <span aria-hidden="true" className={`diagram-kind-mark kind-${surface.kind}`}>{surface.kind === 'flow' ? 'F' : surface.kind === 'mermaid' ? 'MR' : 'C'}</span>}<span>{surface.title}</span></button>
            {surface.closable && <button aria-label={`Close ${surface.title} diagram`} className="diagram-tab-close" onClick={() => closeDiagramView(surface.id)} type="button"><CloseIcon size={12}/></button>}
          </div>)}
        </div>

        <div className="mobile-diagram-switcher">
          <label><span>Views</span><select aria-label="Active diagram view" onChange={event => activateDiagramView(event.target.value)} value={diagramWorkspace.activeSurfaceId}>{diagramSurfaces.map(surface => <option key={surface.id} value={surface.id}>{surface.title}{surface.kind === 'main' ? '' : ` · ${surface.kind}`}</option>)}</select></label>
          {activeDiagramSurface.closable && <button aria-label={`Close ${activeDiagramSurface.title} diagram`} onClick={() => closeDiagramView(activeDiagramSurface.id)} type="button"><CloseIcon size={14}/></button>}
        </div>

        {devMode && <details className="diagram-add-menu" ref={diagramAddMenuRef}>
          <summary aria-label="Create diagram" title="Create diagram"><span aria-hidden="true">+</span><em>Diagram</em></summary>
          <div><button onClick={() => openDerivedDiagram('flow')} type="button"><ActivityIcon size={14}/><span><strong>Dynamic flow</strong><small>Interactions around {selected.name}</small></span></button><button onClick={() => openDerivedDiagram('mermaid')} type="button"><LayersIcon size={14}/><span><strong>Mermaid</strong><small>Semantic structure preview</small></span></button><button onClick={() => openDerivedDiagram('code')} type="button"><CodeIcon size={14}/><span><strong>Code diagram</strong><small>Source-oriented structure</small></span></button></div>
        </details>}
      </nav>

      <main aria-label={`${activeDiagramSurface.title} diagram workspace`} aria-labelledby={diagramTabDomId(activeDiagramSurface.id)} className={`workspace ${mainDiagramActive && detailsOpen ? 'has-details' : ''}`} id="diagram-workspace-panel" role="tabpanel" style={{ '--details-width': `${detailsWidth}px` } as CSSProperties}>
        {activeDiagramSurface.kind === 'main' ? <>
        <section className="map-stage" aria-label="Architecture workspace">
          <CanvasViewport
            activeRelationIds={activeRelationIds}
            animationActive={animationActive}
            authoringDetail={activeDetail}
            authoringEnabled={editingEnabled}
            authoringEntityIds={authoringEntityIds}
            authoringTool={authoringTool}
            camera={camera}
            cinematicTransition={cinematicTransition}
            flowActive={flowActive}
            flowRelationIds={flowRelationIds}
            focusedIds={focusedIds}
            relationFocusIds={relationFocus.endpointIds}
            onCameraSettled={settleCamera}
            onCameraFlightCancel={cancelInspectorCameraFlight}
            onCreateRelationship={createRelationship}
            onDiagnostics={setDiagnostics}
            onGuideRelationship={guideRelationship}
            onInteractionStart={interruptStory}
            onLensCancel={cancelSemanticLensAt}
            onLensPan={stabilizeSemanticLensForPan}
            onLodState={publishLodState}
            onNavigationFlush={flushNavigation}
            onOpenInside={openInside}
            onPick={handlePick}
            onSemanticZoom={handleSemanticZoom}
            onSemanticZoomBurstStart={beginSemanticZoomBurst}
            onViewportChange={setViewport}
            projectionOverride={relationFocus.projectionOverride}
            reduceMotion={reduceMotion}
            requestedBackend={query.backend}
            scene={scene}
            selectedId={rendererSelectedId}
            selectedRelationId={pickedRelationId}
            setCamera={setCamera}
            visibilityMode={effectiveVisibilityMode}
          />

          {devMode && <div aria-label="Diagram interaction mode" className={`authoring-toolbar mode-${interactionMode}`} data-enabled={editingEnabled ? 'true' : 'false'} role="toolbar">
            <div aria-label="Interaction mode" className="diagram-mode-toggle" role="group">
              <button aria-pressed={interactionMode === 'view'} className={interactionMode === 'view' ? 'active' : ''} data-testid="interaction-mode-view" onClick={() => changeInteractionMode('view')} title="Inspect architecture without editing" type="button"><span aria-hidden="true" className="mode-indicator"/>View</button>
              <button aria-pressed={interactionMode === 'edit'} className={interactionMode === 'edit' ? 'active' : ''} data-testid="interaction-mode-edit" onClick={() => changeInteractionMode('edit')} title="Reveal relationship authoring tools" type="button"><span aria-hidden="true" className="mode-indicator"/>Edit</button>
            </div>
            {interactionMode === 'edit' && <div aria-label="Relationship authoring tools" className="authoring-edit-tools" role="group">
              <span aria-hidden="true" className="authoring-toolbar-divider"/>
              <button aria-pressed={authoringTool === 'select'} className={authoringTool === 'select' ? 'active' : ''} data-testid="authoring-tool-select" disabled={!authoringEnabled} onClick={() => setAuthoringTool('select')} title="Select relationships and route guides (V)" type="button">Select</button>
              <button aria-pressed={authoringTool === 'connect'} className={authoringTool === 'connect' ? 'active' : ''} data-testid="authoring-tool-connect" disabled={!authoringEnabled} onClick={() => setAuthoringTool('connect')} title="Connect visible nodes (C)" type="button">Connect</button>
              <span aria-hidden="true" className="authoring-toolbar-divider"/>
              <button aria-label="Undo relationship edit" data-testid="authoring-undo" disabled={!authoringEnabled || !authoringHistory.past.length} onClick={undoAuthoringGesture} title="Undo (⌘Z)" type="button">↶</button>
              <button aria-label="Redo relationship edit" data-testid="authoring-redo" disabled={!authoringEnabled || !authoringHistory.future.length} onClick={redoAuthoringGesture} title="Redo (⇧⌘Z)" type="button">↷</button>
              <button data-testid="relationship-reset-route" disabled={!authoringEnabled || !selectedRouteOverride} onClick={resetSelectedRelationshipRoute} title="Return the selected relationship to automatic routing" type="button">Auto route</button>
              <button data-testid="relationship-delete" disabled={!authoringEnabled || !pickedRelationId} onClick={deleteSelectedRelationship} title="Delete selected relationship" type="button">Delete</button>
            </div>}
          </div>}

          <div className="map-heading">
            <h1>{scene.title}</h1>
            <nav aria-label="Architecture ancestry" className="semantic-breadcrumb">
              {breadcrumbState.chain.map((entity, index) => <span key={entity.id}>{index > 0 && <ChevronIcon size={9}/>} {entity.id === navigationIdentity.rootEntityId ? <b aria-current="page">{entity.name}</b> : <button onClick={() => navigateRoot(entity.id)}>{entity.name}</button>}</span>)}
              {breadcrumbState.descendant && <span className="selected-descendant"><ChevronIcon size={9}/><em>{breadcrumbState.descendant.name}</em></span>}
            </nav>
          </div>

          <nav aria-label="Architecture detail level" className="level-rail">
            <div className="rail-icon"><LayersIcon/></div>
            {levels.map((level, index) => <button aria-current={activeLevel === index ? 'true' : undefined} aria-label={`${level.name} level`} className={activeLevel === index ? 'active' : ''} key={level.name} onClick={() => selectLevel(index)}><span>{level.short}</span><em>{level.name}</em></button>)}
          </nav>

          <div className="zoom-controls" aria-label="Map controls">
            <button aria-label="Zoom in" onClick={() => semanticZoomControl('inward')}><ZoomInIcon/></button>
            <button aria-label="Zoom out" onClick={() => semanticZoomControl('outward')}><ZoomOutIcon/></button>
            <button aria-label="Fit architecture to view" onClick={() => {
              const next = frameProjectionScope(scene, navigationIdentity.rootEntityId, activeDetail, viewport, measureCurrentMapSafeArea(), false, true) ?? defaultCamera;
              navigateCamera(next, 'replace', 'Fit the current architecture scope');
            }}><FitIcon/></button>
          </div>

          <Minimap camera={camera} onPan={(next, phase) => phase === 'move' ? setCamera(() => next) : navigateCamera(next, 'replace', 'Panned the map overview')} scene={scene} viewport={viewport}/>

          {devMode && <button aria-expanded={diagnosticsOpen} aria-label={`Renderer backend: ${backendPresentation.title}`} className={`render-status backend-${backendPresentation.tone}`} data-active-backend={diagnostics.activeBackend} data-testid="renderer-status" onClick={() => setDiagnosticsOpen(open => !open)}>
            <span className="status-light"/><span><b>{backendPresentation.title}</b><small>{backendPresentation.detail} · {Math.round(diagnostics.lastFrameMs * 10) / 10}ms · {Math.round(camera.zoom * 100)}%</small></span><InfoIcon size={14}/>
          </button>}
          {devMode && diagnosticsOpen && <aside className="diagnostics-card" data-testid="diagnostics-panel">
            <div className="diagnostics-title"><ActivityIcon/><strong>Renderer diagnostics</strong><button aria-label="Close diagnostics" onClick={() => setDiagnosticsOpen(false)}><CloseIcon size={15}/></button></div>
            <dl>
              <div><dt>Source</dt><dd>local › okie · frozen worktree fixture</dd></div>
              <div><dt>Projection</dt><dd>{activeProjectionEntityIds.length.toLocaleString()} visible entities · {activeProjectionRelationIds.length.toLocaleString()} relationships{query.fixture === 'stress' ? ' · deterministic benchmark' : ' · evidence-linked'}</dd></div>
              <div><dt>Requested</dt><dd>{diagnostics.requestedBackend}</dd></div>
              <div><dt>Active backend</dt><dd>{diagnostics.activeBackend}</dd></div>
              <div><dt>Execution</dt><dd>{diagnostics.gpuAccelerated ? 'hardware accelerated' : 'compatibility / CPU'}</dd></div>
              <div><dt>Scene</dt><dd>{diagnostics.entityCount.toLocaleString()} / {diagnostics.relationCount.toLocaleString()}</dd></div>
              {diagnostics.visibleEntities !== undefined && <div><dt>Visible</dt><dd>{diagnostics.visibleEntities.toLocaleString()} / {(diagnostics.visibleRelations ?? 0).toLocaleString()}</dd></div>}
              {diagnostics.candidateEntities !== undefined && <div><dt>Candidates</dt><dd>{diagnostics.candidateEntities.toLocaleString()} / {(diagnostics.candidateRelations ?? 0).toLocaleString()}</dd></div>}
              {diagnostics.culledEntities !== undefined && <div><dt>Culled</dt><dd>{diagnostics.culledEntities.toLocaleString()} / {(diagnostics.culledRelations ?? 0).toLocaleString()}</dd></div>}
              {diagnostics.frameP50Ms !== undefined && <div><dt>Frame p50 / p95 / p99</dt><dd>{diagnostics.frameP50Ms.toFixed(1)} / {(diagnostics.frameP95Ms ?? 0).toFixed(1)} / {(diagnostics.frameP99Ms ?? 0).toFixed(1)} ms</dd></div>}
              {diagnostics.drawCalls !== undefined && <div><dt>Draw calls</dt><dd>{diagnostics.drawCalls.toLocaleString()}</dd></div>}
              {diagnostics.meshBuildMs !== undefined && <div><dt>Mesh build</dt><dd>{diagnostics.meshBuildMs.toFixed(2)} ms{diagnostics.meshRebuilt ? ' · rebuilt' : ' · cached'}</dd></div>}
              {diagnostics.geometryUploadBytes !== undefined && <div><dt>Geometry upload</dt><dd>{diagnostics.geometryUploadBytes.toLocaleString()} B · {(diagnostics.geometryBufferUploads ?? 0).toLocaleString()} buffers</dd></div>}
              {diagnostics.staticMeshRevision !== undefined && <div><dt>Static mesh rev / cumulative</dt><dd>{diagnostics.staticMeshRevision} · {(diagnostics.cumulativeStaticGeometryUploadBytes ?? 0).toLocaleString()} B</dd></div>}
              {diagnostics.dynamicIndexUploadBytes !== undefined && <div><dt>Dynamic index / style</dt><dd>{diagnostics.dynamicIndexUploadBytes.toLocaleString()} / {(diagnostics.dynamicStyleUploadBytes ?? 0).toLocaleString()} B</dd></div>}
              {diagnostics.lodUniformUploadBytes !== undefined && <div><dt>LOD uniform / cumulative</dt><dd>{diagnostics.lodUniformUploadBytes.toLocaleString()} / {(diagnostics.cumulativeLodUniformUploadBytes ?? 0).toLocaleString()} B</dd></div>}
              {diagnostics.residentPartitionTotal !== undefined && <div><dt>Resident partitions</dt><dd>{(diagnostics.residentPartitionActive ?? 0).toLocaleString()} / {diagnostics.residentPartitionTotal.toLocaleString()} · {(diagnostics.drawRangeCount ?? 0).toLocaleString()} ranges</dd></div>}
              {diagnostics.frameSampleCount !== undefined && <div><dt>Frame samples</dt><dd>{diagnostics.frameSampleCount} / {(diagnostics.totalFrameCount ?? diagnostics.frameSampleCount).toLocaleString()} total · initial {diagnostics.frameWindowIncludesInitialBuild ? 'included' : 'excluded'}</dd></div>}
              {diagnostics.glyphQuads !== undefined && <div><dt>Glyph quads</dt><dd>{diagnostics.glyphQuads.toLocaleString()}</dd></div>}
              {(diagnostics.deferredTextPrimitives !== undefined || diagnostics.deferredIconPrimitives !== undefined) && <div><dt>Deferred text / icons</dt><dd>{(diagnostics.deferredTextPrimitives ?? 0).toLocaleString()} / {(diagnostics.deferredIconPrimitives ?? 0).toLocaleString()}</dd></div>}
              <div><dt>Fixture / seed</dt><dd>{query.fixture} / {query.seed}</dd></div>
              {scene.scopedCompile && <div><dt>Scoped compile</dt><dd>bands→{scene.scopedCompile.maxBand ?? 'code'} · {scene.scopedCompile.entityCount.toLocaleString()} entities &gt; {scene.scopedCompile.bandDepthThreshold.toLocaleString()} threshold{scene.scopedCompile.maxEdgesPerBand ? ` · ≤${scene.scopedCompile.maxEdgesPerBand} edges/band` : ''}{scene.scopedCompile.maxGridNodes ? ` · grid ${scene.scopedCompile.maxGridNodes.toLocaleString()}` : ''}{scene.scopedCompile.directFallbackCount ? ` · ${scene.scopedCompile.directFallbackCount} direct-fallback` : ''}</dd></div>}
              {scene.scanGuardRefusal && <div><dt>Scan guard</dt><dd>unscoped compile of {scene.scanGuardRefusal.requestedFocusId} refused ({scene.scanGuardRefusal.entityCount.toLocaleString()} entities · {scene.scanGuardRefusal.relationCount.toLocaleString()} relations) → fell back to {scene.scanGuardRefusal.fallbackFocusId}</dd></div>}
              {scene.scanDrillRecompile && <div><dt>Drill recompile</dt><dd>{scene.scanDrillRecompile.targetId} · deeper band {scene.scanDrillRecompile.deeperDetail} absent → recompiled via guarded seam</dd></div>}
            </dl>
            <p>{diagnostics.message}</p>
            {query.warnings.map(warning => <p className="diagnostic-warning" key={warning}>{warning}</p>)}
          </aside>}

          <button aria-controls="architecture-inspector" aria-expanded={detailsOpen} className="details-toggle" aria-label={detailsOpen ? 'Close details panel' : 'Open details panel'} onClick={toggleDetails} ref={detailsOpenerRef}><PanelIcon/></button>

          <details className="entity-explorer">
            <summary aria-label="Toggle entity list" id="entity-explorer"><LayersIcon size={15}/><span>Entity list</span></summary>
            <div className="entity-explorer-list" aria-label="Architecture entities">
              <p>KEYBOARD EXPLORER · {visibleExplorerEntities.length.toLocaleString()} ENTITIES</p>
              {visibleExplorerEntities.map(entity => <button aria-current={entity.id === selectedId ? 'true' : undefined} key={entity.id} onClick={() => focusEntity(entity)}><span className={`result-icon kind-${entity.kind}`}>{(entity.kindLabel ?? entity.kind).slice(0, 2).toUpperCase()}</span><span><strong>{entity.name}</strong><small>{entity.kindLabel ?? entity.kind} · {entity.responsibility}</small></span></button>)}
            </div>
          </details>

          {currentStory ? (
            <section aria-label={`Guided architecture story, ${storyPlaybackStatus}`} className="story-player" data-playback-state={storyPhase === 'flight' ? 'moving' : storyPhase === 'arrival' ? 'arriving' : storyPlaying ? 'playing' : 'paused'} data-story-phase={storyPhase}>
              <div className="story-topline"><span><SparkIcon size={14}/> GUIDED EXPLANATION <em className="story-state">{storyPlaybackStatus}</em></span><button aria-label="Close story" onClick={closeStory}><CloseIcon size={15}/></button></div>
              <div className="story-copy"><div><small>{storyPhase === 'flight' ? 'MOVING TO ' : storyPhase === 'arrival' ? 'ARRIVING AT ' : ''}STEP {storyStep + 1} OF {story.steps.length}</small><h2>{currentStory.title}</h2><p>{currentStory.narration}</p>{currentStory.sourceRefs[0] && <p className="story-evidence">Evidence: {currentStory.sourceRefs[0].path}{currentStory.sourceRefs[0].symbol ? ` · ${currentStory.sourceRefs[0].symbol}` : ''}</p>}{storyInterruption && <p className="story-interruption">{storyInterruption}</p>}{returnToStoryFrameRequired && <button onClick={returnToStoryFrame}>Return to story frame</button>}</div><button aria-label={storyControlLabel} className="story-play" onClick={returnToStoryFrameRequired ? returnToStoryFrame : toggleStoryPlayback}>{storyControlActive ? <PauseIcon/> : <PlayIcon/>}</button></div>
              <div className="story-progress">{story.steps.map((step, index) => <button aria-label={`Go to story step ${index + 1}: ${step.title}`} className={index === storyStep ? 'active' : index < storyStep ? 'passed' : ''} key={step.id} onClick={() => setStep(index, false)}><span/></button>)}</div>
              <div className="story-context-controls" role="group" aria-label="Story context visibility">
                <button aria-pressed={visibilityMode === 'dim'} onClick={() => changeVisibility('dim')}>Dim others</button>
                <button aria-pressed={visibilityMode === 'isolate'} onClick={() => changeVisibility('isolate')} ref={visibilityControlRef}>Isolate focus</button>
                <button disabled={visibilityMode === 'all'} onClick={restoreVisibility}>Restore full view</button>
              </div>
              {effectiveVisibilityMode === 'isolate' && <div className="isolation-status" role="status">Showing {isolatedEntityIds.length} of {scene.entities.length} · <button onClick={restoreVisibility}>Restore full view</button></div>}
              <div className="story-footer"><button aria-label="Previous story step, paused" onClick={() => setStep(storyStep - 1, false)}>Previous</button><button aria-label={storyStep === story.steps.length - 1 ? 'Replay story from the beginning, paused' : 'Next story step, paused'} onClick={() => setStep(storyStep + 1, false)}>{storyStep === story.steps.length - 1 ? <><RestartIcon size={15}/> Replay</> : <>Next <ArrowIcon size={15}/></>}</button></div>
            </section>
          ) : query.fixture === 'stress' ? (
            <div className="stress-badge"><ActivityIcon size={15}/><span><b>Renderer stress fixture</b><small>{fixtureError ?? `${scene.entities.length.toLocaleString()} nodes · ${scene.relations.length.toLocaleString()} paths`}</small></span></div>
          ) : (
            <div className="story-launcher">
              <button className="ask-button" onClick={() => setAskOpen(open => !open)} ref={askButtonRef}><SparkIcon/><span><b>Ask Atlas</b><small>Explain this codebase spatially</small></span><kbd>⌘ ↵</kbd></button>
              <button className="saved-story" onClick={() => setStep(0, true, 'push')}><PlayIcon size={14}/> {story.title} <span>{storyDurationLabel}</span></button>
              {askOpen && <form className="ask-popover" onSubmit={submitQuestion}><label htmlFor="atlas-question">Ask about this codebase</label><textarea autoFocus id="atlas-question" onChange={event => setQuestion(event.target.value)} placeholder="How does Okie turn architecture into a rendered map?" ref={askInputRef} rows={3} value={question}/><p>Live Q&amp;A is not connected in this renderer slice. Submitting plays the evidence-linked Okie explanation.</p><button disabled={!question.trim()} type="submit">Preview explanation <ArrowIcon size={15}/></button></form>}
            </div>
          )}

          <div className="canvas-hint"><span>Scroll to zoom</span><i/>drag to pan<i/>click to inspect<i/>double-click to open inside</div>

        </section>

        <aside aria-hidden={detailsOpen ? undefined : true} aria-label={pickedRelationPresentation ? 'Selected architecture relationship inspector' : 'Selected architecture entity inspector'} className={`details-panel ${detailsOpen ? 'open' : ''}`} id="architecture-inspector" inert={!detailsOpen} ref={detailsPanelRef}>
          <div aria-label="Resize inspector" aria-orientation="vertical" aria-valuemax={detailsWidthRange.max} aria-valuemin={detailsWidthRange.min} aria-valuenow={detailsWidth} className="details-resizer" onDoubleClick={() => { setDetailsWidth(defaultInspectorWidth(window.innerWidth)); setSafeAreaEpoch(epoch => epoch + 1); window.setTimeout(() => reframeEntityAfterInspectorChange(selected), 0); }} onKeyDown={resizeInspectorWithKeyboard} onPointerDown={beginInspectorResize} role="separator" tabIndex={0}/>
          <header className="details-header">
            <div className="details-header-title"><span>DETAILS</span><small>Evidence-backed</small></div>
            <div className="details-header-actions">
              {inspectorHistory.length > 0 && <button aria-label="Back to previous inspector selection" data-testid="inspector-back" onClick={navigateInspectorBack} title="Back within details panel" type="button"><span aria-hidden="true">←</span></button>}
              <button aria-label="Close details panel" onClick={closeDetails}><CloseIcon/></button>
            </div>
          </header>
          <div aria-label="Inspector view" className="inspector-tabs" onKeyDown={navigateInspectorTabs} role="tablist">
            <button aria-controls="source-panel" aria-selected={inspectorTab === 'source'} disabled={!sourceAvailable} id="source-tab" onClick={() => selectInspectorTab('source')} ref={sourceTabRef} role="tab" tabIndex={inspectorTab === 'source' ? 0 : -1} type="button">Source</button>
            <button aria-controls="details-panel" aria-selected={inspectorTab === 'details'} id="details-tab" onClick={() => selectInspectorTab('details')} ref={detailsTabRef} role="tab" tabIndex={inspectorTab === 'details' ? 0 : -1} type="button">Details</button>
          </div>
          {inspectorTab === 'source' && sourceAvailable ? <div aria-labelledby="source-tab" className="source-panel" id="source-panel" role="tabpanel">
            <SourceViewer excerpt={selectedExcerpt} localWorkspace={localWorkspace} onFeedback={setLiveMessage}/>
          </div> : <div aria-labelledby="details-tab" className="details-scroll" id="details-panel" role="tabpanel">
            {pickedRelationPresentation ? <article aria-labelledby="inspector-relation-title" className="inspector-presentation inspector-relation-presentation" data-inspector-presentation="relation" data-inspector-relation-id={pickedRelationPresentation.id}>
              <header className="entity-hero relation-hero">
                <div className="entity-kicker"><span>{levels[activeLevel]?.short ?? 'L1'} · Relationship</span><small className="provenance-badge">Selected edge</small></div>
                <h2 id="inspector-relation-title">{pickedRelationPresentation.label}</h2>
                <p className="responsibility relation-route-copy"><strong>{pickedRelationPresentation.source.name}</strong><span aria-hidden="true">→</span><strong>{pickedRelationPresentation.target.name}</strong></p>
                <div aria-label="Relationship metadata" className="entity-metadata">
                  <span>{pickedRelationPresentation.kindLabel ?? 'Relationship'}</span>
                  {pickedRelationPresentation.protocol && <span className="signal">{pickedRelationPresentation.protocol}</span>}
                </div>
                <div aria-label="Relationship endpoint actions" className="detail-actions" role="group">
                  <button className="primary-detail-action" onClick={() => focusEntity(pickedRelationPresentation.source, 'replace', 'frame', 'details', 'panel')}>Inspect source</button>
                  <button className="secondary-detail-action" onClick={() => focusEntity(pickedRelationPresentation.target, 'replace', 'frame', 'details', 'panel')}>Inspect target</button>
                </div>
              </header>

              <section className="detail-section relation-endpoints-section">
                <div className="section-title"><h3>Endpoints</h3><span>2</span></div>
                <div className="inspector-link-list">
                  <button data-inspector-entity-id={pickedRelationPresentation.source.id} onClick={() => focusEntity(pickedRelationPresentation.source, 'replace', 'preserve', 'auto', 'panel')}><span><strong>{pickedRelationPresentation.source.name}</strong><small>Source · {pickedRelationPresentation.source.kindLabel ?? pickedRelationPresentation.source.kind}</small></span><ArrowIcon size={15}/></button>
                  <button data-inspector-entity-id={pickedRelationPresentation.target.id} onClick={() => focusEntity(pickedRelationPresentation.target, 'replace', 'preserve', 'auto', 'panel')}><span><strong>{pickedRelationPresentation.target.name}</strong><small>Target · {pickedRelationPresentation.target.kindLabel ?? pickedRelationPresentation.target.kind}</small></span><ArrowIcon size={15}/></button>
                </div>
              </section>

              <section className="detail-section relation-evidence-section">
                <div className="section-title"><h3>Evidence context</h3><span>{pickedRelationPresentation.evidence.sourceEntityRefs.length + pickedRelationPresentation.evidence.targetEntityRefs.length}</span></div>
                <dl className="relation-facts">
                  <div><dt>Semantic ID</dt><dd>{pickedRelationPresentation.evidence.relationIds.join(', ')}</dd></div>
                  <div><dt>Source anchors</dt><dd>{pickedRelationPresentation.evidence.sourceEntityRefs.length}</dd></div>
                  <div><dt>Target anchors</dt><dd>{pickedRelationPresentation.evidence.targetEntityRefs.length}</dd></div>
                  {pickedRelationPresentation.evidence.frozenRevision && <div><dt>Frozen revision</dt><dd>{pickedRelationPresentation.evidence.frozenRevision}</dd></div>}
                </dl>
                <p className="relation-evidence-note"><InfoIcon size={13}/> Endpoint evidence is shown as context; it is not asserted as direct evidence for the relationship.</p>
              </section>

              {interactionMode === 'edit' && <div aria-label="Relationship editing actions" className="detail-actions relation-edit-actions" role="group">
                <button className="secondary-detail-action" disabled={!authoringEnabled || !selectedRouteOverride} onClick={resetSelectedRelationshipRoute}>Auto route</button>
                <button className="danger-detail-action" disabled={!authoringEnabled} onClick={deleteSelectedRelationship}>Delete relationship</button>
              </div>}
            </article> : <article aria-labelledby="inspector-entity-title" className="inspector-presentation inspector-entity-presentation" data-inspector-entity-id={selected.id} data-inspector-presentation="entity">
              <header className="entity-hero">
                <div className="entity-kicker"><span>{selectedLevelLabel}</span><small className={`provenance-badge tone-${selectedProvenance.tone}`}>{selectedProvenance.badge}</small></div>
                <h2 id="inspector-entity-title">{selected.name}</h2>
                <p className="responsibility">{selected.responsibility}</p>
                <div aria-label="Entity metadata" className="entity-metadata">
                  <span>{selected.technology ?? 'Technology not specified'}</span>
                  {selected.tags?.map(tag => <span className="signal" key={tag}>{tag}</span>)}
                </div>
                <div aria-label="Entity actions" className="detail-actions" role="group">
                  {selected.detail === 'code'
                    ? <button className="primary-detail-action" disabled={!sourceAvailable} onClick={() => focusEntity(selected, 'replace', 'preserve', 'source', 'preserve')}><CodeIcon size={15}/> Open source</button>
                    : <button className="primary-detail-action" disabled={!selectedHasChildren} onClick={() => openInside(selected.id, 'preserve')}>Open inside <ArrowIcon size={15}/></button>}
                  <button className="secondary-detail-action" onClick={() => focusEntity(selected, 'replace', 'frame', 'details', 'preserve')}><FitIcon size={15}/> Show on map</button>
                </div>
              </header>

              <div aria-label={selectedProvenance.accessibleSummary} className={`provenance-strip tone-${selectedProvenance.tone}`}>
                <div><span><InfoIcon size={13}/> {selectedProvenance.heading}</span><strong>{selectedProvenance.evidenceLabel}</strong></div>
                <p>{selectedProvenance.description}</p>
              </div>

              <section className="detail-section diagrams-section">
                <div className="section-title"><h3>Diagrams</h3><span>{selected.detail === 'component' || selected.detail === 'code' ? 3 : 2}</span></div>
                <div className={`notation-readiness ${notationDiagnostics.length ? 'advisory' : 'ready'}`}><span>{notationDiagnostics.length ? `${notationDiagnostics.length} C4 ${notationDiagnostics.length === 1 ? 'advisory' : 'advisories'}` : 'C4 notation ready'}</span><small>Title, scope, descriptions, technology, and relationship labels</small></div>
                <div className="inspector-link-list">
                  <button data-diagram-action="open-flow" onClick={() => openDerivedDiagram('flow')}><span><strong>Open dynamic flow</strong><small>Evidence-backed ordered interactions around this scope</small></span><ArrowIcon size={15}/></button>
                  <button data-diagram-action="open-mermaid" onClick={() => openDerivedDiagram('mermaid')}><span><strong>Open Mermaid view</strong><small>Deterministic semantic export for this flow</small></span><ArrowIcon size={15}/></button>
                  {(selected.detail === 'component' || selected.detail === 'code') && <button data-diagram-action="open-code" onClick={() => openDerivedDiagram('code')}><span><strong>Open code diagram</strong><small>Curated source structure for this component</small></span><ArrowIcon size={15}/></button>}
                </div>
              </section>

              {selectedParent && <section className="detail-section parent-section">
                <div className="section-title"><h3>Parent layer</h3><span>1</span></div>
                <div className="inspector-link-list"><button data-inspector-entity-id={selectedParent.id} onClick={() => navigateInspectorHierarchy(selectedParent)}><span><strong>{selectedParent.name}</strong><small>{selectedParent.responsibility || selectedParent.kindLabel || selectedParent.kind}</small></span><ArrowIcon size={15}/></button></div>
              </section>}

              {selectedChildren.length > 0 && <section className="detail-section children-section">
                <div className="section-title"><h3>Inside this layer</h3><span>{selectedChildren.length}</span></div>
                <div className="inspector-link-list">{selectedChildren.map(child => <button data-inspector-entity-id={child.id} key={child.id} onClick={() => navigateInspectorHierarchy(child)}><span><strong>{child.name}</strong><small>{child.responsibility || child.kindLabel || child.kind}</small></span><ArrowIcon size={15}/></button>)}</div>
              </section>}

              <section className="detail-section relationships-section">
                <div className="section-title"><h3>Relationships</h3><span>{visibleRelated.length}</span></div>
                <div className="relations-list">{visibleRelated.length > 0 ? visibleRelated.map(relation => {
                  const outbound = relation.from === selected.id;
                  const otherId = outbound ? relation.to : relation.from;
                  const other = scene.entities.find(entity => entity.id === otherId);
                  if (!other) return null;
                  const relationshipLabel = relation.label ?? relation.kindLabel ?? 'Relationship';
                  return <button aria-label={`${outbound ? 'Outbound' : 'Inbound'} ${relationshipLabel} ${outbound ? 'to' : 'from'} ${other.name}`} data-inspector-presentation="relation-summary" data-inspector-relation-id={relation.id} key={relation.id} onClick={() => inspectRelation(relation, 'panel')}><span aria-hidden="true" className="relation-direction">{outbound ? '→' : '←'}</span><span><strong>{other.name}</strong><small>{relationshipLabel}{relation.protocol ? ` · ${relation.protocol}` : ''}</small></span><ChevronIcon size={15}/></button>;
                }) : <div className="empty-inspector-section">No explicit relationships at this level.</div>}</div>
              </section>

              {selected.id === navigationIdentity.rootEntityId && scene.omittedRelations?.length ? <section className="detail-section relationships-section omitted-relations-section" data-testid="omitted-relations">
                <div className="section-title"><h3>Not drawn at this zoom</h3><span>{scene.omittedRelations.length}</span></div>
                <div className="relations-list"><p className="empty-inspector-section">{scene.omittedRelations.length} relation{scene.omittedRelations.length === 1 ? '' : 's'} aggregated out of the routed view for this dense scope — still evidence-backed:</p>{scene.omittedRelations.map(omitted => <div className="source-card static" data-omitted-relation-id={omitted.relationId} key={omitted.relationId}><span><strong>{omitted.fromName} → {omitted.toName}</strong><small>{omitted.label}{omitted.evidencePaths.length ? ` · ${omitted.evidencePaths.length} evidence file${omitted.evidencePaths.length === 1 ? '' : 's'}` : ''}</small></span></div>)}</div>
              </section> : null}

              <section className="detail-section evidence-section">
                <div className="section-title"><h3>Source evidence</h3><span>{selected.sourceRefs?.length ?? 0}</span></div>
                <div className="source-list">{selected.sourceRefs?.length ? selected.sourceRefs.map((source, index) => {
                  const opensSource = sourceAvailable && selectedExcerpt?.path === source.path;
                  const lineLabel = source.startLine === undefined
                    ? ''
                    : source.endLine !== undefined && source.endLine !== source.startLine
                      ? ` · lines ${source.startLine}–${source.endLine}`
                      : ` · line ${source.startLine}`;
                  const sourceContent = <><FileIcon/><span><strong>{source.path.split('/').at(-1)}{source.symbol ? <em>{source.symbol}</em> : null}</strong><small>{source.path}{lineLabel}<br/>Frozen at {source.revision.slice(0, 12)}</small></span>{opensSource ? <ArrowIcon size={15}/> : <span aria-hidden="true" className="source-static-mark">•</span>}</>;
                  return opensSource
                    ? <button className="source-card" key={`${source.path}:${source.symbol ?? ''}:${source.startLine ?? ''}:${index}`} onClick={() => focusEntity(selected, 'replace', 'preserve', 'source', 'preserve')} title="Open frozen source excerpt">{sourceContent}</button>
                    : <div className="source-card static" key={`${source.path}:${source.symbol ?? ''}:${source.startLine ?? ''}:${index}`}>{sourceContent}</div>;
                }) : <div className="empty-inspector-section">No repository source linked.</div>}</div>
                <p><InfoIcon size={13}/> Evidence-linked summaries retain their frozen fixture source references.</p>
              </section>
            </article>}
          </div>}
        </aside>
        </> : <section className="map-stage derived-map-stage"><SemanticDiagramSurface flowArtifact={activeDynamicFlowArtifact} mermaidSource={activeMermaidSource} notationAdvisoryCount={notationDiagnostics.length} onSessionChange={updateActiveDiagramSession} scene={scene} surface={activeDiagramSurface}/></section>}
      </main>
      <div aria-atomic="true" aria-live="polite" className="sr-only" role="status">{liveMessage}</div>
    </div>
  );
}
