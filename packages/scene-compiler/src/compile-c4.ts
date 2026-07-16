import {
  C4_BANDS,
  C4_INTRINSIC_LAYOUT,
  buildC4ProjectionBundle,
  materializeArchitectureAuthoring,
  measureC4Grid,
  routeC4BandEdgesDetailed,
  validateArchitectureAuthoringDocument,
  type ArchitectureEntity,
  type ArchitectureAuthoringDocument,
  type ArchitectureSnapshot,
  type ArchitectureStory,
  type BandLayout,
  type BandProjection,
  type BuildC4ProjectionOptions,
  type C4RouteOverrideDiagnostic,
  type C4Band,
  type C4GridMetrics,
  type C4ProjectionBundle,
  type NodeLayout,
  type RelationRouteOverride,
  type VisualEdge,
  type VisualNode,
} from '@okie/architecture';
import { RENDERER_PROTOCOL_VERSION, type LodRange, type Rect, type Representation, type SceneObject, type ScenePath, type SceneSnapshot, type Timeline } from './protocol.js';
import { defaultTheme, type SceneTheme } from './theme.js';
import { displayTextWidth, fitDisplayText } from './display-text.js';

export type CompiledZoomBand = {
  detail: C4Band;
  enterZoom: number;
  exitZoom: number | null;
  focusZoom: number;
  fadeWidth: number;
  hysteresis: number;
};

/** Canonical camera envelope for the authored four-level C4 atlas. */
export const C4_CAMERA_LIMITS = Object.freeze({ minZoom: 0.32, maxZoom: 32 });

/**
 * Each forced preset is approximately 2.65x the preceding level. Eligibility
 * windows remain overlapped so changing the readable presets cannot introduce
 * a hard representation cut.
 */
export const C4_ZOOM_BANDS: readonly CompiledZoomBand[] = [
  { detail: 'context', enterZoom: 0, exitZoom: 1.30, focusZoom: 0.75, fadeWidth: 0.14, hysteresis: 0.04 },
  { detail: 'container', enterZoom: 1.16, exitZoom: 3.75, focusZoom: 1.99, fadeWidth: 0.14, hysteresis: 0.08 },
  { detail: 'component', enterZoom: 3.35, exitZoom: 7.95, focusZoom: 5.27, fadeWidth: 0.40, hysteresis: 0.23 },
  { detail: 'code', enterZoom: 7.10, exitZoom: null, focusZoom: 13.96, fadeWidth: 0.85, hysteresis: 0.50 },
];

export const C4_PRESENTATION_AT_FOCUS = Object.freeze({
  context: { geometryScale: 0.62, kickerFontSize: 13.5, titleFontSize: 20, descriptionFontSize: 15.5 },
  container: { geometryScale: 0.78, kickerFontSize: 10, titleFontSize: 15.5, descriptionFontSize: 11 },
  component: { geometryScale: 1.10, kickerFontSize: 10, titleFontSize: 16.5, descriptionFontSize: 11 },
  code: { geometryScale: 1.25, kickerFontSize: 7.2, titleFontSize: 11.2, descriptionFontSize: 7.4 },
} satisfies Readonly<Record<C4Band, {
  geometryScale: number;
  kickerFontSize: number;
  titleFontSize: number;
  descriptionFontSize: number;
}>>);

const visualScaleByBand: Readonly<Record<C4Band, number>> = {
  context: C4_PRESENTATION_AT_FOCUS.context.geometryScale / C4_ZOOM_BANDS[0]!.focusZoom,
  container: C4_PRESENTATION_AT_FOCUS.container.geometryScale / C4_ZOOM_BANDS[1]!.focusZoom,
  component: C4_PRESENTATION_AT_FOCUS.component.geometryScale / C4_ZOOM_BANDS[2]!.focusZoom,
  code: C4_PRESENTATION_AT_FOCUS.code.geometryScale / C4_ZOOM_BANDS[3]!.focusZoom,
};

export type BandTransitionNode = {
  visualNodeId: string;
  entityId: string;
  fromBounds?: NodeLayout;
  toBounds?: NodeLayout;
};

export type BandTransitionMap = {
  id: string;
  from: C4Band;
  to: C4Band;
  nodes: BandTransitionNode[];
};

export type CompiledC4Scene = {
  scene: SceneSnapshot;
  projections: C4ProjectionBundle;
  zoomPolicy: { id: string; bands: CompiledZoomBand[]; minZoom: number; maxZoom: number };
  transitionMaps: BandTransitionMap[];
  routeDiagnostics?: C4RouteOverrideDiagnostic[];
};

export type CompileC4SceneOptions = {
  sceneId?: string;
  revision?: number;
  worldPadding?: number;
  theme?: SceneTheme;
  routeOverrides?: readonly RelationRouteOverride[];
};

export type CompileAuthoredC4SceneOptions = Omit<CompileC4SceneOptions, 'routeOverrides'>;

export type CompileC4TimelineOptions = {
  viewportWidth?: number;
  viewportHeight?: number;
  padding?: number;
  arrivalSettleMs?: number;
};

function lodFor(band: C4Band): LodRange {
  const value = C4_ZOOM_BANDS.find(candidate => candidate.detail === band)!;
  return {
    minZoom: value.enterZoom,
    maxZoom: value.exitZoom,
    fadeWidth: value.fadeWidth,
    hysteresis: value.hysteresis,
  };
}

