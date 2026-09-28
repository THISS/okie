import { describe, expect, it, vi } from 'vitest';
import type { ArchitectureSnapshot, SourceExcerpt } from '@okie/architecture';
import { goldenSnapshot } from '@okie/scene-compiler';
import { resolveExplanationExcerpt } from './explanationSource';

const excerpt = (path: string, startLine: number, endLine: number): SourceExcerpt => ({ path, language: 'typescript', startLine, endLine, highlightLine: startLine, frozenRevision: 'sha', text: '', lines: Array.from({ length: endLine - startLine + 1 }, () => '') });
const snapshot = { ...goldenSnapshot, relations: [], entities: [
  { id: 'component:a', kind: 'component' as const, name: 'A', sourceRefs: [] },
  { id: 'component:b', kind: 'component' as const, name: 'B', sourceRefs: [], sourceExcerpts: [excerpt('src/b.ts', 1, 40)] },
] } as ArchitectureSnapshot;

describe('explanation evidence → source excerpt', () => {
  it('loads the cited entity excerpts on demand and highlights the cited line', async () => {
    const ensure = vi.fn().mockResolvedValue([excerpt('src/a.ts', 1, 20), excerpt('src/a.ts', 30, 60)]);
    const found = await resolveExplanationExcerpt(snapshot, { entityId: 'component:a', path: 'src/a.ts', startLine: 35, endLine: 40 }, ensure);
    expect(ensure).toHaveBeenCalledWith('component:a');
    expect(found).toMatchObject({ entityId: 'component:a', exact: true, excerpt: { startLine: 30, highlightLine: 35 } });
  });
  it('opens the nearest captured excerpt, flagged inexact, when the cited line was not captured', async () => {
    const ensure = vi.fn().mockResolvedValue([excerpt('src/a.ts', 1, 20), excerpt('src/a.ts', 30, 60), excerpt('src/a.ts', 100, 120)]);
    const found = await resolveExplanationExcerpt(snapshot, { entityId: 'component:a', path: 'src/a.ts', startLine: 85 }, ensure);
    expect(found).toMatchObject({ entityId: 'component:a', exact: false, excerpt: { startLine: 100, highlightLine: 100 } });
  });
  it('prefers another resident excerpt containing the line over a nearest-only match', async () => {
    const ensure = vi.fn().mockResolvedValue([excerpt('src/b.ts', 50, 60)]);
    expect(await resolveExplanationExcerpt(snapshot, { entityId: 'component:a', path: 'src/b.ts', startLine: 10 }, ensure)).toMatchObject({ entityId: 'component:b', exact: true, excerpt: { highlightLine: 10 } });
  });
  it('falls back to any resident excerpt of the same file', async () => {
    expect(await resolveExplanationExcerpt(snapshot, { path: 'src/b.ts', startLine: 5 })).toMatchObject({ entityId: 'component:b', exact: true, excerpt: { highlightLine: 5 } });
  });
  it('returns undefined when the atlas holds no source for the evidence', async () => {
    expect(await resolveExplanationExcerpt(snapshot, { entityId: 'component:a', path: 'src/zzz.ts' }, () => Promise.reject(new Error('offline')))).toBeUndefined();
  });
});
