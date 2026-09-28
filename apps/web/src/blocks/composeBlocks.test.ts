import { describe, expect, it } from 'vitest';
import type { ContextualOverview } from '../inspector/contextualOverview';
import { composeOverviewBlocks, explanationBlockSpecs, relatedNodeRefs, usesBlockOverview } from './composeBlocks';
import { DEFAULT_BLOCK_RECIPES, defaultBlockPlanner, resolveBlockPlanner, runBlockPlanner, type BlockPlanInput, type BlockPlanner } from './blockPlanner';

const container: ContextualOverview = {
  entity: { id: 'container:web', name: 'Web', kind: 'container', summary: 'Captured responsibility.' },
  parent: { id: 'system:okie', name: 'okie', kind: 'softwareSystem' },
  children: [{ id: 'component:app', name: 'App', relationship: 'component' }],
  dependencies: [
    { id: 'container:api', name: 'API', relationship: 'calls' },
    { id: 'container:api', name: 'API', relationship: 'streams' },
    { id: 'container:db', name: 'Database', relationship: 'reads' },
  ],
  dependents: [{ id: 'container:api', name: 'API', relationship: 'notifies' }, { id: 'person:dev', name: 'Developer', relationship: 'uses' }],
};
const v3 = {
  format: 'v3', summary: 'Renders the **atlas**.', keyPoints: ['Start in `App.tsx`.', 'Stories are deterministic.'],
  diagram: 'flowchart LR\n  a --> b', table: { columns: ['File', 'Role'], rows: [['a.ts', 'Entry']] },
  evidence: [{ entityId: 'component:app', path: 'apps/web/src/App.tsx', startLine: 1, endLine: 9 }],
};

