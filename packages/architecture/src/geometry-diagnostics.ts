/**
 * CLA-140: report-only screen-space geometry diagnostics for routed diagrams.
 *
 * Pure and renderer-agnostic: callers pass world-space node rects, routed
 * polylines and label rects plus the world→screen `zoom` they want evaluated.
 * Tolerances are CSS pixels and are converted to world units per call, so the
 * same routes can be judged at a band's entry and focus zoom. Nothing here
 * feeds back into routing or layout.
 *
 * Determinism: inputs are canonicalized (sorted by id, zero-length steps
 * dropped), every pair is evaluated in a fixed orientation, reported numbers
 * are rounded, and findings are sorted by a total order. Shuffling any input
 * collection yields byte-identical output.
 */

export type GeometryPoint = { x: number; y: number };
export type GeometryRect = { x: number; y: number; width: number; height: number };

export type GeometryDiagnosticNode = { id: string; bounds: GeometryRect; parentId?: string };
export type GeometryDiagnosticEdge = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  points: readonly GeometryPoint[];
  /** Edges sharing a key are an intentional bundle (e.g. parallel lanes of one node pair). */
  bundleKey?: string;
  canonicalRelationIds?: readonly string[];
};
export type GeometryDiagnosticLabel = { id: string; edgeId: string; bounds: GeometryRect };

/** All values are CSS/screen pixels at the evaluated zoom. */
export type GeometryDiagnosticTolerances = {
  /** Geometry carrying a finding shorter than this is reported `hidden`. */
  hiddenLengthPx: number;
  /** Parallel segments closer than this read as one stroke (shared corridor). */
  collinearDistancePx: number;
  /** Labels closer than this to another route or a node are flagged. */
  labelClearancePx: number;
  /** A segment this close to a node border and parallel to it runs along the border… */
  borderRunDistancePx: number;
  /** …once the run is at least this long. */
  borderRunMinLengthPx: number;
  /** Distinct endpoints on one node side closer than this are crowded. */
  endpointSpacingPx: number;
  /**
   * Edges sharing an endpoint node: a crossing within this radius of it, or a
   * collinear overlap that starts/ends within it (fan-out/fan-in trunk), is exempt.
   */
  sharedEndpointRadiusPx: number;
  /**
   * Routes shorter than this read as a tick: the renderer's arrowhead radius is
   * min(8px, half the terminal segment), so below 16px the head itself shrinks.
   */
  minRouteLengthPx: number;
};

export const GEOMETRY_DIAGNOSTIC_TOLERANCES: Readonly<GeometryDiagnosticTolerances> = Object.freeze({
  hiddenLengthPx: 2,
  collinearDistancePx: 2,
  labelClearancePx: 4,
  borderRunDistancePx: 4,
  borderRunMinLengthPx: 48,
  endpointSpacingPx: 8,
  sharedEndpointRadiusPx: 16,
  minRouteLengthPx: 16,
});

export const GEOMETRY_DIAGNOSTIC_KINDS = [
  'edge-crossing',
  'shared-corridor',
  'label-clearance',
  'container-border-run',
  'endpoint-crowding',
  'short-route',
] as const;
export type GeometryDiagnosticKind = typeof GEOMETRY_DIAGNOSTIC_KINDS[number];

export const GEOMETRY_DIAGNOSTIC_EXEMPTIONS = ['bundle', 'shared-endpoint', 'containment', 'own-endpoint'] as const;
export type GeometryDiagnosticExemption = typeof GEOMETRY_DIAGNOSTIC_EXEMPTIONS[number];

export type GeometryDiagnosticsInput = {
  band?: string;
  /** World → screen scale (screen px per world unit). */
  zoom: number;
  nodes: readonly GeometryDiagnosticNode[];
  edges: readonly GeometryDiagnosticEdge[];
  labels?: readonly GeometryDiagnosticLabel[];
  tolerances?: Partial<GeometryDiagnosticTolerances>;
};

export type GeometryDiagnosticsOptions = {
  /** `all-pairs` is the brute-force oracle for tests and benchmarks only. */
  broadPhase?: 'grid' | 'all-pairs';
};

