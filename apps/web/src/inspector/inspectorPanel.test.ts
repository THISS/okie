import { describe, expect, it } from 'vitest';
import {
  clampInspectorWidth,
  defaultInspectorWidth,
  inspectorAcceptedSummary,
  inspectorCanShowSource,
  inspectorCyclomatic,
  inspectorDuplicates,
  inspectorNotationScope,
  inspectorPathOwners,
  inspectorTabForEntity,
  inspectorWidthRange,
  inspectorWidthStorageKey,
  presentInspectorNotationDiagnostics,
  INSPECTOR_EMPTY_SUMMARY,
  INSPECTOR_NOTATION_ADVISORY_SAMPLE,
} from './inspectorPanel';
import { createC4Scene, createGoldenC4Scene } from '../renderer/goldenC4Scene';
import type {
  ArchitectureEntity,
  ArchitectureRelation,
  ArchitectureSnapshot,
  C4NotationCompletenessDiagnostic,
  EntityKind,
} from '@okie/architecture';

describe('inspector panel sizing', () => {
  it('defaults to a compact 376–416px pane and uses 360px at the compact breakpoint', () => {
    expect(defaultInspectorWidth(1_200)).toBe(376);
    expect(defaultInspectorWidth(1_440)).toBe(403);
    expect(defaultInspectorWidth(1_920)).toBe(416);
    expect(defaultInspectorWidth(1_060)).toBe(360);
  });

  it('clamps keyboard and pointer resizing to 360px–min(520px, 46vw)', () => {
    expect(inspectorWidthRange(1_200)).toEqual({ min: 360, max: 520 });
    expect(inspectorWidthRange(1_000)).toEqual({ min: 360, max: 460 });
    expect(clampInspectorWidth(200, 1_200)).toBe(360);
    expect(clampInspectorWidth(900, 1_200)).toBe(520);
    expect(clampInspectorWidth(404, 1_200)).toBe(404);
  });

  it('scopes persisted widths to the repository', () => {
    expect(inspectorWidthStorageKey('repo:okie')).toBe('okie:inspector-width:repo:okie');
  });

  it('opens portable code at Source while explicit canvas inspection and unavailable excerpts use Details', () => {
    expect(inspectorTabForEntity(true, 'auto')).toBe('source');
    expect(inspectorTabForEntity(true, 'source')).toBe('source');
    expect(inspectorTabForEntity(true, 'details')).toBe('details');
    expect(inspectorTabForEntity(false, 'source')).toBe('details');
    expect(inspectorTabForEntity(false, 'auto')).toBe('details');
  });
});

describe('inspector Source tab enablement', () => {
  const excerpt = { path: 'src/model.ts', lines: ['export const x = 1;'] };
  const sourceRef = { path: 'src/model.ts', revision: 'abc123' };
  const codeWithExcerpt = { detail: 'code' as const, sourceExcerpts: [excerpt], sourceRefs: [sourceRef] };
  const codeWithRefsOnly = { detail: 'code' as const, sourceRefs: [sourceRef] };
  const codeWithoutEvidence = { detail: 'code' as const };
  const componentWithRefs = { detail: 'component' as const, sourceRefs: [sourceRef], sourceExcerpts: [excerpt] };

  it('enables Source on a code entity with frozen excerpts or source refs', () => {
    expect(inspectorCanShowSource(codeWithExcerpt)).toBe(true);
    expect(inspectorCanShowSource(codeWithRefsOnly)).toBe(true);
    expect(inspectorTabForEntity(inspectorCanShowSource(codeWithExcerpt))).toBe('source');
    expect(inspectorTabForEntity(inspectorCanShowSource(codeWithRefsOnly))).toBe('source');
  });

  it('keeps Source disabled when the selected entity has no source evidence', () => {
    expect(inspectorCanShowSource(codeWithoutEvidence)).toBe(false);
    expect(inspectorCanShowSource({ detail: 'code', sourceExcerpts: [], sourceRefs: [] })).toBe(false);
    expect(inspectorCanShowSource(componentWithRefs)).toBe(false);
    expect(inspectorCanShowSource(codeWithExcerpt, { pickedRelation: true })).toBe(false);
    expect(inspectorTabForEntity(inspectorCanShowSource(codeWithoutEvidence))).toBe('details');
  });

  it('enables Source on golden L4 entities from excerpts or refs, and not without evidence', () => {
    const scene = createGoldenC4Scene();
    const code = scene.entities.find(entity => entity.id === 'code:model-scoping:select-scoped-view')!;
    const parent = scene.entities.find(entity => entity.id === 'component:model-scoping')!;
    const system = scene.entities.find(entity => entity.id === 'system:okie')!;

    expect(code.detail).toBe('code');
    expect(code.sourceExcerpts?.length).toBeGreaterThan(0);
    expect(code.sourceRefs?.length).toBeGreaterThan(0);
    expect(inspectorCanShowSource(code)).toBe(true);
    expect(inspectorCanShowSource({ ...code, sourceExcerpts: undefined })).toBe(true);
    expect(inspectorCanShowSource({ ...code, sourceExcerpts: undefined, sourceRefs: undefined })).toBe(false);
    expect(inspectorCanShowSource(parent)).toBe(false);
    expect(inspectorCanShowSource(system)).toBe(false);
  });
});

