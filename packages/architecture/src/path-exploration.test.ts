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
  });
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

test("CLA-207: hop cap reports hopLimit only when the frontier was cut off", () => {
  const snap = snapshot(
    [entity("a"), entity("b"), entity("c"), entity("d"), entity("x")],
    [relation("r:ab", "a", "b"), relation("r:bc", "b", "c"), relation("r:cd", "c", "d")],
  );
  assert.deepEqual(expectFound(explorePath(snap, query("a", "d", { maxHops: 3 }))).entityIds, ["a", "b", "c", "d"]);
  expectUnavailable(explorePath(snap, query("a", "d", { maxHops: 2 })), "hopLimit");
  expectUnavailable(explorePath(snap, query("a", "x", { maxHops: 2 })), "hopLimit");
  expectUnavailable(explorePath(snap, query("a", "x", { maxHops: 2, graphCoverage: "partial" })), "hopLimit");
  const exhausted = explorePath(snap, query("a", "x", { maxHops: 3 }));
  assert.equal(exhausted.status, "unreachable");
  if (exhausted.status === "unreachable") assert.equal(exhausted.exploredEntityCount, 4);
  assert.equal(explorePath(snap, query("a", "x", { maxHops: 1 })).status, "unavailable");
  const cyclic = snapshot([entity("a"), entity("b"), entity("x")], [relation("r:ab", "a", "b"), relation("r:ba", "b", "a")]);
  assert.equal(explorePath(cyclic, query("a", "x", { maxHops: 1 })).status, "unreachable");
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
  const entities: ArchitectureEntity[] = [entity("root", "softwareSystem")];
  const relations: ArchitectureRelation[] = [];
  const kinds: RelationKind[] = ["uses", "calls", "dependsOn"];
  for (let layer = 0; layer < layers; layer += 1) {
    for (let slot = 0; slot < width; slot += 1) {
      entities.push(entity(`n${layer}.${slot}`, "component", layer === 0 ? "root" : undefined));
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
  ];
  const expected = queries.map(item => explorePath(base, item));
  const first = expected[0];
  if (first?.status !== "found") throw new Error("expected found");
  assert.deepEqual(first.entityIds, ["n0.3", "n1.0", "n2.0", "n3.0", "n4.2"]);
  assert.ok(first.hops.some(hop => hop.parallelRelationIds.length > 0));
  assert.equal(expectFound(expected[2]!).entityIds[1], "n0.0");
  assert.deepEqual(expected.map(result => result.status), ["found", "found", "found", "found", "unavailable", "unreachable"]);
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

function bruteForceCanonical(snap: ArchitectureSnapshot, from: string, to: string): string[] | undefined {
  const out = new Map<string, Set<string>>();
  for (const item of snap.relations) {
    if (!out.has(item.from)) out.set(item.from, new Set());
    out.get(item.from)!.add(item.to);
  }
  let paths: string[][] = [[from]];
  for (let depth = 0; depth <= snap.entities.length; depth += 1) {
    const hits = paths.filter(path => path.at(-1) === to);
    if (hits.length > 0) {
      return hits.map(path => path).sort((left, right) => {
        for (let index = 0; index < left.length; index += 1) {
          if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1;
        }
        return 0;
      })[0];
    }
    paths = paths.flatMap(path => [...(out.get(path.at(-1)!) ?? [])].filter(next => !path.includes(next)).map(next => [...path, next]));
  }
  return undefined;
}

test("CLA-207: BFS path matches a brute-force lex-min shortest path on random graphs", () => {
  const random = mulberry32(207);
  for (let round = 0; round < 40; round += 1) {
    const ids = Array.from({ length: 7 }, (_, index) => `e${String.fromCharCode(97 + ((index * 5) % 7))}`);
    const relations: ArchitectureRelation[] = [];
    for (let index = 0; index < 14; index += 1) {
      const from = ids[Math.floor(random() * ids.length)]!;
      const to = ids[Math.floor(random() * ids.length)]!;
      relations.push(relation(`r:${index}`, from, to));
    }
    const snap = snapshot(ids.map(id => entity(id)), relations);
    for (const from of ids) {
      for (const to of ids) {
        if (from === to) continue;
        const expected = bruteForceCanonical(snap, from, to);
        const result = explorePath(snap, query(from, to));
        if (expected === undefined) assert.equal(result.status, "unreachable");
        else assert.deepEqual(expectFound(result).entityIds, expected);
      }
    }
  }
});
