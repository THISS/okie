import {
  ASPECT_PRESET_TARGET,
  C4_BANDS,
  GEOMETRY_DIAGNOSTIC_KINDS,
  GEOMETRY_DIAGNOSTIC_TOLERANCES,
  buildC4ProjectionBundle,
  diagnoseGeometry,
  routeC4BandEdgesDetailed,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
  type C4Band,
  type GeometryDiagnosticKind,
  type GeometryDiagnosticsInput,
  type GeometryDiagnosticsResult,
  type GeometryDiagnosticsSummary,
} from '@okie/architecture';
import {
  SCOPED_CODE_COMPILE,
  SCOPED_COMPONENT_COMPILE,
  SCOPED_CONTAINER_COMPILE,
  compileNeighborhood,
  denseNeighborhoodSnapshot,
  denseSnapshot,
} from './band-cost-curve.js';
import { C4_CAMERA_LIMITS, C4_ZOOM_BANDS, compileC4Scene, type CompiledC4Scene } from './compile-c4.js';
import { goldenSnapshot } from './golden-fixture.js';

/**
 * CLA-140 adapter: turns a compiled C4 scene into report-only geometry
 * diagnostics per band, at the band's entry zoom (smallest scale the band is
 * drawn at, clamped to the camera floor) and its focus zoom. Nothing here
 * changes routing, layout or compiled bytes.
 */

export type C4DiagnosticZoomLevel = 'enter' | 'focus';

export function c4DiagnosticZoom(band: C4Band, level: C4DiagnosticZoomLevel): number {
  const zoomBand = C4_ZOOM_BANDS.find(value => value.detail === band)!;
  return level === 'focus' ? zoomBand.focusZoom : Math.max(zoomBand.enterZoom, C4_CAMERA_LIMITS.minZoom);
}

/** Diagnostic input for one band of a compiled scene (world coords, labels from the scene). */
export function c4BandGeometryInput(compiled: CompiledC4Scene, band: C4Band, zoom: number): GeometryDiagnosticsInput {
  const bundle = compiled.projections;
  const projection = bundle.projectionById[bundle.family.projectionIds[band]]!;
  const layout = bundle.bandLayoutById[projection.layoutId]!;
  const nodeIds = projection.visualNodeIds.filter(id => layout.nodes[id]);
  const visible = new Set(nodeIds);
  const nodes = nodeIds.map(id => {
    const parentId = bundle.visualNodeById[id]?.parentVisualId;
    return { id, bounds: { ...layout.nodes[id]! }, ...(parentId && visible.has(parentId) ? { parentId } : {}) };
  });
  const edges = projection.visualEdgeIds.flatMap(id => {
    const edge = bundle.visualEdgeById[id];
    const route = layout.edges[id];
    if (!edge || !route) return [];
    return [{
      id,
      fromNodeId: edge.fromVisualId,
      toNodeId: edge.toVisualId,
      points: route.points,
      // Parallel lanes of one node pair are the router's intentional bundle.
      bundleKey: [edge.fromVisualId, edge.toVisualId].sort().join('\u0000'),
      canonicalRelationIds: edge.relations.map(relation => relation.logicalId),
    }];
  });
  const edgeIds = new Set(edges.map(edge => edge.id));
  const labels = compiled.scene.objects.flatMap(object => {
    if (!object.id.startsWith('relation-label:')) return [];
    const edgeId = object.id.slice('relation-label:'.length);
    if (!edgeIds.has(edgeId) || !object.representations.some(value => value.id.endsWith(`:${band}`))) return [];
    return [{ id: object.id, edgeId, bounds: { ...object.bounds } }];
  });
  return { band, zoom, nodes, edges, labels };
}

export type C4GeometryDiagnosticsRun = {
  band: C4Band;
  level: C4DiagnosticZoomLevel;
  input: GeometryDiagnosticsInput;
  result: GeometryDiagnosticsResult;
};

export function diagnoseC4Scene(
  compiled: CompiledC4Scene,
  bands: readonly C4Band[] = C4_BANDS,
  levels: readonly C4DiagnosticZoomLevel[] = ['enter', 'focus'],
): C4GeometryDiagnosticsRun[] {
  return bands.flatMap(band => levels.map(level => {
    const input = c4BandGeometryInput(compiled, band, c4DiagnosticZoom(band, level));
    return { band, level, input, result: diagnoseGeometry(input) };
  }));
}