export type GeometryFinding = {
  kind: GeometryDiagnosticKind;
  visibility: 'visible' | 'hidden';
  exemption?: GeometryDiagnosticExemption;
  edgeIds: string[];
  nodeIds: string[];
  labelIds: string[];
  canonicalRelationIds: string[];
  geometry: {
    points?: GeometryPoint[];
    segments?: [GeometryPoint, GeometryPoint][];
    rects?: GeometryRect[];
    /** Screen px length of the problem (overlap, run, route). */
    screenLength?: number;
    /** Screen px separation (0 = touching/overlapping). */
    screenDistance?: number;
  };
};

export type GeometryKindCounts = { visible: number; hidden: number; exempt: number };

export type GeometryDiagnosticsSummary = {
  band?: string;
  zoom: number;
  nodeCount: number;
  edgeCount: number;
  labelCount: number;
  segmentCount: number;
  counts: Record<GeometryDiagnosticKind, GeometryKindCounts>;
  totals: GeometryKindCounts;
  exemptions: Record<GeometryDiagnosticExemption, number>;
  broadPhase: { mode: 'grid' | 'all-pairs'; candidatePairs: number; naivePairs: number };
};

export type GeometryDiagnosticsResult = { summary: GeometryDiagnosticsSummary; findings: GeometryFinding[] };

type Segment = {
  edge: number;
  index: number;
  a: GeometryPoint;
  b: GeometryPoint;
  box: GeometryRect;
  length: number;
  /** Axis-aligned orientation, or undefined for diagonal fallback segments. */
  axis?: 'h' | 'v';
  first: boolean;
  last: boolean;
};

type CanonicalEdge = GeometryDiagnosticEdge & { points: GeometryPoint[]; relationIds: string[] };

type Item =
  | { type: 'segment'; box: GeometryRect; ref: number }
  | { type: 'border'; box: GeometryRect; ref: number; side: Side }
  | { type: 'label'; box: GeometryRect; ref: number }
  | { type: 'node'; box: GeometryRect; ref: number };

type Side = 'top' | 'right' | 'bottom' | 'left';
const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];

const REPORT_WORLD_DIGITS = 1e4;
const REPORT_SCREEN_DIGITS = 1e3;
const GRID_MAX_CELLS_PER_AXIS = 256;
const GRID_MAX_CELLS_PER_ITEM = 1024;

const roundWorld = (value: number) => Math.round(value * REPORT_WORLD_DIGITS) / REPORT_WORLD_DIGITS + 0;
const roundScreen = (value: number) => Math.round(value * REPORT_SCREEN_DIGITS) / REPORT_SCREEN_DIGITS + 0;
const wp = (point: GeometryPoint): GeometryPoint => ({ x: roundWorld(point.x), y: roundWorld(point.y) });
const wr = (rect: GeometryRect): GeometryRect => ({
  x: roundWorld(rect.x), y: roundWorld(rect.y), width: roundWorld(rect.width), height: roundWorld(rect.height),
});
/** Reported segments are direction-free: lower (x, y) endpoint first. */
function ws(a: GeometryPoint, b: GeometryPoint): [GeometryPoint, GeometryPoint] {
  const left = wp(a);
  const right = wp(b);
  return left.x < right.x || (left.x === right.x && left.y <= right.y) ? [left, right] : [right, left];
}

function byId<T extends { id: string }>(values: readonly T[], what: string): T[] {
  const sorted = [...values].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.id === sorted[index - 1]!.id) throw new Error(`duplicate ${what} id ${sorted[index]!.id}`);
  }
  return sorted;
}

function boxOf(a: GeometryPoint, b: GeometryPoint): GeometryRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

function boxesTouch(left: GeometryRect, right: GeometryRect, pad: number): boolean {
  return left.x - pad <= right.x + right.width
    && right.x - pad <= left.x + left.width
    && left.y - pad <= right.y + right.height
    && right.y - pad <= left.y + left.height;
}

function contains(outer: GeometryRect, inner: GeometryRect): boolean {
  return outer.x <= inner.x && outer.y <= inner.y
    && outer.x + outer.width >= inner.x + inner.width
    && outer.y + outer.height >= inner.y + inner.height;
}

function pointRectDistance(point: GeometryPoint, rect: GeometryRect): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.hypot(dx, dy);
}

