import assert from "node:assert/strict";
import test from "node:test";
import type {
  ArchitectureEntity,
  ArchitectureRelation,
  ArchitectureSnapshot,
  EntityKind,
  Evidence,
  RelationKind,
} from "./model.js";
import {
  explorePath,
  PATH_EXPLORATION_CLAIM,
  PATH_EXPLORATION_DEFAULT_MAX_HOPS,
  PATH_EXPLORATION_DISCLAIMER,
  PATH_EXPLORATION_VERSION,
  type PathExplorationQuery,
  type PathExplorationResult,
} from "./path-exploration.js";

const SHA = "sha";

function entity(id: string, kind: EntityKind = "component", parentId?: string): ArchitectureEntity {
  return {
    id,
    name: id,
    kind,
    sourceRefs: [{ path: `src/${id}.ts`, commitSha: SHA }],
    ...(parentId ? { parentId } : {}),
  };
}

function evidence(path: string, startLine: number | null = 1, commitSha = SHA): Evidence {
  return {
    source: { path, commitSha, ...(startLine !== null ? { startLine, endLine: startLine + 1 } : {}) },
    reason: "observed",
  };
}

function relation(
  id: string,
  from: string,
  to: string,
  kind: RelationKind = "uses",
  extra: Partial<ArchitectureRelation> = {},
): ArchitectureRelation {
  return { id, from, to, kind, evidence: [evidence(`src/${from}.ts`)], confidence: 1, ...extra };
}

function unscored(item: ArchitectureRelation): ArchitectureRelation {
  const { confidence: _confidence, ...rest } = item;
  return rest;
}

function snapshot(entities: ArchitectureEntity[], relations: ArchitectureRelation[]): ArchitectureSnapshot {
  return {
    schemaVersion: 1,
    id: "snap:test",
    repositoryId: "repo",
    commitSha: SHA,
    generatedAt: "2026-01-01T00:00:00.000Z",
    entities,
    relations,
  };
}

function query(from: string, to: string, extra: Partial<PathExplorationQuery> = {}): PathExplorationQuery {
  return { fromEntityId: from, toEntityId: to, relationKinds: ["uses"], graphCoverage: "complete", ...extra };
}

function expectFound(result: PathExplorationResult) {
  assert.equal(result.status, "found", JSON.stringify(result));
  if (result.status !== "found") throw new Error("unreachable");
  return result;
}

function expectUnavailable(result: PathExplorationResult, reason: string) {
  assert.equal(result.status, "unavailable", JSON.stringify(result));
  if (result.status !== "unavailable") throw new Error("unreachable");
  assert.equal(result.reason, reason);
  assert.ok(result.message.length > 0);
  return result;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}

test("CLA-207: linear chain returns every hop with its relation and evidence", () => {
  const snap = snapshot(
    [entity("a"), entity("b"), entity("c"), entity("d")],
    [relation("r:ab", "a", "b", "uses", { label: "a→b" }), relation("r:bc", "b", "c"), relation("r:cd", "c", "d")],
  );
  const result = expectFound(explorePath(snap, query("a", "d")));
  assert.equal(result.version, PATH_EXPLORATION_VERSION);
  assert.equal(result.claim, PATH_EXPLORATION_CLAIM);
  assert.equal(result.snapshotId, "snap:test");
  assert.equal(result.commitSha, SHA);
  assert.deepEqual(result.entityIds, ["a", "b", "c", "d"]);
  assert.deepEqual(result.relationIds, ["r:ab", "r:bc", "r:cd"]);
  assert.deepEqual(result.limits, []);
  assert.deepEqual(result.hops[0], {
    index: 0,
    fromEntityId: "a",
    toEntityId: "b",
    kind: "uses",
    via: "relation",
    relationId: "r:ab",
    parallelRelationIds: [],
    label: "a→b",
    evidence: [evidence("src/a.ts")],
    confidence: 1,
    limits: [],
  });
  assert.deepEqual(result.hops.map(hop => hop.index), [0, 1, 2]);
  assert.deepEqual(result.query, {
    fromEntityId: "a",
    toEntityId: "d",
    relationKinds: ["uses"],
    includeParentContainment: false,
    graphCoverage: "complete",
    maxHops: PATH_EXPLORATION_DEFAULT_MAX_HOPS,
    endpointScope: "exact",
  });
  assert.deepEqual(result.absentRelationKinds, []);
  assert.equal(explorePath(snap, query("d", "a")).status, "unreachable");
});