// ---- fixtures ---------------------------------------------------------------

const CLA68_NAMES = ['alpha', 'beta', 'gamma', 'delta'] as const;

/** The CLA-68 packed file: four code siblings, one `duplicates` relation between the first two. */
export function cla68PackedFileSnapshot(): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    { id: 'system:d', kind: 'softwareSystem', name: 'D', sourceRefs: [] },
    { id: 'container:c', kind: 'container', parentId: 'system:d', name: 'C', sourceRefs: [] },
    { id: 'component:icons', kind: 'component', parentId: 'container:c', name: 'icons.tsx', sourceRefs: [] },
    ...CLA68_NAMES.map(name => ({ id: `code:${name}`, kind: 'code' as const, parentId: 'component:icons', name, sourceRefs: [] })),
  ];
  return {
    schemaVersion: 1,
    id: 'snapshot:duplicates-gutter',
    repositoryId: 'repo:duplicates-gutter',
    commitSha: 'c',
    generatedAt: '2026-01-01T00:00:00.000Z',
    entities,
    relations: [{
      id: 'relation:dup:alpha-beta',
      from: 'code:alpha',
      to: 'code:beta',
      kind: 'duplicates',
      label: 'duplicates',
      evidence: [{ source: { path: 'src/icons.tsx', commitSha: 'c' } }],
    }],
  };
}

function compileCla68(targetAspect?: number): CompiledC4Scene {
  const snapshot = cla68PackedFileSnapshot();
  const bundle = buildC4ProjectionBundle(snapshot, {
    rootEntityId: 'system:d',
    focusEntityId: 'component:icons',
    familyId: 'view-family:duplicates-gutter',
    ...(targetAspect !== undefined ? { targetAspect } : {}),
  });
  return compileC4Scene(snapshot, bundle, targetAspect !== undefined ? { targetAspect } : {});
}

/**
 * Reconstructs the pre-CLA-68 route on the pre-CLA-68 packing: the tight
 * (two-clearance) gutter of the default compile, with the `duplicates` edge
 * routed as an ordinary edge — the legacy facing side-to-side hop. Only the
 * returned copy is rerouted; compiled bytes are untouched.
 */
export function cla68LegacyHopScene(): CompiledC4Scene {
  const compiled = compileCla68();
  const bundle = compiled.projections;
  const projection = bundle.projectionById[bundle.family.projectionIds.code]!;
  const layout = bundle.bandLayoutById[projection.layoutId]!;
  const focusZoom = c4DiagnosticZoom('code', 'focus');
  const asOrdinary = Object.fromEntries(Object.entries(bundle.visualEdgeById)
    .map(([id, edge]) => [id, edge.kind === 'duplicates' ? { ...edge, kind: 'calls' as const } : edge]));
  const legacy = routeC4BandEdgesDetailed(projection, bundle.visualNodeById, asOrdinary, layout.nodes, {
    clearance: 8 / focusZoom,
    laneSpacing: 10 / focusZoom,
    maxPoints: 16,
  }).edges;
  return {
    ...compiled,
    projections: {
      ...bundle,
      bandLayoutById: { ...bundle.bandLayoutById, [layout.id]: { ...layout, edges: legacy } },
    },
  };
}

export type GeometryDiagnosticFixture = {
  id: string;
  description: string;
  bands: readonly C4Band[];
  compile: () => CompiledC4Scene;
};

