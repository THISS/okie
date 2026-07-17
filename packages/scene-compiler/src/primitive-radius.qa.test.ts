import assert from "node:assert/strict";
import test from "node:test";
import {
  buildC4ProjectionBundle,
  type ArchitectureEntity,
  type ArchitectureSnapshot,
  type ArchitectureView,
} from "@okie/architecture";
import { compileScene } from "./compile-scene.js";
import { compileC4Scene } from "./compile-c4.js";
import { goldenSnapshot } from "./golden-fixture.js";
import type { SceneSnapshot } from "./protocol.js";

// Frozen protocol invariant (crates/atlas-protocol/src/scene.rs): a roundedRect is
// rejected by the renderer when radius > min(width, height) / 2. The compiler must
// never EMIT such a primitive — an invalid one loses the whole GPU surface and forces
// a silent Canvas2D fallback (found dogfooding the real scan of Okie).

interface RoundedRectSample {
  objectId: string;
  radius: number;
  width: number;
  height: number;
}

function roundedRects(scene: SceneSnapshot): RoundedRectSample[] {
  const samples: RoundedRectSample[] = [];
  for (const object of scene.objects) {
    for (const representation of object.representations) {
      for (const primitive of representation.primitives) {
        if (primitive.kind === "roundedRect") {
          samples.push({ objectId: object.id, radius: primitive.radius, width: primitive.rect.width, height: primitive.rect.height });
        }
      }
    }
  }
  return samples;
}

/** Asserts every roundedRect satisfies the protocol rule under f32 rounding (as the renderer sees it). */
function assertRadiiValid(scene: SceneSnapshot, label: string): RoundedRectSample[] {
  const samples = roundedRects(scene);
  assert.ok(samples.length > 0, `${label}: expected roundedRect primitives`);
  for (const sample of samples) {
    const halfExtent = Math.min(Math.fround(sample.width), Math.fround(sample.height)) / 2;
    assert.ok(
      Number.isFinite(sample.radius) && sample.radius >= 0 && Math.fround(sample.radius) <= halfExtent,
      `${label}: ${sample.objectId} radius ${sample.radius} violates <= min(${sample.width}, ${sample.height})/2`,
    );
  }
  return samples;
}

test("compileScene clamps roundedRect radius on entities smaller than the style radius", () => {
  const snapshot: ArchitectureSnapshot = {
    schemaVersion: 1,
    id: "snapshot:radius",
    repositoryId: "repo:radius",
    commitSha: "abc123",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entities: [
      { id: "system:r", kind: "softwareSystem", name: "Root", sourceRefs: [] },
      { id: "code:tiny", kind: "code", parentId: "system:r", name: "Tiny", sourceRefs: [] },
    ],
    relations: [],
  };
  const view: ArchitectureView = {
    schemaVersion: 1,
    id: "view:r",
    snapshotId: snapshot.id,
    name: "Root",
    rootEntityId: "system:r",
    entityIds: ["system:r", "code:tiny"],
    relationIds: [],
    layout: {
      nodes: {
        "system:r": { x: 0, y: 0, width: 200, height: 120 },
        // 5x3 world units — far smaller than the code style radius (6).
        "code:tiny": { x: 10, y: 10, width: 5, height: 3 },
      },
    },
  };
  const scene = compileScene(snapshot, view);
  assertRadiiValid(scene, "compileScene tiny");
  // The tiny cell must be clamped exactly to min(5,3)/2 = 1.5, not the unclamped 6.
  const tiny = roundedRects(scene).filter(sample => sample.objectId === "code:tiny");
  assert.ok(tiny.length > 0);
  for (const sample of tiny) assert.equal(sample.radius, 1.5);
});

/**
 * Reproduces the real scan's shape: one container mixing big code-bearing
 * components with many EMPTY components (files whose only export is
 * `export default …`, so they carry no top-level named declaration). The empty
 * cells squeeze well below the component style radius — exactly the geometry that
 * broke GPU validation on the live scan of Okie (e.g. vite.config.ts).
 */
function squeezedSnapshot(): ArchitectureSnapshot {
  const entities: ArchitectureEntity[] = [
    { id: "system:squeeze", kind: "softwareSystem", name: "Squeeze", sourceRefs: [] },
    { id: "container:squeeze", kind: "container", parentId: "system:squeeze", name: "Container", sourceRefs: [] },
  ];
  for (let index = 0; index < 40; index += 1) {
    const key = index.toString().padStart(3, "0");
    entities.push({ id: `component:coded-${key}`, kind: "component", parentId: "container:squeeze", name: `Coded ${key}`, sourceRefs: [] });
    for (let symbol = 0; symbol < 12; symbol += 1) {
      const leaf = symbol.toString().padStart(2, "0");
      entities.push({ id: `code:coded-${key}-${leaf}`, kind: "code", parentId: `component:coded-${key}`, name: `sym${key}${leaf}`, sourceRefs: [] });
    }
  }
  for (let index = 0; index < 40; index += 1) {
    const key = index.toString().padStart(3, "0");
    entities.push({ id: `component:empty-${key}`, kind: "component", parentId: "container:squeeze", name: `Empty ${key}`, sourceRefs: [] });
  }
  return {
    schemaVersion: 1,
    id: "snapshot:squeeze",
    repositoryId: "repo:squeeze",
    commitSha: "abc123",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entities,
    relations: [],
  };
}

// component style radius = 14 * (geometryScale / focusZoom); an unclamped emission
// would exceed min(w,h)/2 for any cell whose half-extent falls below this.
const COMPONENT_STYLE_RADIUS = 14 * (1.10 / 5.27);

test("compileC4Scene emits no protocol-invalid radius (golden + squeezed-hierarchy sweep)", () => {
  const goldenBundle = buildC4ProjectionBundle(goldenSnapshot, {
    rootEntityId: "system:okie",
    focusEntityId: "system:okie",
    familyId: "view-family:okie-golden:system-root",
  });
  assertRadiiValid(compileC4Scene(goldenSnapshot, goldenBundle).scene, "compileC4 golden");

  const squeezed = squeezedSnapshot();
  const squeezedBundle = buildC4ProjectionBundle(squeezed, {
    rootEntityId: "system:squeeze",
    focusEntityId: "system:squeeze",
    familyId: "view-family:squeeze:system-root",
  });
  const samples = assertRadiiValid(compileC4Scene(squeezed, squeezedBundle).scene, "compileC4 squeezed");
  // Non-vacuous guard: the squeeze must actually produce cells small enough that the
  // unclamped style radius WOULD violate the protocol — so this fails if the clamp is removed.
  assert.ok(
    samples.some(sample => Math.min(sample.width, sample.height) / 2 < COMPONENT_STYLE_RADIUS),
    "squeezed hierarchy must force sub-style-radius cells (else the clamp is untested)",
  );
});
