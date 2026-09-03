import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { buildC4ProjectionBundle } from "@okie/architecture";
import {
  BAND_COST_CHILD_COUNTS,
  BAND_COST_HANG_GUARD_ENTITIES,
  BAND_COST_PREFETCH_CODE_CHILDREN,
  BAND_COST_UNBOUNDED_CHILD_COUNTS,
  SCOPED_CODE_COMPILE,
  SCOPED_COMPONENT_COMPILE,
  SCOPED_CONTAINER_COMPILE,
  compileNeighborhood,
  denseNeighborhoodSnapshot,
  denseSnapshot,
  firstChildOfKind,
  measureBandCompile,
  measureSnapshotNeighborhood,
  softwareSystemId,
  structuralBandCost,
  structuralFields,
  type BandCompileOptions,
  type BandCostStructure,
} from "./band-cost-curve.js";
import { compileC4Scene } from "./compile-c4.js";

type GoldenRow = BandCostStructure & {
  prefetch?: BandCostStructure;
  unbounded?: BandCostStructure;
};

type GoldenCurve = {
  schemaVersion: 1;
  hangGuardEntities: number;
  hangGuardUnchanged: true;
  healthyChildCount: number;
  fallOver: {
    compileScopedChildCount: number | null;
    compileUnboundedChildCount: number | null;
    payloadBytesChildCount: number | null;
    cpuFrameChildCount: number | null;
    prefetchChildCount: number | null;
  };
  rows: GoldenRow[];
};

const golden = JSON.parse(
  readFileSync(new URL("../../../fixtures/architecture/band-cost-curve.json", import.meta.url), "utf8"),
) as GoldenCurve;

function measureStructure(
  band: "component" | "code" | "container",
  childCount: number,
  options: BandCompileOptions,
): BandCostStructure {
  const snapshot = denseNeighborhoodSnapshot(band, childCount);
  const compiled = compileNeighborhood(snapshot, band, options);
  return structuralFields(structuralBandCost(snapshot, band, compiled, options));
}

function scopedRow(row: GoldenRow): BandCostStructure {
  const { prefetch: _prefetch, unbounded: _unbounded, ...rest } = row;
  return rest;
}

test("CLA-67: hang-guard stays 2000 until a measured cap is wired from the table", () => {
  assert.equal(BAND_COST_HANG_GUARD_ENTITIES, 2000);
  assert.equal(golden.hangGuardEntities, 2000);
  assert.equal(golden.hangGuardUnchanged, true);
});