function union(rects: readonly Rect[]): Rect {
  const left = Math.min(...rects.map(rect => rect.x));
  const top = Math.min(...rects.map(rect => rect.y));
  const right = Math.max(...rects.map(rect => rect.x + rect.width));
  const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function expand(rect: Rect, padding: number): Rect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}

function presentation(
  node: VisualNode,
  entity: ArchitectureEntity,
  bounds: NodeLayout,
  band: C4Band,
  boundary: boolean,
  theme: SceneTheme,
): Representation {
  const visualScale = visualScaleByBand[band];
  const fill = theme.entityFill[node.kind];
  const bodyFill: typeof fill = boundary ? [fill[0], fill[1], fill[2], 0.14] : fill;
  const left = bounds.x + (boundary ? 22 : 18) * visualScale;
  const kickerY = bounds.y + (band === 'context' ? 30 : 24) * visualScale;
  const titleY = bounds.y + (boundary ? 36 : band === 'context' ? 68 : band === 'code' ? 42 : 50) * visualScale;
  const descriptionY = bounds.y + (band === 'context' ? 112 : band === 'code' ? 68 : 76) * visualScale;
  const sourcePath = entity.sourceRefs[0]?.path;
  const description = band === 'code' ? sourcePath : node.responsibility;
  const kindLabel: Record<VisualNode['kind'], string> = {
    person: 'PERSON',
    softwareSystem: 'SOFTWARE SYSTEM',
    externalSystem: 'EXTERNAL SYSTEM',
    container: 'CONTAINER',
    dataStore: 'DATA STORE',
    queue: 'QUEUE',
    component: 'COMPONENT',
    code: 'SOURCE',
    boundary: 'BOUNDARY',
  };
  const focusZoom = C4_ZOOM_BANDS.find(candidate => candidate.detail === band)!.focusZoom;
  const focusPresentation = C4_PRESENTATION_AT_FOCUS[band];
  const maxWidth = Math.max(1, bounds.width - 36 * visualScale);
  const titleFontSize = focusPresentation.titleFontSize
    * (boundary && (band === 'context' || band === 'container') ? 0.78 : 1)
    / focusZoom;
  const kickerFontSize = focusPresentation.kickerFontSize / focusZoom;
  const descriptionFontSize = focusPresentation.descriptionFontSize / focusZoom;
  const displayKicker = fitDisplayText(kindLabel[node.kind], maxWidth, kickerFontSize, 'word', 'sans-semibold');
  const displayTitle = fitDisplayText(node.name, maxWidth, titleFontSize, 'identifier', band === 'code' ? 'mono-semibold' : 'sans-semibold');
  const displayDescription = description
    ? fitDisplayText(description, maxWidth, descriptionFontSize, band === 'code' ? 'path' : 'word', band === 'code' ? 'mono-regular' : 'sans-regular')
    : undefined;
  return {
    id: `${node.id}:${band}`,
    lod: lodFor(band),
    bounds: { ...bounds },
    primitives: [
      {
        kind: 'roundedRect',
        rect: bounds,
        radius: (boundary ? 20 : band === 'code' ? 7 : 14) * visualScale,
        fill: bodyFill,
        stroke: { color: [Math.min(1, fill[0] + 0.18), Math.min(1, fill[1] + 0.18), Math.min(1, fill[2] + 0.18), boundary ? 0.62 : 0.94], width: (boundary ? 1.5 : 2) * visualScale },
      },
      {
        kind: 'text',
        position: { x: left, y: kickerY },
        maxWidth,
        content: displayKicker,
        fontFamily: 'IBM Plex Sans SemiBold',
        fontSize: kickerFontSize,
        color: theme.mutedText,
        align: 'start',
      },
      {
        kind: 'text',
        position: { x: left, y: titleY },
        maxWidth,
        content: displayTitle,
        fontFamily: band === 'code' ? 'IBM Plex Mono SemiBold' : 'IBM Plex Sans SemiBold',
        fontSize: titleFontSize,
        color: theme.text,
        align: 'start',
      },
      ...(!boundary && displayDescription ? ([{
        kind: 'text' as const,
        position: { x: left, y: descriptionY },
        maxWidth,
        content: displayDescription,
        fontFamily: band === 'code' ? 'IBM Plex Mono' : 'IBM Plex Sans',
        fontSize: descriptionFontSize,
        color: theme.mutedText,
        align: 'start' as const,
      }] satisfies Representation['primitives']) : []),
    ],
  };
}

function visibleChildren(projection: BandProjection, bundle: C4ProjectionBundle) {
  const visible = new Set(projection.visualNodeIds);
  const parents = new Set<string>();
  for (const id of projection.visualNodeIds) {
    const parent = bundle.visualNodeById[id]?.parentVisualId;
    if (parent && visible.has(parent)) parents.add(parent);
  }
  return parents;
}

