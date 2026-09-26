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
 * dropped, collinear runs merged), every pair is evaluated in a fixed
 * orientation, reported numbers are rounded, and findings are sorted by a
 * total order. Shuffling any input collection yields byte-identical output.
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

/**
 * All values are CSS/screen pixels at the evaluated zoom. Several are coupled
 * to renderer or router constants; changing those means revisiting these.
 */
export type GeometryDiagnosticTolerances = {
  /** Geometry carrying a finding shorter than this is reported `hidden`. */
  hiddenLengthPx: number;
  /** Parallel segments closer than this read as one stroke (shared corridor). */
  collinearDistancePx: number;
  /** Labels closer than this to another route or a node are flagged (half the compiler's 8px label padding). */
  labelClearancePx: number;
  /**
   * A segment this close to a node border and parallel to it runs along the
   * border… Set below the smallest routing clearance any band reaches (8px at
   * focus scales to 3.41px at context entry), so routes the router kept at
   * clearance are never flagged.
   */
  borderRunDistancePx: number;
  /** …once the run is at least this long. */
  borderRunMinLengthPx: number;
  /** Distinct ports on one node closer than this (the 8px arrowhead radius) are crowded. */
  endpointSpacingPx: number;
  /**
   * Edges sharing an endpoint node: a crossing within this radius of either
   * edge's port on it, or a collinear overlap that starts/ends within it
   * (fan-out/fan-in trunk), is exempt.
   */
  sharedEndpointRadiusPx: number;
  /**
   * Routes strictly shorter than this read as a tick: the renderer's arrowhead
   * radius is min(8px, half the terminal segment) (primitives.wgsl), so below
   * 16px the head itself shrinks. Coupled to the packing gap: packed sibling
   * hops are exactly 16px at focus and are deliberately not flagged there.
   */
  minRouteLengthPx: number;
  /**
   * Legs (bend-to-bend or terminal segments) strictly shorter than this
   * collapse under the renderer's corner rounding (PATH_CORNER_RADIUS_PX = 6,
   * atlas-gpu mesh.rs) and under the arrowhead's min(8, half terminal).
   */
  minLegLengthPx: number;
};

export const GEOMETRY_DIAGNOSTIC_TOLERANCES: Readonly<GeometryDiagnosticTolerances> = Object.freeze({
  hiddenLengthPx: 2,
  collinearDistancePx: 2,
  labelClearancePx: 4,
  borderRunDistancePx: 3,
  borderRunMinLengthPx: 48,
  endpointSpacingPx: 8,
  sharedEndpointRadiusPx: 16,
  minRouteLengthPx: 16,
  minLegLengthPx: 6,
});

export const GEOMETRY_DIAGNOSTIC_KINDS = [
  'edge-crossing',
  'shared-corridor',
  'label-clearance',
  'container-border-run',
  'endpoint-crowding',
  'short-route',
  'short-leg',
] as const;
export type GeometryDiagnosticKind = typeof GEOMETRY_DIAGNOSTIC_KINDS[number];

export const GEOMETRY_DIAGNOSTIC_EXEMPTIONS = ['bundle', 'shared-endpoint', 'shared-port', 'containment', 'own-endpoint'] as const;
export type GeometryDiagnosticExemption = typeof GEOMETRY_DIAGNOSTIC_EXEMPTIONS[number];

