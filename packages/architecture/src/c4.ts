import type {
  ArchitectureEntity,
  ArchitectureRelation,
  ArchitectureSnapshot,
  EdgeLayout,
  EntityKind,
  NodeLayout,
  RelationId,
  RelationKind,
  StoryDetail,
} from './model.js';
import type { RelationRouteOverride } from './authoring.js';
import {
  expandRoutingRect,
  routeOrthogonal,
  routeOrthogonalWithIntent,
  type GuidedOrthogonalRouteReason,
  type OrthogonalRouteDiagnostic,
} from './orthogonal-router.js';

export type C4Band = StoryDetail;

export const C4_BANDS: readonly C4Band[] = ['context', 'container', 'component', 'code'];

export type LineageEntityRef = {
  snapshotEntityId: string;
  logicalId: string;
  lineageId: string;
};

export type LineageRelationRef = {
  snapshotRelationId: string;
  logicalId: string;
  lineageId: string;
};

export type ViewFamily = {
  id: string;
  snapshotId: string;
  rootEntity: LineageEntityRef;
  focusEntity: LineageEntityRef;
  zoomPolicyId: string;
  projectionIds: Record<C4Band, string>;
};

export type BandProjection = {
  id: string;
  familyId: string;
  snapshotId: string;
  band: C4Band;
  rootEntity: LineageEntityRef;
  focusEntity: LineageEntityRef;
  visualNodeIds: string[];
  visualEdgeIds: string[];
  contextNodeIds: string[];
  layoutId: string;
};

export type VisualNode = {
  id: string;
  entity: LineageEntityRef;
  kind: EntityKind;
  name: string;
  responsibility?: string;
  technology: string[];
  parentVisualId?: string;
};

export type VisualEdgeAggregate = {
  count: number;
  kinds: RelationKind[];
  labels: string[];
  technologies: string[];
  optionalCount: number;
};

export type VisualEdge = {
  id: string;
  projectionId: string;
  fromVisualId: string;
  toVisualId: string;
  kind: RelationKind;
  label: string;
  relations: LineageRelationRef[];
  aggregate: VisualEdgeAggregate;
};

export type BandLayout = {
  id: string;
  projectionId: string;
  policy: {
    id: string;
    fontMetricsId: string;
    labelPaddingScreenPx: number;
  };
  nodes: Record<string, NodeLayout>;
  edges: Record<string, EdgeLayout>;
};

export type ProjectionIndex = {
  entityIdByVisualNodeId: Record<string, string>;
  visualNodeIdsByEntityId: Record<string, string[]>;
  relationIdsByVisualEdgeId: Record<string, string[]>;
  visualEdgeIdsByRelationId: Record<string, string[]>;
  boundsByEntityIdAndBand: Record<string, Partial<Record<C4Band, NodeLayout>>>;
};

/**
 * Normalized semantic-zoom artifact. Rows are keyed independently so the same
 * visual node can retain identity while different band projections reference it.
 */
export type C4ProjectionBundle = {
  schemaVersion: 1;
  family: ViewFamily;
  projectionById: Record<string, BandProjection>;
  visualNodeById: Record<string, VisualNode>;
  visualEdgeById: Record<string, VisualEdge>;
  bandLayoutById: Record<string, BandLayout>;
  index: ProjectionIndex;
};

export type MaterializedBandProjection = {
  schemaVersion: 1;
  familyId: string;
  snapshotId: string;
  band: C4Band;
  rootEntity: LineageEntityRef;
  focusEntity: LineageEntityRef;
  nodes: Array<VisualNode & { bounds: NodeLayout; context: boolean }>;
  edges: Array<VisualEdge & { route: EdgeLayout }>;
};

export type BuildC4ProjectionOptions = {
  rootEntityId: string;
  focusEntityId?: string;
  familyId?: string;
  zoomPolicyId?: string;
  /** User-owned relations may connect any two nodes already visible in-band. */
  authoredRelationIds?: readonly RelationId[];
};

/**
 * Screen-space geometry contract used when a semantic owner reveals its
 * children. The scene compiler converts these values to world units at the
 * focus zoom of the incoming band.
 */