function rectRectDistance(left: GeometryRect, right: GeometryRect): number {
  const dx = Math.max(right.x - (left.x + left.width), 0, left.x - (right.x + right.width));
  const dy = Math.max(right.y - (left.y + left.height), 0, left.y - (right.y + right.height));
  return Math.hypot(dx, dy);
}

const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx;

function pointSegmentDistance(point: GeometryPoint, a: GeometryPoint, b: GeometryPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

/** Liang–Barsky: does segment a→b touch rect? */
function segmentTouchesRect(a: GeometryPoint, b: GeometryPoint, rect: GeometryRect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const clips: [number, number][] = [
    [-dx, a.x - rect.x], [dx, rect.x + rect.width - a.x],
    [-dy, a.y - rect.y], [dy, rect.y + rect.height - a.y],
  ];
  for (const [p, q] of clips) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const r = q / p;
      if (p < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
  }
  return true;
}

function segmentRectDistance(a: GeometryPoint, b: GeometryPoint, rect: GeometryRect): number {
  if (segmentTouchesRect(a, b, rect)) return 0;
  const corners = [
    { x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height },
  ];
  let best = Math.min(pointRectDistance(a, rect), pointRectDistance(b, rect));
  for (let index = 0; index < 4; index += 1) {
    best = Math.min(best, pointSegmentDistance(corners[index]!, a, b));
  }
  return best;
}

function borderLine(rect: GeometryRect, side: Side): [GeometryPoint, GeometryPoint] {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  if (side === 'top') return [{ x: rect.x, y: rect.y }, { x: right, y: rect.y }];
  if (side === 'bottom') return [{ x: rect.x, y: bottom }, { x: right, y: bottom }];
  if (side === 'left') return [{ x: rect.x, y: rect.y }, { x: rect.x, y: bottom }];
  return [{ x: right, y: rect.y }, { x: right, y: bottom }];
}

function nearestSide(point: GeometryPoint, rect: GeometryRect): Side {
  const distances: Record<Side, number> = {
    top: Math.abs(point.y - rect.y),
    right: Math.abs(point.x - (rect.x + rect.width)),
    bottom: Math.abs(point.y - (rect.y + rect.height)),
    left: Math.abs(point.x - rect.x),
  };
  return SIDES.reduce((best, side) => (distances[side] < distances[best] ? side : best), 'top' as Side);
}

function emptyCounts(): GeometryKindCounts {
  return { visible: 0, hidden: 0, exempt: 0 };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function findingSortKey(finding: GeometryFinding): string {
  return [
    String(GEOMETRY_DIAGNOSTIC_KINDS.indexOf(finding.kind)).padStart(2, '0'),
    finding.edgeIds.join('\u0001'),
    finding.nodeIds.join('\u0001'),
    finding.labelIds.join('\u0001'),
    JSON.stringify(finding.geometry),
    finding.exemption ?? '',
  ].join('\u0000');
}

/**
 * Uniform-grid broad phase. Items whose box spans more than
 * GRID_MAX_CELLS_PER_ITEM cells (whole-diagram containers) are tested only
 * against partner categories by box overlap instead of being rasterized.
 * Returns unique candidate index pairs (lower index first), in ascending order.
 */
function gridPairs(
  items: readonly Item[],
  wants: (left: Item, right: Item) => boolean,
  pad: number,
): { pairs: [number, number][]; candidates: number } {
  if (!items.length) return { pairs: [], candidates: 0 };
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const item of items) {
    minX = Math.min(minX, item.box.x - pad);
    minY = Math.min(minY, item.box.y - pad);
    maxX = Math.max(maxX, item.box.x + item.box.width + pad);
    maxY = Math.max(maxY, item.box.y + item.box.height + pad);
  }
  const extent = Math.max(maxX - minX, maxY - minY, pad * 2, 1e-9);
  const typical = Math.sqrt(((maxX - minX) * (maxY - minY)) / items.length) || 0;
  const cell = Math.max(extent / GRID_MAX_CELLS_PER_AXIS, typical, pad * 2);
  const cells = new Map<number, number[]>();
  const large: number[] = [];
  const stride = GRID_MAX_CELLS_PER_AXIS * 4 + 8;
  items.forEach((item, index) => {
    const x0 = Math.floor((item.box.x - pad - minX) / cell);
    const x1 = Math.floor((item.box.x + item.box.width + pad - minX) / cell);
    const y0 = Math.floor((item.box.y - pad - minY) / cell);
    const y1 = Math.floor((item.box.y + item.box.height + pad - minY) / cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > GRID_MAX_CELLS_PER_ITEM) {
      large.push(index);
      return;
    }
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const key = x * stride + y;
        const bucket = cells.get(key);
        if (bucket) bucket.push(index);
        else cells.set(key, [index]);
      }
    }
  });
  const seen = new Set<number>();
  const pairs: [number, number][] = [];
  const consider = (left: number, right: number) => {
    const low = Math.min(left, right);
    const high = Math.max(left, right);
    const key = low * items.length + high;
    if (seen.has(key) || !wants(items[low]!, items[high]!)) return;
    seen.add(key);
    if (!boxesTouch(items[low]!.box, items[high]!.box, pad * 2)) return;
    pairs.push([low, high]);
  };
  for (const bucket of cells.values()) {
    for (let left = 0; left < bucket.length; left += 1) {
      for (let right = left + 1; right < bucket.length; right += 1) consider(bucket[left]!, bucket[right]!);
    }
  }
  for (const index of large) {
    for (let other = 0; other < items.length; other += 1) {
      if (other !== index && wants(items[index]!, items[other]!)) consider(index, other);
    }
  }
  pairs.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  return { pairs, candidates: seen.size };
}