describe('deterministic composer', () => {
  it('pilots containers and software systems only', () => {
    expect(['container', 'softwareSystem', 'component', 'code', 'person', 'system'].map(usesBlockOverview)).toEqual([true, true, false, false, false, false]);
  });
  it('orders a container by the default recipe with provenance per source', () => {
    const composed = composeOverviewBlocks({ overview: container, explanation: v3 });
    expect(composed.plan).toEqual({ order: composed.blocks.map(block => block.id), source: 'default' });
    expect(composed.blocks.map(block => [block.id, block.type, block.provenance])).toEqual([
      ['enrichment:summary', 'markdown', 'enrichment'],
      ['enrichment:keyPoints', 'keyPoints', 'enrichment'],
      ['nodeRefs:related', 'nodeRefs', 'observed'],
      ['relations:parent', 'relations', 'observed'],
      ['relations:dependencies', 'relations', 'observed'],
      ['relations:dependents', 'relations', 'observed'],
      ['enrichment:diagram', 'mermaid', 'enrichment'],
      ['children', 'children', 'observed'],
      ['enrichment:table', 'table', 'enrichment'],
      ['enrichment:evidence', 'evidence', 'enrichment'],
    ]);
    expect(composed.explained).toBe(true);
    expect(composed.dropped).toEqual([]);
  });
  it('leads a software system with its containers', () => {
    const system: ContextualOverview = { ...container, entity: { ...container.entity, id: 'system:okie', kind: 'softwareSystem' }, parent: undefined };
    expect(composeOverviewBlocks({ overview: system, explanation: v3 }).blocks.map(block => block.id).slice(0, 4))
      .toEqual(['enrichment:summary', 'enrichment:keyPoints', 'children', 'nodeRefs:related']);
    expect(DEFAULT_BLOCK_RECIPES.softwareSystem.indexOf('children')).toBeLessThan(DEFAULT_BLOCK_RECIPES.softwareSystem.indexOf('relations:dependencies'));
  });
  it('shows the captured summary only when no explanation summary is accepted', () => {
    expect(composeOverviewBlocks({ overview: container }).blocks[0]).toMatchObject({ id: 'summary', provenance: 'observed', text: 'Captured responsibility.' });
    expect(composeOverviewBlocks({ overview: container, explanation: v3 }).blocks.some(block => block.id === 'summary')).toBe(false);
    const pointsOnly = composeOverviewBlocks({ overview: container, explanation: { format: 'v3', summary: '', keyPoints: ['A point.'], evidence: [] } });
    expect(pointsOnly.blocks.slice(0, 2).map(block => block.id)).toEqual(['summary', 'enrichment:keyPoints']);
  });
  it('ignores explanations without content and survives malformed ones', () => {
    for (const value of [undefined, null, 'text', 42, { format: 'v3', summary: ' ', keyPoints: [], evidence: [] }, { format: 'v3', keyPoints: 'nope', table: { columns: ['a'], rows: 'x' } }]) {
      const composed = composeOverviewBlocks({ overview: container, explanation: value });
      expect(composed.explained).toBe(false);
      expect(composed.blocks[0]?.id).toBe('summary');
    }
  });
  it('drops a structurally invalid enrichment block, trims an over-cap one, keeps the rest', () => {
    const oversized = { ...v3, diagram: 'x'.repeat(5000), table: { columns: ['a', 'b'], rows: Array.from({ length: 40 }, () => ['x', 'y']) }, evidence: [{ entityId: 'component:ghost' }] };
    const composed = composeOverviewBlocks({ overview: container, explanation: oversized });
    expect(composed.dropped).toEqual([
      { id: 'enrichment:diagram', type: 'mermaid', reason: 'source is 5000 characters (limit 4000)' },
      { id: 'enrichment:evidence', type: 'evidence', reason: 'no evidence item cites a known entity or a safe source path' },
    ]);
    expect(composed.trimmed).toEqual([{ id: 'enrichment:table', type: 'table', omitted: 20, reasons: ['rows over the 20-item cap'] }]);
    expect(composed.blocks.some(block => block.id === 'enrichment:summary')).toBe(true);
  });
  it('decides the placeholder from whether a summary or explanation exists, not from block survival', () => {
    expect(composeOverviewBlocks({ overview: container }).described).toBe(true);
    const bare = { ...container, entity: { ...container.entity, summary: undefined } };
    expect(composeOverviewBlocks({ overview: bare }).described).toBe(false);
    expect(composeOverviewBlocks({ overview: bare, explanation: v3 }).described).toBe(true);
    // Every enrichment block invalid: still described (the explanation exists), and nothing is fabricated.
    const broken = composeOverviewBlocks({ overview: bare, explanation: { format: 'v3', summary: '', keyPoints: [], evidence: [{ entityId: 'component:ghost' }] } });
    expect(broken.described).toBe(true);
    expect(broken.explained).toBe(false);
  });
  it('checks overview names before the host lookup and ignores non-string host names', () => {
    let hostCalls = 0;
    const host = (id: string) => { hostCalls += 1; return id === 'x:obj' ? ({} as unknown as string) : undefined; };
    const composed = composeOverviewBlocks({ overview: container, entityName: host });
    const callsAfterCompose = hostCalls;
    expect(composed.entityName('container:db')).toBe('Database');
    expect(hostCalls).toBe(callsAfterCompose);
    expect(composed.entityName('x:obj')).toBeUndefined();
    expect(composed.entityName('__proto__')).toBeUndefined();
  });
  it('validates references against the host lookup and the overview names', () => {
    const composed = composeOverviewBlocks({ overview: container, explanation: { ...v3, evidence: [{ entityId: 'component:elsewhere' }] }, entityName: id => id === 'component:elsewhere' ? 'Elsewhere' : undefined });
    expect(composed.blocks.find(block => block.id === 'enrichment:evidence')).toMatchObject({ items: [{ entityId: 'component:elsewhere' }] });
    expect(composed.entityName('container:db')).toBe('Database');
  });
});

describe('legacy adapter', () => {
  it('adapts v1/v2 summary, named diagram and evidence; interactions stay operator-only', () => {
    const specs = explanationBlockSpecs({ summary: 'Legacy text.', interactions: ['Calls db'], roleWithinParent: 'Gateway', evidence: [{ path: 'src/a.ts' }], diagram: { nodes: ['container:db', 'x:raw'], edges: [{ from: 'container:db', to: 'x:raw', label: 'reads' }] } }, 'Web', id => id === 'container:db' ? 'Database' : undefined);
    expect(specs.map(spec => (spec as { id: string }).id)).toEqual(['enrichment:summary', 'enrichment:diagram', 'enrichment:evidence']);
    const diagram = specs[1] as { source: string; title: string };
    expect(diagram.title).toBe('Web and its neighbours');
    expect(diagram.source).toContain('n0["Database"]');
    expect(diagram.source).not.toContain('x:raw');
    expect(JSON.stringify(specs)).not.toMatch(/Calls db|Gateway/u);
  });
});

