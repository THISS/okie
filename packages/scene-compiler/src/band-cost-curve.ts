import {
  buildC4ProjectionBundle,
  selectC4BandProjection,
  type ArchitectureEntity,
  type ArchitectureRelation,
  type ArchitectureSnapshot,
  type C4Band,
} from "@okie/architecture";
import { compileC4Scene, type CompiledC4Scene } from "./compile-c4.js";
import type { SceneSnapshot } from "./protocol.js";

/**
 * CLA-67 cost-curve harness. Extends the scoped-compile dense snapshot so
 * per-band compile/render cost is measured instead of guessed. This is not a
 * product cap and must not change default compile bytes.
 */

export const BAND_COST_CHILD_COUNTS = [25, 50, 100, 200, 400, 800] as const;
export const BAND_COST_UNBOUNDED_CHILD_COUNTS = [25, 50, 100, 200] as const;
/** One-down prefetch neighborhood (a single file-component's code children). */
export const BAND_COST_PREFETCH_CODE_CHILDREN = 25;
/**
 * Hang-guard under test. CLA-67 records the curve; it does not invent a
 * replacement. Tests lock this at 2000 until a measured cap is wired from the
 * table in docs/architecture/band-cost-curve.md.
 */
export const BAND_COST_HANG_GUARD_ENTITIES = 2000;

const EVIDENCE = [{ source: { path: "x.ts", commitSha: "c" } }] as const;

function pad(index: number): string {
  return index.toString().padStart(4, "0");
}

/** A dense single-container snapshot: `chainCount` chain edges (count 1) + one hub pair (count 5). */
export function denseSnapshot(componentCount: number): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    { id: "system:d", kind: "softwareSystem", name: "D", sourceRefs: [] },
    { id: "container:c", kind: "container", parentId: "system:d", name: "C", sourceRefs: [] },
  ];
  const cid = (index: number): string => `component:c-m${index.toString().padStart(3, "0")}`;
  for (let index = 0; index < componentCount; index += 1) {
    entities.push({ id: cid(index), kind: "component", parentId: "container:c", name: `m${index}`, sourceRefs: [] });
    entities.push({ id: `code:c-m${index}`, kind: "code", parentId: cid(index), name: "k", sourceRefs: [] });
  }
  const relations: ArchitectureRelation[] = [];
  for (let index = 0; index < componentCount; index += 1) {
    relations.push({
      id: `relation:e${index.toString().padStart(3, "0")}`,
      from: cid(index),
      to: cid((index + 1) % componentCount),
      kind: "dependsOn",
      evidence: [...EVIDENCE],
    });
  }
  for (let copy = 0; copy < 5; copy += 1) {
    relations.push({ id: `relation:hub${copy}`, from: cid(0), to: cid(2), kind: "dependsOn", evidence: [...EVIDENCE] });
  }
  return {
    schemaVersion: 1,
    id: "snapshot:d",
    repositoryId: "repo:d",
    commitSha: "c",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entities,
    relations,
  };
}

export type NeighborhoodBand = Exclude<C4Band, "context">;

/**
 * One C4 neighborhood: a parent at `band`'s owner plus `childCount` native-band
 * children, chained plus a hub pair. No deeper leaves, so childCount is the
 * band's node count.
 */
