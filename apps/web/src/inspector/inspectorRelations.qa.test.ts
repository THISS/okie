import { describe, expect, it } from 'vitest';
import type { ArchitectureEntity, ArchitectureRelation, ArchitectureSnapshot, EntityKind } from '@okie/architecture';
import { createC4Scene, createGoldenC4Scene } from '../renderer/goldenC4Scene';
import { canvasRelationRowsInIsolate, canvasRelationsForEntity } from './inspectorSupport';
import type { AtlasScene, SemanticDetail } from '../renderer/types';

/**
 * Acceptance contract: the inspector's Relationships section is a reading of the
 * canvas, not a second query over canonical relations. Every edge a band draws on
 * the selected card is one row; the two things the canvas dropped are reported
 * separately and honestly. See docs/product/golden-okie-hierarchy.md
 * ("Relation projection rules").
 */

function entity(id: string, kind: EntityKind, parentId?: string): ArchitectureEntity {
  return { id, name: id, kind, sourceRefs: [], ...(parentId ? { parentId } : {}) };
}

function relation(id: string, from: string, to: string, kind: ArchitectureRelation['kind'] = 'uses'): ArchitectureRelation {
  return { id, from, to, kind, evidence: [{ source: { path: `${id}.ts`, commitSha: 'sha' } }] };
}

function snapshot(entities: ArchitectureEntity[], relations: ArchitectureRelation[]): ArchitectureSnapshot {
  return {
    schemaVersion: 1,
    id: 'snapshot:scan',
    repositoryId: 'repo:scan',
    commitSha: 'sha',
    generatedAt: '2026-01-01T00:00:00Z',
    entities,
    relations,
  };
}

/** A scan-shaped repository: no authored L1/L2 prose, only observed file-level facts. */
const scanSnapshot = snapshot(
  [
    entity('system:app', 'softwareSystem'),
    entity('external:db', 'externalSystem'),
    entity('container:web', 'container', 'system:app'),
    entity('container:api', 'container', 'system:app'),
    entity('component:web-x', 'component', 'container:web'),
    entity('component:api-y', 'component', 'container:api'),
    entity('code:w1', 'code', 'component:web-x'),
    entity('code:w2', 'code', 'component:web-x'),
    entity('code:a1', 'code', 'component:api-y'),
  ],
  [
    relation('rel:w1-w2', 'code:w1', 'code:w2', 'calls'),
    relation('rel:w1-a1', 'code:w1', 'code:a1'),
    relation('rel:w2-a1', 'code:w2', 'code:a1'),
    relation('rel:a1-db', 'code:a1', 'external:db', 'reads'),
  ],
);

function scanScene(maxEdgesPerBand?: number): AtlasScene {
  return createC4Scene({
    baseSnapshot: scanSnapshot,
    rootEntityId: 'system:app',
    focusEntityId: 'system:app',
    familyId: 'view-family:scan',
    sceneId: 'scan-c4',
    title: 'Scan',
    subtitle: 'Scan',
    frozenRevision: 'sha',
    ...(maxEdgesPerBand !== undefined ? { maxEdgesPerBand } : {}),
  });
}

/** Exactly what the band draws: the compiled edges the renderer is handed. */
function drawnEdgeIds(scene: AtlasScene, detail: SemanticDetail): string[] {
  return scene.projection!.projectedRelationsByDetail[detail].map(edge => edge.id);
}