test("CLA-207: a relation crossing two container parents is followed without containment", () => {
  const snap = snapshot(
    [
      entity("sys", "softwareSystem"),
      entity("web", "container", "sys"),
      entity("api", "container", "sys"),
      entity("web:ui", "component", "web"),
      entity("api:handler", "component", "api"),
      entity("api:store", "component", "api"),
    ],
    [relation("r:ui-handler", "web:ui", "api:handler", "calls"), relation("r:handler-store", "api:handler", "api:store", "calls")],
  );
  const result = expectFound(explorePath(snap, query("web:ui", "api:store", { relationKinds: ["calls"] })));
  assert.deepEqual(result.entityIds, ["web:ui", "api:handler", "api:store"]);
  assert.ok(result.hops.every(hop => hop.via === "relation"));
});

test("CLA-207: relation kinds stay distinct and are never merged", () => {
  const snap = snapshot(
    [entity("a"), entity("b"), entity("c")],
    [relation("r:uses", "a", "b", "uses"), relation("r:calls", "b", "c", "calls"), relation("r:contains", "a", "c", "contains")],
  );
  assert.equal(explorePath(snap, query("a", "b", { relationKinds: ["calls"] })).status, "unreachable");
  assert.equal(explorePath(snap, query("b", "c", { relationKinds: ["uses"] })).status, "unreachable");
  assert.equal(explorePath(snap, query("a", "c", { relationKinds: ["uses"] })).status, "unreachable");
  assert.equal(explorePath(snap, query("a", "c", { relationKinds: ["uses", "calls"] })).status, "found");
  assert.deepEqual(expectFound(explorePath(snap, query("a", "b", { relationKinds: ["uses"] }))).relationIds, ["r:uses"]);
  assert.deepEqual(expectFound(explorePath(snap, query("b", "c", { relationKinds: ["calls"] }))).relationIds, ["r:calls"]);
  const contains = expectFound(explorePath(snap, query("a", "c", { relationKinds: ["contains"] })));
  assert.deepEqual(contains.relationIds, ["r:contains"]);
  assert.equal(contains.hops[0]!.via, "relation");
  assert.equal(explorePath(snap, query("a", "c", { relationKinds: ["uses", "calls", "reads"] })).status, "found");
  assert.equal(expectFound(explorePath(snap, query("a", "c", { relationKinds: ["uses", "calls", "contains"] }))).hops.length, 1);
});

test("CLA-207: parent containment edges are opt-in, structural and evidence-free", () => {
  const snap = snapshot(
    [entity("sys", "softwareSystem"), entity("api", "container", "sys"), entity("api:h", "component", "api"), entity("other")],
    [relation("r:h-other", "api:h", "other")],
  );
  assert.equal(explorePath(snap, query("sys", "other")).status, "unreachable");
  const result = expectFound(explorePath(snap, query("sys", "other", { includeParentContainment: true })));
  assert.deepEqual(result.entityIds, ["sys", "api", "api:h", "other"]);
  assert.deepEqual(result.relationIds, ["r:h-other"]);
  assert.deepEqual(result.hops[0], {
    index: 0,
    fromEntityId: "sys",
    toEntityId: "api",
    kind: "contains",
    via: "parentContainment",
    parallelRelationIds: [],
    evidence: [],
    limits: ["noEvidence", "structuralContainment"],
  });
  assert.deepEqual(result.limits, ["hopsWithoutEvidence"]);
  assert.equal(explorePath(snap, query("api:h", "sys", { includeParentContainment: true })).status, "unreachable");
  const containmentOnly = expectFound(explorePath(snap, query("sys", "api:h", { relationKinds: [], includeParentContainment: true })));
  assert.deepEqual(containmentOnly.relationIds, []);
});

test("CLA-207: parallel edges choose the smallest relation id and list the rest", () => {
  const snap = snapshot(
    [entity("p", "container"), entity("a", "component", "p"), entity("b")],
    [
      relation("r:3", "a", "b", "uses"),
      relation("r:1", "a", "b", "calls"),
      relation("r:2", "a", "b", "uses"),
      relation("r:0", "a", "b", "reads"),
      relation("r:pa", "p", "a", "contains"),
    ],
  );
  const hop = expectFound(explorePath(snap, query("a", "b", { relationKinds: ["uses", "calls"] }))).hops[0]!;
  assert.equal(hop.relationId, "r:1");
  assert.equal(hop.kind, "calls");
  assert.deepEqual(hop.parallelRelationIds, ["r:2", "r:3"]);
  const containment = expectFound(explorePath(snap, query("p", "a", {
    relationKinds: ["contains"],
    includeParentContainment: true,
  }))).hops[0]!;
  assert.equal(containment.via, "relation");
  assert.equal(containment.relationId, "r:pa");
  assert.deepEqual(containment.parallelRelationIds, []);
  assert.deepEqual(containment.evidence.length, 1);
});