function objectForNode(
  snapshot: ArchitectureSnapshot,
  bundle: C4ProjectionBundle,
  node: VisualNode,
  theme: SceneTheme,
): SceneObject | undefined {
  const entity = snapshot.entities.find(candidate => candidate.id === node.entity.logicalId);
  if (!entity) return undefined;
  const appearances: Array<{ band: C4Band; bounds: NodeLayout; boundary: boolean }> = [];
  for (const band of C4_BANDS) {
    const projection = bundle.projectionById[bundle.family.projectionIds[band]]!;
    const layout = bundle.bandLayoutById[projection.layoutId]!;
    const bounds = layout.nodes[node.id];
    if (bounds) appearances.push({ band, bounds, boundary: visibleChildren(projection, bundle).has(node.id) });
  }
  if (!appearances.length) return undefined;
  const bounds = union(appearances.map(value => value.bounds));
  return {
    id: node.id,
    ...(node.parentVisualId && bundle.visualNodeById[node.parentVisualId] ? { parentId: node.parentVisualId } : {}),
    zIndex: node.kind === 'softwareSystem' ? -4 : node.kind === 'container' || node.kind === 'dataStore' || node.kind === 'queue' ? -3 : node.kind === 'component' ? -2 : 1,
    bounds,
    pickable: true,
    representations: appearances.map(value => presentation(node, entity, value.bounds, value.band, value.boundary, theme)),
  };
}

function intersects(left: Rect, right: Rect): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function contains(outer: Rect, inner: Rect): boolean {
  return outer.x <= inner.x && outer.y <= inner.y
    && outer.x + outer.width >= inner.x + inner.width
    && outer.y + outer.height >= inner.y + inner.height;
}

function padded(rect: Rect, amount: number): Rect {
  return { x: rect.x - amount, y: rect.y - amount, width: rect.width + amount * 2, height: rect.height + amount * 2 };
}

function labelPriority(edge: VisualEdge): number {
  const semanticIds = new Set(edge.relations.map(relation => relation.logicalId));
  if (semanticIds.has('relation:developer-explores-okie')) return 100;
  if (semanticIds.has('relation:okie-renders-browser')) return 90;
  if (semanticIds.has('relation:okie-source-evidence')) return 10;
  return 50;
}

function labelForEdge(
  edge: VisualEdge,
  layout: BandLayout,
  band: C4Band,
  theme: SceneTheme,
  occupiedLabelBounds: readonly Rect[],
): SceneObject | undefined {
  if (band === 'component' || band === 'code') return undefined;
  const route = layout.edges[edge.id];
  if (!route || !edge.label) return undefined;
  const visualScale = visualScaleByBand[band];
  const fontSize = (band === 'context' ? 24 : 13) * visualScale;
  const labelMaxWidth = 420 * visualScale;
  const curatedMapLabels: Readonly<Record<string, string>> = {
    'relation:developer-explores-okie': 'explores',
    'relation:okie-source-evidence': 'source evidence',
    'relation:okie-renders-browser': 'renders through',
    'relation:model-to-compiler': 'provides models',
    'relation:compiler-to-renderer': 'compiles scenes',
    'relation:web-controls-renderer': 'hosts renderer',
    'relation:tooling-builds-renderer': 'builds WASM',
    'relation:tooling-generates-scenes': 'generates fixtures',
  };
  const semanticRelationIds = edge.relations.map(relation => relation.logicalId);
  const curatedLabel = semanticRelationIds.length === 1
    ? curatedMapLabels[semanticRelationIds[0]!]
    : undefined;
  const displayLabel = fitDisplayText(curatedLabel ?? edge.label, labelMaxWidth, fontSize, 'word', 'sans-medium');
  const width = Math.min(labelMaxWidth, Math.max(72 * visualScale, displayTextWidth(displayLabel, fontSize, 'sans-medium')));
  const height = fontSize + 6 * visualScale;
  const from = layout.nodes[edge.fromVisualId];
  const to = layout.nodes[edge.toVisualId];
  if (!from || !to) return undefined;
  const obstacles = Object.entries(layout.nodes)
    .filter(([id, bounds]) => id === edge.fromVisualId
      || id === edge.toVisualId
      || !(contains(bounds, from) && contains(bounds, to)))
    .map(([, bounds]) => bounds);
  const clearance = layout.policy.labelPaddingScreenPx / C4_ZOOM_BANDS.find(value => value.detail === band)!.focusZoom;
  const segments = route.points.slice(0, -1).map((start, index) => {
    const end = route.points[index + 1]!;
    return { start, end, length: Math.abs(end.x - start.x) + Math.abs(end.y - start.y) };
  }).sort((left, right) => right.length - left.length);
  const candidatePositions = segments.flatMap(segment => {
    const center = { x: (segment.start.x + segment.end.x) / 2, y: (segment.start.y + segment.end.y) / 2 };
    return segment.start.y === segment.end.y
      ? [{ x: center.x, y: center.y - 7 * visualScale }, { x: center.x, y: center.y + fontSize + 13 * visualScale }]
      : [
          { x: center.x, y: center.y + fontSize / 2 },
          { x: center.x - width / 2 - 12 * visualScale, y: center.y + fontSize / 2 },
          { x: center.x + width / 2 + 12 * visualScale, y: center.y + fontSize / 2 },
        ];
  });
  let position: { x: number; y: number } | undefined;
  let bounds: Rect | undefined;
  for (const candidate of candidatePositions) {
    const candidateBounds = { x: candidate.x - width / 2, y: candidate.y - fontSize - 3 * visualScale, width, height };
    const collisionBounds = padded(candidateBounds, clearance);
    if (obstacles.some(obstacle => intersects(collisionBounds, obstacle))) continue;
    if (occupiedLabelBounds.some(other => intersects(collisionBounds, padded(other, clearance)))) continue;
    position = candidate;
    bounds = candidateBounds;
    break;
  }
  // Dense labels are optional presentation. When no collision-free segment
  // exists, retain the semantic relation for picking/inspection but suppress
  // the map label instead of drawing over a card or a higher-priority label.
  if (!position || !bounds) return undefined;
  return {
    id: `relation-label:${edge.id}`,
    zIndex: 30,
    bounds,
    pickable: false,
    representations: [{
      id: `relation-label:${edge.id}:${band}`,
      lod: lodFor(band),
      bounds,
      primitives: [{
        kind: 'text',
        position,
        maxWidth: labelMaxWidth,
        content: displayLabel,
        fontFamily: 'IBM Plex Sans Medium',
        fontSize,
        color: theme.edgeLabel,
        align: 'center',
      }],
    }],
  };
}