describe('L1 inspector follows the canvas', () => {
  it('rows every projected edge drawn on the selected card, one row per edge', () => {
    const scene = scanScene();
    const drawn = drawnEdgeIds(scene, 'context');
    const presentation = canvasRelationsForEntity(scene, drawn, 'system:app', 'context');
    const drawnOnCard = scene.projection!.projectedRelationsByDetail.context
      .filter(edge => edge.from === 'system:app' || edge.to === 'system:app');

    expect(drawnOnCard.length).toBeGreaterThan(0);
    expect(presentation.rows.map(row => row.id)).toEqual(drawnOnCard.map(edge => edge.id));
    // The underlying relation is a file-level fact; the canonical endpoints are
    // never system:app, which is exactly what the old filtering dropped.
    expect(presentation.rows[0]).toMatchObject({ relationId: 'rel:a1-db', direction: 'outbound', count: 1 });
    expect(scene.relations.find(candidate => candidate.id === 'rel:a1-db'))
      .toMatchObject({ from: 'code:a1', to: 'external:db' });
  });

  it('collapses one visual edge into one row carrying the underlying relation count', () => {
    const scene = scanScene();
    const rows = canvasRelationsForEntity(scene, drawnEdgeIds(scene, 'container'), 'container:web', 'container').rows;

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ count: 2, semanticIds: ['rel:w1-a1', 'rel:w2-a1'], direction: 'outbound' });
    expect(rows[0]!.counterpart.id).toBe('container:api');
    // Collapsed rows never enumerate their relations — one row, deterministic plural label.
    expect(rows[0]!.label).toBe('2 uses');
  });

  it('reports "Hiding N" only for the internals the canvas dropped at this band', () => {
    const scene = scanScene();
    const l1 = canvasRelationsForEntity(scene, drawnEdgeIds(scene, 'context'), 'system:app', 'context');
    const l2Web = canvasRelationsForEntity(scene, drawnEdgeIds(scene, 'container'), 'container:web', 'container');
    const l2Api = canvasRelationsForEntity(scene, drawnEdgeIds(scene, 'container'), 'container:api', 'container');

    // L1: every relation between two parts of the system self-projects and is dropped.
    expect(l1.hiddenInternalCount).toBe(3);
    // L2: the cross-container traffic is drawn now, so only the in-container relation hides.
    expect(l2Web.hiddenInternalCount).toBe(1);
    expect(l2Api.hiddenInternalCount).toBe(0);
    // Nothing drawn is ever also counted as hidden.
    const drawnRelationIds = new Set(l1.rows.flatMap(row => row.semanticIds));
    expect(l1.hiddenInternalCount + drawnRelationIds.size).toBe(scene.relations.length);
  });

  it('reports "+N more" for the edges a budgeted compile left unrouted', () => {
    const scene = scanScene(1);
    const drawn = drawnEdgeIds(scene, 'container');
    const api = canvasRelationsForEntity(scene, drawn, 'container:api', 'container');

    expect(scene.omittedEdges?.length).toBeGreaterThan(0);
    expect(drawn).toHaveLength(1);
    expect(api.omittedEdgeCount).toBe(1);
    expect(api.omittedRelationCount).toBe(1);
    // The omitted edge is attributed to the cards it touches and to nobody else.
    expect(canvasRelationsForEntity(scene, drawn, 'container:web', 'container').omittedEdgeCount).toBe(0);
    // An unrouted edge is never also a row.
    expect(api.rows.map(row => row.id)).not.toContain(scene.omittedEdges![0]!.edgeId);
  });

  it('leaves the golden L1 card unchanged: three drawn context edges, all evidence-backed', () => {
    const scene = createGoldenC4Scene();
    const drawn = drawnEdgeIds(scene, 'context');
    const okie = canvasRelationsForEntity(scene, drawn, 'system:okie', 'context');

    expect(okie.rows.map(row => `${row.directionLabel}:${row.relationId}`)).toEqual([
      'IN:relation:developer-explores-okie',
      'OUT:relation:okie-renders-browser',
      'OUT:relation:okie-source-evidence',
    ]);
    expect(okie.rows.every(row => row.count === 1)).toBe(true);
    expect(okie.omittedEdgeCount).toBe(0);
    // No fake +N more: leftover omittedRelations are not a second remainder.
    expect(okie.omittedRelationCount).toBe(0);
    // The golden fixture keeps 31 evidence-backed internal relations below L1.
    expect(okie.hiddenInternalCount).toBe(scene.relations.length - okie.rows.length);
    expect(okie.hiddenInternalCount).toBe(31);
  });

  it('does not stack leftover omittedRelations on top of hidden internals', () => {
    const scene = scanScene();
    scene.rootEntityId = 'system:app';
    scene.omittedEdges = [];
    const drawn = drawnEdgeIds(scene, 'context');
    const l1 = canvasRelationsForEntity(scene, drawn, 'system:app', 'context');
    // Live L1 leftover dump is (most of) the internals, not a second set.
    scene.omittedRelations = scene.relations
      .filter(relation => !l1.rows.some(row => row.semanticIds.includes(relation.id)))
      .map(relation => ({
        relationId: relation.id,
        fromName: relation.from,
        toName: relation.to,
        label: relation.label ?? 'uses',
        evidencePaths: [],
      }));

    const stacked = canvasRelationsForEntity(scene, drawn, 'system:app', 'context');
    expect(stacked.rows).toHaveLength(1);
    expect(stacked.hiddenInternalCount).toBe(3);
    expect(stacked.omittedEdgeCount).toBe(0);
    expect(stacked.omittedRelationCount).toBe(0);
    expect(stacked.rows.length + stacked.hiddenInternalCount).toBe(scene.relations.length);
  });

  it('Isolate keeps the projected L1 row the canvas draws when canonical ends are not isolated', () => {
    const scene = scanScene();
    const drawn = drawnEdgeIds(scene, 'context');
    const presentation = canvasRelationsForEntity(scene, drawn, 'system:app', 'context');
    const isolateSet = new Set(['system:app', 'external:db']);

    expect(presentation.rows[0]).toMatchObject({ relationId: 'rel:a1-db', direction: 'outbound' });
    expect(scene.relations.find(candidate => candidate.id === 'rel:a1-db'))
      .toMatchObject({ from: 'code:a1', to: 'external:db' });
    expect(isolateSet.has('code:a1')).toBe(false);
    expect(scene.relations.filter(relation => isolateSet.has(relation.from) && isolateSet.has(relation.to)))
      .toEqual([]);
    expect(canvasRelationRowsInIsolate(presentation.rows, 'system:app', isolateSet).map(row => row.id))
      .toEqual(presentation.rows.map(row => row.id));
    expect(canvasRelationRowsInIsolate(presentation.rows, 'system:app', new Set(['system:app']))).toEqual([]);
  });

  it('Isolate does not change golden L1 rows when both visual ends are isolated', () => {
    const scene = createGoldenC4Scene();
    const rows = canvasRelationsForEntity(scene, drawnEdgeIds(scene, 'context'), 'system:okie', 'context').rows;
    const visualEnds = new Set(['system:okie', ...rows.map(row => row.counterpart.id)]);

    expect(rows.map(row => `${row.directionLabel}:${row.relationId}`)).toEqual([
      'IN:relation:developer-explores-okie',
      'OUT:relation:okie-renders-browser',
      'OUT:relation:okie-source-evidence',
    ]);
    expect(canvasRelationRowsInIsolate(rows, 'system:okie', visualEnds)).toEqual(rows);
  });

  it('shows relations and evidence with empty enrich copy', () => {
    const scene = scanScene();
    const okie = canvasRelationsForEntity(scene, drawnEdgeIds(scene, 'context'), 'system:app', 'context');

    // Deterministic layer only: no summaries were authored, and the rows still stand.
    expect(scene.entities.find(candidate => candidate.id === 'system:app')?.responsibility)
      .toBe('No summary supplied.');
    expect(okie.rows).toHaveLength(1);
    expect(okie.rows[0]!.semanticIds.every(id => scene.relations.some(candidate => candidate.id === id))).toBe(true);
  });
});