export function denseNeighborhoodSnapshot(
  band: NeighborhoodBand,
  childCount: number,
): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    { id: "system:d", kind: "softwareSystem", name: "D", sourceRefs: [] },
  ];
  const relations: ArchitectureRelation[] = [];
  const childId = (index: number): string => `${band}:${pad(index)}`;

  if (band === "container") {
    for (let index = 0; index < childCount; index += 1) {
      entities.push({
        id: childId(index),
        kind: "container",
        parentId: "system:d",
        name: `c${index}`,
        sourceRefs: [],
      });
    }
  } else if (band === "component") {
    entities.push({ id: "container:c", kind: "container", parentId: "system:d", name: "C", sourceRefs: [] });
    for (let index = 0; index < childCount; index += 1) {
      entities.push({
        id: childId(index),
        kind: "component",
        parentId: "container:c",
        name: `m${index}`,
        sourceRefs: [],
      });
    }
  } else {
    entities.push({ id: "container:c", kind: "container", parentId: "system:d", name: "C", sourceRefs: [] });
    entities.push({ id: "component:c", kind: "component", parentId: "container:c", name: "M", sourceRefs: [] });
    for (let index = 0; index < childCount; index += 1) {
      entities.push({
        id: childId(index),
        kind: "code",
        parentId: "component:c",
        name: `k${index}`,
        sourceRefs: [],
      });
    }
  }

  if (childCount >= 2) {
    for (let index = 0; index < childCount; index += 1) {
      relations.push({
        id: `relation:e${pad(index)}`,
        from: childId(index),
        to: childId((index + 1) % childCount),
        kind: "dependsOn",
        evidence: [...EVIDENCE],
      });
    }
  }
  if (childCount >= 3) {
    for (let copy = 0; copy < 5; copy += 1) {
      relations.push({
        id: `relation:hub${copy}`,
        from: childId(0),
        to: childId(2),
        kind: "dependsOn",
        evidence: [...EVIDENCE],
      });
    }
  }

  return {
    schemaVersion: 1,
    id: "snapshot:band-cost",
    repositoryId: "repo:band-cost",
    commitSha: "c",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entities,
    relations,
  };
}

export type BandCompileOptions = {
  maxBand: C4Band;
  maxEdgesPerBand?: number;
  maxGridNodes?: number;
};

export function neighborhoodFocus(band: NeighborhoodBand): {
  rootEntityId: string;
  focusEntityId: string;
  familyId: string;
} {
  if (band === "container") {
    return { rootEntityId: "system:d", focusEntityId: "system:d", familyId: "f" };
  }
  if (band === "component") {
    return { rootEntityId: "system:d", focusEntityId: "container:c", familyId: "f" };
  }
  return { rootEntityId: "system:d", focusEntityId: "component:c", familyId: "f" };
}

/** CLA-66 product path for a container drill: current band + edge/grid caps. */
export const SCOPED_COMPONENT_COMPILE: BandCompileOptions = {
  maxBand: "component",
  maxEdgesPerBand: 24,
  maxGridNodes: 1500,
};

export const SCOPED_CONTAINER_COMPILE: BandCompileOptions = { maxBand: "container" };
export const SCOPED_CODE_COMPILE: BandCompileOptions = { maxBand: "code" };

export function compileNeighborhood(
  snapshot: ArchitectureSnapshot,
  band: NeighborhoodBand,
  options: BandCompileOptions,
): CompiledC4Scene {
  const focus = neighborhoodFocus(band);
  const bundle = buildC4ProjectionBundle(snapshot, { ...focus, ...options });
  return compileC4Scene(snapshot, bundle, {
    ...(options.maxGridNodes !== undefined ? { maxGridNodes: options.maxGridNodes } : {}),
    routeOverrides: [],
  });
}

export type BandCostStructure = {
  band: NeighborhoodBand;
  childCount: number;
  entityCount: number;
  relationCount: number;
  bandNodeCount: number;
  bandEdgeCount: number;
  bandOmittedEdgeCount: number;
  objectCount: number;
  pathCount: number;
  payloadBytes: number;
  directFallbackCount: number;
  compileOptions: BandCompileOptions;
};

export type BandCostSample = BandCostStructure & {
  compileMs: number;
};

export type PrefetchCostSample = BandCostSample & {
  fromBand: NeighborhoodBand;
};

function payloadBytes(scene: SceneSnapshot): number {
  return Buffer.byteLength(JSON.stringify(scene), "utf8");
}

export function medianMs(run: () => void, samples = 5, warmup = 1): number {
  for (let index = 0; index < warmup; index += 1) run();
  const times: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    run();
    times.push(performance.now() - started);
  }
  times.sort((left, right) => left - right);
  return times[Math.floor(times.length / 2)]!;
}