test("CLA-207: equal-length alternatives pick the lexicographically smallest entity sequence", () => {
  const snap = snapshot(
    [entity("s"), entity("m1"), entity("m2"), entity("x"), entity("y"), entity("t")],
    [
      relation("r:s-m2", "s", "m2"),
      relation("r:s-m1", "s", "m1"),
      relation("r:m2-x", "m2", "x"),
      relation("r:m1-y", "m1", "y"),
      relation("r:x-t", "x", "t"),
      relation("r:y-t", "y", "t"),
      relation("r:long", "s", "t", "calls"),
    ],
  );
  assert.deepEqual(expectFound(explorePath(snap, query("s", "t"))).entityIds, ["s", "m1", "y", "t"]);
  assert.deepEqual(expectFound(explorePath(snap, query("s", "t", { relationKinds: ["uses", "calls"] }))).entityIds, ["s", "t"]);
  const codeUnit = snapshot(
    [entity("s"), entity("B"), entity("a"), entity("t")],
    [relation("r:1", "s", "a"), relation("r:2", "s", "B"), relation("r:3", "a", "t"), relation("r:4", "B", "t")],
  );
  assert.deepEqual(expectFound(explorePath(codeUnit, query("s", "t"))).entityIds, ["s", "B", "t"]);
});

test("CLA-207: cycles terminate", () => {
  const snap = snapshot(
    [entity("a"), entity("b"), entity("c"), entity("z")],
    [relation("r:ab", "a", "b"), relation("r:bc", "b", "c"), relation("r:ca", "c", "a"), relation("r:aa", "a", "a")],
  );
  assert.deepEqual(expectFound(explorePath(snap, query("b", "a"))).entityIds, ["b", "c", "a"]);
  const result = explorePath(snap, query("a", "z"));
  assert.equal(result.status, "unreachable");
  if (result.status === "unreachable") assert.equal(result.exploredEntityCount, 3);
});

test("CLA-207: self-selection is found with zero hops", () => {
  const snap = snapshot([entity("a"), entity("b")], [relation("r:aa", "a", "a"), relation("r:ab", "a", "b")]);
  const result = expectFound(explorePath(snap, query("a", "a")));
  assert.deepEqual(result.entityIds, ["a"]);
  assert.deepEqual(result.relationIds, []);
  assert.deepEqual(result.hops, []);
  assert.deepEqual(result.limits, []);
});

test("CLA-207: disconnected endpoints are unreachable on a complete graph", () => {
  const snap = snapshot([entity("a"), entity("b"), entity("c"), entity("d")], [relation("r:ab", "a", "b"), relation("r:cd", "c", "d")]);
  const result = explorePath(snap, query("a", "d"));
  assert.equal(result.status, "unreachable");
  if (result.status === "unreachable") assert.equal(result.exploredEntityCount, 2);
});

test("CLA-207: unknown and stale endpoints are unavailable, from checked before to", () => {
  const snap = snapshot([entity("a"), entity("b")], [relation("r:ab", "a", "b")]);
  expectUnavailable(explorePath(snap, query("ghost", "b")), "unknownFromEntity");
  expectUnavailable(explorePath(snap, query("a", "ghost")), "unknownToEntity");
  expectUnavailable(explorePath(snap, query("ghost", "phantom")), "unknownFromEntity");
  const renamed = snapshot([entity("a2"), entity("b")], [relation("r:ab", "a2", "b")]);
  const stale = expectUnavailable(explorePath(renamed, query("a", "b")), "unknownFromEntity");
  assert.equal(stale.snapshotId, "snap:test");
  expectUnavailable(explorePath(snap, query("ghost", "ghost")), "unknownFromEntity");
});

test("CLA-207: no eligible kinds and invalid queries are unavailable", () => {
  const snap = snapshot([entity("a"), entity("b")], [relation("r:ab", "a", "b")]);
  expectUnavailable(explorePath(snap, query("a", "b", { relationKinds: [] })), "noEligibleKinds");
  expectUnavailable(explorePath(snap, query("a", "b", { relationKinds: [], includeParentContainment: false })), "noEligibleKinds");
  for (const maxHops of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expectUnavailable(explorePath(snap, query("a", "b", { maxHops })), "invalidQuery");
  }
  expectUnavailable(explorePath(snap, query("a", "b", { relationKinds: ["uses", "invokes" as RelationKind] })), "invalidQuery");
  expectUnavailable(explorePath(snap, query("a", "b", { graphCoverage: "some" as "complete" })), "invalidQuery");
  expectUnavailable(explorePath(snap, { ...query("a", "b"), graphCoverage: undefined as unknown as "complete" }), "invalidQuery");
  expectUnavailable(explorePath(snap, query("a", "b", { relationKinds: [undefined as unknown as RelationKind] })), "invalidQuery");
  expectUnavailable(explorePath(snap, query("a", "b", { relationKinds: ["uses", null as unknown as RelationKind] })), "invalidQuery");
  expectUnavailable(explorePath(snap, query("a", "b", { endpointScope: "tree" as "exact" })), "invalidQuery");
});