function transitionMaps(bundle: C4ProjectionBundle): BandTransitionMap[] {
  return C4_BANDS.slice(0, -1).map((from, index) => {
    const to = C4_BANDS[index + 1]!;
    const fromProjection = bundle.projectionById[bundle.family.projectionIds[from]]!;
    const toProjection = bundle.projectionById[bundle.family.projectionIds[to]]!;
    const fromLayout = bundle.bandLayoutById[fromProjection.layoutId]!;
    const toLayout = bundle.bandLayoutById[toProjection.layoutId]!;
    const ids = [...new Set([...fromProjection.visualNodeIds, ...toProjection.visualNodeIds])].sort();
    return {
      id: `band-transition:${bundle.family.id}:${from}:${to}`,
      from,
      to,
      nodes: ids.map(visualNodeId => ({
        visualNodeId,
        entityId: bundle.index.entityIdByVisualNodeId[visualNodeId]!,
        ...(fromLayout.nodes[visualNodeId] ? { fromBounds: { ...fromLayout.nodes[visualNodeId]! } } : {}),
        ...(toLayout.nodes[visualNodeId] ? { toBounds: { ...toLayout.nodes[visualNodeId]! } } : {}),
      })),
    };
  });
}

type OwnerTransform = {
  ownerId: string;
  scale: number;
  offsetX: number;
  offsetY: number;
};

function semanticBandForEntity(entity: ArchitectureEntity): C4Band {
  if (entity.kind === 'container' || entity.kind === 'dataStore' || entity.kind === 'queue') return 'container';
  if (entity.kind === 'component') return 'component';
  if (entity.kind === 'code') return 'code';
  return 'context';
}

type IntrinsicSize = { width: number; height: number };

function intrinsicMetricsForOwner(entity: ArchitectureEntity): C4GridMetrics | undefined {
  const contract = C4_INTRINSIC_LAYOUT;
  const focusZoom = entity.kind === 'component'
    ? C4_ZOOM_BANDS[3]!.focusZoom
    : entity.kind === 'container' || entity.kind === 'dataStore' || entity.kind === 'queue'
      ? C4_ZOOM_BANDS[2]!.focusZoom
      : entity.kind === 'softwareSystem'
        ? C4_ZOOM_BANDS[1]!.focusZoom
        : undefined;
  if (!focusZoom) return undefined;
  const header = entity.kind === 'component'
    ? contract.header.component
    : entity.kind === 'softwareSystem'
      ? contract.header.system
      : contract.header.container;
  return {
    gap: contract.gap / focusZoom,
    paddingLeft: contract.sidePadding / focusZoom,
    paddingRight: contract.sidePadding / focusZoom,
    paddingTop: header / focusZoom,
    paddingBottom: contract.bottomPadding / focusZoom,
    maxColumns: contract.maxColumns,
  };
}

function expectedChildKind(owner: ArchitectureEntity, child: ArchitectureEntity): boolean {
  if (owner.kind === 'component') return child.kind === 'code';
  if (owner.kind === 'container' || owner.kind === 'dataStore' || owner.kind === 'queue') {
    return child.kind === 'component';
  }
  if (owner.kind === 'softwareSystem') {
    return child.kind === 'container' || child.kind === 'dataStore' || child.kind === 'queue';
  }
  return false;
}

/**
 * Grows the squeeze-normalized hierarchy from its leaves upward, then reflows
 * every direct-child grid inside the resulting persistent owner shells.
 */