export type GeometryDiagnosticsInput = {
  band?: string;
  /** World → screen scale (screen px per world unit). */
  zoom: number;
  nodes: readonly GeometryDiagnosticNode[];
  edges: readonly GeometryDiagnosticEdge[];
  labels?: readonly GeometryDiagnosticLabel[];
  tolerances?: { [K in keyof GeometryDiagnosticTolerances]?: number | undefined };
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
    /** Screen px length of the problem (overlap/trunk, run, route, leg). */
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
  /**
   * `naivePairs`: every wanted category pair; `examinedPairs`: pair tests the
   * broad phase actually ran (grid cells count a pair once per shared cell);
   * `candidatePairs`: unique box-overlapping pairs handed to the narrow phase
   * (identical for both modes); `largeItems`: items that bypassed the grid.
   */
  broadPhase: { mode: 'grid' | 'all-pairs'; naivePairs: number; examinedPairs: number; candidatePairs: number; largeItems: number };
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
type ItemType = 'segment' | 'border' | 'label' | 'node';
type Item = { type: ItemType; box: GeometryRect; ref: number; side?: Side };
type Side = 'top' | 'right' | 'bottom' | 'left';
const SIDES: readonly Side[] = ['top', 'right', 'bottom', 'left'];

const REPORT_WORLD_DIGITS = 1e4;
const REPORT_SCREEN_DIGITS = 1e3;
/** Items spanning more grid cells than this (whole-diagram owners) are paired by type scan instead. */
const GRID_MAX_CELLS_PER_ITEM = 4096;

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

const compareStrings = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function byId<T extends { id: string }>(values: readonly T[], what: string): T[] {
  const sorted = [...values].sort((left, right) => compareStrings(left.id, right.id));
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.id === sorted[index - 1]!.id) throw new Error(`duplicate ${what} id ${sorted[index]!.id}`);
  }
  return sorted;
}

function assertFinite(what: string, ...values: number[]) {
  if (!values.every(Number.isFinite)) throw new Error(`non-finite geometry in ${what}`);
}

function boxOf(a: GeometryPoint, b: GeometryPoint): GeometryRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
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
  for (const corner of corners) best = Math.min(best, pointSegmentDistance(corner, a, b));
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

/** Drops zero-length steps and merges consecutive collinear same-direction steps. */
function canonicalPoints(points: readonly GeometryPoint[], edgeId: string): GeometryPoint[] {
  const out: GeometryPoint[] = [];
  for (const raw of points) {
    assertFinite(`edge ${edgeId}`, raw.x, raw.y);
    const point = { x: raw.x, y: raw.y };
    const last = out[out.length - 1];
    if (last && last.x === point.x && last.y === point.y) continue;
    const prev = out[out.length - 2];
    if (last && prev) {
      const ax = last.x - prev.x; const ay = last.y - prev.y;
      const bx = point.x - last.x; const by = point.y - last.y;
      if (Math.abs(cross(ax, ay, bx, by)) <= 1e-12 * Math.hypot(ax, ay) * Math.hypot(bx, by) && ax * bx + ay * by > 0) {
        out[out.length - 1] = point;
        continue;
      }
    }
    out.push(point);
  }
  return out;
}

/**
 * Two polylines touch at `at` with local rays a1/a2 and b1/b2 (neighbouring
 * vertices). They cross iff exactly one b-ray lies strictly inside the arc
 * a1→a2; a b-ray on an a-ray is tangency or overlap, not a crossing.
 */