test("CLA-207: self-selection is found before kind checks and never carries partialGraph", () => {
  const snap = snapshot([entity("a"), entity("b")], [relation("r:ab", "a", "b")]);
  const empty = expectFound(explorePath(snap, query("a", "a", { relationKinds: [] })));
  assert.deepEqual(empty.entityIds, ["a"]);
  const partial = expectFound(explorePath(snap, query("a", "a", { graphCoverage: "partial" })));
  assert.deepEqual(partial.limits, []);
  assert.deepEqual(expectFound(explorePath(snap, query("a", "a", { endpointScope: "subtree" }))).hops, []);
});

test("CLA-207: query is normalized with deduped, code-unit sorted kinds", () => {
  const snap = snapshot([entity("a"), entity("b")], [relation("r:ab", "a", "b")]);
  const result = explorePath(snap, query("a", "b", { relationKinds: ["uses", "calls", "uses", "dependsOn"], maxHops: 3 }));
  assert.deepEqual(result.query.relationKinds, ["calls", "dependsOn", "uses"]);
  assert.equal(result.query.maxHops, 3);
  assert.equal(result.query.includeParentContainment, false);
});

test("CLA-207: partial coverage never claims unreachable", () => {
  const snap = snapshot([entity("a"), entity("b"), entity("c")], [relation("r:ab", "a", "b")]);
  const found = expectFound(explorePath(snap, query("a", "b", { graphCoverage: "partial" })));
  assert.deepEqual(found.limits, ["partialGraph"]);
  expectUnavailable(explorePath(snap, query("a", "c", { graphCoverage: "partial" })), "partialGraph");
  assert.equal(explorePath(snap, query("a", "c")).status, "unreachable");
});

test("CLA-207: hopLimit only when a longer path really exists", () => {
  const snap = snapshot(
    [entity("a"), entity("b"), entity("c"), entity("d"), entity("x")],
    [relation("r:ab", "a", "b"), relation("r:bc", "b", "c"), relation("r:cd", "c", "d")],
  );
  assert.deepEqual(expectFound(explorePath(snap, query("a", "d", { maxHops: 3 }))).entityIds, ["a", "b", "c", "d"]);
  const capped = expectUnavailable(explorePath(snap, query("a", "d", { maxHops: 2 })), "hopLimit");
  assert.equal(capped.message, "A path exists but is longer than 2 hops.");
  assert.ok(!("entityIds" in capped));
  expectUnavailable(explorePath(snap, query("a", "d", { maxHops: 1, graphCoverage: "partial" })), "hopLimit");
  const exhausted = explorePath(snap, query("a", "x", { maxHops: 1 }));
  assert.equal(exhausted.status, "unreachable");
  if (exhausted.status === "unreachable") assert.equal(exhausted.exploredEntityCount, 4);
  expectUnavailable(explorePath(snap, query("a", "x", { maxHops: 1, graphCoverage: "partial" })), "partialGraph");
  const branch = snapshot(
    [entity("s"), entity("x"), entity("y"), entity("t")],
    [relation("r:sx", "s", "x"), relation("r:xy", "x", "y")],
  );
  assert.equal(explorePath(branch, query("s", "t", { maxHops: 1 })).status, "unreachable");
});

test("CLA-207: dangling relations are ignored and counted", () => {
  const snap = snapshot(
    [entity("a"), entity("b")],
    [
      relation("r:ab", "a", "b"),
      relation("r:a-ghost", "a", "ghost"),
      relation("r:ghost-b", "ghost", "b"),
      relation("r:ghost-calls", "a", "ghost", "calls"),
    ],
  );
  const result = expectFound(explorePath(snap, query("a", "b")));
  assert.equal(result.ignoredDanglingRelationCount, 2);
  assert.deepEqual(result.relationIds, ["r:ab"]);
  assert.equal(explorePath(snap, query("a", "b", { relationKinds: ["uses", "calls"] })).ignoredDanglingRelationCount, 3);
  assert.equal(explorePath(snap, query("a", "a")).ignoredDanglingRelationCount, 2);
  assert.equal(expectUnavailable(explorePath(snap, query("a", "nope")), "unknownToEntity").ignoredDanglingRelationCount, 2);
  assert.equal(expectUnavailable(explorePath(snap, query("a", "b", { relationKinds: [] })), "noEligibleKinds").ignoredDanglingRelationCount, 0);
});

