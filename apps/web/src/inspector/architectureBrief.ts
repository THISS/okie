import {
  type ArchitectureEntity,
  type ArchitectureRelation,
  type ArchitectureSnapshot,
  type EntityKind,
} from '@okie/architecture';
import { escapeMermaidLabel, mermaidSafeIdentifier } from '@okie/scene-compiler';
import { inspectorAcceptedSummary } from './inspectorPanel';
import {
  ONE_PAGER_LEAK,
  ONE_PAGER_MAX_NODES,
  structuralSystemSummary,
  type ScanOnePagerContainer,
} from './scanOnePager';

/** Inline brief diagrams stay readable in the inspector document, not a giant atlas dump. */
export const BRIEF_MAX_NODES = ONE_PAGER_MAX_NODES;
export const BRIEF_MAX_FLOWS = 16;

const CONTAINER_KINDS: ReadonlySet<EntityKind> = new Set(['container', 'dataStore', 'queue']);
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

export type ArchitectureBriefContainer = ScanOnePagerContainer & {
  kindLabel: string;
  technology?: string[];
};

export type ArchitectureBriefFlow = {
  id: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  label: string;
};

export type ArchitectureBrief = {
  systemId?: string;
  systemName: string;
  systemSummary: string;
  systemSummaryKind: 'accepted' | 'structural';
  worldSentence?: string;
  containers: ArchitectureBriefContainer[];
  containerCount: number;
  omittedContainerCount: number;
  containerIntro: string;
  flows: ArchitectureBriefFlow[];
  omittedFlowCount: number;
  contextMermaid: string;
  contextMermaidTitle: string;
  flowsMermaid?: string;
  flowsMermaidTitle: string;
  graphNodeCount: number;
  graphOmittedCount: number;
  markdown: string;
};