/** Real dense Okie fixtures plus the CLA-68 gutter regression (before/after). */
export const GEOMETRY_DIAGNOSTIC_FIXTURES: readonly GeometryDiagnosticFixture[] = [
  {
    id: 'golden-okie',
    description: 'Hand-authored Okie self-map, default compile, all bands',
    bands: C4_BANDS,
    compile: () => compileC4Scene(goldenSnapshot, buildC4ProjectionBundle(goldenSnapshot, {
      rootEntityId: 'system:okie',
      focusEntityId: 'system:okie',
    })),
  },
  {
    id: 'dense-default-40',
    description: 'CLA-67 dense snapshot (40 components, chain + 5-copy hub), default compile',
    bands: ['component'],
    compile: () => {
      const snapshot = denseSnapshot(40);
      return compileC4Scene(snapshot, buildC4ProjectionBundle(snapshot, {
        rootEntityId: 'system:d', focusEntityId: 'system:d', familyId: 'f',
      }));
    },
  },
  {
    id: 'dense-container-25',
    description: 'CLA-67 container neighborhood, 25 children, scoped compile',
    bands: ['container'],
    compile: () => compileNeighborhood(denseNeighborhoodSnapshot('container', 25), 'container', SCOPED_CONTAINER_COMPILE),
  },
  {
    id: 'dense-component-50',
    description: 'CLA-67 component neighborhood, 50 children, CLA-66 scoped product compile',
    bands: ['component'],
    compile: () => compileNeighborhood(denseNeighborhoodSnapshot('component', 50), 'component', SCOPED_COMPONENT_COMPILE),
  },
  {
    id: 'dense-code-25',
    description: 'CLA-67 code neighborhood, 25 children, scoped compile',
    bands: ['code'],
    compile: () => compileNeighborhood(denseNeighborhoodSnapshot('code', 25), 'code', SCOPED_CODE_COMPILE),
  },
  {
    id: 'cla68-before',
    description: 'CLA-68 before: tight L4 gutter with the legacy facing side-to-side hop (reconstructed)',
    bands: ['code'],
    compile: cla68LegacyHopScene,
  },
  {
    id: 'cla68-after-tight',
    description: 'CLA-68 after, default packing: duplicates U-loop in the tight gutter',
    bands: ['code'],
    compile: () => compileCla68(),
  },
  {
    id: 'cla68-after-scan',
    description: 'CLA-68 after, scan packing (landscape): widened gutter + duplicates U-loop',
    bands: ['code'],
    compile: () => compileCla68(ASPECT_PRESET_TARGET.landscape),
  },
];

// ---- baseline -----------------------------------------------------------------

export type GeometryBaselineRow = Omit<GeometryDiagnosticsSummary, 'broadPhase' | 'band'> & {
  band: C4Band;
  level: C4DiagnosticZoomLevel;
  candidatePairs: number;
  naivePairs: number;
  /** Visible, non-exempt findings as `kind edgeIds [nodeIds] [labelIds]`. */
  visibleProblems: string[];
};

export type GeometryDiagnosticsBaseline = {
  schemaVersion: 1;
  tolerances: typeof GEOMETRY_DIAGNOSTIC_TOLERANCES;
  kinds: readonly GeometryDiagnosticKind[];
  fixtures: Array<{ id: string; description: string; rows: GeometryBaselineRow[] }>;
};

export function geometryBaselineRow(run: C4GeometryDiagnosticsRun): GeometryBaselineRow {
  const { broadPhase, band: _band, ...summary } = run.result.summary;
  return {
    band: run.band,
    level: run.level,
    ...summary,
    candidatePairs: broadPhase.candidatePairs,
    naivePairs: broadPhase.naivePairs,
    visibleProblems: run.result.findings
      .filter(finding => finding.visibility === 'visible' && !finding.exemption)
      .map(finding => [
        finding.kind,
        finding.edgeIds.join(','),
        ...(finding.nodeIds.length ? [`[${finding.nodeIds.join(',')}]`] : []),
        ...(finding.labelIds.length ? [`[${finding.labelIds.join(',')}]`] : []),
      ].join(' ')),
  };
}

export function measureGeometryDiagnosticsBaseline(
  fixtures: readonly GeometryDiagnosticFixture[] = GEOMETRY_DIAGNOSTIC_FIXTURES,
): GeometryDiagnosticsBaseline {
  return {
    schemaVersion: 1,
    tolerances: GEOMETRY_DIAGNOSTIC_TOLERANCES,
    kinds: GEOMETRY_DIAGNOSTIC_KINDS,
    fixtures: fixtures.map(fixture => ({
      id: fixture.id,
      description: fixture.description,
      rows: diagnoseC4Scene(fixture.compile(), fixture.bands).map(geometryBaselineRow),
    })),
  };
}

// ---- deterministic SVG render ----------------------------------------------------

const KIND_COLOR: Readonly<Record<GeometryDiagnosticKind, string>> = {
  'edge-crossing': '#d7263d',
  'shared-corridor': '#f46036',
  'label-clearance': '#8e44ad',
  'container-border-run': '#1b998b',
  'endpoint-crowding': '#e2a400',
  'short-route': '#2e86de',
};

