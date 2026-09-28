import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { goldenSnapshot } from '@okie/scene-compiler';
import { buildContextualOverview } from '../inspector/contextualOverview';
import { ContextualOverviewView } from '../inspector/ContextualOverviewView';
import { BLOCK_TYPES, type OverviewBlock } from './blockModel';
import { BLOCK_RENDERERS, OverviewBlocks } from './OverviewBlocks';

const snapshot = { ...goldenSnapshot, entities: [
  { id: 'system:okie', kind: 'softwareSystem' as const, name: 'okie', responsibility: 'Maps repositories.', sourceRefs: [] },
  { id: 'container:web', kind: 'container' as const, parentId: 'system:okie', name: 'Web', responsibility: 'Renders the atlas.', sourceRefs: [] },
  { id: 'container:api', kind: 'container' as const, parentId: 'system:okie', name: 'API', sourceRefs: [] },
  { id: 'component:app', kind: 'component' as const, parentId: 'container:web', name: 'App', sourceRefs: [] },
], relations: [{ id: 'r1', from: 'container:web', to: 'container:api', kind: 'uses' as const, label: 'calls', evidence: [] }] };
const entityName = (id: string) => snapshot.entities.find(entity => entity.id === id)?.name;
const scope = (id: string, explanation: unknown) => ({ scopeId: id, entityId: id, name: id, state: 'accepted' as const, explanation: explanation as never });
const render = (id: string, explanation?: unknown) => renderToStaticMarkup(<ContextualOverviewView entityName={entityName} {...(explanation ? { explanation: scope(id, explanation) } : {})} onOpenEntity={() => undefined} onOpenEvidence={() => undefined} overview={buildContextualOverview(snapshot, id)}/>);
const blockOrder = (markup: string) => [...markup.matchAll(/data-block-id="([^"]+)"/gu)].map(match => match[1]);

describe('block Overview pilot', () => {
  it('renders a container as versioned, attributed blocks in recipe order', () => {
    const markup = render('container:web', { format: 'v3', summary: 'Owns the **canvas**.', keyPoints: ['Look at `App.tsx`.'], evidence: [{ entityId: 'component:app', path: 'apps/web/src/App.tsx', startLine: 2 }] });
    expect(markup).toContain('data-overview-blocks="v1"');
    expect(markup).toContain('data-blocks-dropped="0"');
    expect(blockOrder(markup)).toEqual(['enrichment:summary', 'enrichment:keyPoints', 'nodeRefs:related', 'relations:parent', 'relations:dependencies', 'children', 'enrichment:evidence']);
    expect(markup).toMatch(/data-block-id="enrichment:summary" data-block-provenance="enrichment" data-block-type="markdown"/u);
    expect(markup).toMatch(/data-block-id="relations:dependencies" data-block-provenance="observed" data-block-type="relations"/u);
    expect(markup).toContain('<strong>canvas</strong>');
    expect(markup).toContain('<code>apps/web/src/App.tsx:2</code>');
    expect(markup).toContain('Direct dependencies');
    expect(markup).toMatch(/<button class="overview-node-ref"[^>]*title="Focus API on the map"[^>]*><span>API<\/span><small>depends on · calls<\/small>/u);
    expect(markup).toContain('<small>Software system</small>');
    expect(markup).not.toContain('Renders the atlas.');
    expect(markup).not.toContain('section omitted');
  });
  it('falls back to the captured summary, then the placeholder, without an explanation', () => {
    const markup = render('container:web');
    expect(markup).toContain('<p class="overview-description">Renders the atlas.</p>');
    expect(markup).not.toContain('data-overview-explained');
    expect(render('container:api')).toContain('Part of okie. No description has been captured yet.');
  });
  it('shows a short neutral note for dropped blocks and trimmed items', () => {
    const markup = render('container:web', { format: 'v3', summary: 'Fine.', keyPoints: [], evidence: [], diagram: 'x'.repeat(5000), table: { columns: ['a', 'b'], rows: Array.from({ length: 30 }, () => ['x', 'y']) } });
    expect(markup).toContain('data-blocks-dropped="1"');
    expect(markup).toContain('data-block-items-omitted="10"');
    expect(markup).toContain('<p class="overview-blocks-note" role="note">1 section and 10 items omitted.</p>');
    expect(markup).toContain('data-block-id="enrichment:table"');
    expect(markup).not.toContain('limit');
  });
  it('bases the placeholder on whether a summary exists, not on block survival', () => {
    // Explanation present but every block invalid: no placeholder claims nothing was captured, and nothing is invented.
    const broken = render('container:api', { format: 'v3', summary: '', keyPoints: [], evidence: [{ entityId: 'component:ghost' }] });
    expect(broken).not.toContain('No description has been captured yet.');
    expect(broken).not.toContain('data-overview-explained');
    expect(broken).toContain('1 section omitted.');
  });
  it('clips an oversized captured summary instead of dropping it', () => {
    const long = { ...snapshot, entities: snapshot.entities.map(entity => entity.id === 'container:web' ? { ...entity, responsibility: 'y'.repeat(5000) } : entity) };
    const markup = renderToStaticMarkup(<ContextualOverviewView entityName={entityName} onOpenEntity={() => undefined} overview={buildContextualOverview(long, 'container:web')}/>);
    expect(markup).toContain(`<p class="overview-description">${'y'.repeat(3999)}…</p>`);
    expect(markup).toContain('data-blocks-dropped="0"');
  });
  it('renders legacy explanations as blocks for a software system', () => {
    const markup = render('system:okie', { summary: 'Legacy system text.', interactions: ['Calls x'], evidence: [] });
    expect(blockOrder(markup)).toEqual(['enrichment:summary', 'children']);
    expect(markup).toContain('Legacy system text.');
    expect(markup).not.toContain('Calls x');
  });
  it('keeps the classic Overview for other kinds', () => {
    const markup = render('component:app');
    expect(markup).toContain('data-contextual-overview="component:app"');
    expect(markup).not.toContain('data-overview-blocks');
    expect(markup).not.toContain('data-block-id');
  });
});

describe('renderer registry', () => {
  it('has exactly one renderer per catalog type', () => {
    expect(Object.keys(BLOCK_RENDERERS).sort()).toEqual([...BLOCK_TYPES].sort());
  });
  it('never renders an unregistered type, even if one is forced through', () => {
    const forged = [{ id: 'enrichment:x', type: 'script', provenance: 'enrichment', text: '<script>alert(1)</script>' }, { id: 'enrichment:y', type: 'toString', provenance: 'enrichment' }] as unknown as OverviewBlock[];
    const markup = renderToStaticMarkup(<OverviewBlocks blocks={forged} dropped={0} entityName={() => undefined} onOpenEntity={() => undefined} subjectName="X"/>);
    expect(markup).toBe('<div class="overview-blocks"></div>');
  });
  it('labels node refs from canonical names, never from model text', () => {
    const blocks: OverviewBlock[] = [{ id: 'enrichment:refs', type: 'nodeRefs', provenance: 'enrichment', title: 'Related', refs: [{ id: 'container:api', reason: 'shares a queue' }] }];
    const markup = renderToStaticMarkup(<OverviewBlocks blocks={blocks} dropped={2} entityName={entityName} onOpenEntity={() => undefined} subjectName="X"/>);
    expect(markup).toContain('<span>API</span><small>shares a queue</small>');
    expect(markup).toContain('2 sections omitted.');
  });
});