export type BuildArchitectureBriefInput = {
  snapshot: ArchitectureSnapshot;
  childCounts?: Record<string, number>;
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

export function architectureKindLabel(kind: EntityKind): string {
  if (kind === 'softwareSystem') return 'software system';
  if (kind === 'externalSystem') return 'external system';
  if (kind === 'dataStore') return 'data store';
  return kind;
}

function joinEnglish(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function relationPhrase(relation: ArchitectureRelation): string {
  const explicit = relation.label?.trim();
  if (explicit) return explicit;
  return relation.kind.replace(/([a-z])([A-Z])/gu, '$1 $2').toLowerCase();
}

function markdownPlain(text: string): string {
  return text.replace(/\\/gu, '\\\\').replace(/`/gu, "'");
}

function mermaidFence(source: string): string {
  return `\`\`\`mermaid\n${source.replace(/\n$/u, '')}\n\`\`\``;
}

/**
 * Architecture-first rank for the brief graph: system, people, containers,
 * then unnamed third-party externals. Matches CLA-86 orientation (do not lead
 * with npm packages) without inventing copy for those externals.
 */
function briefContextRank(entities: readonly ArchitectureEntity[]): ArchitectureEntity[] {
  return [
    ...entities.filter(entity => entity.kind === 'softwareSystem').sort(byId),
    ...entities.filter(entity => entity.kind === 'person').sort(byId),
    ...entities.filter(entity => isContainerKind(entity.kind)).sort(byId),
    ...entities.filter(entity => entity.kind === 'externalSystem').sort(byId),
  ];
}

function serializeBriefMermaid(
  nodes: readonly ArchitectureEntity[],
  relations: readonly ArchitectureRelation[],
  options: { section: 'context' | 'flows'; direction: 'TB' | 'LR'; includeContainment: boolean },
): string {
  const included = new Set(nodes.map(entity => entity.id));
  const lines = [
    `%% okie-architecture-brief ${JSON.stringify({ section: options.section, nodeCount: nodes.length })}`,
    `flowchart ${options.direction}`,
  ];
  for (const entity of nodes) {
    lines.push(`  %% okie-entity ${JSON.stringify({ semanticEntityId: entity.id })}`);
    lines.push(`  ${mermaidSafeIdentifier(entity.id)}["${escapeMermaidLabel(entity.name)}"]`);
  }
  const containment = new Set<string>();
  if (options.includeContainment) {
    for (const entity of nodes) {
      if (!entity.parentId || !included.has(entity.parentId)) continue;
      const key = `${entity.parentId}->${entity.id}`;
      containment.add(key);
      lines.push(`  ${mermaidSafeIdentifier(entity.parentId)} --> ${mermaidSafeIdentifier(entity.id)}`);
    }
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
    lines.push(`  ${mermaidSafeIdentifier(relation.from)} -->|"${escapeMermaidLabel(relationPhrase(relation))}"| ${mermaidSafeIdentifier(relation.to)}`);
  }
  return `${lines.join('\n')}\n`;
}

function worldSentenceFor(
  systemName: string,
  persons: readonly ArchitectureEntity[],
  externals: readonly ArchitectureEntity[],
): string | undefined {
  if (persons.length === 0 && externals.length === 0) return undefined;
  const named = [
    ...persons.map(entity => entity.name),
    ...externals.filter(entity => inspectorAcceptedSummary(entity)).map(entity => entity.name),
  ];
  const unnamedExternals = externals.filter(entity => !inspectorAcceptedSummary(entity)).length;
  const parts = [...named];
  if (unnamedExternals === 1) parts.push('1 external system');
  else if (unnamedExternals > 1) parts.push(`${unnamedExternals} external systems`);
  if (parts.length === 0) return undefined;
  return `${systemName} meets the world through ${joinEnglish(parts)}.`;
}

function selectFlows(
  entities: readonly ArchitectureEntity[],
  relations: readonly ArchitectureRelation[],
  allowedIds: ReadonlySet<string>,
  maxNodes: number,
  maxEdges: number,
): { nodes: ArchitectureEntity[]; flows: ArchitectureBriefFlow[]; omitted: number } {
  const byEntityId = new Map(entities.map(entity => [entity.id, entity]));
  const candidates = relations
    .filter(relation => (
      GRAPH_RELATION_KINDS.has(relation.kind)
      && allowedIds.has(relation.from)
      && allowedIds.has(relation.to)
      && relation.from !== relation.to
    ))
    .sort((left, right) => compareId(left.id, right.id));
  const nodeIds = new Set<string>();
  const flows: ArchitectureBriefFlow[] = [];
  let omitted = 0;
  for (const relation of candidates) {
    const next = new Set(nodeIds);
    next.add(relation.from);
    next.add(relation.to);
    if (flows.length >= maxEdges || next.size > maxNodes) {
      omitted += 1;
      continue;
    }
    const from = byEntityId.get(relation.from);
    const to = byEntityId.get(relation.to);
    if (!from || !to) {
      omitted += 1;
      continue;
    }
    nodeIds.add(relation.from);
    nodeIds.add(relation.to);
    flows.push({
      id: relation.id,
      fromId: from.id,
      fromName: from.name,
      toId: to.id,
      toName: to.name,
      label: relationPhrase(relation),
    });
  }
  const nodes = [...nodeIds]
    .map(id => byEntityId.get(id))
    .filter((entity): entity is ArchitectureEntity => Boolean(entity))
    .sort(byId);
  return { nodes, flows, omitted };
}

function serializeArchitectureBriefMarkdown(brief: Omit<ArchitectureBrief, 'markdown'>): string {
  const lines: string[] = [
    `# ${markdownPlain(brief.systemName)}`,
    '',
    markdownPlain(brief.systemSummary),
    '',
    '## System',
    '',
  ];
  if (brief.worldSentence) {
    lines.push(markdownPlain(brief.worldSentence), '');
  }
  lines.push(mermaidFence(brief.contextMermaid), '');
  if (brief.graphOmittedCount > 0) {
    lines.push(`Diagram shows ${brief.graphNodeCount} of ${brief.graphNodeCount + brief.graphOmittedCount} nodes.`, '');
  }
  lines.push('## Containers', '', markdownPlain(brief.containerIntro), '');
  if (brief.containers.length === 0) {
    lines.push('No containers are in this snapshot neighborhood.', '');
  }
  for (const container of brief.containers) {
    lines.push(`### ${markdownPlain(container.name)}`, '');
    if (container.summary) lines.push(markdownPlain(container.summary), '');
    else lines.push(`${markdownPlain(container.name)} is a ${container.kindLabel}.`, '');
    if (container.technology?.length) {
      lines.push(`Technology: ${markdownPlain(container.technology.join(' · '))}.`, '');
    }
  }
  if (brief.omittedContainerCount > 0) {
    lines.push(`${brief.containers.length} of ${brief.containerCount} containers are loaded in this neighborhood.`, '');
  }
  lines.push('## Key flows', '');
  if (brief.flowsMermaid) {
    lines.push(mermaidFence(brief.flowsMermaid), '');
  }
  if (brief.flows.length === 0) {
    lines.push('No key flows are in this snapshot neighborhood.', '');
  } else {
    for (const flow of brief.flows) {
      lines.push(`- ${markdownPlain(flow.fromName)} ${markdownPlain(flow.label)} ${markdownPlain(flow.toName)}`);
    }
    lines.push('');
  }
  if (brief.omittedFlowCount > 0) {
    lines.push(`List shows ${brief.flows.length} of ${brief.flows.length + brief.omittedFlowCount} flows.`, '');
  }
  return lines.join('\n');
}

/**
 * Atlas-scoped markdown architecture brief for a published snapshot.
 * Copy is accepted `responsibility` when present; otherwise deterministic
 * names, kinds, counts, and relation labels. Mermaid is generated from
 * entities/relations only — never paths, evidence, or gate-reject reasons.
 */
export function buildArchitectureBrief(input: BuildArchitectureBriefInput): ArchitectureBrief {
  const entities = [...input.snapshot.entities].sort(byId);
  const system = entities.find(entity => entity.kind === 'softwareSystem');
  const containers = entities.filter(entity => (
    isContainerKind(entity.kind)
    && (!system || entity.parentId === system.id || entity.parentId === undefined)
  ));
  const persons = entities.filter(entity => entity.kind === 'person');
  const externals = entities.filter(entity => entity.kind === 'externalSystem');
  const publishedContainerCount = system && input.childCounts?.[system.id] !== undefined
    ? input.childCounts[system.id]!
    : containers.length;
  const entityCount = entities.length;
  const systemName = system?.name.trim() || 'This system';
  const accepted = inspectorAcceptedSummary(system);
  const systemSummary = accepted ?? structuralSystemSummary(systemName, publishedContainerCount, entityCount);
  const listedContainers: ArchitectureBriefContainer[] = containers.map(entity => {
    const summary = inspectorAcceptedSummary(entity);
    const technology = (entity.technology ?? []).map(item => item.trim()).filter(Boolean);
    return {
      id: entity.id,
      name: entity.name,
      kind: entity.kind,
      kindLabel: architectureKindLabel(entity.kind),
      ...(summary ? { summary } : {}),
      ...(technology.length ? { technology } : {}),
    };
  });
  const ranked = briefContextRank(entities);
  const contextNodes = ranked.slice(0, BRIEF_MAX_NODES);
  const graphOmittedCount = Math.max(0, ranked.length - contextNodes.length);
  const allowedIds = new Set(ranked.map(entity => entity.id));
  const { nodes: flowNodes, flows, omitted: omittedFlowCount } = selectFlows(
    entities,
    input.snapshot.relations,
    allowedIds,
    BRIEF_MAX_NODES,
    BRIEF_MAX_FLOWS,
  );
  const containerLabel = publishedContainerCount === 1 ? 'container' : 'containers';
  const containerIntro = `${systemName} includes ${publishedContainerCount} ${containerLabel}.`;
  const contextMermaid = serializeBriefMermaid(contextNodes, input.snapshot.relations, {
    section: 'context',
    direction: 'TB',
    includeContainment: true,
  });
  const flowsMermaid = flows.length > 0
    ? serializeBriefMermaid(flowNodes, input.snapshot.relations.filter(relation => flows.some(flow => flow.id === relation.id)), {
      section: 'flows',
      direction: 'LR',
      includeContainment: false,
    })
    : undefined;
  const worldSentence = worldSentenceFor(systemName, persons, externals);
  const brief = {
    ...(system ? { systemId: system.id } : {}),
    systemName,
    systemSummary,
    systemSummaryKind: accepted ? 'accepted' as const : 'structural' as const,
    ...(worldSentence ? { worldSentence } : {}),
    containers: listedContainers,
    containerCount: publishedContainerCount,
    omittedContainerCount: Math.max(0, publishedContainerCount - listedContainers.length),
    containerIntro,
    flows,
    omittedFlowCount,
    contextMermaid,
    contextMermaidTitle: 'L1 → L2 · context → containers',
    ...(flowsMermaid ? { flowsMermaid } : {}),
    flowsMermaidTitle: 'Key flows',
    graphNodeCount: contextNodes.length,
    graphOmittedCount,
  };
  return {
    ...brief,
    markdown: serializeArchitectureBriefMarkdown(brief),
  };
}

export function architectureBriefLeaksSecretsOrHostPaths(brief: ArchitectureBrief): string[] {
  const blobs = [
    brief.markdown,
    brief.systemName,
    brief.systemSummary,
    brief.worldSentence ?? '',
    brief.containerIntro,
    brief.contextMermaid,
    brief.flowsMermaid ?? '',
    ...brief.containers.flatMap(container => [container.name, container.summary ?? '', container.technology?.join(' ') ?? '']),
    ...brief.flows.flatMap(flow => [flow.fromName, flow.toName, flow.label]),
  ];
  return blobs.filter(text => ONE_PAGER_LEAK.test(text));
}

export function architectureBriefIncludesEntityPath(brief: ArchitectureBrief, entity: ArchitectureEntity): boolean {
  const paths = entity.sourceRefs.map(ref => ref.path).filter(Boolean);
  if (paths.length === 0) return false;
  return paths.some(path => brief.markdown.includes(path));
}

/** Marketing verbs that structural (unenriched) copy must never invent. */
export const STRUCTURAL_INVENTED_PROSE = /\b(?:presents|enables|helps|allows users|designed to|empowers|unlocks)\b/iu;