export const C4_INTRINSIC_LAYOUT = {
  maxColumns: 3,
  leaf: {
    code: { width: 224, height: 112 },
  },
  gap: 16,
  sidePadding: 20,
  bottomPadding: 20,
  header: {
    system: 72,
    container: 72,
    component: 96,
  },
} as const;

export type C4GridItem = {
  id: string;
  width: number;
  height: number;
};

export type C4GridMetrics = {
  gap: number;
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
  maxColumns?: number;
};

export type C4GridMeasurement = {
  columns: number;
  rows: number;
  columnWidths: number[];
  rowHeights: number[];
  contentWidth: number;
  contentHeight: number;
  width: number;
  height: number;
};

/** Deterministically measures a compact row-major hierarchy grid. */
export function measureC4Grid(
  items: readonly C4GridItem[],
  metrics: C4GridMetrics,
): C4GridMeasurement {
  const ordered = [...items].sort((left, right) => left.id.localeCompare(right.id));
  const maximumColumns = Math.max(1, metrics.maxColumns ?? C4_INTRINSIC_LAYOUT.maxColumns);
  const columns = ordered.length === 0
    ? 0
    : Math.min(maximumColumns, Math.max(1, Math.ceil(Math.sqrt(ordered.length))));
  const rows = columns === 0 ? 0 : Math.ceil(ordered.length / columns);
  const columnWidths = Array.from({ length: columns }, (_, column) => Math.max(
    0,
    ...ordered.filter((_, index) => index % columns === column).map(value => value.width),
  ));
  const rowHeights = Array.from({ length: rows }, (_, row) => Math.max(
    0,
    ...ordered.slice(row * columns, (row + 1) * columns).map(value => value.height),
  ));
  const contentWidth = columnWidths.reduce((sum, value) => sum + value, 0)
    + metrics.gap * Math.max(0, columns - 1);
  const contentHeight = rowHeights.reduce((sum, value) => sum + value, 0)
    + metrics.gap * Math.max(0, rows - 1);
  return {
    columns,
    rows,
    columnWidths,
    rowHeights,
    contentWidth,
    contentHeight,
    width: metrics.paddingLeft + contentWidth + metrics.paddingRight,
    height: metrics.paddingTop + contentHeight + metrics.paddingBottom,
  };
}

const bandRank: Record<C4Band, number> = {
  context: 0,
  container: 1,
  component: 2,
  code: 3,
};

function entityRank(kind: EntityKind): number {
  switch (kind) {
    case 'person':
    case 'softwareSystem':
    case 'externalSystem':
      return 0;
    case 'container':
    case 'dataStore':
    case 'queue':
      return 1;
    case 'component':
      return 2;
    case 'code':
      return 3;
    case 'boundary':
      return 0;
  }
}

function entityRef(snapshot: ArchitectureSnapshot, entity: ArchitectureEntity): LineageEntityRef {
  return {
    snapshotEntityId: `${snapshot.id}::${entity.id}`,
    logicalId: entity.id,
    lineageId: entity.lineageId ?? entity.id,
  };
}

function relationRef(snapshot: ArchitectureSnapshot, relation: ArchitectureRelation): LineageRelationRef {
  return {
    snapshotRelationId: `${snapshot.id}::${relation.id}`,
    logicalId: relation.id,
    lineageId: relation.lineageId ?? relation.id,
  };
}

function visualNodeId(_familyId: string, entity: ArchitectureEntity): string {
  return `visual-node:${entity.lineageId ?? entity.id}`;
}

function visualEdgeId(
  band: C4Band,
  fromVisualId: string,
  toVisualId: string,
  relation: ArchitectureRelation,
): string {
  return `visual-edge:${band}:${encodeURIComponent(fromVisualId)}>${encodeURIComponent(toVisualId)}:${relation.kind}`;
}

function isDescendantOrSelf(
  entityId: string,
  ancestorId: string,
  entityById: ReadonlyMap<string, ArchitectureEntity>,
): boolean {
  let current = entityById.get(entityId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (current.id === ancestorId) return true;
    visited.add(current.id);
    current = current.parentId ? entityById.get(current.parentId) : undefined;
  }
  return false;
}

