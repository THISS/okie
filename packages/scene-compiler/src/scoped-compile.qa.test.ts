import assert from "node:assert/strict";
import test from "node:test";
import {
  buildC4ProjectionBundle,
  selectC4BandProjection,
  type ArchitectureSnapshot,
  type C4Band,
} from "@okie/architecture";
import { compileC4Scene } from "./compile-c4.js";
import { denseSnapshot } from "./band-cost-curve.js";

// Opt-in scoped compile (task #26): band-depth + per-band edge budget bound the routing
// cost of large-repo scenes. Defaults are OFF and must stay byte-identical.
// CLA-67 extends this harness in band-cost-curve.ts / band-cost-curve.qa.test.ts.

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

test("maxGridNodes cap degrades gracefully (never throws) and stays deterministic; default byte-identical", () => {
  const snapshot = denseSnapshot(40);
  // A tiny grid budget must NOT throw — edges that can't route obstacle-safe fall back to a direct L.
  const compileTight = () => compileC4Scene(snapshot, buildC4ProjectionBundle(snapshot, { ...rootFocus, maxEdgesPerBand: 30, maxGridNodes: 64 }), { maxGridNodes: 64 }).scene;
  const first = compileTight();
  assert.ok(first.paths.length > 0, "compiles under a tight grid budget");
  assert.equal(JSON.stringify(first), JSON.stringify(compileTight()), "deterministic under a grid cap");
  // default (no maxGridNodes) equals the explicit 20000 default — opt-in never changes the default path.
  const dflt = compileC4Scene(snapshot, buildC4ProjectionBundle(snapshot, rootFocus)).scene;
  const explicit = compileC4Scene(snapshot, buildC4ProjectionBundle(snapshot, { ...rootFocus, maxGridNodes: 20_000 }), { maxGridNodes: 20_000 }).scene;
  assert.equal(JSON.stringify(dflt), JSON.stringify(explicit), "default == maxGridNodes 20000 (byte-identical)");
});
