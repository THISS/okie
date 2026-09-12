import type { ArchitectureSnapshot } from '@okie/architecture';
import type { AtlasScene } from '../renderer/types';

export type RelationshipMapStatus = 'shown' | 'aggregated' | 'hidden' | 'unavailable';

export interface CanonicalRelationshipRow {
  relationId: string;
  direction: 'outbound' | 'inbound' | 'recursive';
  group: string;
  counterpartId: string;
  counterpartName: string;
  label: string;
  mapStatus: RelationshipMapStatus;
  shownVisualRelationIds: string[];
}

export interface CanonicalRelationshipGroup {
  id: string;
  label: string;
  rows: CanonicalRelationshipRow[];
}

const groupRank: Record<string, number> = { 'calls-out': 0, 'called-by': 1, 'uses-out': 2, 'used-by': 3, recursive: 4 };

function groupFor(kind: string, direction: CanonicalRelationshipRow['direction']): string {
  if (direction === 'recursive') return 'recursive';
  if (kind === 'calls') return direction === 'outbound' ? 'calls-out' : 'called-by';
  return direction === 'outbound' ? 'uses-out' : 'used-by';
}

function groupLabel(group: string): string {
  return { 'calls-out': 'Calls', 'called-by': 'Called by', 'uses-out': 'Uses', 'used-by': 'Used by', recursive: 'Recursive relationships' }[group] ?? group;
}

export function canonicalRelationshipGroupsForEntity(
  snapshot: ArchitectureSnapshot,
  scene: AtlasScene,
  visibleVisualRelationIds: ReadonlySet<string>,
  entityId: string,
  visibleEntityIds?: ReadonlySet<string>,
): CanonicalRelationshipGroup[] {
  const names = new Map(snapshot.entities.map((entity) => [entity.id, entity.name]));
  const sceneRelationIds = new Set(scene.relations.map((relation) => relation.id));
  const projection = scene.projection?.semanticToVisualRelationIds ?? {};
  const groups = new Map<string, CanonicalRelationshipRow[]>();
  const seen = new Set<string>();
  const projected = [...scene.relations, ...Object.values(scene.projection?.projectedRelationsByDetail ?? {}).flat()];
  for (const relation of snapshot.relations) {
    if (seen.has(relation.id)) continue;
    seen.add(relation.id);
    if (relation.from !== entityId && relation.to !== entityId) continue;
    const direction = relation.from === relation.to ? 'recursive' : relation.from === entityId ? 'outbound' : 'inbound';
    const counterpartId = direction === 'inbound' ? relation.from : relation.to;
    const visualIds = projection[relation.id] ?? (sceneRelationIds.has(relation.id) ? [relation.id] : []);
    const shownVisualRelationIds = [...new Set([...visualIds, ...projected.filter(edge => edge.semanticIds?.includes(relation.id)).map(edge => edge.id)])]
      .filter(id => visibleVisualRelationIds.has(id))
      .filter(id => !visibleEntityIds || projected.some(edge => edge.id === id && visibleEntityIds.has(edge.from) && visibleEntityIds.has(edge.to)));
    const individuallyShown = shownVisualRelationIds.some(id => projected.some(edge => edge.id === id
      && edge.from === relation.from && edge.to === relation.to && (edge.semanticIds?.length ?? 1) <= 1));
    const mapStatus: RelationshipMapStatus = individuallyShown ? 'shown' : shownVisualRelationIds.length ? 'aggregated' : 'hidden';
    const group = groupFor(relation.kind, direction);
    const rows = groups.get(group) ?? [];
    rows.push({ relationId: relation.id, direction, group, counterpartId, counterpartName: names.get(counterpartId) ?? counterpartId, label: relation.label ?? relation.kind, mapStatus, shownVisualRelationIds });
    groups.set(group, rows);
  }
  return [...groups.entries()].sort(([left], [right]) => (groupRank[left] ?? 99) - (groupRank[right] ?? 99) || left.localeCompare(right)).map(([id, rows]) => ({
    id,
    label: groupLabel(id),
    rows: rows.sort((left, right) => left.counterpartName.localeCompare(right.counterpartName) || left.label.localeCompare(right.label) || left.relationId.localeCompare(right.relationId)),
  }));
}