export function structuralBandCost(
  snapshot: ArchitectureSnapshot,
  band: NeighborhoodBand,
  compiled: CompiledC4Scene,
  options: BandCompileOptions,
  childCount = snapshot.entities.filter(entity => {
    if (band === "container") return entity.kind === "container";
    if (band === "component") return entity.kind === "component";
    return entity.kind === "code";
  }).length,
): BandCostStructure {
  const projection = compiled.projections.projectionById[compiled.projections.family.projectionIds[band]];
  const materialized = selectC4BandProjection(compiled.projections, band);
  return {
    band,
    childCount,
    entityCount: snapshot.entities.length,
    relationCount: snapshot.relations.length,
    bandNodeCount: materialized.nodes.length,
    bandEdgeCount: projection?.visualEdgeIds.length ?? 0,
    bandOmittedEdgeCount: projection?.omittedEdgeIds?.length ?? 0,
    objectCount: compiled.scene.objects.length,
    pathCount: compiled.scene.paths.length,
    payloadBytes: payloadBytes(compiled.scene),
    directFallbackCount: (compiled.routeDiagnostics ?? [])
      .filter(diagnostic => diagnostic.routerDiagnostic === "direct-fallback").length,
    compileOptions: { ...options },
  };
}

export function measureBandCompile(
  band: NeighborhoodBand,
  childCount: number,
  options: BandCompileOptions,
  timing: { samples?: number; warmup?: number } = {},
): BandCostSample {
  const snapshot = denseNeighborhoodSnapshot(band, childCount);
  const compiled = compileNeighborhood(snapshot, band, options);
  const samples = timing.samples ?? 3;
  const warmup = timing.warmup ?? 1;
  const compileMs = medianMs(() => {
    compileNeighborhood(snapshot, band, options);
  }, samples, warmup);
  return { ...structuralBandCost(snapshot, band, compiled, options), compileMs };
}

/** Open inside / one-down prefetch: compile the next band of a single child. */
export function measurePrefetchCompile(
  fromBand: NeighborhoodBand,
  nextChildCount: number,
  timing: { samples?: number; warmup?: number } = {},
): PrefetchCostSample {
  const nextBand: NeighborhoodBand = fromBand === "container" ? "component" : "code";
  const options: BandCompileOptions = nextBand === "component" ? SCOPED_COMPONENT_COMPILE : SCOPED_CODE_COMPILE;
  const sample = measureBandCompile(nextBand, nextChildCount, options, timing);
  return { ...sample, fromBand };
}

export type ProtocolCpuFrame = {
  visibleObjects: number;
  visiblePaths: number;
  firstFrameMs: number;
  panMs: number;
  zoomMs: number;
};

/**
 * CPU stand-in for a GPU engine frame: viewport cull of protocol objects/paths.
 * The atlas-engine test measures the real ProtocolEngine path; this keeps the
 * TypeScript harness self-contained and CI-stable.
 */
export function measureProtocolCpuFrame(
  scene: SceneSnapshot,
  zoom: number,
  viewport = { width: 1280, height: 720 },
): ProtocolCpuFrame {
  const world = scene.worldBounds;
  const center = { x: world.x + world.width / 2, y: world.y + world.height / 2 };
  const viewAt = (camera: { x: number; y: number; zoom: number }) => ({
    x: camera.x - viewport.width / (2 * camera.zoom),
    y: camera.y - viewport.height / (2 * camera.zoom),
    width: viewport.width / camera.zoom,
    height: viewport.height / camera.zoom,
  });
  const intersects = (
    left: { x: number; y: number; width: number; height: number },
    right: { x: number; y: number; width: number; height: number },
  ) =>
    left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
  const pathBounds = (points: readonly { x: number; y: number }[]) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  };
  const cull = (camera: { x: number; y: number; zoom: number }) => {
    const view = viewAt(camera);
    let visibleObjects = 0;
    let visiblePaths = 0;
    for (const object of scene.objects) if (intersects(object.bounds, view)) visibleObjects += 1;
    for (const path of scene.paths) if (intersects(pathBounds(path.points), view)) visiblePaths += 1;
    return { visibleObjects, visiblePaths };
  };
  const fitted = { x: center.x, y: center.y, zoom };
  const first = cull(fitted);
  const firstFrameMs = medianMs(() => {
    cull(fitted);
  });
  const panned = { ...fitted, x: fitted.x + 120, y: fitted.y + 80 };
  const panMs = medianMs(() => {
    cull(panned);
  });
  const zoomed = { ...fitted, zoom: zoom * 1.25 };
  const zoomMs = medianMs(() => {
    cull(zoomed);
  });
  return { ...first, firstFrameMs, panMs, zoomMs };
}