function nearestRepresentative(
  entityId: string,
  rank: number,
  entityById: ReadonlyMap<string, ArchitectureEntity>,
): ArchitectureEntity | undefined {
  let current = entityById.get(entityId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (entityRank(current.kind) <= rank && current.kind !== 'boundary') return current;
    visited.add(current.id);
    current = current.parentId ? entityById.get(current.parentId) : undefined;
  }
  return current;
}

function ancestors(entityId: string, entityById: ReadonlyMap<string, ArchitectureEntity>): ArchitectureEntity[] {
  const result: ArchitectureEntity[] = [];
  let current = entityById.get(entityId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    result.unshift(current);
    visited.add(current.id);
    current = current.parentId ? entityById.get(current.parentId) : undefined;
  }
  return result;
}

function leafSize(kind: EntityKind): { width: number; height: number } {
  switch (kind) {
    case 'person':
    case 'externalSystem':
      return { width: 480, height: 190 };
    case 'softwareSystem':
      return { width: 480, height: 250 };
    case 'container':
    case 'dataStore':
    case 'queue':
      return { width: 420, height: 180 };
    case 'component':
      return { width: 300, height: 150 };
    case 'code':
      return { width: 270, height: 110 };
    case 'boundary':
      return { width: 420, height: 240 };
  }
}

type LocalTreeLayout = {
  width: number;
  height: number;
  nodes: Record<string, NodeLayout>;
};

function shiftNodes(nodes: Record<string, NodeLayout>, x: number, y: number): Record<string, NodeLayout> {
  return Object.fromEntries(Object.entries(nodes).map(([id, bounds]) => [id, {
    ...bounds,
    x: bounds.x + x,
    y: bounds.y + y,
  }]));
}

function layoutTree(
  nodeId: string,
  childrenByVisualId: ReadonlyMap<string, readonly string[]>,
  nodeById: Readonly<Record<string, VisualNode>>,
): LocalTreeLayout {
  const node = nodeById[nodeId];
  if (!node) throw new Error(`Missing visual node ${nodeId}`);
  const children = [...(childrenByVisualId.get(nodeId) ?? [])].sort();
  const minimum = leafSize(node.kind);
  if (!children.length) {
    return {
      width: minimum.width,
      height: minimum.height,
      nodes: { [nodeId]: { x: 0, y: 0, width: minimum.width, height: minimum.height } },
    };
  }

  const childLayouts = children.map(childId => ({ id: childId, layout: layoutTree(childId, childrenByVisualId, nodeById) }));
  const gap = 44;
  const paddingX = 48;
  const paddingTop = 86;
  const paddingBottom = 48;
  const measurement = measureC4Grid(childLayouts.map(({ id, layout }) => ({
    id,
    width: layout.width,
    height: layout.height,
  })), {
    gap,
    paddingLeft: paddingX,
    paddingRight: paddingX,
    paddingTop,
    paddingBottom,
  });
  const { columns, columnWidths, rowHeights } = measurement;
  const width = Math.max(minimum.width, measurement.width);
  const height = Math.max(minimum.height, measurement.height);
  const nodes: Record<string, NodeLayout> = { [nodeId]: { x: 0, y: 0, width, height } };

  childLayouts.forEach(({ layout }, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = paddingX + columnWidths.slice(0, column).reduce((sum, value) => sum + value, 0) + gap * column;
    const y = paddingTop + rowHeights.slice(0, row).reduce((sum, value) => sum + value, 0) + gap * row;
    Object.assign(nodes, shiftNodes(layout.nodes, x, y));
  });
  return { width, height, nodes };
}

export type RouteC4BandEdgesOptions = {
  clearance: number;
  laneSpacing: number;
  maxPoints?: number;
  maxGridNodes?: number;
  routeOverrides?: readonly RelationRouteOverride[];
};

export type C4RouteOverrideDiagnostic = {
  overrideId: string;
  detail: C4Band;
  status: 'applied' | 'fallback' | 'stale';
  visualEdgeId?: string;
  reason?: GuidedOrthogonalRouteReason | 'edge-not-visible' | 'superseded';
  routerDiagnostic?: OrthogonalRouteDiagnostic;
};

export type RouteC4BandEdgesResult = {
  edges: Record<string, EdgeLayout>;
  diagnostics: C4RouteOverrideDiagnostic[];
};

