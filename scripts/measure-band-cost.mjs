#!/usr/bin/env node
/**
 * CLA-67: measure per-band compile / CPU-frame cost and write the committed table.
 * Regenerates fixtures/architecture/band-cost-curve.json. Does not change the 2000 hang-guard.
 *
 *   pnpm --filter @okie/architecture build
 *   pnpm --filter @okie/scene-compiler build
 *   node scripts/measure-band-cost.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  BAND_COST_CHILD_COUNTS,
  BAND_COST_HANG_GUARD_ENTITIES,
  BAND_COST_PREFETCH_CODE_CHILDREN,
  SCOPED_CODE_COMPILE,
  SCOPED_COMPONENT_COMPILE,
  SCOPED_CONTAINER_COMPILE,
  firstChildOfKind,
  entityIdByName,
  measureBandCompile,
  measureComponentBandRow,
  measureSnapshotNeighborhood,
  softwareSystemId,
  structuralFields,
} from "../packages/scene-compiler/dist/band-cost-curve.js";

const COMPILE_HEALTHY_MS = 120;
const COMPILE_FALLOVER_MS = 200;
const PAYLOAD_HEALTHY_BYTES = 500_000;
const PAYLOAD_FALLOVER_BYTES = 1_500_000;
const FRAME_HEALTHY_MS = 8;
const FRAME_FALLOVER_MS = 16.7;
const PREFETCH_HEALTHY_MS = 80;
const PREFETCH_FALLOVER_MS = 200;

function firstWhere(counts, predicate) {
  for (const count of counts) {
    if (predicate(count)) return count;
  }
  return null;
}

function lastWhere(counts, predicate) {
  let found = null;
  for (const count of counts) {
    if (predicate(count)) found = count;
    else break;
  }
  return found;
}

const rows = [];
for (const childCount of BAND_COST_CHILD_COUNTS) {
  const row = measureComponentBandRow(childCount);
  rows.push(row);
  const unbounded = row.unbounded
    ? ` unboundedCompile=${row.unbounded.compileMs.toFixed(1)}ms`
    : "";
  console.log(
    `component ${childCount}: nodes=${row.bandNodeCount} edges=${row.bandEdgeCount} omitted=${row.bandOmittedEdgeCount} `
    + `objects=${row.objectCount} paths=${row.pathCount} payload=${row.payloadBytes}B `
    + `compile=${row.compileMs.toFixed(1)}ms cpuFrame=${row.cpuFrame.firstFrameMs.toFixed(2)}ms `
    + `prefetch=${row.prefetch.compileMs.toFixed(1)}ms${unbounded}`,
  );
}

const container = measureBandCompile("container", 25, SCOPED_CONTAINER_COMPILE);
const code = measureBandCompile("code", 25, SCOPED_CODE_COMPILE);
console.log(
  `container 25: nodes=${container.bandNodeCount} compile=${container.compileMs.toFixed(1)}ms payload=${container.payloadBytes}B`,
);
console.log(
  `code 25: nodes=${code.bandNodeCount} compile=${code.compileMs.toFixed(1)}ms payload=${code.payloadBytes}B`,
);

const healthyChildCount = lastWhere(
  BAND_COST_CHILD_COUNTS,
  count => {
    const row = rows.find(item => item.childCount === count);
    return row
      && row.compileMs < COMPILE_HEALTHY_MS
      && row.payloadBytes < PAYLOAD_HEALTHY_BYTES
      && row.cpuFrame.firstFrameMs < FRAME_HEALTHY_MS
      && row.prefetch.compileMs < PREFETCH_HEALTHY_MS;
  },
) ?? BAND_COST_CHILD_COUNTS[0];

const fallOver = {
  compileScopedChildCount: firstWhere(BAND_COST_CHILD_COUNTS, count => {
    const row = rows.find(item => item.childCount === count);
    return Boolean(row && row.compileMs >= COMPILE_FALLOVER_MS);
  }),
  compileUnboundedChildCount: firstWhere(BAND_COST_CHILD_COUNTS, count => {
    const row = rows.find(item => item.childCount === count);
    return Boolean(row?.unbounded && row.unbounded.compileMs >= COMPILE_FALLOVER_MS);
  }),
  payloadBytesChildCount: firstWhere(BAND_COST_CHILD_COUNTS, count => {
    const row = rows.find(item => item.childCount === count);
    return Boolean(row && row.payloadBytes >= PAYLOAD_FALLOVER_BYTES);
  }),
  cpuFrameChildCount: firstWhere(BAND_COST_CHILD_COUNTS, count => {
    const row = rows.find(item => item.childCount === count);
    return Boolean(row && row.cpuFrame.firstFrameMs >= FRAME_FALLOVER_MS);
  }),
  prefetchChildCount: firstWhere(BAND_COST_CHILD_COUNTS, count => {
    const row = rows.find(item => item.childCount === count);
    return Boolean(row?.prefetch && row.prefetch.compileMs >= PREFETCH_FALLOVER_MS);
  }),
};

const artifact = {
  schemaVersion: 1,
  hangGuardEntities: BAND_COST_HANG_GUARD_ENTITIES,
  hangGuardUnchanged: true,
  healthyChildCount,
  thresholds: {
    compileHealthyMs: COMPILE_HEALTHY_MS,
    compileFallOverMs: COMPILE_FALLOVER_MS,
    payloadHealthyBytes: PAYLOAD_HEALTHY_BYTES,
    payloadFallOverBytes: PAYLOAD_FALLOVER_BYTES,
    cpuFrameHealthyMs: FRAME_HEALTHY_MS,
    cpuFrameFallOverMs: FRAME_FALLOVER_MS,
    prefetchHealthyMs: PREFETCH_HEALTHY_MS,
    prefetchFallOverMs: PREFETCH_FALLOVER_MS,
    prefetchCodeChildren: BAND_COST_PREFETCH_CODE_CHILDREN,
  },
  fallOver,
  rows: rows.map(row => ({
    ...structuralFields(row),
    ...(row.prefetch ? { prefetch: structuralFields(row.prefetch) } : {}),
    ...(row.unbounded ? { unbounded: structuralFields(row.unbounded) } : {}),
  })),
  observed: {
    host: "unspecified",
    note: "Wall-clock on one host. CI locks structure + generous ceilings, not these milliseconds.",
    rows: rows.map(row => ({
      childCount: row.childCount,
      compileMs: row.compileMs,
      payloadBytes: row.payloadBytes,
      cpuFirstFrameMs: row.cpuFrame.firstFrameMs,
      cpuPanMs: row.cpuFrame.panMs,
      cpuZoomMs: row.cpuFrame.zoomMs,
      prefetchCompileMs: row.prefetch?.compileMs,
      prefetchCpuFirstFrameMs: row.prefetch?.cpuFrame.firstFrameMs,
      unboundedCompileMs: row.unbounded?.compileMs,
    })),
    container25CompileMs: container.compileMs,
    code25CompileMs: code.compileMs,
  },
};

const scanPath = resolve("fixtures/scan/snapshot.json");
if (existsSync(scanPath)) {
  const snapshot = JSON.parse(readFileSync(scanPath, "utf8"));
  const rootId = softwareSystemId(snapshot);
  const containerId = firstChildOfKind(snapshot, rootId, "container");
  const componentId = containerId ? firstChildOfKind(snapshot, containerId, "component") : undefined;
  const l1 = measureSnapshotNeighborhood(snapshot, "container", rootId, rootId, SCOPED_CONTAINER_COMPILE, 0.75);
  artifact.selfScan = {
    entityCount: snapshot.entities.length,
    relationCount: snapshot.relations.length,
    hangGuardApplies: snapshot.entities.length > BAND_COST_HANG_GUARD_ENTITIES,
    l1: { focusEntityId: l1.focusEntityId, ...structuralFields(l1), compileMs: l1.compileMs, cpuFirstFrameMs: l1.cpuFrame.firstFrameMs },
  };
  if (containerId) {
    const l2 = measureSnapshotNeighborhood(snapshot, "component", rootId, containerId, SCOPED_COMPONENT_COMPILE, 5.27);
    artifact.selfScan.l2OpenInside = {
      focusEntityId: l2.focusEntityId,
      ...structuralFields(l2),
      compileMs: l2.compileMs,
      cpuFirstFrameMs: l2.cpuFrame.firstFrameMs,
    };
  }
  if (componentId) {
    const l3 = measureSnapshotNeighborhood(snapshot, "code", rootId, componentId, SCOPED_CODE_COMPILE, 13.96);
    artifact.selfScan.l3OpenInside = {
      focusEntityId: l3.focusEntityId,
      ...structuralFields(l3),
      compileMs: l3.compileMs,
      cpuFirstFrameMs: l3.cpuFrame.firstFrameMs,
    };
  }
  const quiet = {};
  for (const name of ["@okie/architecture", "@okie/scene-compiler"]) {
    const id = entityIdByName(snapshot, name);
    if (!id) continue;
    const sample = measureSnapshotNeighborhood(snapshot, "component", rootId, id, SCOPED_COMPONENT_COMPILE, 5.27);
    quiet[name] = {
      focusEntityId: sample.focusEntityId,
      ...structuralFields(sample),
      compileMs: sample.compileMs,
      cpuFirstFrameMs: sample.cpuFrame.firstFrameMs,
    };
    const codeId = firstChildOfKind(snapshot, id, "component");
    if (codeId) {
      const codeSample = measureSnapshotNeighborhood(snapshot, "code", rootId, codeId, SCOPED_CODE_COMPILE, 13.96);
      quiet[`${name} L4`] = {
        focusEntityId: codeSample.focusEntityId,
        ...structuralFields(codeSample),
        compileMs: codeSample.compileMs,
        cpuFirstFrameMs: codeSample.cpuFrame.firstFrameMs,
      };
    }
  }
  if (Object.keys(quiet).length) artifact.selfScan.quietPackages = quiet;
  console.log(`self-scan entities=${snapshot.entities.length} relations=${snapshot.relations.length}`);
  console.log(`  L1 compile=${l1.compileMs.toFixed(1)}ms nodes=${l1.bandNodeCount} payload=${l1.payloadBytes}B`);
  if (artifact.selfScan.l2OpenInside) {
    console.log(`  L2 Open inside compile=${artifact.selfScan.l2OpenInside.compileMs.toFixed(1)}ms nodes=${artifact.selfScan.l2OpenInside.bandNodeCount}`);
  }
  if (artifact.selfScan.l3OpenInside) {
    console.log(`  L3→L4 Open inside compile=${artifact.selfScan.l3OpenInside.compileMs.toFixed(1)}ms nodes=${artifact.selfScan.l3OpenInside.bandNodeCount}`);
  }
  if (artifact.selfScan.quietPackages) {
    for (const [name, sample] of Object.entries(artifact.selfScan.quietPackages)) {
      console.log(`  quiet ${name}: compile=${sample.compileMs.toFixed(1)}ms nodes=${sample.bandNodeCount} children=${sample.childCount}`);
    }
  }
} else {
  console.log("no fixtures/scan/snapshot.json — dense curve only (generate with okie-scan to add the self-scan row)");
}

const output = resolve("fixtures/architecture/band-cost-curve.json");
await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`wrote ${output}`);
console.log(`healthyChildCount=${healthyChildCount}`);
console.log(`fallOver=${JSON.stringify(fallOver)}`);
console.log(`hang-guard unchanged at ${BAND_COST_HANG_GUARD_ENTITIES}`);
