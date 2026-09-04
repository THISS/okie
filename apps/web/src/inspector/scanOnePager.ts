import {
  type ArchitectureEntity,
  type ArchitectureRelation,
  type ArchitectureSnapshot,
  type C4Band,
  type EntityKind,
} from '@okie/architecture';
import { escapeMermaidLabel, mermaidSafeIdentifier } from '@okie/scene-compiler';
import { inspectorAcceptedSummary } from './inspectorPanel';

/** Keep the inline one-pager diagram small enough to read in the inspector rail. */
export const ONE_PAGER_MAX_NODES = 20;

const CONTAINER_KINDS: ReadonlySet<EntityKind> = new Set(['container', 'dataStore', 'queue']);
const WORLD_KINDS: ReadonlySet<EntityKind> = new Set(['person', 'externalSystem']);
const GRAPH_RELATION_KINDS: ReadonlySet<ArchitectureRelation['kind']> = new Set([
  'uses',
  'calls',
  'reads',
  'writes',
  'publishes',
  'subscribes',
  'dependsOn',
  'returns',
]);

export type ScanOnePagerContainer = {
  id: string;
  name: string;
  kind: EntityKind;
  summary?: string;
};

export type ScanOnePager = {
  systemId?: string;
  systemName: string;
  systemSummary: string;
  systemSummaryKind: 'accepted' | 'structural';
  containers: ScanOnePagerContainer[];
  containerCount: number;
  entityCount: number;
  omittedContainerCount: number;
  mermaidSource: string;
  mermaidTitle: string;
  band: C4Band;
  graphNodeCount: number;
  graphOmittedCount: number;
};

function compareId(left: string, right: string): number {
  return left.localeCompare(right);
}

function byId(left: ArchitectureEntity, right: ArchitectureEntity): number {
  return compareId(left.id, right.id);
}

function isContainerKind(kind: EntityKind): boolean {
  return CONTAINER_KINDS.has(kind);
}

export function onePagerBand(detail: string | undefined): C4Band {
  if (detail === 'component' || detail === 'code' || detail === 'container' || detail === 'context') {
    return detail;
  }
  return 'container';
}

export function structuralSystemSummary(
  systemName: string,
  containerCount: number,
  entityCount: number,
): string {
  const containerLabel = containerCount === 1 ? 'container' : 'containers';
  const entityLabel = entityCount === 1 ? 'entity' : 'entities';
  return `${systemName} is a software system with ${containerCount} ${containerLabel} and ${entityCount} ${entityLabel}.`;
}

function mermaidTitleForBand(band: C4Band): string {
  if (band === 'component') return 'Current band · containers → components';
  if (band === 'code') return 'Current band · components → code';
  return 'L1 → L2 · context → containers';
}

function entitiesInBandRank(entities: readonly ArchitectureEntity[], band: C4Band): ArchitectureEntity[] {
  if (band === 'component') {
    return [
      ...entities.filter(entity => isContainerKind(entity.kind)).sort(byId),
      ...entities.filter(entity => entity.kind === 'component').sort(byId),
    ];
  }
  if (band === 'code') {
    return [
      ...entities.filter(entity => entity.kind === 'component').sort(byId),
      ...entities.filter(entity => entity.kind === 'code').sort(byId),
    ];
  }
  return [
    ...entities.filter(entity => entity.kind === 'softwareSystem').sort(byId),
    ...entities.filter(entity => isContainerKind(entity.kind)).sort(byId),
    ...entities.filter(entity => WORLD_KINDS.has(entity.kind)).sort(byId),
  ];
}

function selectGraphEntities(
  entities: readonly ArchitectureEntity[],
  band: C4Band,
  cap: number,
): { nodes: ArchitectureEntity[]; omitted: number } {
  const ranked = entitiesInBandRank(entities, band);
  return {
    nodes: ranked.slice(0, cap),
    omitted: Math.max(0, ranked.length - cap),
  };
}