test("CLA-207: an observed uses relation wins over containment on the same pair", () => {
  const snap = snapshot(
    [entity("api", "container"), entity("api:h", "component", "api")],
    [relation("r:api-h", "api", "api:h", "uses")],
  );
  const hop = expectFound(explorePath(snap, query("api", "api:h", { includeParentContainment: true }))).hops[0]!;
  assert.equal(hop.via, "relation");
  assert.equal(hop.kind, "uses");
  assert.equal(hop.relationId, "r:api-h");
  assert.deepEqual(hop.limits, []);
  const structural = expectFound(explorePath(snap, query("api", "api:h", { relationKinds: ["calls"], includeParentContainment: true })));
  assert.equal(structural.hops[0]!.via, "parentContainment");
});

test("CLA-207: an endpoint missing from a partial graph is not loaded, not stale", () => {
  const snap = snapshot([entity("a"), entity("b")], [relation("r:ab", "a", "b")]);
  expectUnavailable(explorePath(snap, query("ghost", "b", { graphCoverage: "partial" })), "endpointNotLoaded");
  expectUnavailable(explorePath(snap, query("a", "ghost", { graphCoverage: "partial" })), "endpointNotLoaded");
  expectUnavailable(explorePath(snap, query("ghost", "b")), "unknownFromEntity");
});

test("CLA-207: duplicate entity or relation ids make the snapshot invalid", () => {
  const dupEntities = snapshot([entity("a"), entity("b"), entity("a")], [relation("r:ab", "a", "b")]);
  expectUnavailable(explorePath(dupEntities, query("a", "b")), "invalidSnapshot");
  const dupRelations = snapshot([entity("a"), entity("b")], [relation("r:ab", "a", "b"), relation("r:ab", "b", "a")]);
  expectUnavailable(explorePath(dupRelations, query("a", "b")), "invalidSnapshot");
  expectUnavailable(explorePath(dupRelations, query("ghost", "b")), "invalidSnapshot");
  expectUnavailable(explorePath(dupRelations, query("a", "b", { maxHops: 0 })), "invalidQuery");
});

test("CLA-207: absent eligible kinds are reported and never yield unreachable alone", () => {
  const snap = snapshot(
    [entity("a"), entity("b"), entity("c")],
    [relation("r:ab", "a", "b"), relation("r:b-ghost", "b", "ghost", "calls")],
  );
  const found = expectFound(explorePath(snap, query("a", "b", { relationKinds: ["uses", "reads", "calls"] })));
  assert.deepEqual(found.absentRelationKinds, ["calls", "reads"]);
  const unreachable = explorePath(snap, query("a", "c", { relationKinds: ["uses", "writes"] }));
  assert.equal(unreachable.status, "unreachable");
  if (unreachable.status === "unreachable") assert.deepEqual(unreachable.absentRelationKinds, ["writes"]);
  const none = expectUnavailable(explorePath(snap, query("a", "c", { relationKinds: ["calls", "reads"] })), "noEligibleRelations");
  assert.equal(none.ignoredDanglingRelationCount, 1);
  assert.equal(expectFound(explorePath(snap, query("a", "a", { relationKinds: ["reads"] }))).absentRelationKinds[0], "reads");
  const tree = snapshot([entity("p"), entity("q", "component", "p")], []);
  assert.equal(explorePath(tree, query("p", "q", { relationKinds: ["reads"], includeParentContainment: true })).status, "found");
  expectUnavailable(explorePath(tree, query("p", "q", { relationKinds: ["reads"] })), "noEligibleRelations");
});

function c4Snapshot(): ArchitectureSnapshot {
  return snapshot(
    [
      entity("sys", "softwareSystem"),
      entity("web", "container", "sys"),
      entity("api", "container", "sys"),
      entity("db", "dataStore", "sys"),
      entity("web:b", "component", "web"),
      entity("web:a", "component", "web"),
      entity("web:a.fn", "code", "web:a"),
      entity("api:z", "component", "api"),
      entity("api:y", "component", "api"),
      entity("api:y.fn", "code", "api:y"),
      entity("db:t", "component", "db"),
    ],
    [
      relation("r:b-z", "web:b", "api:z", "calls"),
      relation("r:afn-y", "web:a.fn", "api:y", "calls"),
      relation("r:b-yfn", "web:b", "api:y.fn", "calls"),
      relation("r:z-t", "api:z", "db:t", "writes"),
      relation("r:yfn-t", "api:y.fn", "db:t", "writes"),
    ],
  );
}