export function compileSnapshotNeighborhood(
  snapshot: ArchitectureSnapshot,
  rootEntityId: string,
  focusEntityId: string,
  options: BandCompileOptions,
): CompiledC4Scene {
  const bundle = buildC4ProjectionBundle(snapshot, {
    rootEntityId,
    focusEntityId,
    familyId: "f",
    ...options,
  });
  return compileC4Scene(snapshot, bundle, {
    ...(options.maxGridNodes !== undefined ? { maxGridNodes: options.maxGridNodes } : {}),
    routeOverrides: [],
  });
}

export type ScanBandSample = BandCostSample & {
  focusEntityId: string;
  cpuFrame: ProtocolCpuFrame;
};

export function measureSnapshotNeighborhood(
  snapshot: ArchitectureSnapshot,
  band: NeighborhoodBand,
  rootEntityId: string,
  focusEntityId: string,
  options: BandCompileOptions,
  zoom: number,
): ScanBandSample {
  const compiled = compileSnapshotNeighborhood(snapshot, rootEntityId, focusEntityId, options);
  const compileMs = medianMs(() => {
    compileSnapshotNeighborhood(snapshot, rootEntityId, focusEntityId, options);
  }, 3, 1);
  const childCount = snapshot.entities.filter(entity => entity.parentId === focusEntityId).length;
  return {
    ...structuralBandCost(snapshot, band, compiled, options, childCount),
    compileMs,
    focusEntityId,
    cpuFrame: measureProtocolCpuFrame(compiled.scene, zoom),
  };
}

export function softwareSystemId(snapshot: ArchitectureSnapshot): string {
  const system = snapshot.entities.find(entity => entity.kind === "softwareSystem");
  if (!system) throw new Error("snapshot has no softwareSystem");
  return system.id;
}

export function firstChildOfKind(
  snapshot: ArchitectureSnapshot,
  parentId: string,
  kind: ArchitectureEntity["kind"],
): string | undefined {
  return snapshot.entities.find(entity => entity.parentId === parentId && entity.kind === kind)?.id;
}

export function entityIdByName(snapshot: ArchitectureSnapshot, name: string): string | undefined {
  return snapshot.entities.find(entity => entity.name === name)?.id;
}

export type BandCostCurveRow = BandCostSample & {
  cpuFrame: ProtocolCpuFrame;
  prefetch?: PrefetchCostSample & { cpuFrame: ProtocolCpuFrame };
  unbounded?: BandCostSample;
};

export function measureComponentBandRow(childCount: number): BandCostCurveRow {
  const scoped = measureBandCompile("component", childCount, SCOPED_COMPONENT_COMPILE);
  const snapshot = denseNeighborhoodSnapshot("component", childCount);
  const compiled = compileNeighborhood(snapshot, "component", SCOPED_COMPONENT_COMPILE);
  const cpuFrame = measureProtocolCpuFrame(compiled.scene, 5.27);
  const prefetchBase = measurePrefetchCompile("component", BAND_COST_PREFETCH_CODE_CHILDREN);
  const prefetchCompiled = compileNeighborhood(
    denseNeighborhoodSnapshot("code", BAND_COST_PREFETCH_CODE_CHILDREN),
    "code",
    SCOPED_CODE_COMPILE,
  );
  const prefetch = {
    ...prefetchBase,
    cpuFrame: measureProtocolCpuFrame(prefetchCompiled.scene, 13.96),
  };
  const unbounded = (BAND_COST_UNBOUNDED_CHILD_COUNTS as readonly number[]).includes(childCount)
    ? measureBandCompile("component", childCount, { maxBand: "component" })
    : undefined;
  return { ...scoped, cpuFrame, prefetch, ...(unbounded ? { unbounded } : {}) };
}

export function structuralFields(row: BandCostStructure): BandCostStructure {
  return {
    band: row.band,
    childCount: row.childCount,
    entityCount: row.entityCount,
    relationCount: row.relationCount,
    bandNodeCount: row.bandNodeCount,
    bandEdgeCount: row.bandEdgeCount,
    bandOmittedEdgeCount: row.bandOmittedEdgeCount,
    objectCount: row.objectCount,
    pathCount: row.pathCount,
    payloadBytes: row.payloadBytes,
    directFallbackCount: row.directFallbackCount,
    compileOptions: { ...row.compileOptions },
  };
}