function visibleAncestorChain(
  visualId: string,
  visible: ReadonlySet<string>,
  visualNodeById: Readonly<Record<string, VisualNode>>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = visualId;
  while (current && visible.has(current) && !seen.has(current)) {
    result.push(current);
    seen.add(current);
    current = visualNodeById[current]?.parentVisualId;
  }
  return result;
}

/**
 * Routes a complete band after its node geometry is final. The shared helper is
 * used by both authored layouts and compiler-normalized layouts so obstacle and
 * tie-breaking behavior cannot diverge between those stages.
 */
export function routeC4BandEdges(
  projection: BandProjection,
  visualNodeById: Readonly<Record<string, VisualNode>>,
  visualEdgeById: Readonly<Record<string, VisualEdge>>,
  nodes: Readonly<Record<string, NodeLayout>>,
  options: RouteC4BandEdgesOptions,
): Record<string, EdgeLayout> {
  return routeC4BandEdgesDetailed(projection, visualNodeById, visualEdgeById, nodes, options).edges;
}

export function routeC4BandEdgesDetailed(
  projection: BandProjection,
  visualNodeById: Readonly<Record<string, VisualNode>>,
  visualEdgeById: Readonly<Record<string, VisualEdge>>,
  nodes: Readonly<Record<string, NodeLayout>>,
  options: RouteC4BandEdgesOptions,
): RouteC4BandEdgesResult {
  const visible = new Set(projection.visualNodeIds.filter(id => Boolean(nodes[id])));
  const ancestorChains = new Map([...visible].map(id => [
    id,
    visibleAncestorChain(id, visible, visualNodeById),
  ]));
  const isAncestor = (ancestorId: string, visualId: string) => (
    ancestorChains.get(visualId)?.includes(ancestorId) ?? false
  );
  const pairKey = (edge: VisualEdge) => [edge.fromVisualId, edge.toVisualId].sort().join('\u0000');
  const parallelByPair = new Map<string, string[]>();
  for (const edgeId of [...projection.visualEdgeIds].sort()) {
    const edge = visualEdgeById[edgeId];
    if (!edge || !visible.has(edge.fromVisualId) || !visible.has(edge.toVisualId)) continue;
    const key = pairKey(edge);
    const ids = parallelByPair.get(key) ?? [];
    ids.push(edgeId);
    parallelByPair.set(key, ids);
  }
  for (const ids of parallelByPair.values()) ids.sort();

  const relevantOverrides = (options.routeOverrides ?? [])
    .filter(value => value.viewId === projection.familyId && value.detail === projection.band)
    .sort((left, right) => left.id.localeCompare(right.id));
  const consumedOverrides = new Set<string>();
  const diagnostics: C4RouteOverrideDiagnostic[] = [];
  const edges: Record<string, EdgeLayout> = {};
  for (const edgeId of [...projection.visualEdgeIds].sort()) {
    const edge = visualEdgeById[edgeId];
    if (!edge) continue;
    const source = nodes[edge.fromVisualId];
    const target = nodes[edge.toVisualId];
    if (!source || !target) continue;
    const sourceAncestors = ancestorChains.get(edge.fromVisualId) ?? [];
    const targetAncestorSet = new Set(ancestorChains.get(edge.toVisualId) ?? []);
    const lcaId = sourceAncestors.find(id => targetAncestorSet.has(id));
    const candidateIds = [...visible].filter(id => (
      id !== edge.fromVisualId
      && id !== edge.toVisualId
      && !isAncestor(id, edge.fromVisualId)
      && !isAncestor(id, edge.toVisualId)
    ));
    const candidateSet = new Set(candidateIds);
    const obstacles = candidateIds.filter(id => {
      let parentId = visualNodeById[id]?.parentVisualId;
      const seen = new Set<string>();
      while (parentId && !seen.has(parentId)) {
        if (candidateSet.has(parentId)) return false;
        seen.add(parentId);
        parentId = visualNodeById[parentId]?.parentVisualId;
      }
      return true;
    }).sort().map(id => ({ id, bounds: nodes[id]! }));
    const parallel = parallelByPair.get(pairKey(edge)) ?? [edgeId];
    const laneIndex = parallel.indexOf(edgeId);
    const laneOffset = (laneIndex - (parallel.length - 1) / 2) * options.laneSpacing;
    const lcaBounds = lcaId ? nodes[lcaId] : undefined;
    const matchingOverrides = relevantOverrides.filter(value => value.visualEdgeId !== undefined
      ? value.visualEdgeId === edgeId
      : edge.relations.some(relation => relation.logicalId === value.relationId))
      .sort((left, right) => Number(right.visualEdgeId !== undefined) - Number(left.visualEdgeId !== undefined)
        || left.id.localeCompare(right.id));
    const selectedOverride = matchingOverrides[0];
    for (const superseded of matchingOverrides.slice(1)) {
      consumedOverrides.add(superseded.id);
      diagnostics.push({
        overrideId: superseded.id,
        detail: projection.band,
        status: 'stale',
        visualEdgeId: edgeId,
        reason: 'superseded',
      });
    }
    if (selectedOverride) consumedOverrides.add(selectedOverride.id);
    const routeOptions = {
      source,
      target,
      obstacles,
      ...(lcaBounds ? { domain: expandRoutingRect(lcaBounds, options.clearance * 2 + 1) } : {}),
      clearance: options.clearance,
      laneOffset,
      maxPoints: options.maxPoints ?? 16,
      maxGridNodes: options.maxGridNodes ?? 20_000,
    };
    if (selectedOverride) {
      const guided = routeOrthogonalWithIntent(routeOptions, selectedOverride.intent);
      edges[edgeId] = { points: guided.points };
      diagnostics.push({
        overrideId: selectedOverride.id,
        detail: projection.band,
        status: guided.status === 'applied' ? 'applied' : 'fallback',
        visualEdgeId: edgeId,
        ...(guided.reason ? { reason: guided.reason } : {}),
        routerDiagnostic: guided.diagnostic,
      });
    } else {
      edges[edgeId] = { points: routeOrthogonal(routeOptions).points };
    }
  }
  for (const override of relevantOverrides) {
    if (consumedOverrides.has(override.id)) continue;
    diagnostics.push({
      overrideId: override.id,
      detail: projection.band,
      status: 'stale',
      reason: 'edge-not-visible',
    });
  }
  diagnostics.sort((left, right) => left.overrideId.localeCompare(right.overrideId));
  return { edges, diagnostics };
}