function serializeOnePagerMermaid(
  nodes: readonly ArchitectureEntity[],
  relations: readonly ArchitectureRelation[],
  band: C4Band,
): string {
  const included = new Set(nodes.map(entity => entity.id));
  const lines = [
    `%% okie-one-pager ${JSON.stringify({ band, nodeCount: nodes.length })}`,
    'flowchart TB',
  ];
  for (const entity of nodes) {
    lines.push(`  %% okie-entity ${JSON.stringify({ semanticEntityId: entity.id })}`);
    lines.push(`  ${mermaidSafeIdentifier(entity.id)}["${escapeMermaidLabel(entity.name)}"]`);
  }
  const containment = new Set<string>();
  for (const entity of nodes) {
    if (!entity.parentId || !included.has(entity.parentId)) continue;
    const key = `${entity.parentId}->${entity.id}`;
    containment.add(key);
    lines.push(`  ${mermaidSafeIdentifier(entity.parentId)} --> ${mermaidSafeIdentifier(entity.id)}`);
  }
  const graphRelations = relations
    .filter(relation => (
      GRAPH_RELATION_KINDS.has(relation.kind)
      && included.has(relation.from)
      && included.has(relation.to)
      && relation.from !== relation.to
      && !containment.has(`${relation.from}->${relation.to}`)
    ))
    .sort((left, right) => compareId(left.id, right.id));
  for (const relation of graphRelations) {
    const label = escapeMermaidLabel(relation.label?.trim() || relation.kind);
    lines.push(`  ${mermaidSafeIdentifier(relation.from)} -->|"${label}"| ${mermaidSafeIdentifier(relation.to)}`);
  }
  return `${lines.join('\n')}\n`;
}

export type BuildScanOnePagerInput = {
  snapshot: ArchitectureSnapshot;
  childCounts?: Record<string, number>;
  band?: C4Band | string;
};

/**
 * Atlas-scoped one-pager for a frozen scan (or golden) snapshot. Copy is
 * accepted `responsibility` when present; otherwise a deterministic count
 * sentence. Mermaid is generated from entities/relations only — names, not
 * paths, evidence, or gate-reject reasons.
 */
export function buildScanOnePager(input: BuildScanOnePagerInput): ScanOnePager {
  const band = onePagerBand(input.band);
  const entities = [...input.snapshot.entities].sort(byId);
  const system = entities.find(entity => entity.kind === 'softwareSystem');
  const containers = entities.filter(entity => (
    isContainerKind(entity.kind)
    && (!system || entity.parentId === system.id || entity.parentId === undefined)
  ));
  const publishedContainerCount = system && input.childCounts?.[system.id] !== undefined
    ? input.childCounts[system.id]!
    : containers.length;
  const entityCount = entities.length;
  const systemName = system?.name.trim() || 'This system';
  const accepted = inspectorAcceptedSummary(system);
  const systemSummary = accepted ?? structuralSystemSummary(systemName, publishedContainerCount, entityCount);
  const listedContainers: ScanOnePagerContainer[] = containers.map(entity => {
    const summary = inspectorAcceptedSummary(entity);
    return {
      id: entity.id,
      name: entity.name,
      kind: entity.kind,
      ...(summary ? { summary } : {}),
    };
  });
  const { nodes, omitted } = selectGraphEntities(entities, band, ONE_PAGER_MAX_NODES);
  return {
    ...(system ? { systemId: system.id } : {}),
    systemName,
    systemSummary,
    systemSummaryKind: accepted ? 'accepted' : 'structural',
    containers: listedContainers,
    containerCount: publishedContainerCount,
    entityCount,
    omittedContainerCount: Math.max(0, publishedContainerCount - listedContainers.length),
    mermaidSource: serializeOnePagerMermaid(nodes, input.snapshot.relations, band),
    mermaidTitle: mermaidTitleForBand(band),
    band,
    graphNodeCount: nodes.length,
    graphOmittedCount: omitted,
  };
}

/** Test helper: one-pager payloads must never echo host paths or credential-shaped text. */
export const ONE_PAGER_LEAK = /(?:^|[\s'"=`])(?:\/(?:Users|home|root|opt|var|etc|tmp)\/|[A-Za-z]:\\|\.env\b|scanRoot|OPENROUTER|api[_-]?key|gho_|ghp_|github_pat_|sk-|AKIA)/iu;

export function onePagerLeaksSecretsOrHostPaths(pager: ScanOnePager): string[] {
  const blobs = [
    pager.systemName,
    pager.systemSummary,
    pager.mermaidSource,
    pager.mermaidTitle,
    ...pager.containers.flatMap(container => [container.name, container.summary ?? '']),
  ];
  return blobs.filter(text => ONE_PAGER_LEAK.test(text));
}

export function onePagerIncludesEntityPath(pager: ScanOnePager, entity: ArchitectureEntity): boolean {
  const paths = entity.sourceRefs.map(ref => ref.path).filter(Boolean);
  if (paths.length === 0) return false;
  const haystack = `${pager.systemSummary}\n${pager.mermaidSource}\n${pager.containers.map(item => `${item.name}\n${item.summary ?? ''}`).join('\n')}`;
  return paths.some(path => haystack.includes(path));
}