test("CLA-207: subtree scope routes container to container through components", () => {
  const snap = c4Snapshot();
  assert.equal(explorePath(snap, query("web", "api", { relationKinds: ["calls"] })).status, "unreachable");
  const result = expectFound(explorePath(snap, query("web", "api", { relationKinds: ["calls"], endpointScope: "subtree" })));
  assert.equal(result.query.endpointScope, "subtree");
  assert.deepEqual(result.entityIds, ["web:a.fn", "api:y"]);
  assert.deepEqual(result.relationIds, ["r:afn-y"]);
  const toDb = expectFound(explorePath(snap, query("web", "db", { relationKinds: ["calls", "writes"], endpointScope: "subtree" })));
  assert.deepEqual(toDb.entityIds, ["web:b", "api:y.fn", "db:t"]);
  assert.equal(toDb.entityIds[0], "web:b");
  assert.equal(toDb.entityIds.at(-1), "db:t");
});

test("CLA-207: subtree scope rejects nested endpoints and keeps self", () => {
  const snap = c4Snapshot();
  const subtree = { relationKinds: ["calls"] as RelationKind[], endpointScope: "subtree" as const };
  expectUnavailable(explorePath(snap, query("sys", "api", subtree)), "nestedEndpoints");
  expectUnavailable(explorePath(snap, query("api:y.fn", "api", subtree)), "nestedEndpoints");
  assert.deepEqual(expectFound(explorePath(snap, query("api", "api", subtree))).entityIds, ["api"]);
  assert.equal(explorePath(snap, query("sys", "api", { relationKinds: ["calls"], includeParentContainment: true })).status, "found");
  const cyclic = snapshot(
    [entity("p", "container", "q"), entity("q", "container", "p"), entity("r")],
    [relation("r:qr", "q", "r")],
  );
  expectUnavailable(explorePath(cyclic, query("p", "q", { endpointScope: "subtree" })), "nestedEndpoints");
  assert.deepEqual(expectFound(explorePath(cyclic, query("p", "r", { endpointScope: "subtree" }))).entityIds, ["q", "r"]);
});

test("CLA-207: every per-hop limit is exercised", () => {
  const snap = snapshot(
    [entity("p", "container"), entity("a", "component", "p"), entity("b"), entity("c"), entity("d"), entity("e"), entity("f")],
    [
      relation("r:ab", "a", "b", "uses", { evidence: [] }),
      relation("r:bc", "b", "c", "uses", { evidence: [evidence("src/b.ts"), evidence("src/b.ts", null)] }),
      relation("r:cd", "c", "d", "uses", { evidence: [evidence("src/c.ts", 4, "old-sha")] }),
      relation("r:de", "d", "e", "uses", { optional: true }),
      unscored(relation("r:ef", "e", "f")),
    ],
  );
  const result = expectFound(explorePath(snap, query("p", "f", { includeParentContainment: true })));
  assert.deepEqual(result.hops.map(hop => hop.limits), [
    ["noEvidence", "structuralContainment"],
    ["noEvidence"],
    ["evidenceWithoutLineRange"],
    ["evidenceFromOtherCommit"],
    ["optionalRelation"],
    ["unscoredConfidence"],
  ]);
  assert.equal(result.hops[5]!.confidence, undefined);
  assert.ok(!("confidence" in result.hops[5]!));
  assert.deepEqual(result.limits, ["hopsWithoutEvidence"]);
  const combined = snapshot(
    [entity("a"), entity("b")],
    [unscored(relation("r:ab", "a", "b", "uses", { evidence: [evidence("x.ts", null, "old")], optional: true }))],
  );
  assert.deepEqual(expectFound(explorePath(combined, query("a", "b"))).hops[0]!.limits, [
    "evidenceWithoutLineRange",
    "evidenceFromOtherCommit",
    "optionalRelation",
    "unscoredConfidence",
  ]);
});