function scanEntity(id: string, kind: EntityKind, parentId?: string): ArchitectureEntity {
  return { id, name: id, kind, sourceRefs: kind === 'code' ? [{ path: `${id}.ts`, commitSha: 'sha' }] : [], ...(parentId ? { parentId } : {}) };
}

function scanRelation(id: string, from: string, to: string): ArchitectureRelation {
  return { id, from, to, kind: 'uses', evidence: [{ source: { path: `${id}.ts`, commitSha: 'sha' } }] };
}

function scanSnapshot(entities: ArchitectureEntity[], relations: ArchitectureRelation[]): ArchitectureSnapshot {
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

describe('inspector accepted section summaries (CLA-26)', () => {
  it('returns authored or accepted copy and ignores blank or placeholder enrich copy', () => {
    expect(inspectorAcceptedSummary({ responsibility: 'Hosts the scan server.' })).toBe('Hosts the scan server.');
    expect(inspectorAcceptedSummary({ responsibility: '  Trimmed summary.  ' })).toBe('Trimmed summary.');
    expect(inspectorAcceptedSummary({ responsibility: INSPECTOR_EMPTY_SUMMARY })).toBeUndefined();
    expect(inspectorAcceptedSummary({ responsibility: ` ${INSPECTOR_EMPTY_SUMMARY} ` })).toBeUndefined();
    expect(inspectorAcceptedSummary({ responsibility: '' })).toBeUndefined();
    expect(inspectorAcceptedSummary({ responsibility: '   ' })).toBeUndefined();
    expect(inspectorAcceptedSummary({})).toBeUndefined();
    expect(inspectorAcceptedSummary(undefined)).toBeUndefined();
  });

  it('shows golden container and code summaries in Details', () => {
    const scene = createGoldenC4Scene();
    const container = scene.entities.find(entity => entity.id === 'container:web-app')!;
    const code = scene.entities.find(entity => entity.id === 'code:web-shell:app')!;

    expect(inspectorAcceptedSummary(container)).toBe(container.responsibility);
    expect(inspectorAcceptedSummary(code)).toBe(code.responsibility);
    expect(container.responsibility).not.toBe(INSPECTOR_EMPTY_SUMMARY);
    expect(code.responsibility).not.toBe(INSPECTOR_EMPTY_SUMMARY);
  });

  it('keeps Details/Source available when enrichment is off, skipped, or rejected', () => {
    const scene = createC4Scene({
      baseSnapshot: scanSnapshot(
        [
          scanEntity('system:app', 'softwareSystem'),
          scanEntity('container:web', 'container', 'system:app'),
          scanEntity('component:web-x', 'component', 'container:web'),
          scanEntity('code:w1', 'code', 'component:web-x'),
        ],
        [scanRelation('rel:w1-app', 'code:w1', 'system:app')],
      ),
      rootEntityId: 'system:app',
      focusEntityId: 'system:app',
      familyId: 'view-family:scan',
      sceneId: 'scan-c4',
      title: 'Scan',
      subtitle: 'Scan',
      frozenRevision: 'sha',
    });
    const container = scene.entities.find(entity => entity.id === 'container:web')!;
    const code = scene.entities.find(entity => entity.id === 'code:w1')!;

    expect(container.responsibility).toBe(INSPECTOR_EMPTY_SUMMARY);
    expect(code.responsibility).toBe(INSPECTOR_EMPTY_SUMMARY);
    expect(inspectorAcceptedSummary(container)).toBeUndefined();
    expect(inspectorAcceptedSummary(code)).toBeUndefined();
    expect(inspectorCanShowSource(code)).toBe(true);
    expect(inspectorTabForEntity(inspectorCanShowSource(container))).toBe('details');
    expect(inspectorTabForEntity(inspectorCanShowSource(code))).toBe('source');
    expect(code.sourceRefs?.length).toBeGreaterThan(0);
  });
});

describe('scanned portable source excerpts (CLA-54)', () => {
  it('shows a portable excerpt on a scanned code entity and keeps containers sourceless', () => {
    const lines = [
      'export function inspectorAcceptedSummary(',
      '  entity: InspectorSummaryEntity | undefined,',
      '): string | undefined {',
      '  const text = entity?.responsibility?.trim();',
      '  if (!text || text === INSPECTOR_EMPTY_SUMMARY) return undefined;',
      '  return text;',
      '}',
    ];
    const excerpt = {
      path: 'apps/web/src/inspector/inspectorPanel.ts',
      symbol: 'inspectorAcceptedSummary',
      language: 'typescript' as const,
      startLine: 83,
      endLine: 89,
      highlightLine: 83,
      frozenRevision: 'sha',
      lines,
      text: lines.join('\n'),
    };
    const scene = createC4Scene({
      baseSnapshot: scanSnapshot(
        [
          scanEntity('system:app', 'softwareSystem'),
          {
            ...scanEntity('container:web', 'container', 'system:app'),
            sourceRefs: [{ path: 'apps/web/package.json', commitSha: 'sha' }],
          },
          scanEntity('component:web-inspector', 'component', 'container:web'),
          {
            id: 'code:apps-web-src-inspector-inspector-panel-ts:inspector-accepted-summary',
            name: 'inspectorAcceptedSummary',
            kind: 'code',
            parentId: 'component:web-inspector',
            sourceRefs: [{
              path: excerpt.path,
              symbol: excerpt.symbol,
              commitSha: 'sha',
              startLine: excerpt.startLine,
              endLine: excerpt.endLine,
            }],
            sourceExcerpts: [excerpt],
          },
        ],
        [scanRelation('rel:web-app', 'container:web', 'system:app')],
      ),
      rootEntityId: 'system:app',
      focusEntityId: 'system:app',
      familyId: 'view-family:scan',
      sceneId: 'scan-c4',
      title: 'Scan',
      subtitle: 'Scan',
      frozenRevision: 'sha',
    });
    const code = scene.entities.find(entity => entity.name === 'inspectorAcceptedSummary')!;
    const container = scene.entities.find(entity => entity.id === 'container:web')!;

    expect(code.detail).toBe('code');
    expect(code.sourceExcerpts?.[0]?.text).toContain('export function inspectorAcceptedSummary(');
    expect(inspectorCanShowSource(code)).toBe(true);
    expect(inspectorTabForEntity(inspectorCanShowSource(code))).toBe('source');
    expect(container.detail).toBe('container');
    expect(container.sourceExcerpts).toBeUndefined();
    expect(inspectorCanShowSource(container)).toBe(false);
    expect(inspectorTabForEntity(inspectorCanShowSource(container))).toBe('details');
  });
});

describe('inspector CODEOWNERS path owners (CLA-51)', () => {
  it('lists observed owners when present and omits the section when absent', () => {
    expect(inspectorPathOwners({ owners: ['@acme/a-team', ' @alice ', '@acme/a-team'] })).toEqual(['@acme/a-team', '@alice']);
    expect(inspectorPathOwners({ owners: ['@alice'] })).toEqual(['@alice']);
    expect(inspectorPathOwners({ owners: [] })).toEqual([]);
    expect(inspectorPathOwners({ owners: ['  ', ''] })).toEqual([]);
    expect(inspectorPathOwners({})).toEqual([]);
    expect(inspectorPathOwners(undefined)).toEqual([]);
  });

  it('does not invent owners on the golden atlas or a scanned entity without CODEOWNERS', () => {
    const golden = createGoldenC4Scene();
    const system = golden.entities.find(entity => entity.id === 'system:okie')!;
    const container = golden.entities.find(entity => entity.id === 'container:web-app')!;
    const code = golden.entities.find(entity => entity.id === 'code:web-shell:app')!;
    expect(inspectorPathOwners(system)).toEqual([]);
    expect(inspectorPathOwners(container)).toEqual([]);
    expect(inspectorPathOwners(code)).toEqual([]);

    const scene = createC4Scene({
      baseSnapshot: scanSnapshot(
        [
          scanEntity('system:app', 'softwareSystem'),
          scanEntity('container:web', 'container', 'system:app'),
          scanEntity('component:web-x', 'component', 'container:web'),
          scanEntity('code:w1', 'code', 'component:web-x'),
        ],
        [scanRelation('rel:w1-app', 'code:w1', 'system:app')],
      ),
      rootEntityId: 'system:app',
      focusEntityId: 'system:app',
      familyId: 'view-family:scan',
      sceneId: 'scan-c4',
      title: 'Scan',
      subtitle: 'Scan',
      frozenRevision: 'sha',
    });
    expect(inspectorPathOwners(scene.entities.find(entity => entity.id === 'system:app'))).toEqual([]);
    expect(inspectorPathOwners(scene.entities.find(entity => entity.id === 'container:web'))).toEqual([]);
    expect(inspectorPathOwners(scene.entities.find(entity => entity.id === 'code:w1'))).toEqual([]);
  });

  it('shows fixture CODEOWNERS on compiled scan entities', () => {
    const scene = createC4Scene({
      baseSnapshot: {
        ...scanSnapshot(
          [
            { ...scanEntity('system:app', 'softwareSystem'), owners: ['@acme/a-team', '@acme/maintainers'] },
            { ...scanEntity('container:web', 'container', 'system:app'), owners: ['@acme/a-team'] },
            scanEntity('component:web-x', 'component', 'container:web'),
            { ...scanEntity('code:w1', 'code', 'component:web-x'), owners: ['@alice'] },
          ],
          [scanRelation('rel:w1-app', 'code:w1', 'system:app')],
        ),
      },
      rootEntityId: 'system:app',
      focusEntityId: 'system:app',
      familyId: 'view-family:scan',
      sceneId: 'scan-c4',
      title: 'Scan',
      subtitle: 'Scan',
      frozenRevision: 'sha',
    });
    expect(inspectorPathOwners(scene.entities.find(entity => entity.id === 'system:app'))).toEqual(['@acme/a-team', '@acme/maintainers']);
    expect(inspectorPathOwners(scene.entities.find(entity => entity.id === 'container:web'))).toEqual(['@acme/a-team']);
    expect(inspectorPathOwners(scene.entities.find(entity => entity.id === 'code:w1'))).toEqual(['@alice']);
    expect(inspectorPathOwners(scene.entities.find(entity => entity.id === 'component:web-x'))).toEqual([]);
  });
});

describe('inspector cyclomatic complexity (CLA-49)', () => {
  it('shows the McCabe number and flags only when complexity is greater than 6', () => {
    expect(inspectorCyclomatic({ cyclomaticComplexity: 1 })).toEqual({ complexity: 1, flagged: false });
    expect(inspectorCyclomatic({ cyclomaticComplexity: 6 })).toEqual({ complexity: 6, flagged: false });
    expect(inspectorCyclomatic({ cyclomaticComplexity: 7 })).toEqual({ complexity: 7, flagged: true });
    expect(inspectorCyclomatic({ cyclomaticComplexity: 10 })).toEqual({ complexity: 10, flagged: true });
    expect(inspectorCyclomatic({ cyclomaticComplexity: 0 })).toBeUndefined();
    expect(inspectorCyclomatic({ cyclomaticComplexity: 1.5 })).toBeUndefined();
    expect(inspectorCyclomatic({})).toBeUndefined();
    expect(inspectorCyclomatic(undefined)).toBeUndefined();
  });

  it('does not invent cyclomatic on the golden atlas and carries scan overlay onto compiled L4 nodes', () => {
    const golden = createGoldenC4Scene();
    const code = golden.entities.find(entity => entity.id === 'code:web-shell:app')!;
    expect(inspectorCyclomatic(code)).toBeUndefined();

    const scene = createC4Scene({
      baseSnapshot: scanSnapshot(
        [
          scanEntity('system:app', 'softwareSystem'),
          scanEntity('container:web', 'container', 'system:app'),
          scanEntity('component:web-x', 'component', 'container:web'),
          { ...scanEntity('code:simple', 'code', 'component:web-x'), cyclomaticComplexity: 1 },
          { ...scanEntity('code:tangled', 'code', 'component:web-x'), cyclomaticComplexity: 7 },
          scanEntity('code:alias', 'code', 'component:web-x'),
        ],
        [scanRelation('rel:simple-app', 'code:simple', 'system:app')],
      ),
      rootEntityId: 'system:app',
      focusEntityId: 'system:app',
      familyId: 'view-family:scan',
      sceneId: 'scan-c4',
      title: 'Scan',
      subtitle: 'Scan',
      frozenRevision: 'sha',
    });
    expect(inspectorCyclomatic(scene.entities.find(entity => entity.id === 'code:simple'))).toEqual({ complexity: 1, flagged: false });
    expect(inspectorCyclomatic(scene.entities.find(entity => entity.id === 'code:tangled'))).toEqual({ complexity: 7, flagged: true });
    expect(inspectorCyclomatic(scene.entities.find(entity => entity.id === 'code:alias'))).toBeUndefined();
    expect(inspectorCyclomatic(scene.entities.find(entity => entity.id === 'component:web-x'))).toBeUndefined();
    expect(scene.entities.map(entity => entity.id).filter(id => id.startsWith('code:')).sort()).toEqual([
      'code:alias',
      'code:simple',
      'code:tangled',
    ]);
  });
});

describe('inspector clone duplicates (CLA-61)', () => {
  it('lists existing counterpart ids from duplicates edges and ignores invented ids', () => {
    expect(inspectorDuplicates('code:alpha', [
      { from: 'code:alpha', to: 'code:beta', kind: 'duplicates' },
      { from: 'code:invented', to: 'code:alpha', kind: 'duplicates' },
      { from: 'code:alpha', to: 'code:gamma', kind: 'uses' },
    ], [
      { id: 'code:alpha', name: 'alpha' },
      { id: 'code:beta', name: 'beta' },
    ])).toEqual([{ id: 'code:beta', name: 'beta' }]);
    expect(inspectorDuplicates('code:alpha', [], [{ id: 'code:alpha', name: 'alpha' }])).toEqual([]);
    expect(inspectorDuplicates(undefined, [{ from: 'code:alpha', to: 'code:beta', kind: 'duplicates' }], [])).toEqual([]);
  });

  it('does not invent clones on the golden atlas and carries scan overlay onto compiled L4 nodes', () => {
    const golden = createGoldenC4Scene();
    expect(inspectorDuplicates(
      golden.entities.find(entity => entity.id === 'code:web-shell:app')?.id,
      [],
      golden.entities,
    )).toEqual([]);

    const snapshot = scanSnapshot(
      [
        scanEntity('system:app', 'softwareSystem'),
        scanEntity('container:web', 'container', 'system:app'),
        scanEntity('component:web-x', 'component', 'container:web'),
        scanEntity('code:alpha', 'code', 'component:web-x'),
        scanEntity('code:beta', 'code', 'component:web-x'),
        scanEntity('code:alias', 'code', 'component:web-x'),
      ],
      [{
        id: 'relation:dup:alpha-beta',
        from: 'code:alpha',
        to: 'code:beta',
        kind: 'duplicates',
        label: 'duplicates',
        evidence: [],
      }],
    );
    const scene = createC4Scene({
      baseSnapshot: snapshot,
      rootEntityId: 'system:app',
      focusEntityId: 'system:app',
      familyId: 'view-family:scan',
      sceneId: 'scan-c4',
      title: 'Scan',
      subtitle: 'Scan',
      frozenRevision: 'sha',
    });
    expect(inspectorDuplicates('code:alpha', snapshot.relations, scene.entities)).toEqual([{ id: 'code:beta', name: 'code:beta' }]);
    expect(inspectorDuplicates('code:beta', snapshot.relations, scene.entities)).toEqual([{ id: 'code:alpha', name: 'code:alpha' }]);
    expect(inspectorDuplicates('code:alias', snapshot.relations, scene.entities)).toEqual([]);
    expect(scene.entities.map(entity => entity.id).filter(id => id.startsWith('code:')).sort()).toEqual([
      'code:alias',
      'code:alpha',
      'code:beta',
    ]);
    expect(scene.projection?.projectedRelationsByDetail.code.some(relation => relation.kindLabel === 'duplicates')).toBe(true);
    expect(scene.projection?.projectedRelationsByDetail.context.some(relation => relation.kindLabel === 'duplicates')).toBe(false);
  });
});

function advisory(
  code: C4NotationCompletenessDiagnostic['code'],
  path: string,
  message: string,
  subject: C4NotationCompletenessDiagnostic['subject'],
): C4NotationCompletenessDiagnostic {
  return { severity: 'advisory', code, path, message, subject, glossaryTerms: [] };
}

describe('inspector C4 notation sample (CLA-59)', () => {
  it('caps a thousands-long completeness list to a count-with-sample instead of dumping every row', () => {
    const diagnostics = Array.from({ length: 3_200 }, (_, index) => advisory(
      'element.description.missing',
      `entities.code:${index}.responsibility`,
      `C4 element code:${index} should have a description.`,
      { kind: 'element', id: `code:${index}` },
    ));
    const presented = presentInspectorNotationDiagnostics(diagnostics);

    expect(presented.total).toBe(3_200);
    expect(presented.ready).toBe(false);
    expect(presented.errors).toEqual([]);
    expect(presented.sample).toHaveLength(INSPECTOR_NOTATION_ADVISORY_SAMPLE);
    expect(presented.hiddenCount).toBe(3_200 - INSPECTOR_NOTATION_ADVISORY_SAMPLE);
    expect(presented.sample.map(row => row.subjectId)).toEqual(
      Array.from({ length: INSPECTOR_NOTATION_ADVISORY_SAMPLE }, (_, index) => `code:${index}`),
    );
    expect(presented.errors.length + presented.sample.length).toBeLessThan(20);
  });

  it('still lists a real notation error when completeness noise would bury it', () => {
    const noise = Array.from({ length: 2_400 }, (_, index) => advisory(
      'relationship.label.missing',
      `relations.rel:${index}.label`,
      `C4 relationship rel:${index} should have a directional label.`,
      { kind: 'relationship', id: `rel:${index}` },
    ));
    const error = advisory(
      'element.type.unsupported',
      'entities.widget:x.kind',
      'C4 element widget:x has an unsupported type: widget.',
      { kind: 'element', id: 'widget:x' },
    );
    const presented = presentInspectorNotationDiagnostics([...noise, error]);

    expect(presented.total).toBe(2_401);
    expect(presented.errors).toHaveLength(1);
    expect(presented.errors[0]?.code).toBe('element.type.unsupported');
    expect(presented.errors[0]?.message).toContain('unsupported type');
    expect(presented.sample).toHaveLength(INSPECTOR_NOTATION_ADVISORY_SAMPLE);
    expect(presented.hiddenCount).toBe(2_400 - INSPECTOR_NOTATION_ADVISORY_SAMPLE);
    expect(presented.sample.some(row => row.code === 'element.type.unsupported')).toBe(false);
  });

  it('does not invent owners while sampling advisories', () => {
    const scene = createGoldenC4Scene();
    const system = scene.entities.find(entity => entity.id === 'system:okie')!;
    expect(inspectorPathOwners(system)).toEqual([]);
    expect(presentInspectorNotationDiagnostics([]).ready).toBe(true);
    expect(presentInspectorNotationDiagnostics([]).total).toBe(0);
  });
});

describe('inspector C4 notation scope (CLA-60)', () => {
  const entities = [
    { id: 'system:okie' },
    { id: 'person:reader' },
    { id: 'container:web', parentId: 'system:okie' },
    { id: 'container:model', parentId: 'system:okie' },
    { id: 'container:other', parentId: 'system:other' },
    { id: 'component:shell', parentId: 'container:web' },
    ...Array.from({ length: 80 }, (_, index) => ({ id: `code:${index}`, parentId: 'component:shell' })),
  ];
  const relations = [
    { id: 'rel:okie-reader', from: 'system:okie', to: 'person:reader' },
    { id: 'rel:web-model', from: 'container:web', to: 'container:model' },
    { id: 'rel:code-0-1', from: 'code:0', to: 'code:1' },
    { id: 'rel:unrelated', from: 'container:other', to: 'person:reader' },
  ];

  function atlasDump() {
    const missingDescriptions = [
      advisory('element.description.missing', 'entities.system:okie.responsibility', 'C4 element system:okie should have a description.', { kind: 'element', id: 'system:okie' }),
      advisory('element.description.missing', 'entities.person:reader.responsibility', 'C4 element person:reader should have a description.', { kind: 'element', id: 'person:reader' }),
      advisory('element.description.missing', 'entities.container:web.responsibility', 'C4 element container:web should have a description.', { kind: 'element', id: 'container:web' }),
      advisory('element.description.missing', 'entities.container:model.responsibility', 'C4 element container:model should have a description.', { kind: 'element', id: 'container:model' }),
      ...Array.from({ length: 80 }, (_, index) => advisory(
        'element.description.missing',
        `entities.code:${index}.responsibility`,
        `C4 element code:${index} should have a description.`,
        { kind: 'element', id: `code:${index}` },
      )),
    ];
    const missingLabels = [
      advisory('relationship.label.missing', 'relations.rel:okie-reader.label', 'C4 relationship rel:okie-reader should have a directional label.', { kind: 'relationship', id: 'rel:okie-reader' }),
      advisory('relationship.label.missing', 'relations.rel:web-model.label', 'C4 relationship rel:web-model should have a directional label.', { kind: 'relationship', id: 'rel:web-model' }),
      advisory('relationship.label.missing', 'relations.rel:code-0-1.label', 'C4 relationship rel:code-0-1 should have a directional label.', { kind: 'relationship', id: 'rel:code-0-1' }),
      advisory('relationship.label.missing', 'relations.rel:unrelated.label', 'C4 relationship rel:unrelated should have a directional label.', { kind: 'relationship', id: 'rel:unrelated' }),
    ];
    return [...missingDescriptions, ...missingLabels];
  }

  it('does not count atlas-wide completeness against a selected L1 system', () => {
    const dump = atlasDump();
    const scope = inspectorNotationScope({
      selectedId: 'system:okie',
      bandEntityIds: ['system:okie', 'person:reader'],
      entities,
      relations,
    });
    const presented = presentInspectorNotationDiagnostics(dump, { scope });

    expect(dump.length).toBeGreaterThan(80);
    expect(scope.entityIds).toEqual(new Set(['system:okie']));
    expect(presented.total).toBe(2);
    expect(presented.total).toBeLessThan(10);
    expect(presented.sample.map(row => row.subjectId).sort()).toEqual(['rel:okie-reader', 'system:okie']);
    expect(presented.hiddenCount).toBe(0);
    expect(presented.sample.some(row => row.subjectId.startsWith('code:'))).toBe(false);
    expect(presented.sample.some(row => row.subjectId === 'person:reader')).toBe(false);
  });

  it('includes the current C4 band under the selected parent, not sibling trees', () => {
    const dump = atlasDump();
    const scope = inspectorNotationScope({
      selectedId: 'system:okie',
      bandEntityIds: ['container:web', 'container:model', 'container:other'],
      entities,
      relations,
    });
    const presented = presentInspectorNotationDiagnostics(dump, { scope });

    expect([...scope.entityIds].sort()).toEqual(['container:model', 'container:web', 'system:okie']);
    expect(presented.total).toBe(5);
    expect(presented.sample.map(row => row.subjectId).sort()).toEqual([
      'container:model',
      'container:web',
      'rel:okie-reader',
      'rel:web-model',
      'system:okie',
    ]);
    expect(presented.sample.some(row => row.subjectId === 'container:other')).toBe(false);
    expect(presented.sample.some(row => row.subjectId.startsWith('code:'))).toBe(false);
  });

  it('scopes a selected container to itself at L2 and to its code band without the rest of the atlas', () => {
    const dump = atlasDump();
    const l2 = presentInspectorNotationDiagnostics(dump, {
      scope: inspectorNotationScope({
        selectedId: 'container:web',
        bandEntityIds: ['container:web', 'container:model', 'container:other'],
        entities,
        relations,
      }),
    });
    expect(l2.total).toBe(2);
    expect(l2.sample.map(row => row.subjectId).sort()).toEqual(['container:web', 'rel:web-model']);

    const l4 = presentInspectorNotationDiagnostics(dump, {
      scope: inspectorNotationScope({
        selectedId: 'container:web',
        bandEntityIds: Array.from({ length: 80 }, (_, index) => `code:${index}`),
        entities,
        relations,
      }),
    });
    expect(l4.total).toBe(1 + 80 + 1 + 1);
    expect(l4.sample).toHaveLength(INSPECTOR_NOTATION_ADVISORY_SAMPLE);
    expect(l4.hiddenCount).toBe(l4.total - INSPECTOR_NOTATION_ADVISORY_SAMPLE);
    expect(l4.sample.some(row => row.subjectId === 'container:model')).toBe(false);
  });

  it('still lists a real notation error in full when it sits outside the selected entity', () => {
    const error = advisory(
      'element.type.unsupported',
      'entities.widget:x.kind',
      'C4 element widget:x has an unsupported type: widget.',
      { kind: 'element', id: 'widget:x' },
    );
    const presented = presentInspectorNotationDiagnostics([...atlasDump(), error], {
      scope: inspectorNotationScope({
        selectedId: 'system:okie',
        bandEntityIds: ['system:okie', 'person:reader'],
        entities,
        relations,
      }),
    });

    expect(presented.errors).toHaveLength(1);
    expect(presented.errors[0]?.code).toBe('element.type.unsupported');
    expect(presented.errors[0]?.message).toContain('unsupported type');
    expect(presented.total).toBe(3);
    expect(presented.sample.some(row => row.code === 'element.type.unsupported')).toBe(false);
  });

  it('keeps diagram completeness on the scoped pane and still omits owners when none exist', () => {
    const scene = createGoldenC4Scene();
    const system = scene.entities.find(entity => entity.id === 'system:okie')!;
    const title = advisory(
      'diagram.title.missing',
      'diagram.title',
      'C4 diagrams should have a non-blank title.',
      { kind: 'diagram', id: 'view:scan' },
    );
    const presented = presentInspectorNotationDiagnostics([...atlasDump(), title], {
      scope: inspectorNotationScope({
        selectedId: 'system:okie',
        bandEntityIds: ['system:okie', 'person:reader'],
        entities,
        relations,
      }),
    });

    expect(inspectorPathOwners(system)).toEqual([]);
    expect(presented.sample.some(row => row.code === 'diagram.title.missing')).toBe(true);
    expect(presented.total).toBe(3);
  });
});