function layoutProjection(
  projection: BandProjection,
  visualNodeById: Readonly<Record<string, VisualNode>>,
  visualEdgeById: Readonly<Record<string, VisualEdge>>,
): BandLayout {
  const visible = new Set(projection.visualNodeIds);
  const childrenByVisualId = new Map<string, string[]>();
  const roots: string[] = [];
  for (const nodeId of projection.visualNodeIds) {
    const parentId = visualNodeById[nodeId]?.parentVisualId;
    if (parentId && visible.has(parentId)) {
      const values = childrenByVisualId.get(parentId) ?? [];
      values.push(nodeId);
      childrenByVisualId.set(parentId, values);
    } else {
      roots.push(nodeId);
    }
  }
  for (const values of childrenByVisualId.values()) values.sort();

  const hierarchyRoots = roots.filter(id => {
    const kind = visualNodeById[id]?.kind;
    return kind !== 'person' && kind !== 'externalSystem';
  }).sort();
  const contextRoots = roots.filter(id => !hierarchyRoots.includes(id)).sort();
  const nodes: Record<string, NodeLayout> = {};
  const leftContextRight = contextRoots.reduce((right, rootId, index) => {
    if (index % 2 !== 0) return right;
    return Math.max(right, 80 + leafSize(visualNodeById[rootId]!.kind).width);
  }, 0);
  // Keep enough room for the relation label between the left context column
  // and the hierarchy without making the overview wider than a laptop map.
  const contextRouteCorridor = 260;
  let hierarchyX = Math.max(520, leftContextRight + contextRouteCorridor);
  let maximumBottom = 0;
  for (const rootId of hierarchyRoots) {
    const tree = layoutTree(rootId, childrenByVisualId, visualNodeById);
    Object.assign(nodes, shiftNodes(tree.nodes, hierarchyX, 120));
    hierarchyX += tree.width + 100;
    maximumBottom = Math.max(maximumBottom, 120 + tree.height);
  }
  contextRoots.forEach((rootId, index) => {
    const size = leafSize(visualNodeById[rootId]!.kind);
    const leftSide = index % 2 === 0;
    const column = Math.floor(index / 2);
    nodes[rootId] = {
      x: leftSide ? 80 : hierarchyX + contextRouteCorridor,
      y: 180 + column * (size.height + 70),
      width: size.width,
      height: size.height,
    };
    maximumBottom = Math.max(maximumBottom, nodes[rootId]!.y + size.height);
  });
  if (!hierarchyRoots.length) {
    contextRoots.forEach((rootId, index) => {
      const size = leafSize(visualNodeById[rootId]!.kind);
      nodes[rootId] = { x: 180 + index * (size.width + 90), y: 180, width: size.width, height: size.height };
    });
  }

  const edges = routeC4BandEdges(projection, visualNodeById, visualEdgeById, nodes, {
    clearance: 12,
    laneSpacing: 12,
  });
  void maximumBottom;
  return {
    id: projection.layoutId,
    projectionId: projection.id,
    policy: {
      id: 'collision-safe-orthogonal-v2',
      fontMetricsId: 'okie-ibm-plex-static-v1',
      labelPaddingScreenPx: 8,
    },
    nodes,
    edges,
  };
}