test("CLA-207: returned evidence is copied, not aliased to the snapshot", () => {
  const snap = snapshot([entity("a"), entity("b")], [relation("r:ab", "a", "b")]);
  const before = structuredClone(snap);
  const result = expectFound(explorePath(snap, query("a", "b")));
  const hop = result.hops[0]!;
  assert.notEqual(hop.evidence, snap.relations[0]!.evidence);
  assert.notEqual(hop.evidence[0], snap.relations[0]!.evidence[0]);
  assert.notEqual(hop.evidence[0]!.source, snap.relations[0]!.evidence[0]!.source);
  hop.evidence[0]!.source.path = "mutated";
  hop.evidence[0]!.reason = "mutated";
  hop.evidence.push(evidence("extra.ts"));
  result.entityIds.push("mutated");
  result.query.relationKinds.push("calls");
  assert.deepEqual(snap, before);
});

test("CLA-207: disclaimer and claim describe static observation only", () => {
  assert.equal(PATH_EXPLORATION_CLAIM, "staticObservedRelations");
  assert.match(PATH_EXPLORATION_DISCLAIMER, /statically observed/);
  assert.match(PATH_EXPLORATION_DISCLAIMER, /does not show that this path runs at runtime/);
});

function layeredGraph(): ArchitectureSnapshot {
  const layers = 5;
  const width = 4;
  const entities: ArchitectureEntity[] = [
    entity("root", "softwareSystem"),
    entity("c.left", "container", "root"),
    entity("c.right", "container", "root"),
  ];
  const parents: Record<string, string> = { "n1.0": "c.left", "n1.1": "c.left", "n3.2": "c.right", "n3.3": "c.right" };
  const relations: ArchitectureRelation[] = [];
  const kinds: RelationKind[] = ["uses", "calls", "dependsOn"];
  for (let layer = 0; layer < layers; layer += 1) {
    for (let slot = 0; slot < width; slot += 1) {
      entities.push(entity(`n${layer}.${slot}`, "component", layer === 0 ? "root" : parents[`n${layer}.${slot}`]));
      if (layer === 0) continue;
      for (let prev = 0; prev < width; prev += 1) {
        const from = `n${layer - 1}.${prev}`;
        const to = `n${layer}.${slot}`;
        const copies = (prev + slot + layer) % 3 + 1;
        for (let copy = 0; copy < copies; copy += 1) {
          relations.push(relation(`r:${from}-${to}#${copies - copy}`, from, to, kinds[(copy + slot) % kinds.length]!));
        }
      }
    }
  }
  relations.push(relation("r:back", "n4.3", "n0.2", "uses"));
  relations.push(relation("r:root-n0.1", "root", "n0.1", "uses"));
  relations.push(relation("r:left-n1.1", "c.left", "n1.1", "dependsOn"));
  relations.push(relation("r:dangling", "n2.1", "ghost", "uses"));
  return snapshot(entities, relations);
}

test("CLA-207: result is identical under any permutation of entities and relations", () => {
  const base = layeredGraph();
  const queries: PathExplorationQuery[] = [
    query("n0.3", "n4.2", { relationKinds: ["uses", "calls", "dependsOn"] }),
    query("n0.1", "n4.0", { relationKinds: ["calls"] }),
    query("root", "n4.1", { relationKinds: ["dependsOn", "uses"], includeParentContainment: true }),
    query("n4.3", "n3.2", { relationKinds: ["uses", "calls", "dependsOn"], graphCoverage: "partial" }),
    query("n0.0", "n4.0", { relationKinds: ["uses", "calls", "dependsOn"], maxHops: 2 }),
    query("n4.0", "n0.0", { relationKinds: ["uses", "calls", "dependsOn"] }),
    query("c.left", "c.right", { relationKinds: ["uses", "calls", "dependsOn"], endpointScope: "subtree" }),
    query("c.left", "n3.3", { relationKinds: ["calls"], endpointScope: "subtree", includeParentContainment: true }),
    query("root", "n1.1", { relationKinds: ["uses", "dependsOn"], includeParentContainment: true }),
  ];
  const expected = queries.map(item => explorePath(base, item));
  const first = expected[0];
  if (first?.status !== "found") throw new Error("expected found");
  assert.deepEqual(first.entityIds, ["n0.3", "n1.0", "n2.0", "n3.0", "n4.2"]);
  assert.ok(first.hops.some(hop => hop.parallelRelationIds.length > 0));
  assert.deepEqual(expectFound(expected[2]!).entityIds.slice(0, 2), ["root", "c.right"]);
  assert.deepEqual(expected.map(result => result.status), [
    "found", "found", "found", "found", "unavailable", "unreachable", "found", "found", "found",
  ]);
  assert.deepEqual(expectFound(expected[6]!).entityIds, ["n1.0", "n2.0", "n3.2"]);
  const viaRelation = expectFound(expected[8]!).hops.find(hop => hop.fromEntityId === "c.left");
  assert.equal(viaRelation?.relationId, "r:left-n1.1");
  for (const seed of [1, 7, 42, 2026, 90210]) {
    const random = mulberry32(seed);
    for (let round = 0; round < 12; round += 1) {
      const permuted: ArchitectureSnapshot = {
        ...base,
        entities: shuffled(base.entities, random),
        relations: shuffled(base.relations, random),
      };
      queries.forEach((item, index) => assert.deepEqual(explorePath(permuted, item), expected[index]));
    }
  }
});

