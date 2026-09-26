/**
 * CLA-208: pure view model for path exploration.
 *
 * Builds the engine query from the reader's own endpoint state, runs
 * `explorePath`, and maps the result to honest, plain-language copy. Share
 * state is derived only from that UI state — never from a result's echoed
 * query — so an invalid query can never leak into a link.
 */
import {
  explorePath,
  PATH_EXPLORATION_DISCLAIMER,
  type ArchitectureSnapshot,
  type Evidence,
  type PathEndpointScope,
  type PathExplorationResult,
  type PathGraphCoverage,
  type PathHop,
  type PathHopLimit,
  type PathUnavailableReason,
  type RelationKind,
  type SourceExcerpt,
} from '@okie/architecture';
import type { NavigationPathState } from '../navigation/navigationState';

export { PATH_EXPLORATION_DISCLAIMER };

const KNOWN_KIND_RECORD = {
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
} satisfies Record<RelationKind, true>;

export const KNOWN_RELATION_KINDS = Object.keys(KNOWN_KIND_RECORD).sort() as RelationKind[];
const KNOWN_KIND_SET: ReadonlySet<string> = new Set(KNOWN_RELATION_KINDS);

export function isKnownRelationKind(kind: string): kind is RelationKind {
  return KNOWN_KIND_SET.has(kind);
}

/** The reader's own path-exploration state; the only source of share links. */
export type PathDraft = {
  fromId?: string;
  toId?: string;
  kinds: string[];
  containment: boolean;
  scope: PathEndpointScope;
  /** Set only when restored from a link made at another snapshot. */
  linkSnapshotId?: string;
};

export type PathEndpointView = { id: string; name: string; known: boolean };

export type PathEvidenceView = {
  reason?: string;
  path: string;
  startLine?: number;
  endLine?: number;
  commitSha: string;
  location: string;
  /** Resident frozen excerpt covering this evidence, highlighted at its line. */
  excerpt?: SourceExcerpt;
};

export type PathHopLimitView = { code: PathHopLimit; label: string };

export type PathHopView = {
  index: number;
  from: PathEndpointView;
  to: PathEndpointView;
  kind: string;
  via: PathHop['via'];
  viaLabel: string;
  relationId?: string;
  label?: string;
  parallelCount: number;
  confidenceLabel: string;
  evidence: PathEvidenceView[];
  limits: PathHopLimitView[];
  /** Containment hops have no drawn relation route. */
  mapNote?: string;
};

export type PathViewState = 'incomplete' | 'snapshotMismatch' | 'unknownKinds' | 'found' | 'unreachable' | 'unavailable';

export type PathKindOption = { kind: string; checked: boolean; present: boolean; known: boolean };

export type PathExplorationView = {
  state: PathViewState;
  reason?: PathUnavailableReason;
  title: string;
  message: string;
  from?: PathEndpointView;
  to?: PathEndpointView;
  /** Under subtree scope: the descendants the path actually starts/ends at. */
  resolvedFrom?: PathEndpointView;
  resolvedTo?: PathEndpointView;
  kinds: PathKindOption[];
  containment: boolean;
  scope: PathEndpointScope;
  coverage: PathGraphCoverage;
  notes: string[];
  hops: PathHopView[];
  /** Semantic relation + entity IDs to highlight through the C4 projection. */
  reveal?: { relationIds: string[]; entityIds: string[] };
  result?: PathExplorationResult;
  disclaimer: string;
};

const LIMIT_COPY: Record<PathHopLimit, string> = {
  noEvidence: 'No evidence captured',
  evidenceWithoutLineRange: 'Evidence has no line range',
  evidenceFromOtherCommit: 'Evidence from another commit',
  optionalRelation: 'Conditional (optional) relation',
  unscoredConfidence: 'Confidence not scored',
  structuralContainment: 'Structural containment, not an observed call',
};