function raysInterleave(at: GeometryPoint, a1: GeometryPoint, a2: GeometryPoint, b1: GeometryPoint, b2: GeometryPoint): boolean {
  const angle = (point: GeometryPoint) => Math.atan2(point.y - at.y, point.x - at.x);
  const ccw = (from: number, to: number) => ((to - from) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const start = angle(a1);
  const span = ccw(start, angle(a2));
  const inside: boolean[] = [];
  for (const ray of [b1, b2]) {
    const offset = ccw(start, angle(ray));
    if (offset < 1e-9 || Math.abs(offset - span) < 1e-9 || offset > 2 * Math.PI - 1e-9) return false;
    inside.push(offset < span);
  }
  return inside[0] !== inside[1];
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

type BroadPhase = { pairs: number[]; examined: number; large: number };

/**
 * Hashed uniform grid. The cell edge is the 75th-percentile padded item span, so one
 * far outlier cannot stretch cells over the whole diagram. A pair is emitted
 * only from the cell holding the min corner of the two padded boxes'
 * intersection, so no global dedupe set is needed. Items spanning more than
 * GRID_MAX_CELLS_PER_ITEM cells are paired by scanning their partner types.
 */
function gridPairs(items: readonly Item[], wants: (left: Item, right: Item) => boolean, pad: number): BroadPhase {
  const pairs: number[] = [];
  if (!items.length) return { pairs, examined: 0, large: 0 };
  const spans = items.map(item => Math.max(item.box.width, item.box.height) + 2 * pad).sort((left, right) => left - right);
  const cell = Math.max(spans[Math.floor((spans.length - 1) * 0.75)]!, 2 * pad, Number.MIN_VALUE);
  const index = (value: number) => Math.floor((value - pad) / cell);
  const cells = new Map<string, { x: number; y: number; members: number[] }>();
  const large: number[] = [];
  items.forEach((item, itemIndex) => {
    const x0 = index(item.box.x);
    const y0 = index(item.box.y);
    const x1 = Math.floor((item.box.x + item.box.width + pad) / cell);
    const y1 = Math.floor((item.box.y + item.box.height + pad) / cell);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > GRID_MAX_CELLS_PER_ITEM) {
      large.push(itemIndex);
      return;
    }
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        const key = `${x},${y}`;
        const bucket = cells.get(key);
        if (bucket) bucket.members.push(itemIndex);
        else cells.set(key, { x, y, members: [itemIndex] });
      }
    }
  });
  let examined = 0;
  for (const { x, y, members } of cells.values()) {
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        const i = members[left]!;
        const j = members[right]!;
        const a = items[i]!;
        const b = items[j]!;
        if (!wants(a, b)) continue;
        examined += 1;
        if (!boxesTouch(a.box, b.box, 2 * pad)) continue;
        if (index(Math.max(a.box.x, b.box.x)) !== x || index(Math.max(a.box.y, b.box.y)) !== y) continue;
        pairs.push(Math.min(i, j), Math.max(i, j));
      }
    }
  }
  const isLarge = new Set(large);
  for (const i of large) {
    for (let j = 0; j < items.length; j += 1) {
      if (j === i || (isLarge.has(j) && j < i) || !wants(items[i]!, items[j]!)) continue;
      examined += 1;
      if (boxesTouch(items[i]!.box, items[j]!.box, 2 * pad)) pairs.push(Math.min(i, j), Math.max(i, j));
    }
  }
  return { pairs, examined, large: large.length };
}

function allPairs(items: readonly Item[], wants: (left: Item, right: Item) => boolean, pad: number): BroadPhase {
  const pairs: number[] = [];
  let examined = 0;
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      if (!wants(items[left]!, items[right]!)) continue;
      examined += 1;
      if (boxesTouch(items[left]!.box, items[right]!.box, 2 * pad)) pairs.push(left, right);
    }
  }
  return { pairs, examined, large: 0 };
}

const WANTED = new Set(['segment|segment', 'border|segment', 'segment|border', 'label|segment', 'segment|label', 'label|node', 'node|label']);

