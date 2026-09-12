import { inspectorAcceptedSummary } from './inspectorPanel';
import type { ArchitectureSnapshot } from '@okie/architecture';

export interface ContextualOverviewLink { id: string; name: string; relationship: string; }
export interface ContextualOverview {
  entity: { id: string; name: string; kind: string; summary?: string };
  parent?: { id: string; name: string; kind: string };
  children: ContextualOverviewLink[];
  dependencies: ContextualOverviewLink[];
  dependents: ContextualOverviewLink[];
}

export function buildContextualOverview(snapshot: ArchitectureSnapshot, entityId: string): ContextualOverview | undefined {
  const entity = snapshot.entities.find((candidate) => candidate.id === entityId);
  if (!entity) return undefined;
  const entities = new Map(snapshot.entities.map((candidate) => [candidate.id, candidate]));
  const link = (id: string, relationship: string): ContextualOverviewLink => ({ id, name: entities.get(id)?.name ?? id, relationship });
  const order = (items: ContextualOverviewLink[]) => Array.from(new Map(items.map(item => [`${item.id}:${item.relationship}`, item])).values()).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const parent = entity.parentId ? entities.get(entity.parentId) : undefined;
  return {
    entity: { id: entity.id, name: entity.name, kind: entity.kind, summary: inspectorAcceptedSummary(entity) },
    parent: parent ? { id: parent.id, name: parent.name, kind: parent.kind } : undefined,
    children: order(snapshot.entities.filter((candidate) => candidate.parentId === entityId).map((candidate) => link(candidate.id, candidate.kind))),
    dependencies: order(snapshot.relations.filter((relation) => relation.from === entityId && relation.to !== entityId).map((relation) => link(relation.to, relation.label ?? relation.kind))),
    dependents: order(snapshot.relations.filter((relation) => relation.to === entityId && relation.from !== entityId).map((relation) => link(relation.from, relation.label ?? relation.kind))),
  };
}
