import { describe, expect, it } from 'vitest';
import {
  clampInspectorWidth,
  defaultInspectorWidth,
  inspectorAcceptedSummary,
  inspectorCanShowSource,
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