const UNAVAILABLE_TITLE: Record<PathUnavailableReason, string> = {
  unknownFromEntity: "This link refers to an entity that isn't in this snapshot.",
  unknownToEntity: "This link refers to an entity that isn't in this snapshot.",
  noEligibleKinds: 'Choose at least one relation kind or parent containment.',
  invalidQuery: 'This path query is not valid.',
  invalidSnapshot: 'This snapshot cannot be explored.',
  endpointNotLoaded: "An endpoint isn't loaded in this part of the map yet.",
  nestedEndpoints: 'One endpoint is inside the other.',
  noEligibleRelations: 'This snapshot has no relations of the selected kinds.',
  partialGraph: 'No path in the part of the map loaded so far.',
  hopLimit: 'The path is too long to show.',
};

const UNAVAILABLE_HINT: Partial<Record<PathUnavailableReason, string>> = {
  endpointNotLoaded: 'Open more of the map around it, then explore again.',
  partialGraph: 'More of the map must be loaded before Okie can say whether a path exists.',
  nestedEndpoints: 'Turn off “Match parts inside endpoints” or choose endpoints that are not nested.',
};

export function presentRelationKinds(snapshot: ArchitectureSnapshot): RelationKind[] {
  return [...new Set(snapshot.relations.map(relation => relation.kind))].filter(isKnownRelationKind).sort();
}

function hasDescendants(snapshot: ArchitectureSnapshot, id: string | undefined): boolean {
  return id !== undefined && snapshot.entities.some(entity => entity.parentId === id && entity.id !== id);
}

/**
 * Containers and components are matched through their contents (`subtree`) so
 * container→container questions can route through code; leaves stay exact.
 */
export function defaultPathScope(snapshot: ArchitectureSnapshot, fromId?: string, toId?: string): PathEndpointScope {
  return hasDescendants(snapshot, fromId) || hasDescendants(snapshot, toId) ? 'subtree' : 'exact';
}

export function setPathEndpoint(
  draft: PathDraft | undefined,
  role: 'from' | 'to',
  entityId: string,
  snapshot: ArchitectureSnapshot,
): PathDraft {
  const base = draft && draft.linkSnapshotId === undefined
    ? draft
    : { kinds: presentRelationKinds(snapshot), containment: false, scope: 'exact' as const };
  const fromId = role === 'from' ? entityId : base.fromId;
  const toId = role === 'to' ? entityId : base.toId;
  return {
    ...(fromId !== undefined ? { fromId } : {}),
    ...(toId !== undefined ? { toId } : {}),
    kinds: [...base.kinds],
    containment: base.containment,
    scope: defaultPathScope(snapshot, fromId, toId),
  };
}

export function swapPathEndpoints(draft: PathDraft): PathDraft {
  const { fromId, toId, linkSnapshotId: _link, ...rest } = draft;
  return { ...rest, ...(toId !== undefined ? { fromId: toId } : {}), ...(fromId !== undefined ? { toId: fromId } : {}) };
}

export function togglePathKind(draft: PathDraft, kind: string): PathDraft {
  const { linkSnapshotId: _link, ...rest } = draft;
  const kinds = draft.kinds.includes(kind) ? draft.kinds.filter(item => item !== kind) : [...draft.kinds, kind];
  return { ...rest, kinds: [...new Set(kinds)].sort() };
}

export function setPathOption(draft: PathDraft, option: { containment?: boolean; scope?: PathEndpointScope }): PathDraft {
  const { linkSnapshotId: _link, ...rest } = draft;
  return { ...rest, ...option };
}