function aggregateLabel(relations: readonly ArchitectureRelation[], kind: RelationKind): string {
  const labels = [...new Set(relations.map(relation => relation.label?.trim()).filter((label): label is string => Boolean(label)))].sort();
  if (labels.length === 1 && relations.every(relation => relation.label?.trim() === labels[0])) return labels[0]!;
  if (relations.length === 1) return labels[0] ?? kind;
  const plural: Record<RelationKind, string> = {
    uses: 'uses',
    calls: 'calls',
    reads: 'reads',
    writes: 'writes',
    publishes: 'publications',
    subscribes: 'subscriptions',
    contains: 'containment relationships',
    dependsOn: 'dependencies',
    returns: 'returns',
  };
  return `${relations.length} ${plural[kind]}`;
}

export function buildC4ProjectionBundle(
  snapshot: ArchitectureSnapshot,
  options: BuildC4ProjectionOptions,
): C4ProjectionBundle {
  const entityById = new Map(snapshot.entities.map(entity => [entity.id, entity]));
  const root = entityById.get(options.rootEntityId);
  if (!root) throw new Error(`Unknown C4 root entity ${options.rootEntityId}`);
  const focus = entityById.get(options.focusEntityId ?? root.id);
  if (!focus) throw new Error(`Unknown C4 focus entity ${options.focusEntityId}`);
  if (!isDescendantOrSelf(focus.id, root.id, entityById)) {
    throw new Error(`C4 focus ${focus.id} is outside root ${root.id}`);
  }
  const familyId = options.familyId ?? `view-family:${snapshot.repositoryId}:${root.lineageId ?? root.id}:${focus.lineageId ?? focus.id}`;
  const projectionIds = Object.fromEntries(C4_BANDS.map(band => [band, `band-projection:${familyId}:${band}`])) as Record<C4Band, string>;
  const family: ViewFamily = {
    id: familyId,
    snapshotId: snapshot.id,
    rootEntity: entityRef(snapshot, root),
    focusEntity: entityRef(snapshot, focus),
    zoomPolicyId: options.zoomPolicyId ?? 'zoom-policy:c4-default',
    projectionIds,
  };
  const projectionById: Record<string, BandProjection> = {};
  const visualNodeById: Record<string, VisualNode> = {};
  const visualEdgeById: Record<string, VisualEdge> = {};
  const bandLayoutById: Record<string, BandLayout> = {};
  const authoredRelationIds = new Set(options.authoredRelationIds ?? []);

  for (const band of C4_BANDS) {
    const rank = bandRank[band];
    const projectionId = projectionIds[band];
    const includedEntities = new Map<string, ArchitectureEntity>();
    const focusAncestors = new Set(ancestors(focus.id, entityById).map(entity => entity.id));
    for (const entity of snapshot.entities) {
      if (entity.kind === 'boundary') continue;
      if (isDescendantOrSelf(entity.id, focus.id, entityById) && entityRank(entity.kind) <= rank) {
        includedEntities.set(entity.id, entity);
      }
      if (entity.kind === 'person' || entity.kind === 'externalSystem') {
        includedEntities.set(entity.id, entity);
      }
    }
    for (const ancestor of ancestors(focus.id, entityById)) includedEntities.set(ancestor.id, ancestor);

    type EdgeGroup = { from: ArchitectureEntity; to: ArchitectureEntity; relations: ArchitectureRelation[] };
    const groups = new Map<string, EdgeGroup>();
    for (const relation of [...snapshot.relations].sort((left, right) => left.id.localeCompare(right.id))) {
      const fromEntity = entityById.get(relation.from);
      const toEntity = entityById.get(relation.to);
      if (!fromEntity || !toEntity) continue;
      // Coarser authored summaries belong only to their native band. Finer
      // evidence is projected upward and collapsed, preventing duplicate L1/L2
      // arrows while retaining real implementation relationships.
      if (Math.max(entityRank(fromEntity.kind), entityRank(toEntity.kind)) < rank) continue;
      const touchesFocus = isDescendantOrSelf(relation.from, focus.id, entityById)
        || isDescendantOrSelf(relation.to, focus.id, entityById);
      // A relation authored between two nodes already visible as surrounding
      // context must remain visible even when neither endpoint is inside the
      // focus subtree. This is what makes connect-by-drag on context peers a
      // first-class semantic edit instead of a fact that vanishes on compile.
      const connectsVisibleContext = authoredRelationIds.has(relation.id)
        && includedEntities.has(fromEntity.id)
        && includedEntities.has(toEntity.id);
      if (!touchesFocus && !connectsVisibleContext) continue;
      const from = nearestRepresentative(relation.from, rank, entityById);
      const to = nearestRepresentative(relation.to, rank, entityById);
      if (!from || !to || from.id === to.id) continue;
      includedEntities.set(from.id, from);
      includedEntities.set(to.id, to);
      const fromVisualId = visualNodeId(familyId, from);
      const toVisualId = visualNodeId(familyId, to);
      const id = visualEdgeId(band, fromVisualId, toVisualId, relation);
      const group = groups.get(id) ?? { from, to, relations: [] };
      group.relations.push(relation);
      groups.set(id, group);
    }

    // Every nested visual object keeps its nearest visible parent so boundaries
    // remain stable and containment never needs a second set of arrows.
    for (const entity of [...includedEntities.values()]) {
      let parentId = entity.parentId;
      while (parentId) {
        const parent = entityById.get(parentId);
        if (!parent) break;
        if (entityRank(parent.kind) <= rank || focusAncestors.has(parent.id)) includedEntities.set(parent.id, parent);
        parentId = parent.parentId;
      }
    }

    const visualNodeIds = [...includedEntities.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(entity => {
        const id = visualNodeId(familyId, entity);
        const parent = entity.parentId ? includedEntities.get(entity.parentId) : undefined;
        visualNodeById[id] ??= {
          id,
          entity: entityRef(snapshot, entity),
          kind: entity.kind,
          name: entity.name,
          technology: [...(entity.technology ?? [])].sort(),
          ...(entity.responsibility ? { responsibility: entity.responsibility } : {}),
          ...(parent ? { parentVisualId: visualNodeId(familyId, parent) } : {}),
        };
        return id;
      });

    const visualEdgeIds = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([id, group]) => {
      const relations = [...new Map(group.relations.map(relation => [relation.id, relation])).values()]
        .sort((left, right) => left.id.localeCompare(right.id));
      const first = relations[0]!;
      const labels = [...new Set(relations.map(relation => relation.label?.trim()).filter((label): label is string => Boolean(label)))].sort();
      visualEdgeById[id] = {
        id,
        projectionId,
        fromVisualId: visualNodeId(familyId, group.from),
        toVisualId: visualNodeId(familyId, group.to),
        kind: first.kind,
        label: aggregateLabel(relations, first.kind),
        relations: relations.map(relation => relationRef(snapshot, relation)),
        aggregate: {
          count: relations.length,
          kinds: [...new Set(relations.map(relation => relation.kind))].sort(),
          labels,
          technologies: [...new Set(relations.flatMap(relation => relation.technology ? [relation.technology] : []))].sort(),
          optionalCount: relations.filter(relation => relation.optional).length,
        },
      };
      return id;
    });
    const layoutId = `band-layout:${projectionId}:v2-font-metrics-label-policy`;
    const projection: BandProjection = {
      id: projectionId,
      familyId,
      snapshotId: snapshot.id,
      band,
      rootEntity: entityRef(snapshot, root),
      focusEntity: entityRef(snapshot, focus),
      visualNodeIds,
      visualEdgeIds,
      contextNodeIds: visualNodeIds.filter(id => {
        const entityId = visualNodeById[id]!.entity.logicalId;
        return !isDescendantOrSelf(entityId, focus.id, entityById) && !focusAncestors.has(entityId);
      }),
      layoutId,
    };
    projectionById[projectionId] = projection;
    bandLayoutById[layoutId] = layoutProjection(projection, visualNodeById, visualEdgeById);
  }

  const index: ProjectionIndex = {
    entityIdByVisualNodeId: {},
    visualNodeIdsByEntityId: {},
    relationIdsByVisualEdgeId: {},
    visualEdgeIdsByRelationId: {},
    boundsByEntityIdAndBand: {},
  };
  for (const node of Object.values(visualNodeById).sort((left, right) => left.id.localeCompare(right.id))) {
    index.entityIdByVisualNodeId[node.id] = node.entity.logicalId;
    index.visualNodeIdsByEntityId[node.entity.logicalId] = [node.id];
  }
  for (const edge of Object.values(visualEdgeById).sort((left, right) => left.id.localeCompare(right.id))) {
    const relationIds = edge.relations.map(relation => relation.logicalId).sort();
    index.relationIdsByVisualEdgeId[edge.id] = relationIds;
    for (const relationId of relationIds) {
      const values = index.visualEdgeIdsByRelationId[relationId] ?? [];
      values.push(edge.id);
      index.visualEdgeIdsByRelationId[relationId] = values;
    }
  }
  for (const values of Object.values(index.visualEdgeIdsByRelationId)) values.sort();
  for (const band of C4_BANDS) {
    const projection = projectionById[projectionIds[band]]!;
    const layout = bandLayoutById[projection.layoutId]!;
    for (const [nodeId, bounds] of Object.entries(layout.nodes)) {
      const entityId = visualNodeById[nodeId]!.entity.logicalId;
      index.boundsByEntityIdAndBand[entityId] ??= {};
      index.boundsByEntityIdAndBand[entityId]![band] = { ...bounds };
    }
  }

  return {
    schemaVersion: 1,
    family,
    projectionById,
    visualNodeById,
    visualEdgeById,
    bandLayoutById,
    index,
  };
}