test("CLA-67: default compile of the shared dense snapshot stays byte-identical", () => {
  const snapshot = denseSnapshot(20);
  const focus = { rootEntityId: "system:d", focusEntityId: "system:d", familyId: "f" } as const;
  const first = compileC4Scene(snapshot, buildC4ProjectionBundle(snapshot, focus)).scene;
  const second = compileC4Scene(snapshot, buildC4ProjectionBundle(snapshot, focus)).scene;
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("CLA-67: structural per-band cost curve matches the committed table", () => {
  assert.deepEqual([...BAND_COST_CHILD_COUNTS], golden.rows.map(row => row.childCount));
  for (const expected of golden.rows) {
    assert.deepEqual(
      measureStructure("component", expected.childCount, SCOPED_COMPONENT_COMPILE),
      scopedRow(expected),
      `scoped structure at ${expected.childCount}`,
    );
    if (expected.prefetch) {
      assert.deepEqual(
        measureStructure("code", BAND_COST_PREFETCH_CODE_CHILDREN, SCOPED_CODE_COMPILE),
        expected.prefetch,
        `prefetch structure at ${expected.childCount}`,
      );
    }
    if (expected.unbounded) {
      assert.deepEqual(
        measureStructure("component", expected.childCount, { maxBand: "component" }),
        expected.unbounded,
        `unbounded structure at ${expected.childCount}`,
      );
    }
  }
});

test("CLA-67: named healthy count stays interactive; unbounded fall-over is slower", () => {
  const healthy = measureBandCompile("component", golden.healthyChildCount, SCOPED_COMPONENT_COMPILE);
  assert.ok(healthy.compileMs < 2_000, `healthy scoped compile ${healthy.compileMs}ms must stay under 2s`);
  assert.ok(healthy.payloadBytes < 1_500_000, `healthy payload ${healthy.payloadBytes} must stay under 1.5MB`);
  const prefetch = measureBandCompile("code", BAND_COST_PREFETCH_CODE_CHILDREN, SCOPED_CODE_COMPILE);
  assert.ok(prefetch.compileMs < 2_000, `one-down prefetch ${prefetch.compileMs}ms must stay under 2s`);

  if (golden.fallOver.compileUnboundedChildCount !== null) {
    const unbounded = measureBandCompile(
      "component",
      golden.fallOver.compileUnboundedChildCount,
      { maxBand: "component" },
    );
    assert.ok(
      unbounded.compileMs > healthy.compileMs,
      "unbounded fall-over compile is slower than the healthy scoped neighborhood",
    );
  }
});

test("CLA-67: container and code neighborhoods compile at a 25-child handful", () => {
  const container = measureBandCompile("container", 25, SCOPED_CONTAINER_COMPILE);
  const code = measureBandCompile("code", 25, SCOPED_CODE_COMPILE);
  assert.equal(container.childCount, 25);
  assert.equal(code.childCount, 25);
  assert.ok(container.bandNodeCount >= 25);
  assert.ok(code.bandNodeCount >= 25);
  assert.ok(container.compileMs < 2_000, `container band ${container.compileMs}ms`);
  assert.ok(code.compileMs < 2_000, `code band ${code.compileMs}ms`);
});

test("CLA-67: unbounded child counts are a prefix of the curve (no invented extra cap)", () => {
  assert.deepEqual(
    [...BAND_COST_UNBOUNDED_CHILD_COUNTS],
    BAND_COST_CHILD_COUNTS.filter(count => count <= Math.max(...BAND_COST_UNBOUNDED_CHILD_COUNTS)),
  );
});

test("CLA-67: self-scan L1 is a handful when fixtures/scan is present", () => {
  const scanPath = new URL("../../../fixtures/scan/snapshot.json", import.meta.url);
  if (!existsSync(scanPath)) {
    return;
  }
  const snapshot = JSON.parse(readFileSync(scanPath, "utf8")) as Parameters<typeof softwareSystemId>[0];
  const rootId = softwareSystemId(snapshot);
  const l1 = measureSnapshotNeighborhood(snapshot, "container", rootId, rootId, SCOPED_CONTAINER_COMPILE, 0.75);
  assert.ok(l1.bandNodeCount < 50, `L1 band nodes ${l1.bandNodeCount} must stay a handful, not the L4 dump`);
  assert.ok(l1.compileMs < 2_000, `L1 compile ${l1.compileMs}ms`);
  const architecture = snapshot.entities.find(entity => entity.name === "@okie/architecture");
  if (architecture) {
    const l2 = measureSnapshotNeighborhood(
      snapshot,
      "component",
      rootId,
      architecture.id,
      SCOPED_COMPONENT_COMPILE,
      5.27,
    );
    assert.ok(l2.bandNodeCount < 80, `architecture L3 nodes ${l2.bandNodeCount}`);
    const file = firstChildOfKind(snapshot, architecture.id, "component");
    if (file) {
      const l4 = measureSnapshotNeighborhood(snapshot, "code", rootId, file, SCOPED_CODE_COMPILE, 13.96);
      assert.ok(l4.bandNodeCount < 200, `architecture L4 nodes ${l4.bandNodeCount}`);
      assert.ok(l4.compileMs < 5_000, `architecture L4 compile ${l4.compileMs}ms`);
    }
  }
});