type OracleCase = {
  snap: ArchitectureSnapshot;
  containment: boolean;
  subtree: boolean;
  maxHops: number;
};

function descendants(snap: ArchitectureSnapshot, root: string): Set<string> {
  const out = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const item of snap.entities) {
      if (item.parentId !== undefined && out.has(item.parentId) && !out.has(item.id)) {
        out.add(item.id);
        grew = true;
      }
    }
  }
  return out;
}

function comparePaths(left: string[], right: string[]): number {
  if (left.length !== right.length) return left.length - right.length;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
  }
  return 0;
}

function oracle(item: OracleCase, from: string, to: string): { status: string; reason?: string; entityIds?: string[] } {
  if (from === to) return { status: "found", entityIds: [from] };
  const sources = item.subtree ? descendants(item.snap, from) : new Set([from]);
  const targets = item.subtree ? descendants(item.snap, to) : new Set([to]);
  if (item.subtree && (sources.has(to) || targets.has(from))) return { status: "unavailable", reason: "nestedEndpoints" };
  const out = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!out.has(a)) out.set(a, new Set());
    out.get(a)!.add(b);
  };
  for (const relationItem of item.snap.relations) link(relationItem.from, relationItem.to);
  if (item.containment) for (const entityItem of item.snap.entities) if (entityItem.parentId) link(entityItem.parentId, entityItem.id);
  let paths = [...sources].map(source => [source]);
  let best: string[] | undefined;
  while (paths.length > 0 && best === undefined) {
    const next: string[][] = [];
    for (const path of paths) {
      for (const step of out.get(path.at(-1)!) ?? []) {
        if (path.includes(step) || sources.has(step)) continue;
        const extended = [...path, step];
        if (targets.has(step)) {
          if (best === undefined || comparePaths(extended, best) < 0) best = extended;
        } else next.push(extended);
      }
    }
    paths = next;
  }
  if (best === undefined) return { status: "unreachable" };
  if (best.length - 1 > item.maxHops) return { status: "unavailable", reason: "hopLimit" };
  return { status: "found", entityIds: best };
}

test("CLA-207: BFS path matches a brute-force oracle across scope, containment and hop caps", () => {
  const random = mulberry32(207);
  const seen = new Set<string>();
  for (let round = 0; round < 60; round += 1) {
    const ids = Array.from({ length: 8 }, (_, index) => `e${String.fromCharCode(97 + ((index * 5) % 8))}`);
    const entities = ids.map((id, index) => {
      const parent = index > 0 && random() < 0.5 ? ids[Math.floor(random() * index)] : undefined;
      return entity(id, "component", parent);
    });
    const relations: ArchitectureRelation[] = [];
    for (let index = 0; index < 10; index += 1) {
      relations.push(relation(`r:${index}`, ids[Math.floor(random() * ids.length)]!, ids[Math.floor(random() * ids.length)]!));
    }
    const item: OracleCase = {
      snap: snapshot(shuffled(entities, random), relations),
      containment: random() < 0.5,
      subtree: random() < 0.5,
      maxHops: 1 + Math.floor(random() * 4),
    };
    for (const from of ids) {
      for (const to of ids) {
        const expected = oracle(item, from, to);
        const result = explorePath(item.snap, query(from, to, {
          includeParentContainment: item.containment,
          endpointScope: item.subtree ? "subtree" : "exact",
          maxHops: item.maxHops,
        }));
        const label = JSON.stringify({ round, from, to, expected });
        seen.add(`${expected.status}:${expected.reason ?? (expected.entityIds?.length === 1 ? "self" : "")}`);
        assert.equal(result.status, expected.status, label);
        if (result.status === "unavailable") assert.equal(result.reason, expected.reason, label);
        if (result.status === "found") assert.deepEqual(result.entityIds, expected.entityIds, label);
      }
    }
  }
  assert.deepEqual([...seen].sort(), [
    "found:", "found:self", "unavailable:hopLimit", "unavailable:nestedEndpoints", "unreachable:",
  ]);
});