function applyIntrinsicOwnerGeometry(
  snapshot: ArchitectureSnapshot,
  bundle: C4ProjectionBundle,
  entityById: ReadonlyMap<string, ArchitectureEntity>,
  routeOverrides: readonly RelationRouteOverride[],
  routeDiagnostics: C4RouteOverrideDiagnostic[],
): void {
  const rootId = bundle.family.rootEntity.logicalId;
  const childrenByOwner = new Map<string, ArchitectureEntity[]>();
  for (const entity of snapshot.entities) {
    if (!entity.parentId) continue;
    const owner = entityById.get(entity.parentId);
    if (!owner || !expectedChildKind(owner, entity)) continue;
    const children = childrenByOwner.get(owner.id) ?? [];
    children.push(entity);
    childrenByOwner.set(owner.id, children);
  }
  for (const children of childrenByOwner.values()) children.sort((left, right) => left.id.localeCompare(right.id));

  const boundsFor = (entity: ArchitectureEntity): NodeLayout | undefined => {
    const visualId = bundle.index.visualNodeIdsByEntityId[entity.id]?.[0];
    if (!visualId) return undefined;
    const projection = bundle.projectionById[bundle.family.projectionIds[semanticBandForEntity(entity)]];
    return projection ? bundle.bandLayoutById[projection.layoutId]?.nodes[visualId] : undefined;
  };
  const requiredByEntityId = new Map<string, IntrinsicSize>();
  const measuring = new Set<string>();
  const requiredFor = (entity: ArchitectureEntity): IntrinsicSize => {
    const cached = requiredByEntityId.get(entity.id);
    if (cached) return cached;
    if (measuring.has(entity.id)) throw new Error(`Cyclic C4 hierarchy at ${entity.id}`);
    measuring.add(entity.id);
    const baseline = boundsFor(entity) ?? { x: 0, y: 0, width: 0, height: 0 };
    let required: IntrinsicSize = { width: baseline.width, height: baseline.height };
    if (entity.kind === 'code') {
      const focusZoom = C4_ZOOM_BANDS[3]!.focusZoom;
      required = {
        width: Math.max(required.width, C4_INTRINSIC_LAYOUT.leaf.code.width / focusZoom),
        height: Math.max(required.height, C4_INTRINSIC_LAYOUT.leaf.code.height / focusZoom),
      };
    } else {
      const metrics = intrinsicMetricsForOwner(entity);
      const children = childrenByOwner.get(entity.id) ?? [];
      if (metrics && children.length) {
        const measurement = measureC4Grid(children.map(child => ({ id: child.id, ...requiredFor(child) })), metrics);
        required = {
          width: Math.max(required.width, measurement.width),
          height: Math.max(required.height, measurement.height),
        };
      }
    }
    measuring.delete(entity.id);
    requiredByEntityId.set(entity.id, required);
    return required;
  };

  const root = entityById.get(rootId);
  if (!root) return;
  requiredFor(root);
  const canonical = new Map<string, NodeLayout>();
  const rootBaseline = boundsFor(root);
  if (!rootBaseline) return;
  const rootRequired = requiredByEntityId.get(root.id)!;
  canonical.set(root.id, {
    x: rootBaseline.x + (rootBaseline.width - rootRequired.width) / 2,
    y: rootBaseline.y + (rootBaseline.height - rootRequired.height) / 2,
    ...rootRequired,
  });

  const placeChildren = (owner: ArchitectureEntity): void => {
    const ownerBounds = canonical.get(owner.id);
    const children = childrenByOwner.get(owner.id) ?? [];
    const metrics = intrinsicMetricsForOwner(owner);
    if (!ownerBounds || !metrics || !children.length) return;
    const items = children.map(child => ({ id: child.id, ...requiredByEntityId.get(child.id)! }));
    const measurement = measureC4Grid(items, metrics);
    const availableWidth = ownerBounds.width - metrics.paddingLeft - metrics.paddingRight;
    const availableHeight = ownerBounds.height - metrics.paddingTop - metrics.paddingBottom;
    const gridX = ownerBounds.x + metrics.paddingLeft
      + Math.max(0, availableWidth - measurement.contentWidth) / 2;
    const gridY = ownerBounds.y + metrics.paddingTop
      + Math.max(0, availableHeight - measurement.contentHeight) / 2;
    const ordered = [...children].sort((left, right) => left.id.localeCompare(right.id));
    ordered.forEach((child, index) => {
      const size = requiredByEntityId.get(child.id)!;
      const column = index % measurement.columns;
      const row = Math.floor(index / measurement.columns);
      const columnX = measurement.columnWidths.slice(0, column).reduce((sum, value) => sum + value, 0)
        + metrics.gap * column;
      const rowY = measurement.rowHeights.slice(0, row).reduce((sum, value) => sum + value, 0)
        + metrics.gap * row;
      canonical.set(child.id, {
        x: gridX + columnX + (measurement.columnWidths[column]! - size.width) / 2,
        y: gridY + rowY + (measurement.rowHeights[row]! - size.height) / 2,
        ...size,
      });
      placeChildren(child);
    });
  };
  placeChildren(root);

  for (const band of C4_BANDS) {
    const projection = bundle.projectionById[bundle.family.projectionIds[band]]!;
    const layout = bundle.bandLayoutById[projection.layoutId]!;
    for (const visualId of projection.visualNodeIds) {
      const entityId = bundle.index.entityIdByVisualNodeId[visualId]!;
      const bounds = canonical.get(entityId);
      if (bounds) layout.nodes[visualId] = { ...bounds };
    }
    const focusZoom = C4_ZOOM_BANDS.find(value => value.detail === band)!.focusZoom;
    const routed = routeC4BandEdgesDetailed(
      projection,
      bundle.visualNodeById,
      bundle.visualEdgeById,
      layout.nodes,
      {
        clearance: 8 / focusZoom,
        laneSpacing: 10 / focusZoom,
        maxPoints: 16,
        maxGridNodes: 20_000,
        routeOverrides,
      },
    );
    layout.edges = routed.edges;
    routeDiagnostics.push(...routed.diagnostics);
  }
}

