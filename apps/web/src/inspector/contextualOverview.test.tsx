import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { goldenSnapshot } from '@okie/scene-compiler';
import { buildContextualOverview } from './contextualOverview';
import { ContextualOverviewView } from './ContextualOverviewView';

describe('contextual overview contract', () => {
  it('uses accepted local responsibility and immediate parent, deduplicating identical links', () => {
    const snapshot = { ...goldenSnapshot, entities: [
      { id: 'root', kind: 'softwareSystem' as const, name: 'System', responsibility: 'System summary', sourceRefs: [] },
      { id: 'child', kind: 'component' as const, name: 'Child', parentId: 'root', responsibility: 'No summary supplied.', sourceRefs: [] },
      { id: 'dep', kind: 'component' as const, name: 'Dependency', sourceRefs: [] },
    ], relations: [1, 2].map(id => ({ id: String(id), from: 'child', to: 'dep', kind: 'uses' as const, evidence: [] })) };
    const overview = buildContextualOverview(snapshot, 'child')!;
    expect(overview.parent?.id).toBe('root');
    expect(overview.entity.summary).toBeUndefined();
    expect(overview.dependencies).toHaveLength(1);
    const markup = renderToStaticMarkup(<ContextualOverviewView overview={overview} onOpenEntity={() => undefined}/>);
    expect(markup).not.toContain('System summary');
    expect(markup).not.toContain('No summary supplied.');
  });
  it.each([0, 5, 6])('bounds each sidebar group with a truthful total for %i items', count => {
    const items = Array.from({ length: count }, (_, i) => ({ id: `child-${i}`, name: `Child ${i}`, relationship: 'uses' }));
    const markup = renderToStaticMarkup(<ContextualOverviewView overview={{ entity: { id: 'root', name: 'Root', kind: 'system' }, dependencies: items, dependents: [], children: [] }} onOpenEntity={() => undefined}/>);
    expect((markup.match(/<span>Child /g) ?? []).length).toBe(Math.min(count, 5));
    expect(markup.includes(`Show all ${count}`)).toBe(count > 5);
    if (count) expect(markup).toContain(`detail-count">${count}</span>`);
    else { expect(markup).toContain('No relationships captured.'); expect(markup).not.toContain('Direct dependencies'); }
  });
});
