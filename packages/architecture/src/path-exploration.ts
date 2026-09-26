/**
 * CLA-207: deterministic shortest-path exploration over one semantic snapshot.
 *
 * Directed edges come only from relations whose kind the caller names, plus
 * opt-in parent→child containment. Kinds are never merged or inferred. The
 * canonical path is the fewest-hop path with the lexicographically smallest
 * entity-ID sequence (code-unit order); per hop the smallest relation id wins,
 * and structural containment is chosen only when no observed relation joins the pair. Shuffling entities or relations yields an
 * identical result. A found path is a static claim, never runtime proof.
 */
import type {
  ArchitectureEntity,
  ArchitectureRelation,
  ArchitectureSnapshot,
  EntityId,
  Evidence,
  RelationId,
  RelationKind,
  SnapshotId,
} from "./model.js";

export const PATH_EXPLORATION_VERSION = 1 as const;
export const PATH_EXPLORATION_DEFAULT_MAX_HOPS = 64;
/** Never imply runtime execution. */
export const PATH_EXPLORATION_CLAIM = "staticObservedRelations" as const;
export const PATH_EXPLORATION_DISCLAIMER =
  "This path follows statically observed relations in one snapshot. It does not show that this path runs at runtime.";

export type PathGraphCoverage = "complete" | "partial";

export type PathExplorationQuery = {
  fromEntityId: EntityId;
  toEntityId: EntityId;
  /** Explicit eligible kinds; nothing is inferred from an empty list. */
  relationKinds: readonly RelationKind[];
  /** Adds parent→child edges from `entity.parentId`. Default false. */
  includeParentContainment?: boolean;
  /** `partial` when the snapshot is a truncated neighborhood; unreachability is then never claimed. */
  graphCoverage: PathGraphCoverage;
  /** Positive integer; default PATH_EXPLORATION_DEFAULT_MAX_HOPS. */
  maxHops?: number;
};

export type NormalizedPathExplorationQuery = {
  fromEntityId: EntityId;
  toEntityId: EntityId;
  relationKinds: RelationKind[];
  includeParentContainment: boolean;
  graphCoverage: PathGraphCoverage;
  maxHops: number;
};

export type PathHopVia = "relation" | "parentContainment";

export type PathHopLimit =
  | "noEvidence"
  | "evidenceWithoutLineRange"
  | "evidenceFromOtherCommit"
  | "optionalRelation"
  | "unscoredConfidence"
  | "structuralContainment";

export type PathHop = {
  index: number;
  fromEntityId: EntityId;
  toEntityId: EntityId;
  /** `contains` for parentContainment hops. */
  kind: RelationKind;
  via: PathHopVia;
  /** Chosen relation; absent for parentContainment. */
  relationId?: RelationId;
  /** Other eligible relations for the same from→to, canonical order (parallel edges). Never includes relationId. */
  parallelRelationIds: RelationId[];
  label?: string;
  evidence: Evidence[];
  confidence?: number;
  limits: PathHopLimit[];
};

export type PathResultLimit = "partialGraph" | "hopsWithoutEvidence";

export type PathUnavailableReason =
  | "unknownFromEntity"
  | "unknownToEntity"
  | "noEligibleKinds"
  | "invalidQuery"
  | "partialGraph"
  | "hopLimit";

type PathResultBase = {
  version: typeof PATH_EXPLORATION_VERSION;
  snapshotId: SnapshotId;
  commitSha: string;
  query: NormalizedPathExplorationQuery;
  claim: typeof PATH_EXPLORATION_CLAIM;
  ignoredDanglingRelationCount: number;
};

export type PathExplorationFound = PathResultBase & {
  status: "found";
  entityIds: EntityId[];
  relationIds: RelationId[];
  hops: PathHop[];
  limits: PathResultLimit[];
};
export type PathExplorationUnreachable = PathResultBase & { status: "unreachable"; exploredEntityCount: number };
export type PathExplorationUnavailable = PathResultBase & {
  status: "unavailable";
  reason: PathUnavailableReason;
  message: string;
};
export type PathExplorationResult = PathExplorationFound | PathExplorationUnreachable | PathExplorationUnavailable;

const RELATION_KIND_SET: ReadonlySet<string> = new Set(Object.keys({
  uses: true,
  calls: true,
  reads: true,
  writes: true,
  publishes: true,
  subscribes: true,
  contains: true,
  dependsOn: true,
  returns: true,
  duplicates: true,
} satisfies Record<RelationKind, true>));

const HOP_LIMIT_ORDER: readonly PathHopLimit[] = [
  "noEvidence",
  "evidenceWithoutLineRange",
  "evidenceFromOtherCommit",
  "optionalRelation",
  "unscoredConfidence",
  "structuralContainment",
];

