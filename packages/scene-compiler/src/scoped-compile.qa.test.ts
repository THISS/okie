import assert from "node:assert/strict";
import test from "node:test";
import {
  buildC4ProjectionBundle,
  selectC4BandProjection,
  type ArchitectureEntity,
  type ArchitectureRelation,
  type ArchitectureSnapshot,
  type C4Band,
} from "@okie/architecture";
import { compileC4Scene } from "./compile-c4.js";

// Opt-in scoped compile (task #26): band-depth + per-band edge budget bound the routing
// cost of large-repo scenes. Defaults are OFF and must stay byte-identical.

/** A dense single-container snapshot: `chainCount` chain edges (count 1) + one hub pair (count 5). */
function denseSnapshot(componentCount: number): ArchitectureSnapshot {
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
  const evidence = [{ source: { path: "x.ts", commitSha: "c" } }];
  for (let index = 0; index < componentCount; index += 1) {
    relations.push({ id: `relation:e${index.toString().padStart(3, "0")}`, from: cid(index), to: cid((index + 1) % componentCount), kind: "dependsOn", evidence });
  }
  // A hub pair (m000 -> m002) with 5 relations -> aggregate count 5, the highest-weight edge.
  for (let copy = 0; copy < 5; copy += 1) {
    relations.push({ id: `relation:hub${copy}`, from: cid(0), to: cid(2), kind: "dependsOn", evidence });
  }
  return { schemaVersion: 1, id: "snapshot:d", repositoryId: "repo:d", commitSha: "c", generatedAt: "2026-01-01T00:00:00.000Z", entities, relations };
}

const rootFocus = { rootEntityId: "system:d", focusEntityId: "system:d", familyId: "f" } as const;
function bandEdges(bundle: ReturnType<typeof buildC4ProjectionBundle>, band: C4Band): { routed: string[]; omitted: string[] } {
  const projection = bundle.projectionById[bundle.family.projectionIds[band]]!;
  return { routed: projection.visualEdgeIds, omitted: projection.omittedEdgeIds ?? [] };
}

test("maxBand leaves deeper bands empty (container-only top scene)", () => {
  const snapshot = denseSnapshot(40);
  const bundle = buildC4ProjectionBundle(snapshot, { ...rootFocus, maxBand: "container" });
  assert.ok(selectC4BandProjection(bundle, "container").nodes.length > 0, "container band populated");
  assert.equal(selectC4BandProjection(bundle, "component").nodes.length, 0, "component band empty");
  assert.equal(selectC4BandProjection(bundle, "code").nodes.length, 0, "code band empty");
  // the compiled scene renders no component/code objects — only container-level.
  const scene = compileC4Scene(snapshot, bundle).scene;
  assert.ok(scene.objects.length > 0 && scene.objects.length < 12, "bounded top scene");
});

test("maxEdgesPerBand routes only the top-N edges by (count desc, id asc); the rest are omitted but retained", () => {
  const snapshot = denseSnapshot(40);
  const budget = 10;
  const bundle = buildC4ProjectionBundle(snapshot, { ...rootFocus, maxEdgesPerBand: budget });
  const { routed, omitted } = bandEdges(bundle, "component");
  assert.equal(routed.length, budget, "routes exactly the budget");
  assert.equal(routed.length + omitted.length, 41, "kept + omitted = all visual edges (40 chain + 1 hub)");
  // the hub (aggregate count 5) is the highest weight -> always kept.
  assert.ok(routed.some(id => bundle.visualEdgeById[id]!.aggregate.count === 5), "hub edge kept");
  assert.ok(omitted.every(id => bundle.visualEdgeById[id]!.aggregate.count === 1), "only count-1 edges omitted");
  // omitted edges stay enumerable via the index (their relation ids survive).
  for (const id of omitted) assert.ok((bundle.index.relationIdsByVisualEdgeId[id]?.length ?? 0) >= 1);
  // routing is bounded: the compiled scene has exactly `budget` paths.
  assert.equal(compileC4Scene(snapshot, bundle).scene.paths.length, budget);
});

test("edge budget selection is deterministic under shuffled relation order", () => {
  const snapshot = denseSnapshot(40);
  const shuffled: ArchitectureSnapshot = { ...snapshot, relations: [...snapshot.relations].reverse() };
  const a = bandEdges(buildC4ProjectionBundle(snapshot, { ...rootFocus, maxEdgesPerBand: 12 }), "component");
  const b = bandEdges(buildC4ProjectionBundle(shuffled, { ...rootFocus, maxEdgesPerBand: 12 }), "component");
  assert.deepEqual(a.routed, b.routed);
  assert.deepEqual(a.omitted, b.omitted);
});

test("default path is byte-identical and carries no omittedEdgeIds", () => {
  const snapshot = denseSnapshot(20);
  const first = buildC4ProjectionBundle(snapshot, rootFocus);
  const second = buildC4ProjectionBundle(snapshot, rootFocus);
  assert.equal(JSON.stringify(first), JSON.stringify(second), "default build is deterministic");
  for (const band of ["context", "container", "component", "code"] as const) {
    assert.equal(first.projectionById[first.family.projectionIds[band]]!.omittedEdgeIds, undefined, `${band} has no omittedEdgeIds by default`);
  }
  // a budget large enough to keep everything must equal the default bytes exactly.
  const unbounded = buildC4ProjectionBundle(snapshot, { ...rootFocus, maxEdgesPerBand: 100000 });
  assert.equal(JSON.stringify(unbounded), JSON.stringify(first), "over-budget == default (opt-in never changes small graphs)");
});