export function diagnoseGeometry(
  input: GeometryDiagnosticsInput,
  options: GeometryDiagnosticsOptions = {},
): GeometryDiagnosticsResult {
  if (!(input.zoom > 0) || !Number.isFinite(input.zoom)) throw new Error('geometry diagnostics need a positive finite zoom');
  const tolerances: GeometryDiagnosticTolerances = { ...GEOMETRY_DIAGNOSTIC_TOLERANCES };
  for (const [name, value] of Object.entries(input.tolerances ?? {})) {
    if (value === undefined) continue;
    if (!(name in tolerances) || !Number.isFinite(value) || value < 0) throw new Error(`invalid tolerance ${name}`);
    tolerances[name as keyof GeometryDiagnosticTolerances] = value;
  }
  const zoom = input.zoom;
  const world = (px: number) => px / zoom;
  /** Reported screen values; threshold comparisons use the same rounded value. */
  const px = (length: number) => roundScreen(length * zoom);
  const mode = options.broadPhase ?? 'grid';

  const nodes = byId(input.nodes, 'node');
  for (const node of nodes) assertFinite(`node ${node.id}`, node.bounds.x, node.bounds.y, node.bounds.width, node.bounds.height);
  const nodeIndex = new Map(nodes.map((node, index) => [node.id, index]));
  const edges: CanonicalEdge[] = byId(input.edges, 'edge').map(edge => ({
    ...edge,
    points: canonicalPoints(edge.points, edge.id),
    relationIds: [...new Set(edge.canonicalRelationIds ?? [])].sort(compareStrings),
  }));
  const edgeIndex = new Map(edges.map((edge, index) => [edge.id, index]));
  const labels = byId(input.labels ?? [], 'label').filter(label => edgeIndex.has(label.edgeId));
  for (const label of labels) assertFinite(`label ${label.id}`, label.bounds.x, label.bounds.y, label.bounds.width, label.bounds.height);

  let magnitude = 1;
  for (const node of nodes) magnitude = Math.max(magnitude, Math.abs(node.bounds.x), Math.abs(node.bounds.y));
  for (const edge of edges) for (const point of edge.points) magnitude = Math.max(magnitude, Math.abs(point.x), Math.abs(point.y));
  const eps = 1e-9 * magnitude;

  const ancestors = nodes.map(node => {
    const chain = new Set<number>();
    let parent = node.parentId;
    while (parent !== undefined && nodeIndex.has(parent) && !chain.has(nodeIndex.get(parent)!) && parent !== node.id) {
      chain.add(nodeIndex.get(parent)!);
      parent = nodes[nodeIndex.get(parent)!]!.parentId;
    }
    return chain;
  });
  const fromOf = edges.map(edge => nodeIndex.get(edge.fromNodeId));
  const toOf = edges.map(edge => nodeIndex.get(edge.toNodeId));
  const endpointNodes = edges.map((_, number) => [fromOf[number], toOf[number]].filter((value): value is number => value !== undefined));
  /** The route's actual port point(s) on `node`. */
  const portsOn = (number: number, node: number): GeometryPoint[] => {
    const points = edges[number]!.points;
    if (!points.length) return [];
    return [
      ...(fromOf[number] === node ? [points[0]!] : []),
      ...(toOf[number] === node ? [points[points.length - 1]!] : []),
    ];
  };

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
  const bundled = (left: number, right: number) => {
    const key = edges[left]!.bundleKey;
    return key !== undefined && key === edges[right]!.bundleKey;
  };
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
      edgeIds: [...new Set(ids.edges.map(value => edges[value]!.id))].sort(compareStrings),
      nodeIds: [...new Set((ids.nodes ?? []).map(value => nodes[value]!.id))].sort(compareStrings),
      labelIds: [...new Set((ids.labels ?? []).map(value => labels[value]!.id))].sort(compareStrings),
      canonicalRelationIds: [...new Set(ids.edges.flatMap(value => edges[value]!.relationIds))].sort(compareStrings),
      geometry,
    });
  };
  /** Any of `where` within the radius of either edge's port on a node both edges share. */
  const nearSharedPort = (left: number, right: number, where: GeometryPoint[]): boolean => {
    const radius = world(tolerances.sharedEndpointRadiusPx) + eps;
    return endpointNodes[left]!.filter(node => endpointNodes[right]!.includes(node)).some(node =>
      [...portsOn(left, node), ...portsOn(right, node)].some(port =>
        where.some(point => Math.hypot(point.x - port.x, point.y - port.y) <= radius)));
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
    if (!WANTED.has(`${left.type}|${right.type}`)) return false;
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
  type LabelHit = { label: number; edge?: number; node?: number; distance: number; exemption?: GeometryDiagnosticExemption };
  const labelHits = new Map<string, LabelHit>();
  const recordLabel = (key: string, hit: LabelHit) => {
    const previous = labelHits.get(key);
    if (!previous || hit.distance < previous.distance) labelHits.set(key, hit);
  };

  const segmentPair = (first: Segment, second: Segment) => {
    if (first.length <= eps || second.length <= eps) return;
    const [s, t] = first.edge < second.edge ? [first, second] : [second, first];
    const rx = s.b.x - s.a.x; const ry = s.b.y - s.a.y;
    const qx = t.b.x - t.a.x; const qy = t.b.y - t.a.y;
    const denominator = cross(rx, ry, qx, qy);
    if (Math.abs(denominator) > 1e-9 * s.length * t.length) {
      const u = cross(t.a.x - s.a.x, t.a.y - s.a.y, qx, qy) / denominator;
      const v = cross(t.a.x - s.a.x, t.a.y - s.a.y, rx, ry) / denominator;
      const place = (param: number, segment: Segment) => {
        const along = param * segment.length;
        if (along < -eps || along > segment.length + eps) return 'outside';
        if (along <= eps) return 'start';
        return along >= segment.length - eps ? 'end' : 'interior';
      };
      const ps = place(u, s);
      const pt = place(v, t);
      // Each vertex contact is examined once, from the segment it starts; route ends are junctions.
      if (ps === 'outside' || pt === 'outside' || ps === 'end' || pt === 'end') return;
      if ((ps === 'start' && s.first) || (pt === 'start' && t.first)) return;
      const point = ps === 'start' ? s.a : pt === 'start' ? t.a : { x: s.a.x + u * rx, y: s.a.y + u * ry };
      const behind = (segment: Segment, at: string) => (at === 'start' ? edges[segment.edge]!.points[segment.index - 1]! : segment.a);
      if ((ps !== 'interior' || pt !== 'interior') && !raysInterleave(point, behind(s, ps), s.b, behind(t, pt), t.b)) return;
      const exemption = bundled(s.edge, t.edge) ? 'bundle' as const
        : nearSharedPort(s.edge, t.edge, [point]) ? 'shared-endpoint' as const : undefined;
      const shortest = Math.min(s.length, t.length);
      push('edge-crossing', px(shortest) >= tolerances.hiddenLengthPx, exemption, { edges: [s.edge, t.edge] }, {
        points: [wp(point)],
        segments: [ws(s.a, s.b), ws(t.a, t.b)],
        screenLength: px(shortest),
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
      : nearSharedPort(s.edge, t.edge, [from, to]) ? 'shared-endpoint' as const : undefined;
    // For a shared-endpoint exemption screenLength is the fan-out/fan-in trunk length.
    push('shared-corridor', px(end - start) >= tolerances.hiddenLengthPx, exemption, { edges: [s.edge, t.edge] }, {
      segments: [ws(from, to)],
      screenLength: px(end - start),
      screenDistance: px(distance),
    });
  };

  const borderRun = (segment: Segment, node: number, side: Side) => {
    const bounds = nodes[node]!.bounds;
    const horizontal = side === 'top' || side === 'bottom';
    if ((segment.axis === 'h') !== horizontal) return;
    const [a, b] = borderLine(bounds, side);
    const offset = horizontal ? Math.abs(segment.a.y - a.y) : Math.abs(segment.a.x - a.x);
    if (offset > world(tolerances.borderRunDistancePx) + eps) return;
    const along = (point: GeometryPoint) => (horizontal ? point.x : point.y);
    const r0 = Math.max(along(a), Math.min(along(segment.a), along(segment.b)));
    const r1 = Math.min(along(b), Math.max(along(segment.a), along(segment.b)));
    if (px(r1 - r0) < tolerances.borderRunMinLengthPx) return;
    const report = (lo: number, hi: number, exemption?: GeometryDiagnosticExemption) => {
      if (hi - lo <= eps || (!exemption && px(hi - lo) < tolerances.borderRunMinLengthPx)) return;
      const at = (value: number) => (horizontal ? { x: value, y: segment.a.y } : { x: segment.a.x, y: value });
      push('container-border-run', px(hi - lo) >= tolerances.hiddenLengthPx, exemption, { edges: [segment.edge], nodes: [node] },
        { segments: [ws(at(lo), at(hi))], rects: [wr(bounds)], screenLength: px(hi - lo), screenDistance: px(offset) });
    };
    const endCard = segment.first ? fromOf[segment.edge] : segment.last ? toOf[segment.edge] : undefined;
    const alsoEnd = segment.first && segment.last ? toOf[segment.edge] : undefined;
    if (endCard === node || alsoEnd === node) return report(r0, r1, 'own-endpoint');
    const card = [endCard, alsoEnd].find(value => value !== undefined && ancestors[value]!.has(node));
    if (card === undefined) return report(r0, r1);
    // Containment: only the part of the terminal stub within its own card's extent is exempt.
    const cardBounds = nodes[card]!.bounds;
    const c0 = horizontal ? cardBounds.x : cardBounds.y;
    const c1 = c0 + (horizontal ? cardBounds.width : cardBounds.height);
    report(r0, Math.min(r1, c0));
    report(Math.max(r0, c0), Math.min(r1, c1), 'containment');
    report(Math.max(r0, c1), r1);
  };

  const labelSegment = (label: number, segment: Segment) => {
    const owner = edgeIndex.get(labels[label]!.edgeId)!;
    if (segment.edge === owner) return;
    const distance = segmentRectDistance(segment.a, segment.b, labels[label]!.bounds);
    if (distance > world(tolerances.labelClearancePx) + eps) return;
    recordLabel(`e${label}:${segment.edge}`, {
      label, edge: segment.edge, distance, ...(bundled(owner, segment.edge) ? { exemption: 'bundle' as const } : {}),
    });
  };

  const labelNode = (label: number, node: number) => {
    const owner = edgeIndex.get(labels[label]!.edgeId)!;
    const bounds = nodes[node]!.bounds;
    const distance = rectRectDistance(labels[label]!.bounds, bounds);
    if (distance > world(tolerances.labelClearancePx) + eps) return;
    const endpoints = endpointNodes[owner]!;
    const containsBoth = !endpoints.includes(node) && endpoints.length > 0
      && endpoints.every(endpoint => ancestors[endpoint]!.has(node) || contains(bounds, nodes[endpoint]!.bounds));
    recordLabel(`n${label}:${node}`, { label, node, distance, ...(containsBoth ? { exemption: 'containment' as const } : {}) });
  };

  for (let index = 0; index < broad.pairs.length; index += 2) {
    const left = items[broad.pairs[index]!]!;
    const right = items[broad.pairs[index + 1]!]!;
    const segment = left.type === 'segment' ? left : right.type === 'segment' ? right : undefined;
    const other = segment === left ? right : left;
    if (other.type === 'segment') segmentPair(segments[left.ref]!, segments[right.ref]!);
    else if (other.type === 'border') borderRun(segments[segment!.ref]!, other.ref, other.side!);
    else if (segment) labelSegment(other.ref, segments[segment.ref]!);
    else labelNode((left.type === 'label' ? left : right).ref, (left.type === 'node' ? left : right).ref);
  }

  for (const hit of labelHits.values()) {
    const label = labels[hit.label]!;
    const owner = edgeIndex.get(label.edgeId)!;
    push('label-clearance', px(Math.min(label.bounds.width, label.bounds.height)) >= tolerances.hiddenLengthPx, hit.exemption, {
      edges: hit.edge !== undefined ? [owner, hit.edge] : [owner],
      ...(hit.node !== undefined ? { nodes: [hit.node] } : {}),
      labels: [hit.label],
    }, {
      rects: [wr(label.bounds), ...(hit.node !== undefined ? [wr(nodes[hit.node]!.bounds)] : [])],
      screenDistance: px(hit.distance),
    });
  }

  // ---- endpoint crowding: per node, x-sorted sweep with Euclidean distance (catches corners) ----
  const ports = new Map<number, { edge: number; point: GeometryPoint }[]>();
  edges.forEach((edge, number) => {
    if (edge.points.length < 2) return;
    for (const node of new Set(endpointNodes[number])) {
      for (const point of portsOn(number, node)) {
        const list = ports.get(node) ?? [];
        list.push({ edge: number, point });
        ports.set(node, list);
      }
    }
  });
  const spacing = world(tolerances.endpointSpacingPx);
  for (const [node, list] of ports) {
    list.sort((left, right) => left.point.x - right.point.x || left.point.y - right.point.y || left.edge - right.edge);
    for (let left = 0; left < list.length; left += 1) {
      for (let right = left + 1; right < list.length && list[right]!.point.x - list[left]!.point.x < spacing; right += 1) {
        const a = list[left]!;
        const b = list[right]!;
        const distance = Math.hypot(b.point.x - a.point.x, b.point.y - a.point.y);
        if (a.edge === b.edge || px(distance) >= tolerances.endpointSpacingPx) continue;
        const exemption = bundled(a.edge, b.edge) ? 'bundle' as const : distance <= eps ? 'shared-port' as const : undefined;
        push('endpoint-crowding', px(distance) >= tolerances.hiddenLengthPx, exemption, { edges: [a.edge, b.edge], nodes: [node] },
          { points: [wp(a.point), wp(b.point)].sort((p, q) => p.x - q.x || p.y - q.y), screenDistance: px(distance) });
      }
    }
  }

  // ---- short routes and legs --------------------------------------------
  edges.forEach((edge, number) => {
    const own = segments.filter(segment => segment.edge === number);
    const length = own.reduce((sum, segment) => sum + segment.length, 0);
    if (px(length) < tolerances.minRouteLengthPx) {
      push('short-route', px(length) >= tolerances.hiddenLengthPx, undefined, { edges: [number], nodes: endpointNodes[number]! },
        { points: edge.points.map(wp), screenLength: px(length) });
      return;
    }
    if (own.length < 2) return;
    for (const segment of own) {
      if (px(segment.length) >= tolerances.minLegLengthPx) continue;
      push('short-leg', px(segment.length) >= tolerances.hiddenLengthPx, undefined, { edges: [number], nodes: endpointNodes[number]! },
        { segments: [ws(segment.a, segment.b)], screenLength: px(segment.length) });
    }
  });

  // ---- stable output -----------------------------------------------------
  const keyed = findings.map(finding => ({ key: findingSortKey(finding), finding }))
    .sort((left, right) => compareStrings(left.key, right.key))
    .filter((value, index, all) => index === 0 || value.key !== all[index - 1]!.key);
  const counts = Object.fromEntries(GEOMETRY_DIAGNOSTIC_KINDS.map(kind => [kind, { visible: 0, hidden: 0, exempt: 0 }])) as Record<GeometryDiagnosticKind, GeometryKindCounts>;
  const exemptions = Object.fromEntries(GEOMETRY_DIAGNOSTIC_EXEMPTIONS.map(value => [value, 0])) as Record<GeometryDiagnosticExemption, number>;
  const totals: GeometryKindCounts = { visible: 0, hidden: 0, exempt: 0 };
  for (const { finding } of keyed) {
    const bucket = finding.exemption ? 'exempt' : finding.visibility;
    counts[finding.kind][bucket] += 1;
    totals[bucket] += 1;
    if (finding.exemption) exemptions[finding.exemption] += 1;
  }
  const byType: Record<ItemType, number> = { segment: 0, border: 0, label: 0, node: 0 };
  for (const item of items) byType[item.type] += 1;
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
      broadPhase: {
        mode,
        naivePairs: (byType.segment * (byType.segment - 1)) / 2 + byType.segment * byType.border
          + byType.label * byType.segment + byType.label * byType.node,
        examinedPairs: broad.examined,
        candidatePairs: broad.pairs.length / 2,
        largeItems: broad.large,
      },
    },
    findings: keyed.map(value => value.finding),
  };
}

/** Visible, non-exempt findings only — the report-only "problems" view. */
export function visibleGeometryProblems(result: GeometryDiagnosticsResult): GeometryFinding[] {
  return result.findings.filter(finding => finding.visibility === 'visible' && !finding.exemption);
}