function allPairs(
  items: readonly Item[],
  wants: (left: Item, right: Item) => boolean,
  pad: number,
): { pairs: [number, number][]; candidates: number } {
  const pairs: [number, number][] = [];
  let candidates = 0;
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      if (!wants(items[left]!, items[right]!)) continue;
      candidates += 1;
      if (boxesTouch(items[left]!.box, items[right]!.box, pad * 2)) pairs.push([left, right]);
    }
  }
  return { pairs, candidates };
}

const WANTED: Readonly<Record<string, true>> = {
  'segment|segment': true,
  'border|segment': true,
  'segment|border': true,
  'label|segment': true,
  'segment|label': true,
  'label|node': true,
  'node|label': true,
};

export function diagnoseGeometry(
  input: GeometryDiagnosticsInput,
  options: GeometryDiagnosticsOptions = {},
): GeometryDiagnosticsResult {
  if (!(input.zoom > 0) || !Number.isFinite(input.zoom)) throw new Error('geometry diagnostics need a positive finite zoom');
  const tolerances: GeometryDiagnosticTolerances = { ...GEOMETRY_DIAGNOSTIC_TOLERANCES, ...input.tolerances };
  const zoom = input.zoom;
  const world = (px: number) => px / zoom;
  const screen = (length: number) => roundScreen(length * zoom);
  /** Threshold comparisons use the same rounded screen value that is reported. */
  const px = screen;
  const mode = options.broadPhase ?? 'grid';

  const nodes = byId(input.nodes, 'node');
  const nodeIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const edges: CanonicalEdge[] = byId(input.edges, 'edge').map(edge => {
    const points: GeometryPoint[] = [];
    for (const point of edge.points) {
      const last = points[points.length - 1];
      if (!last || last.x !== point.x || last.y !== point.y) points.push({ x: point.x, y: point.y });
    }
    return { ...edge, points, relationIds: [...new Set(edge.canonicalRelationIds ?? [])].sort(compareStrings) };
  });
  const edgeIndex = new Map(edges.map((edge, index) => [edge.id, index]));
  const labels = byId(input.labels ?? [], 'label').filter(label => edgeIndex.has(label.edgeId));

  let magnitude = 1;
  for (const node of nodes) magnitude = Math.max(magnitude, Math.abs(node.bounds.x), Math.abs(node.bounds.y));
  for (const edge of edges) for (const point of edge.points) magnitude = Math.max(magnitude, Math.abs(point.x), Math.abs(point.y));
  const eps = 1e-9 * magnitude;

  const ancestors = nodes.map(node => {
    const chain: number[] = [];
    const seen = new Set<string>([node.id]);
    let parent = node.parentId;
    while (parent !== undefined && nodeIndex.has(parent) && !seen.has(parent)) {
      chain.push(nodeIndex.get(parent)!);
      seen.add(parent);
      parent = nodes[nodeIndex.get(parent)!]!.parentId;
    }
    return new Set(chain);
  });
  const endpointNodes = edges.map(edge => [nodeIndex.get(edge.fromNodeId), nodeIndex.get(edge.toNodeId)]
    .filter((value): value is number => value !== undefined));

  const segments: Segment[] = [];
  edges.forEach((edge, edgeNumber) => {
    for (let index = 0; index + 1 < edge.points.length; index += 1) {
      const a = edge.points[index]!;
      const b = edge.points[index + 1]!;
      const axis = Math.abs(a.y - b.y) <= eps ? 'h' as const : Math.abs(a.x - b.x) <= eps ? 'v' as const : undefined;
      segments.push({
        edge: edgeNumber, index, a, b, box: boxOf(a, b), length: Math.hypot(b.x - a.x, b.y - a.y),
        ...(axis ? { axis } : {}),
        first: index === 0, last: index + 2 === edge.points.length,
      });
    }
  });

  const findings: GeometryFinding[] = [];
  const edgeIdsOf = (...numbers: number[]) => [...new Set(numbers.map(value => edges[value]!.id))].sort(compareStrings);
  const relationIdsOf = (...numbers: number[]) => [...new Set(numbers.flatMap(value => edges[value]!.relationIds))].sort(compareStrings);
  const bundled = (left: number, right: number) => {
    const key = edges[left]!.bundleKey;
    return key !== undefined && key === edges[right]!.bundleKey;
  };
  const sharedNodes = (left: number, right: number) => endpointNodes[left]!.filter(value => endpointNodes[right]!.includes(value));
  const push = (
    kind: GeometryDiagnosticKind,
    visible: boolean,
    exemption: GeometryDiagnosticExemption | undefined,
    ids: { edges: number[]; nodes?: number[]; labels?: number[] },
    geometry: GeometryFinding['geometry'],
  ) => {
    findings.push({
      kind,
      visibility: visible ? 'visible' : 'hidden',
      ...(exemption ? { exemption } : {}),
      edgeIds: edgeIdsOf(...ids.edges),
      nodeIds: [...new Set((ids.nodes ?? []).map(value => nodes[value]!.id))].sort(compareStrings),
      labelIds: [...new Set((ids.labels ?? []).map(value => labels[value]!.id))].sort(compareStrings),
      canonicalRelationIds: relationIdsOf(...ids.edges),
      geometry,
    });
  };
  /** A shared endpoint node within the radius of any of `where` (crossing point, or either end of an overlap). */
  const nearShared = (left: number, right: number, where: GeometryPoint[]): number | undefined => {
    const radius = world(tolerances.sharedEndpointRadiusPx);
    return sharedNodes(left, right).find(node => where.some(point => pointRectDistance(point, nodes[node]!.bounds) <= radius + eps));
  };

  // ---- broad phase -------------------------------------------------------
  const items: Item[] = [
    ...segments.map((segment, ref) => ({ type: 'segment' as const, box: segment.box, ref })),
    ...nodes.flatMap((node, ref) => SIDES.map(side => {
      const [a, b] = borderLine(node.bounds, side);
      return { type: 'border' as const, box: boxOf(a, b), ref, side };
    })),
    ...labels.map((label, ref) => ({ type: 'label' as const, box: label.bounds, ref })),
    ...nodes.map((node, ref) => ({ type: 'node' as const, box: node.bounds, ref })),
  ];
  const wants = (left: Item, right: Item) => {
    if (!WANTED[`${left.type}|${right.type}`]) return false;
    if (left.type === 'segment' && right.type === 'segment') return segments[left.ref]!.edge !== segments[right.ref]!.edge;
    if (left.type === 'border' || right.type === 'border') {
      const segment = segments[(left.type === 'segment' ? left : right).ref]!;
      return segment.axis !== undefined && segment.length > eps;
    }
    return true;
  };
  const pad = world(Math.max(tolerances.collinearDistancePx, tolerances.labelClearancePx, tolerances.borderRunDistancePx)) / 2 + eps;
  const broad = mode === 'all-pairs' ? allPairs(items, wants, pad) : gridPairs(items, wants, pad);

  // ---- narrow phase ------------------------------------------------------
  const labelHits = new Map<string, { label: number; edge?: number; node?: number; distance: number; exemption?: GeometryDiagnosticExemption }>();
  for (const [leftIndex, rightIndex] of broad.pairs) {
    const left = items[leftIndex]!;
    const right = items[rightIndex]!;
    if (left.type === 'segment' && right.type === 'segment') {
      segmentPair(segments[left.ref]!, segments[right.ref]!);
    } else if (left.type === 'border' || right.type === 'border') {
      const border = (left.type === 'border' ? left : right) as Extract<Item, { type: 'border' }>;
      borderRun(segments[(left.type === 'segment' ? left : right).ref]!, border.ref, border.side);
    } else if (left.type === 'label' || right.type === 'label') {
      const label = (left.type === 'label' ? left : right).ref;
      const other = left.type === 'label' ? right : left;
      if (other.type === 'segment') labelSegment(label, segments[other.ref]!);
      else labelNode(label, other.ref);
    }
  }

  function segmentPair(first: Segment, second: Segment) {
    if (first.length <= eps || second.length <= eps) return;
    const [s, t] = first.edge < second.edge || (first.edge === second.edge && first.index <= second.index)
      ? [first, second] : [second, first];
    const rx = s.b.x - s.a.x; const ry = s.b.y - s.a.y;
    const qx = t.b.x - t.a.x; const qy = t.b.y - t.a.y;
    const denominator = cross(rx, ry, qx, qy);
    const parallel = Math.abs(denominator) <= 1e-9 * s.length * t.length;
    if (!parallel) {
      const u = cross(t.a.x - s.a.x, t.a.y - s.a.y, qx, qy) / denominator;
      const v = cross(t.a.x - s.a.x, t.a.y - s.a.y, rx, ry) / denominator;
      if (u * s.length <= eps || (1 - u) * s.length <= eps || v * t.length <= eps || (1 - v) * t.length <= eps) return;
      if (u < 0 || u > 1 || v < 0 || v > 1) return;
      const point = { x: s.a.x + u * rx, y: s.a.y + u * ry };
      const exemption = bundled(s.edge, t.edge) ? 'bundle' as const
        : nearShared(s.edge, t.edge, [point]) !== undefined ? 'shared-endpoint' as const : undefined;
      const shortest = Math.min(s.length, t.length);
      push('edge-crossing', px(shortest) >= tolerances.hiddenLengthPx, exemption, { edges: [s.edge, t.edge] }, {
        points: [wp(point)],
        segments: [ws(s.a, s.b), ws(t.a, t.b)],
        screenLength: screen(shortest),
      });
      return;
    }
    const distance = Math.abs(cross(rx, ry, t.a.x - s.a.x, t.a.y - s.a.y)) / s.length;
    if (distance > world(tolerances.collinearDistancePx) + eps) return;
    const ux = rx / s.length; const uy = ry / s.length;
    const p0 = (t.a.x - s.a.x) * ux + (t.a.y - s.a.y) * uy;
    const p1 = (t.b.x - s.a.x) * ux + (t.b.y - s.a.y) * uy;
    const start = Math.max(0, Math.min(p0, p1));
    const end = Math.min(s.length, Math.max(p0, p1));
    if (end - start <= eps) return;
    const from = { x: s.a.x + ux * start, y: s.a.y + uy * start };
    const to = { x: s.a.x + ux * end, y: s.a.y + uy * end };
    const exemption = bundled(s.edge, t.edge) ? 'bundle' as const
      : nearShared(s.edge, t.edge, [from, to]) !== undefined ? 'shared-endpoint' as const : undefined;
    push('shared-corridor', px(end - start) >= tolerances.hiddenLengthPx, exemption, { edges: [s.edge, t.edge] }, {
      segments: [ws(from, to)],
      screenLength: screen(end - start),
      screenDistance: screen(distance),
    });
  }

  function borderRun(segment: Segment, node: number, side: Side) {
    const bounds = nodes[node]!.bounds;
    const horizontalSide = side === 'top' || side === 'bottom';
    if ((segment.axis === 'h') !== horizontalSide) return;
    const [a, b] = borderLine(bounds, side);
    const offset = horizontalSide ? Math.abs(segment.a.y - a.y) : Math.abs(segment.a.x - a.x);
    if (offset > world(tolerances.borderRunDistancePx) + eps) return;
    const [lo, hi] = horizontalSide ? [a.x, b.x] : [a.y, b.y];
    const [s0, s1] = horizontalSide
      ? [Math.min(segment.a.x, segment.b.x), Math.max(segment.a.x, segment.b.x)]
      : [Math.min(segment.a.y, segment.b.y), Math.max(segment.a.y, segment.b.y)];
    const run = Math.min(hi, s1) - Math.max(lo, s0);
    if (px(run) < tolerances.borderRunMinLengthPx) return;
    const edge = edges[segment.edge]!;
    const endpoints = endpointNodes[segment.edge]!;
    const ownEndpoint = endpoints.includes(node);
    const containerStub = (segment.first && nodeIndex.has(edge.fromNodeId) && ancestors[nodeIndex.get(edge.fromNodeId)!]!.has(node))
      || (segment.last && nodeIndex.has(edge.toNodeId) && ancestors[nodeIndex.get(edge.toNodeId)!]!.has(node));
    const runStart = Math.max(lo, s0);
    const runEnd = runStart + run;
    const from = horizontalSide ? { x: runStart, y: segment.a.y } : { x: segment.a.x, y: runStart };
    const to = horizontalSide ? { x: runEnd, y: segment.a.y } : { x: segment.a.x, y: runEnd };
    push('container-border-run', px(run) >= tolerances.hiddenLengthPx,
      ownEndpoint ? 'own-endpoint' : containerStub ? 'containment' : undefined,
      { edges: [segment.edge], nodes: [node] },
      { segments: [ws(from, to)], rects: [wr(bounds)], screenLength: screen(run), screenDistance: screen(offset) });
  }

  function recordLabel(key: string, hit: { label: number; edge?: number; node?: number; distance: number; exemption?: GeometryDiagnosticExemption }) {
    const previous = labelHits.get(key);
    if (!previous || hit.distance < previous.distance) labelHits.set(key, hit);
  }

  function labelSegment(label: number, segment: Segment) {
    const owner = edgeIndex.get(labels[label]!.edgeId)!;
    if (segment.edge === owner) return;
    const distance = segmentRectDistance(segment.a, segment.b, labels[label]!.bounds);
    if (distance > world(tolerances.labelClearancePx) + eps) return;
    recordLabel(`e${label}:${segment.edge}`, {
      label, edge: segment.edge, distance, ...(bundled(owner, segment.edge) ? { exemption: 'bundle' as const } : {}),
    });
  }

  function labelNode(label: number, node: number) {
    const owner = edgeIndex.get(labels[label]!.edgeId)!;
    const bounds = nodes[node]!.bounds;
    const distance = rectRectDistance(labels[label]!.bounds, bounds);
    if (distance > world(tolerances.labelClearancePx) + eps) return;
    const endpoints = endpointNodes[owner]!;
    const containsBoth = !endpoints.includes(node) && endpoints.length > 0
      && endpoints.every(endpoint => ancestors[endpoint]!.has(node) || contains(bounds, nodes[endpoint]!.bounds));
    recordLabel(`n${label}:${node}`, { label, node, distance, ...(containsBoth ? { exemption: 'containment' as const } : {}) });
  }

  for (const hit of labelHits.values()) {
    const label = labels[hit.label]!;
    const owner = edgeIndex.get(label.edgeId)!;
    const minSide = Math.min(label.bounds.width, label.bounds.height);
    push('label-clearance', px(minSide) >= tolerances.hiddenLengthPx, hit.exemption, {
      edges: hit.edge !== undefined ? [owner, hit.edge] : [owner],
      ...(hit.node !== undefined ? { nodes: [hit.node] } : {}),
      labels: [hit.label],
    }, {
      rects: [wr(label.bounds), ...(hit.node !== undefined ? [wr(nodes[hit.node]!.bounds)] : [])],
      screenDistance: screen(hit.distance),
    });
  }

  // ---- endpoint crowding: per node side, 1-D sweep ------------------------
  const ports = new Map<string, { edge: number; node: number; side: Side; along: number; point: GeometryPoint }[]>();
  edges.forEach((edge, number) => {
    if (edge.points.length < 2) return;
    const ends: [string, GeometryPoint][] = [[edge.fromNodeId, edge.points[0]!], [edge.toNodeId, edge.points[edge.points.length - 1]!]];
    for (const [nodeId, point] of ends) {
      const node = nodeIndex.get(nodeId);
      if (node === undefined) continue;
      const side = nearestSide(point, nodes[node]!.bounds);
      const key = `${node}:${side}`;
      const list = ports.get(key) ?? [];
      list.push({ edge: number, node, side, along: side === 'top' || side === 'bottom' ? point.x : point.y, point });
      ports.set(key, list);
    }
  });
  const spacing = world(tolerances.endpointSpacingPx);
  for (const list of [...ports.values()]) {
    list.sort((left, right) => left.along - right.along || left.edge - right.edge);
    for (let left = 0; left < list.length; left += 1) {
      for (let right = left + 1; right < list.length && list[right]!.along - list[left]!.along < spacing - eps; right += 1) {
        const a = list[left]!;
        const b = list[right]!;
        if (a.edge === b.edge) continue;
        // Coincident ports merge into one: the second endpoint is hidden under the first.
        push('endpoint-crowding', px(b.along - a.along) >= tolerances.hiddenLengthPx, bundled(a.edge, b.edge) ? 'bundle' : undefined,
          { edges: [a.edge, b.edge], nodes: [a.node] },
          { points: [wp(a.point), wp(b.point)].sort((p, q) => p.x - q.x || p.y - q.y), screenDistance: screen(b.along - a.along) });
      }
    }
  }

  // ---- short routes ------------------------------------------------------
  edges.forEach((edge, number) => {
    let length = 0;
    for (let index = 0; index + 1 < edge.points.length; index += 1) {
      length += Math.hypot(edge.points[index + 1]!.x - edge.points[index]!.x, edge.points[index + 1]!.y - edge.points[index]!.y);
    }
    if (px(length) >= tolerances.minRouteLengthPx) return;
    push('short-route', px(length) >= tolerances.hiddenLengthPx, undefined, { edges: [number], nodes: endpointNodes[number]! }, {
      points: edge.points.map(wp),
      screenLength: screen(length),
    });
  });

  // ---- stable output -----------------------------------------------------
  const keyed = findings.map(finding => ({ key: findingSortKey(finding), finding }))
    .sort((left, right) => compareStrings(left.key, right.key));
  const unique: GeometryFinding[] = [];
  for (let index = 0; index < keyed.length; index += 1) {
    if (index > 0 && keyed[index]!.key === keyed[index - 1]!.key) continue;
    unique.push(keyed[index]!.finding);
  }
  const counts = Object.fromEntries(GEOMETRY_DIAGNOSTIC_KINDS.map(kind => [kind, emptyCounts()])) as Record<GeometryDiagnosticKind, GeometryKindCounts>;
  const exemptions = Object.fromEntries(GEOMETRY_DIAGNOSTIC_EXEMPTIONS.map(value => [value, 0])) as Record<GeometryDiagnosticExemption, number>;
  const totals = emptyCounts();
  for (const finding of unique) {
    const bucket = finding.exemption ? 'exempt' : finding.visibility;
    counts[finding.kind][bucket] += 1;
    totals[bucket] += 1;
    if (finding.exemption) exemptions[finding.exemption] += 1;
  }
  const byType = { segment: 0, border: 0, label: 0, node: 0 };
  for (const item of items) byType[item.type] += 1;
  const naivePairs = (byType.segment * (byType.segment - 1)) / 2 + byType.segment * byType.border
    + byType.label * byType.segment + byType.label * byType.node;
  return {
    summary: {
      ...(input.band !== undefined ? { band: input.band } : {}),
      zoom,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      labelCount: labels.length,
      segmentCount: segments.length,
      counts,
      totals,
      exemptions,
      broadPhase: { mode, candidatePairs: broad.candidates, naivePairs },
    },
    findings: unique,
  };
}

/** Visible, non-exempt findings only — the report-only "problems" view. */
export function visibleGeometryProblems(result: GeometryDiagnosticsResult): GeometryFinding[] {
  return result.findings.filter(finding => finding.visibility === 'visible' && !finding.exemption);
}