describe('related node refs', () => {
  it('ranks by connection count with human-readable reasons', () => {
    expect(relatedNodeRefs(container)).toEqual([
      { id: 'container:api', reason: 'depends on · calls, streams; used by · notifies' },
      { id: 'container:db', reason: 'depends on · reads' },
      { id: 'person:dev', reason: 'used by · uses' },
    ]);
  });
  it('is capped and deterministic', () => {
    const many = Array.from({ length: 10 }, (_, index) => ({ id: `c:${9 - index}`, name: `N${9 - index}`, relationship: 'uses' }));
    expect(relatedNodeRefs({ dependencies: many, dependents: [] }).map(ref => ref.id)).toEqual(['c:0', 'c:1', 'c:2', 'c:3', 'c:4', 'c:5']);
  });
});

describe('block planner seam', () => {
  const input: BlockPlanInput = {
    node: { id: 'container:web', kind: 'container', size: { children: 1, dependencies: 2, dependents: 2 } },
    context: { mode: 'overview' },
    candidates: [{ id: 'children', type: 'children', provenance: 'observed' }, { id: 'enrichment:summary', type: 'markdown', provenance: 'enrichment' }],
    budget: { maxBlocks: 16 },
  };
  const fake = (plan: unknown): BlockPlanner => ({ name: 'fake', plan: () => plan as ReturnType<BlockPlanner['plan']> });
  it('uses the default recipe unless a planner is enabled and available', () => {
    expect(resolveBlockPlanner()).toBe(defaultBlockPlanner);
    expect(resolveBlockPlanner({ remotePlanner: true })).toBe(defaultBlockPlanner);
    expect(resolveBlockPlanner({}, fake({ order: ['children'] }))).toBe(defaultBlockPlanner);
    expect(runBlockPlanner(defaultBlockPlanner, input)).toEqual({ order: ['enrichment:summary', 'children'], source: 'default' });
  });
  it('accepts an ordered subset of existing ids with clipped reasons', () => {
    const plan = runBlockPlanner(resolveBlockPlanner({ remotePlanner: true }, fake({ order: ['children'], reasons: { children: `  ${'r'.repeat(200)}`, ghost: 'x' } })), input);
    expect(plan).toEqual({ order: ['children'], reasons: { children: 'r'.repeat(120) }, source: 'planner' });
  });
  it.each([
    [{ order: ['ghost'] }, 'plan names an unknown block'],
    [{ order: ['children', 'children'] }, 'plan repeats a block'],
    [{ order: [] }, 'plan order is empty'],
    [{ order: ['children', 'enrichment:summary', 'x', 'y'] }, 'plan exceeds the block budget'],
    ['nonsense', 'planner returned no plan'],
  ])('falls back to the default on an invalid plan (%j)', (plan, why) => {
    const budget = typeof plan === 'object' && plan.order.length > 2 ? { maxBlocks: 2 } : input.budget;
    expect(runBlockPlanner(fake(plan), { ...input, budget })).toEqual({ order: ['enrichment:summary', 'children'], source: 'default', fallback: why });
  });
  it('lets a planner reorder and select composed blocks without supplying content', () => {
    const composed = composeOverviewBlocks({ overview: container, explanation: v3, planner: resolveBlockPlanner({ remotePlanner: true }, fake({ order: ['children', 'enrichment:summary'] })) });
    expect(composed.blocks.map(block => block.id)).toEqual(['children', 'enrichment:summary']);
    expect(composed.plan.source).toBe('planner');
    const bad = composeOverviewBlocks({ overview: container, planner: fake({ order: ['ghost'] }) });
    expect(bad.plan).toMatchObject({ source: 'default', fallback: 'plan names an unknown block' });
    expect(bad.blocks[0]?.id).toBe('summary');
  });
  it.each([
    ['unavailable', fake(undefined), 'planner unavailable'],
    ['throwing', { name: 'boom', plan: () => { throw new Error('x'); } } satisfies BlockPlanner, 'planner failed'],
  ])('keeps a %s planner\'s fallback labelled as the default through compose', (_label, planner, why) => {
    const composed = composeOverviewBlocks({ overview: container, explanation: v3, planner: resolveBlockPlanner({ remotePlanner: true }, planner) });
    const expected = composeOverviewBlocks({ overview: container, explanation: v3 });
    expect(composed.plan).toEqual({ ...expected.plan, source: 'default', fallback: why });
    expect(composed.blocks.map(block => block.id)).toEqual(expected.blocks.map(block => block.id));
  });
});
