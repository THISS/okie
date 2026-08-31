import { describe, expect, it } from 'vitest';
import {
  clampInspectorWidth,
  defaultInspectorWidth,
  inspectorCanShowSource,
  inspectorTabForEntity,
  inspectorWidthRange,
  inspectorWidthStorageKey,
} from './inspectorPanel';
import { createGoldenC4Scene } from '../renderer/goldenC4Scene';

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