/**
 * Keeps every expandable owner in one persistent world-space box. Incoming
 * children and routes are uniformly fitted inside that box, then ordinary
 * camera zoom provides the reading runway to the next semantic handoff.
 */
export function normalizeC4OwnerGeometry(
  snapshot: ArchitectureSnapshot,
  source: C4ProjectionBundle,
  routeOverrides: readonly RelationRouteOverride[] = [],
  routeDiagnostics: C4RouteOverrideDiagnostic[] = [],
): C4ProjectionBundle {
  const bundle: C4ProjectionBundle = {
    ...source,
    bandLayoutById: Object.fromEntries(Object.entries(source.bandLayoutById).map(([id, layout]) => [id, {
      ...layout,
      policy: { ...layout.policy },
      nodes: Object.fromEntries(Object.entries(layout.nodes).map(([nodeId, bounds]) => [nodeId, { ...bounds }])),
      edges: Object.fromEntries(Object.entries(layout.edges).map(([edgeId, route]) => [edgeId, {
        points: route.points.map(point => ({ ...point })),
      }])),
    }])),
    index: {
      ...source.index,
      entityIdByVisualNodeId: { ...source.index.entityIdByVisualNodeId },
      visualNodeIdsByEntityId: Object.fromEntries(Object.entries(source.index.visualNodeIdsByEntityId)
        .map(([id, values]) => [id, [...values]])),
      relationIdsByVisualEdgeId: Object.fromEntries(Object.entries(source.index.relationIdsByVisualEdgeId)
        .map(([id, values]) => [id, [...values]])),
      visualEdgeIdsByRelationId: Object.fromEntries(Object.entries(source.index.visualEdgeIdsByRelationId)
        .map(([id, values]) => [id, [...values]])),
      boundsByEntityIdAndBand: {},
    },
  };
  const entityById = new Map(snapshot.entities.map(entity => [entity.id, entity]));
  const isDescendantOrSelf = (entityId: string, ownerId: string) => {
    let current = entityById.get(entityId);
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (current.id === ownerId) return true;
      seen.add(current.id);
      current = current.parentId ? entityById.get(current.parentId) : undefined;
    }
    return false;
  };
  const transitions = C4_BANDS.slice(1).map((to, index) => ({ from: C4_BANDS[index]!, to }));
  for (const { from, to } of transitions) {
    const fromProjection = bundle.projectionById[bundle.family.projectionIds[from]]!;
    const toProjection = bundle.projectionById[bundle.family.projectionIds[to]]!;
    const fromLayout = bundle.bandLayoutById[fromProjection.layoutId]!;
    const toLayout = bundle.bandLayoutById[toProjection.layoutId]!;
    const targetEntityIds = new Set(toProjection.visualNodeIds.map(id => bundle.index.entityIdByVisualNodeId[id]!));
    const owners = snapshot.entities
      .filter(entity => semanticBandForEntity(entity) === from)
      .filter(entity => {
        const visualId = bundle.index.visualNodeIdsByEntityId[entity.id]?.[0];
        return Boolean(visualId && fromLayout.nodes[visualId] && toLayout.nodes[visualId])
          && [...targetEntityIds].some(candidate => candidate !== entity.id && isDescendantOrSelf(candidate, entity.id));
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    const ownerIds = new Set(owners.map(owner => owner.id));
    const transforms = new Map<string, OwnerTransform>();
    for (const owner of owners) {
      const visualId = bundle.index.visualNodeIdsByEntityId[owner.id]![0]!;
      const previous = fromLayout.nodes[visualId]!;
      const authored = toLayout.nodes[visualId]!;
      const scale = Math.min(
        previous.width / Math.max(Number.EPSILON, authored.width),
        previous.height / Math.max(Number.EPSILON, authored.height),
      );
      transforms.set(owner.id, {
        ownerId: owner.id,
        scale,
        offsetX: previous.x + previous.width / 2 - (authored.x + authored.width / 2) * scale,
        offsetY: previous.y + previous.height / 2 - (authored.y + authored.height / 2) * scale,
      });
    }
    const ownerFor = (entityId: string): OwnerTransform | undefined => {
      let current = entityById.get(entityId);
      const seen = new Set<string>();
      while (current && !seen.has(current.id)) {
        if (ownerIds.has(current.id)) return transforms.get(current.id);
        seen.add(current.id);
        current = current.parentId ? entityById.get(current.parentId) : undefined;
      }
      return undefined;
    };
    const transformPoint = (point: { x: number; y: number }, transform: OwnerTransform | undefined) => transform
      ? { x: point.x * transform.scale + transform.offsetX, y: point.y * transform.scale + transform.offsetY }
      : { ...point };
    for (const [visualId, bounds] of Object.entries(toLayout.nodes)) {
      const entityId = bundle.index.entityIdByVisualNodeId[visualId]!;
      const transform = ownerFor(entityId);
      if (!transform) {
        // Context and already-expanded ancestors remain persistent shells in all
        // deeper bands; only the newly expanded owner subtree gets a new layout.
        if (fromLayout.nodes[visualId]) toLayout.nodes[visualId] = { ...fromLayout.nodes[visualId]! };
        continue;
      }
      if (entityId === transform.ownerId) {
        toLayout.nodes[visualId] = { ...fromLayout.nodes[visualId]! };
        continue;
      }
      const origin = transformPoint(bounds, transform);
      toLayout.nodes[visualId] = {
        ...bounds,
        ...origin,
        width: bounds.width * transform.scale,
        height: bounds.height * transform.scale,
      };
    }
    for (const edgeId of toProjection.visualEdgeIds) {
      const edge = bundle.visualEdgeById[edgeId];
      const route = toLayout.edges[edgeId];
      if (!edge || !route) continue;
      const fromEntityId = bundle.index.entityIdByVisualNodeId[edge.fromVisualId]!;
      const toEntityId = bundle.index.entityIdByVisualNodeId[edge.toVisualId]!;
      const fromTransform = ownerFor(fromEntityId);
      const toTransform = ownerFor(toEntityId);
      route.points = route.points.map((point, pointIndex) => {
        const start = transformPoint(point, fromTransform);
        const end = transformPoint(point, toTransform);
        const progress = route.points.length <= 1 ? 0 : pointIndex / (route.points.length - 1);
        return {
          x: start.x + (end.x - start.x) * progress,
          y: start.y + (end.y - start.y) * progress,
        };
      });
    }
  }
  applyIntrinsicOwnerGeometry(snapshot, bundle, entityById, routeOverrides, routeDiagnostics);
  for (const band of C4_BANDS) {
    const projection = bundle.projectionById[bundle.family.projectionIds[band]]!;
    const layout = bundle.bandLayoutById[projection.layoutId]!;
    for (const [visualId, bounds] of Object.entries(layout.nodes)) {
      const entityId = bundle.index.entityIdByVisualNodeId[visualId]!;
      bundle.index.boundsByEntityIdAndBand[entityId] ??= {};
      bundle.index.boundsByEntityIdAndBand[entityId]![band] = { ...bounds };
    }
  }
  return bundle;
}

export function compileC4Scene(
  snapshot: ArchitectureSnapshot,
  bundle: C4ProjectionBundle,
  options: CompileC4SceneOptions = {},
): CompiledC4Scene {
  if (bundle.family.snapshotId !== snapshot.id) throw new Error('C4 projection bundle does not match snapshot');
  const routeDiagnostics: C4RouteOverrideDiagnostic[] = [];
  bundle = normalizeC4OwnerGeometry(snapshot, bundle, options.routeOverrides ?? [], routeDiagnostics);
  const theme = options.theme ?? defaultTheme;
  const entityObjects = Object.values(bundle.visualNodeById)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(node => objectForNode(snapshot, bundle, node, theme))
    .filter((object): object is SceneObject => object !== undefined);
  const paths: ScenePath[] = [];
  const labelObjects: SceneObject[] = [];
  for (const band of C4_BANDS) {
    const projection = bundle.projectionById[bundle.family.projectionIds[band]]!;
    const layout = bundle.bandLayoutById[projection.layoutId]!;
    const bandEdges = projection.visualEdgeIds.map(edgeId => bundle.visualEdgeById[edgeId]!)
      .sort((left, right) => labelPriority(right) - labelPriority(left) || left.id.localeCompare(right.id));
    for (const edge of bandEdges) {
      const route = layout.edges[edge.id];
      if (!route) continue;
      paths.push({
        id: edge.id,
        fromObjectId: edge.fromVisualId,
        toObjectId: edge.toVisualId,
        points: route.points.map(point => ({ ...point })),
        stroke: edge.aggregate.optionalCount === edge.aggregate.count ? theme.optionalEdge : theme.edge,
        width: Math.min(4, 1.7 + Math.log2(edge.aggregate.count + 1) * 0.35) * visualScaleByBand[band],
        arrow: 'end',
        optional: edge.aggregate.optionalCount === edge.aggregate.count,
        pickable: true,
        lod: lodFor(band),
      });
      const occupied = labelObjects
        .filter(object => object.representations.some(representation => representation.id.endsWith(`:${band}`)))
        .map(object => object.bounds);
      const label = labelForEdge(edge, layout, band, theme, occupied);
      if (label) labelObjects.push(label);
    }
  }
  const objects = [...entityObjects, ...labelObjects].sort((left, right) => left.id.localeCompare(right.id));
  const worldBounds = expand(union(objects.map(object => object.bounds)), options.worldPadding ?? 120);
  return {
    scene: {
      protocolVersion: RENDERER_PROTOCOL_VERSION,
      sceneId: options.sceneId ?? `scene:${snapshot.repositoryId}:c4`,
      revision: options.revision ?? 1,
      worldBounds,
      objects,
      paths: paths.sort((left, right) => left.id.localeCompare(right.id)),
    },
    projections: bundle,
    zoomPolicy: {
      id: bundle.family.zoomPolicyId,
      bands: C4_ZOOM_BANDS.map(band => ({ ...band })),
      minZoom: C4_CAMERA_LIMITS.minZoom,
      maxZoom: C4_CAMERA_LIMITS.maxZoom,
    },
    transitionMaps: transitionMaps(bundle),
    ...(options.routeOverrides !== undefined ? { routeDiagnostics } : {}),
  };
}

/**
 * Compiles extracted facts plus durable user-owned relation and routing intent.
 * Invalid authoring is rejected before it can affect a projection; stale route
 * guidance is handled by the router and reported through routeDiagnostics.
 */
export function compileAuthoredC4Scene(
  snapshot: ArchitectureSnapshot,
  authoring: ArchitectureAuthoringDocument,
  buildOptions: BuildC4ProjectionOptions,
  options: CompileAuthoredC4SceneOptions = {},
): CompiledC4Scene {
  const issues = validateArchitectureAuthoringDocument(snapshot, authoring);
  if (issues.length > 0) {
    throw new Error(`Invalid architecture authoring document:\n${issues.map(issue => `${issue.path}: ${issue.message}`).join('\n')}`);
  }
  const effectiveSnapshot = materializeArchitectureAuthoring(snapshot, authoring);
  const bundle = buildC4ProjectionBundle(effectiveSnapshot, {
    ...buildOptions,
    authoredRelationIds: authoring.relations.map(relation => relation.id),
  });
  return compileC4Scene(effectiveSnapshot, bundle, {
    ...options,
    routeOverrides: authoring.routeOverrides,
  });
}

function storyBand(snapshot: ArchitectureSnapshot, step: ArchitectureStory['steps'][number]): C4Band {
  if (step.reveal) return step.reveal;
  const ranks = step.focusEntityIds.map(id => {
    const kind = snapshot.entities.find(entity => entity.id === id)?.kind;
    if (kind === 'code') return 3;
    if (kind === 'component') return 2;
    if (kind === 'container' || kind === 'dataStore' || kind === 'queue') return 1;
    return 0;
  });
  return C4_BANDS[Math.max(0, ...ranks)]!;
}

export function compileC4Timeline(
  snapshot: ArchitectureSnapshot,
  story: ArchitectureStory,
  compiled: CompiledC4Scene,
  options: CompileC4TimelineOptions = {},
): Timeline {
  if (story.snapshotId !== snapshot.id) throw new Error('C4 story does not match snapshot');
  const viewportWidth = options.viewportWidth ?? 1_280;
  const viewportHeight = options.viewportHeight ?? 720;
  const padding = options.padding ?? 100;
  const arrivalSettleMs = options.arrivalSettleMs ?? 150;
  const sceneObjectIds = new Set(compiled.scene.objects.map(object => object.id));
  const scenePathIds = new Set(compiled.scene.paths.map(path => path.id));
  let atMs = 0;
  const keyframes: Timeline['keyframes'] = [];
  for (const step of story.steps) {
    const band = storyBand(snapshot, step);
    const projection = compiled.projections.projectionById[compiled.projections.family.projectionIds[band]]!;
    const layout = compiled.projections.bandLayoutById[projection.layoutId]!;
    const objectIds = step.focusEntityIds
      .flatMap(entityId => compiled.projections.index.visualNodeIdsByEntityId[entityId] ?? [])
      .filter(id => sceneObjectIds.has(id) && layout.nodes[id])
      .sort();
    const bounds = objectIds.map(id => layout.nodes[id]!).filter(Boolean);
    if (!bounds.length) throw new Error(`C4 story step ${step.id} has no visible focus in ${band}`);
    const focusBounds = union(bounds);
    const bandPolicy = compiled.zoomPolicy.bands.find(value => value.detail === band)!;
    const fitZoom = Math.min(
      compiled.zoomPolicy.maxZoom,
      viewportWidth / Math.max(1, focusBounds.width + padding * 2),
      viewportHeight / Math.max(1, focusBounds.height + padding * 2),
    );
    const zoom = Math.max(bandPolicy.enterZoom, Math.min(compiled.zoomPolicy.maxZoom, Math.max(bandPolicy.focusZoom, fitZoom)));
    const camera = {
      center: { x: focusBounds.x + focusBounds.width / 2, y: focusBounds.y + focusBounds.height / 2 },
      zoom,
    };
    const pathIds = (step.traceRelationIds ?? []).flatMap(relationId =>
      compiled.projections.index.visualEdgeIdsByRelationId[relationId] ?? [],
    ).filter(id => projection.visualEdgeIds.includes(id) && scenePathIds.has(id)).sort();
    const objectStates = [{ objectIds, opacity: 1, emphasis: 1 }];
    const pathStates = pathIds.length ? [{ pathIds, opacity: 1, emphasis: 1, flowSpeed: 0, color: defaultTheme.selection }] : [];
    atMs += 700;
    keyframes.push({ id: `${step.id}:arrival`, atMs, easing: 'easeInOut', camera, objectStates, pathStates });
    atMs += arrivalSettleMs + (step.durationMs ?? 4_200);
    keyframes.push({
      id: `${step.id}:hold`,
      atMs,
      easing: 'linear',
      camera,
      objectStates,
      pathStates: pathStates.map(state => ({ ...state, flowSpeed: 1 })),
    });
  }
  return {
    protocolVersion: RENDERER_PROTOCOL_VERSION,
    timelineVersion: 2,
    id: `timeline:${story.id}`,
    sceneId: compiled.scene.sceneId,
    durationMs: atMs,
    looped: false,
    keyframes,
  };
}