function writableId(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Share/URL state from the reader's own endpoint state only. */
export function navigationPathFromDraft(draft: PathDraft | undefined): NavigationPathState | undefined {
  if (!draft || !writableId(draft.fromId) || !writableId(draft.toId)) return undefined;
  return {
    fromId: draft.fromId,
    toId: draft.toId,
    kinds: [...new Set(draft.kinds.filter(writableId))].sort(),
    containment: draft.containment,
    scope: draft.scope,
    ...(draft.linkSnapshotId !== undefined ? { snapshotId: draft.linkSnapshotId } : {}),
  };
}

export function pathDraftFromNavigation(path: NavigationPathState | undefined): PathDraft | undefined {
  if (!path) return undefined;
  return {
    fromId: path.fromId,
    toId: path.toId,
    kinds: [...path.kinds],
    containment: path.containment,
    scope: path.scope,
    ...(path.snapshotId !== undefined ? { linkSnapshotId: path.snapshotId } : {}),
  };
}

/** Neighborhood (scan) boots load a partial graph; only full loads may claim unreachability. */
export function pathGraphCoverage(input: { scanBoot?: 'neighborhood' | 'full' }): PathGraphCoverage {
  return input.scanBoot === 'neighborhood' ? 'partial' : 'complete';
}

function endpoint(snapshot: ArchitectureSnapshot, id: string): PathEndpointView {
  const entity = snapshot.entities.find(candidate => candidate.id === id);
  return { id, name: entity?.name ?? id, known: Boolean(entity) };
}

function shortSha(sha: string) {
  return /^[0-9a-f]{12,}$/i.test(sha) ? sha.slice(0, 12) : sha;
}

function evidenceLocation(evidence: Evidence): string {
  const { path, startLine, endLine, commitSha } = evidence.source;
  const lines = startLine === undefined ? '' : endLine !== undefined && endLine !== startLine ? `:${startLine}-${endLine}` : `:${startLine}`;
  return `${path}${lines}@${shortSha(commitSha)}`;
}

/** A resident frozen excerpt of the same file, revision, and (when known) line. */
export function evidenceExcerpt(snapshot: ArchitectureSnapshot, evidence: Evidence, preferEntityIds: readonly string[] = []): SourceExcerpt | undefined {
  const { path, commitSha, startLine } = evidence.source;
  const byId = new Map(snapshot.entities.map(entity => [entity.id, entity]));
  const ordered = [...preferEntityIds.flatMap(id => byId.get(id) ?? []), ...snapshot.entities];
  for (const entity of ordered) {
    for (const excerpt of entity.sourceExcerpts ?? []) {
      if (excerpt.path !== path || excerpt.frozenRevision !== commitSha) continue;
      if (startLine !== undefined && (startLine < excerpt.startLine || startLine > excerpt.endLine)) continue;
      return startLine === undefined ? excerpt : { ...excerpt, highlightLine: startLine };
    }
  }
  return undefined;
}

function hopView(snapshot: ArchitectureSnapshot, hop: PathHop): PathHopView {
  const from = endpoint(snapshot, hop.fromEntityId);
  const to = endpoint(snapshot, hop.toEntityId);
  const containment = hop.via === 'parentContainment';
  return {
    index: hop.index,
    from,
    to,
    kind: hop.kind,
    via: hop.via,
    viaLabel: containment ? 'Parent containment' : 'Observed relation',
    ...(hop.relationId !== undefined ? { relationId: hop.relationId } : {}),
    ...(hop.label !== undefined ? { label: hop.label } : {}),
    parallelCount: hop.parallelRelationIds.length,
    confidenceLabel: containment ? 'Not applicable' : hop.confidence === undefined ? 'Not scored' : `${Math.round(hop.confidence * 100)}%`,
    evidence: hop.evidence.map(item => {
      const excerpt = evidenceExcerpt(snapshot, item, [hop.fromEntityId, hop.toEntityId]);
      return {
        ...(item.reason !== undefined ? { reason: item.reason } : {}),
        path: item.source.path,
        ...(item.source.startLine !== undefined ? { startLine: item.source.startLine } : {}),
        ...(item.source.endLine !== undefined ? { endLine: item.source.endLine } : {}),
        commitSha: item.source.commitSha,
        location: evidenceLocation(item),
        ...(excerpt ? { excerpt } : {}),
      };
    }),
    limits: hop.limits.map(code => ({ code, label: LIMIT_COPY[code] })),
    ...(containment ? { mapNote: `${to.name} sits inside ${from.name}. Containment is structure, so there is no relation route to show on the map.` } : {}),
  };
}

function kindOptions(draft: PathDraft, present: readonly string[]): PathKindOption[] {
  const presentSet = new Set(present);
  const all = [...new Set([...present, ...draft.kinds])].sort();
  return all.map(kind => ({ kind, checked: draft.kinds.includes(kind), present: presentSet.has(kind), known: isKnownRelationKind(kind) }));
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

export function explorePathView(
  snapshot: ArchitectureSnapshot,
  draft: PathDraft,
  coverage: PathGraphCoverage,
): PathExplorationView {
  const from = draft.fromId !== undefined ? endpoint(snapshot, draft.fromId) : undefined;
  const to = draft.toId !== undefined ? endpoint(snapshot, draft.toId) : undefined;
  const base = {
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    kinds: kindOptions(draft, presentRelationKinds(snapshot)),
    containment: draft.containment,
    scope: draft.scope,
    coverage,
    notes: [] as string[],
    hops: [] as PathHopView[],
    disclaimer: PATH_EXPLORATION_DISCLAIMER,
  };
  if (!draft.fromId || !draft.toId) {
    return { ...base, state: 'incomplete', title: 'Choose both endpoints.', message: draft.fromId ? 'Select another entity and choose “Path to here”.' : 'Select another entity and choose “Path from here”.' };
  }
  if (draft.linkSnapshotId !== undefined && draft.linkSnapshotId !== snapshot.id) {
    return {
      ...base,
      state: 'snapshotMismatch',
      title: "This path link was made for a different snapshot.",
      message: `The link's snapshot is ${draft.linkSnapshotId}, but the loaded map is ${snapshot.id}. The path was not re-run, because the answer could differ.`,
    };
  }
  const unknownKinds = draft.kinds.filter(kind => !isKnownRelationKind(kind));
  if (unknownKinds.length) {
    return {
      ...base,
      state: 'unknownKinds',
      title: "This path names relation kinds Okie doesn't recognise.",
      message: `Unrecognised: ${unknownKinds.join(', ')}. The path was not run, so it isn't silently answered with different kinds. Untick them to explore with the rest.`,
    };
  }

  const result = explorePath(snapshot, {
    fromEntityId: draft.fromId,
    toEntityId: draft.toId,
    relationKinds: draft.kinds as RelationKind[],
    includeParentContainment: draft.containment,
    graphCoverage: coverage,
    endpointScope: draft.scope,
  });
  const notes: string[] = [];
  if (result.ignoredDanglingRelationCount > 0) {
    notes.push(`${plural(result.ignoredDanglingRelationCount, 'relation')} of the selected kinds point${result.ignoredDanglingRelationCount === 1 ? 's' : ''} outside this snapshot and ${result.ignoredDanglingRelationCount === 1 ? 'was' : 'were'} ignored.`);
  }
  if (result.status !== 'unavailable' && result.absentRelationKinds.length) {
    notes.push(`No traversable relations of kind ${result.absentRelationKinds.join(', ')} exist in this snapshot.`);
  }

  if (result.status === 'found') {
    const hops = result.hops.map(hop => hopView(snapshot, hop));
    const firstId = result.entityIds[0]!;
    const lastId = result.entityIds.at(-1)!;
    if (result.limits.includes('partialGraph')) {
      notes.unshift('Found in a partially loaded map. A shorter path may exist through parts not loaded yet.');
    }
    if (result.limits.includes('hopsWithoutEvidence')) notes.push('Some hops have no captured evidence.');
    return {
      ...base,
      notes,
      state: 'found',
      title: hops.length === 0 ? 'The origin and destination are the same entity.' : `Path found: ${plural(hops.length, 'hop')}.`,
      message: hops.length === 0 ? 'There is nothing to traverse.' : `Shortest path over the selected kinds, ${hops.length === 1 ? 'one step' : `${hops.length} steps`} from ${endpoint(snapshot, firstId).name} to ${endpoint(snapshot, lastId).name}.`,
      ...(firstId !== draft.fromId ? { resolvedFrom: endpoint(snapshot, firstId) } : {}),
      ...(lastId !== draft.toId ? { resolvedTo: endpoint(snapshot, lastId) } : {}),
      hops,
      reveal: { relationIds: [...result.relationIds], entityIds: [...result.entityIds] },
      result,
    };
  }
  if (result.status === 'unreachable') {
    return {
      ...base,
      notes,
      state: 'unreachable',
      title: 'No path exists over the selected kinds.',
      message: `Explored ${plural(result.exploredEntityCount, 'entity', 'entities')} reachable from ${from!.name} in this complete snapshot; none leads to ${to!.name}.`,
      result,
    };
  }
  const hint = UNAVAILABLE_HINT[result.reason];
  return {
    ...base,
    notes,
    state: 'unavailable',
    reason: result.reason,
    title: UNAVAILABLE_TITLE[result.reason],
    message: hint ? `${result.message} ${hint}` : result.message,
    result,
  };
}