/**
 * Compact SVG of one diagnostic run in screen px: nodes, routes, labels, then
 * visible findings (exempt/hidden omitted) highlighted per kind.
 */
export function renderGeometryDiagnosticsSvg(input: GeometryDiagnosticsInput, result: GeometryDiagnosticsResult, title: string): string {
  const zoom = input.zoom;
  // Frame the routed region (edge endpoints' cards + routes), not far context peers.
  const endpoints = new Set(input.edges.flatMap(edge => [edge.fromNodeId, edge.toNodeId]));
  const framed = input.edges.length ? input.nodes.filter(node => endpoints.has(node.id)) : input.nodes;
  const xs = [...framed.flatMap(node => [node.bounds.x, node.bounds.x + node.bounds.width]), ...input.edges.flatMap(edge => edge.points.map(point => point.x))];
  const ys = [...framed.flatMap(node => [node.bounds.y, node.bounds.y + node.bounds.height]), ...input.edges.flatMap(edge => edge.points.map(point => point.y))];
  const pad = 24;
  const minX = (xs.length ? Math.min(...xs) : 0) - pad / zoom;
  const minY = (ys.length ? Math.min(...ys) : 0) - pad / zoom;
  const n = (value: number) => Number(value.toFixed(1));
  const sx = (x: number) => n((x - minX) * zoom);
  const sy = (y: number) => n((y - minY) * zoom + 18);
  const width = n(((xs.length ? Math.max(...xs) : 0) - minX) * zoom + pad);
  const height = n(((ys.length ? Math.max(...ys) : 0) - minY) * zoom + pad + 18);
  const rect = (r: { x: number; y: number; width: number; height: number }, attrs: string) =>
    `<rect x="${sx(r.x)}" y="${sy(r.y)}" width="${n(r.width * zoom)}" height="${n(r.height * zoom)}" ${attrs}/>`;
  const line = (points: readonly { x: number; y: number }[], attrs: string) =>
    `<polyline points="${points.map(point => `${sx(point.x)},${sy(point.y)}`).join(' ')}" fill="none" ${attrs}/>`;
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="sans-serif" font-size="11">`,
    `<rect width="100%" height="100%" fill="#f1f2f5"/>`,
  ];
  for (const node of input.nodes) out.push(rect(node.bounds, 'fill="#fff" fill-opacity="0.6" stroke="#7a8599" stroke-width="1"'));
  for (const label of input.labels ?? []) out.push(rect(label.bounds, 'fill="#fff" stroke="#b0b0b0" stroke-dasharray="2 2"'));
  for (const edge of input.edges) out.push(line(edge.points, 'stroke="#445" stroke-width="1.5"'));
  for (const finding of result.findings) {
    if (finding.exemption || finding.visibility !== 'visible') continue;
    const color = KIND_COLOR[finding.kind];
    for (const segment of finding.geometry.segments ?? []) {
      if (finding.kind === 'edge-crossing') continue;
      out.push(line(segment, `stroke="${color}" stroke-width="4" stroke-opacity="0.75"`));
    }
    if (finding.kind === 'label-clearance') out.push(rect(finding.geometry.rects![0]!, `fill="none" stroke="${color}" stroke-width="2"`));
    if (finding.kind === 'short-route') out.push(line(finding.geometry.points!, `stroke="${color}" stroke-width="5" stroke-opacity="0.75"`));
    for (const point of finding.kind === 'short-route' ? [] : finding.geometry.points ?? []) {
      out.push(`<circle cx="${sx(point.x)}" cy="${sy(point.y)}" r="4" fill="none" stroke="${color}" stroke-width="2"/>`);
    }
  }
  const legend = GEOMETRY_DIAGNOSTIC_KINDS
    .map(kind => `${kind}:${result.summary.counts[kind].visible}`)
    .join('  ');
  out.push(
    `<text x="${pad}" y="14">${title.replace(/[<&]/g, '')}</text>`,
    `<text x="${pad}" y="${n(height - 6)}" font-size="10" fill="#555">${legend}</text>`,
    '</svg>',
  );
  return `${out.join('\n')}\n`;
}