type PathEdge =
  | { via: "parentContainment" }
  | { via: "relation"; relation: ArchitectureRelation };

/** Observed relations (by id, then kind) before evidence-free structural containment. */
function compareEdges(left: PathEdge, right: PathEdge): number {
  if (left.via !== "relation" || right.via !== "relation") {
    return (left.via === "relation" ? 0 : 1) - (right.via === "relation" ? 0 : 1);
  }
  return compareText(left.relation.id, right.relation.id) || compareText(left.relation.kind, right.relation.kind);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeQuery(query: PathExplorationQuery): NormalizedPathExplorationQuery {
  const kinds = Array.isArray(query.relationKinds) ? query.relationKinds : [];
  return {
    fromEntityId: query.fromEntityId,
    toEntityId: query.toEntityId,
    relationKinds: [...new Set(kinds)].sort(compareText),
    includeParentContainment: query.includeParentContainment === true,
    graphCoverage: query.graphCoverage,
    maxHops: query.maxHops === undefined ? PATH_EXPLORATION_DEFAULT_MAX_HOPS : query.maxHops,
  };
}

function invalidQueryMessage(query: PathExplorationQuery, normalized: NormalizedPathExplorationQuery): string | undefined {
  if (typeof query.fromEntityId !== "string" || typeof query.toEntityId !== "string") {
    return "fromEntityId and toEntityId must be strings.";
  }
  if (!Array.isArray(query.relationKinds)) return "relationKinds must be an array.";
  const unknownKind = normalized.relationKinds.find(kind => !RELATION_KIND_SET.has(kind));
  if (unknownKind !== undefined) return `Unknown relation kind "${String(unknownKind)}".`;
  if (normalized.graphCoverage !== "complete" && normalized.graphCoverage !== "partial") {
    return 'graphCoverage must be "complete" or "partial".';
  }
  if (!Number.isInteger(normalized.maxHops) || normalized.maxHops < 1) return "maxHops must be a positive integer.";
  return undefined;
}

function buildAdjacency(
  snapshot: ArchitectureSnapshot,
  entityIds: ReadonlySet<EntityId>,
  query: NormalizedPathExplorationQuery,
): { adjacency: Map<EntityId, Map<EntityId, PathEdge[]>>; dangling: number } {
  const adjacency = new Map<EntityId, Map<EntityId, PathEdge[]>>();
  const add = (from: EntityId, to: EntityId, edge: PathEdge): void => {
    let targets = adjacency.get(from);
    if (!targets) adjacency.set(from, targets = new Map());
    const edges = targets.get(to);
    if (edges) edges.push(edge);
    else targets.set(to, [edge]);
  };
  const kinds = new Set<string>(query.relationKinds);
  let dangling = 0;
  for (const relation of snapshot.relations) {
    if (!kinds.has(relation.kind)) continue;
    if (!entityIds.has(relation.from) || !entityIds.has(relation.to)) {
      dangling += 1;
      continue;
    }
    add(relation.from, relation.to, { via: "relation", relation });
  }
  if (query.includeParentContainment) {
    const seen = new Set<EntityId>();
    for (const entity of snapshot.entities) {
      if (seen.has(entity.id)) continue;
      seen.add(entity.id);
      if (entity.parentId !== undefined && entity.parentId !== entity.id && entityIds.has(entity.parentId)) {
        add(entity.parentId, entity.id, { via: "parentContainment" });
      }
    }
  }
  for (const targets of adjacency.values()) {
    for (const edges of targets.values()) {
      edges.sort(compareEdges);
    }
  }
  return { adjacency, dangling };
}

function copyEvidence(evidence: Evidence): Evidence {
  return { ...evidence, source: { ...evidence.source } };
}

function hopFor(index: number, from: EntityId, to: EntityId, edges: readonly PathEdge[], commitSha: string): PathHop {
  const chosen = edges[0]!;
  const parallelRelationIds = edges.slice(1).flatMap(edge => edge.via === "relation" ? [edge.relation.id] : []);
  if (chosen.via === "parentContainment") {
    return {
      index,
      fromEntityId: from,
      toEntityId: to,
      kind: "contains",
      via: "parentContainment",
      parallelRelationIds,
      evidence: [],
      limits: ["noEvidence", "structuralContainment"],
    };
  }
  const relation = chosen.relation;
  const limits = new Set<PathHopLimit>();
  if (relation.evidence.length === 0) limits.add("noEvidence");
  if (relation.evidence.some(item => item.source.startLine === undefined)) limits.add("evidenceWithoutLineRange");
  if (relation.evidence.some(item => item.source.commitSha !== commitSha)) limits.add("evidenceFromOtherCommit");
  if (relation.optional === true) limits.add("optionalRelation");
  if (relation.confidence === undefined) limits.add("unscoredConfidence");
  return {
    index,
    fromEntityId: from,
    toEntityId: to,
    kind: relation.kind,
    via: "relation",
    relationId: relation.id,
    parallelRelationIds,
    ...(relation.label !== undefined ? { label: relation.label } : {}),
    evidence: relation.evidence.map(copyEvidence),
    ...(relation.confidence !== undefined ? { confidence: relation.confidence } : {}),
    limits: HOP_LIMIT_ORDER.filter(limit => limits.has(limit)),
  };
}

export function explorePath(snapshot: ArchitectureSnapshot, query: PathExplorationQuery): PathExplorationResult {
  const normalized = normalizeQuery(query);
  const base = (dangling: number): PathResultBase => ({
    version: PATH_EXPLORATION_VERSION,
    snapshotId: snapshot.id,
    commitSha: snapshot.commitSha,
    query: normalized,
    claim: PATH_EXPLORATION_CLAIM,
    ignoredDanglingRelationCount: dangling,
  });
  const unavailable = (reason: PathUnavailableReason, message: string, dangling = 0): PathExplorationUnavailable => ({
    ...base(dangling),
    status: "unavailable",
    reason,
    message,
  });

  const invalid = invalidQueryMessage(query, normalized);
  if (invalid !== undefined) return unavailable("invalidQuery", invalid);
  const entityIds = new Set(snapshot.entities.map((entity: ArchitectureEntity) => entity.id));
  const { fromEntityId: from, toEntityId: to } = normalized;
  if (!entityIds.has(from)) return unavailable("unknownFromEntity", `Entity "${from}" is not in snapshot ${snapshot.id}.`);
  if (!entityIds.has(to)) return unavailable("unknownToEntity", `Entity "${to}" is not in snapshot ${snapshot.id}.`);
  if (normalized.relationKinds.length === 0 && !normalized.includeParentContainment) {
    return unavailable("noEligibleKinds", "No relation kinds or containment were selected.");
  }

  const { adjacency, dangling } = buildAdjacency(snapshot, entityIds, normalized);
  const partial = normalized.graphCoverage === "partial";
  const found = (entityPath: EntityId[]): PathExplorationFound => {
    const hops = entityPath.slice(1).map((target, index) => {
      const source = entityPath[index]!;
      return hopFor(index, source, target, adjacency.get(source)!.get(target)!, snapshot.commitSha);
    });
    const limits: PathResultLimit[] = [];
    if (partial) limits.push("partialGraph");
    if (hops.some(hop => hop.limits.includes("noEvidence"))) limits.push("hopsWithoutEvidence");
    return {
      ...base(dangling),
      status: "found",
      entityIds: entityPath,
      relationIds: hops.flatMap(hop => hop.relationId !== undefined ? [hop.relationId] : []),
      hops,
      limits,
    };
  };
  if (from === to) return found([from]);

  const sortedNeighbors = new Map<EntityId, EntityId[]>();
  for (const [source, targets] of adjacency) sortedNeighbors.set(source, [...targets.keys()].sort(compareText));

  const parent = new Map<EntityId, EntityId>();
  const depth = new Map<EntityId, number>([[from, 0]]);
  const queue: EntityId[] = [from];
  let hitCap = false;
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    const currentDepth = depth.get(current)!;
    const neighbors = sortedNeighbors.get(current) ?? [];
    if (currentDepth >= normalized.maxHops) {
      if (neighbors.some(neighbor => !depth.has(neighbor))) hitCap = true;
      continue;
    }
    for (const neighbor of neighbors) {
      if (depth.has(neighbor)) continue;
      depth.set(neighbor, currentDepth + 1);
      parent.set(neighbor, current);
      if (neighbor === to) {
        const entityPath = [to];
        for (let step = parent.get(to); step !== undefined; step = parent.get(step)) entityPath.push(step);
        return found(entityPath.reverse());
      }
      queue.push(neighbor);
    }
  }

  if (hitCap) {
    return unavailable(
      "hopLimit",
      `No path within ${normalized.maxHops} hops; the search stopped at the hop limit.`,
      dangling,
    );
  }
  if (partial) {
    return unavailable(
      "partialGraph",
      "No path in the loaded partial graph; entities outside it may still connect these endpoints.",
      dangling,
    );
  }
  return { ...base(dangling), status: "unreachable", exploredEntityCount: depth.size };
}