/** Canonical semantic projection consumed by Mermaid, embeds and static export. */
export function selectC4BandProjection(
  bundle: C4ProjectionBundle,
  band: C4Band,
): MaterializedBandProjection {
  const projection = bundle.projectionById[bundle.family.projectionIds[band]];
  if (!projection) throw new Error(`Missing ${band} projection for ${bundle.family.id}`);
  const layout = bundle.bandLayoutById[projection.layoutId];
  if (!layout) throw new Error(`Missing layout ${projection.layoutId}`);
  const context = new Set(projection.contextNodeIds);
  return {
    schemaVersion: 1,
    familyId: bundle.family.id,
    snapshotId: bundle.family.snapshotId,
    band,
    rootEntity: { ...projection.rootEntity },
    focusEntity: { ...projection.focusEntity },
    nodes: projection.visualNodeIds.map(id => ({
      ...bundle.visualNodeById[id]!,
      entity: { ...bundle.visualNodeById[id]!.entity },
      technology: [...bundle.visualNodeById[id]!.technology],
      bounds: { ...layout.nodes[id]! },
      context: context.has(id),
    })),
    edges: projection.visualEdgeIds.map(id => ({
      ...bundle.visualEdgeById[id]!,
      relations: bundle.visualEdgeById[id]!.relations.map(value => ({ ...value })),
      aggregate: {
        ...bundle.visualEdgeById[id]!.aggregate,
        kinds: [...bundle.visualEdgeById[id]!.aggregate.kinds],
        labels: [...bundle.visualEdgeById[id]!.aggregate.labels],
        technologies: [...bundle.visualEdgeById[id]!.aggregate.technologies],
      },
      route: { points: layout.edges[id]!.points.map(point => ({ ...point })) },
    })),
  };
}
