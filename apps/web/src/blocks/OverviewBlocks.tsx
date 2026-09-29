import type { ReactNode } from 'react';
import { MermaidDiagram } from '../diagram/MermaidDiagram';
import { EvidenceRow, ExplanationTable } from '../explanation/ExplanationView';
import { BlockMarkdown, InlineMarkdown } from '../explanation/markdownLite';
import { kindLabel, type EntityNameLookup, type ExplanationEvidence } from '../explanation/explanationModel';
import { LinkList } from '../inspector/LinkList';
import { resolvedName, type BlockLink, type BlockOf, type BlockType, type OverviewBlock } from './blockModel';
import '../explanation/explanation.css';
import './blocks.css';

/** What every block renderer may use: canonical names and the two existing navigation callbacks. */
interface BlockRenderContext {
  subjectName: string;
  entityName: EntityNameLookup;
  onOpenEntity: (id: string) => void;
  onOpenEvidence?: (evidence: ExplanationEvidence) => void;
}
type BlockRenderer<T extends BlockType> = (props: { block: BlockOf<T>; ctx: BlockRenderContext }) => ReactNode;

const named = (items: BlockLink[], entityName: EntityNameLookup) => items.map(item => ({ ...item, name: resolvedName(entityName, item.id) ?? 'Unnamed element' }));
const RELATION_TITLES = { dependencies: 'Direct dependencies', dependents: 'Direct dependents' } as const;

/**
 * The renderer registry: a fixed map from block type to component. Known types
 * render with existing Overview/explanation components; nothing else can render.
 */
export const BLOCK_RENDERERS: { readonly [T in BlockType]: BlockRenderer<T> } = {
  // Observed text is captured prose, shown literally; enrichment text is markdown-lite.
  markdown: ({ block }) => block.provenance === 'enrichment'
    ? <BlockMarkdown className="explanation-summary" text={block.text}/>
    : <p className="overview-description">{block.text}</p>,
  keyPoints: ({ block }) => <section aria-label={block.title} className="explanation-key-points">
    <h4>{block.title}</h4>
    <ul>{block.items.map((point, index) => <li key={index}><InlineMarkdown text={point}/></li>)}</ul>
  </section>,
  nodeRefs: ({ block, ctx }) => <section aria-label={block.title} className="detail-section overview-node-refs">
    <div className="section-heading"><span>{block.title}</span></div>
    <ul>{block.refs.map(ref => {
      const name = resolvedName(ctx.entityName, ref.id) ?? 'Unnamed element';
      return <li key={ref.id}><button className="overview-node-ref" onClick={() => ctx.onOpenEntity(ref.id)} title={`Focus ${name} on the map`} type="button"><span>{name}</span><small>{ref.reason}</small></button></li>;
    })}</ul>
  </section>,
  relations: ({ block, ctx }) => {
    if (block.direction === 'parent') {
      const parent = block.items[0]!;
      return <section className="detail-section"><div className="section-heading"><span>Parent</span></div><button type="button" className="inspector-link-row" onClick={() => ctx.onOpenEntity(parent.id)}><span>{resolvedName(ctx.entityName, parent.id) ?? 'Unnamed element'}</span><small>{kindLabel(parent.relationship)}</small></button></section>;
    }
    return <LinkList title={RELATION_TITLES[block.direction]} items={named(block.items, ctx.entityName)} onOpenEntity={ctx.onOpenEntity}/>;
  },
  children: ({ block, ctx }) => <LinkList title="Children" items={named(block.items, ctx.entityName)} onOpenEntity={ctx.onOpenEntity}/>,
  mermaid: ({ block }) => <div className="explanation-diagram"><MermaidDiagram compact fallbackNote="The explanation text and evidence are still available." source={block.source} title={block.title}/></div>,
  table: ({ block }) => <ExplanationTable table={{ ...(block.caption ? { caption: block.caption } : {}), columns: block.columns, rows: block.rows }} title={block.title}/>,
  evidence: ({ block, ctx }) => <section aria-label="Evidence" className="explanation-evidence">
    <h4>Evidence</h4>
    <ul>{block.items.map((item, index) => <EvidenceRow entityName={ctx.entityName} evidence={item} key={index} {...(ctx.onOpenEvidence ? { onOpenEvidence: ctx.onOpenEvidence } : {})}/>)}</ul>
  </section>,
};

/** Types that render their own `detail-section`; the rest are explanation prose. */
const SECTION_TYPES: ReadonlySet<BlockType> = new Set(['nodeRefs', 'relations', 'children']);

const isRegistered = (type: unknown): type is BlockType => typeof type === 'string' && Object.hasOwn(BLOCK_RENDERERS, type);

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
/** "1 section omitted.", "3 items omitted.", "1 section and 3 items omitted." */
export function omittedNote(sections: number, items: number): string | undefined {
  const parts = [sections > 0 ? plural(sections, 'section') : '', items > 0 ? plural(items, 'item') : ''].filter(Boolean);
  return parts.length ? `${parts.join(' and ')} omitted.` : undefined;
}

export function OverviewBlocks({ blocks, dropped, itemsOmitted = 0, ...ctx }: BlockRenderContext & { blocks: readonly OverviewBlock[]; dropped: number; itemsOmitted?: number }) {
  const note = omittedNote(dropped, itemsOmitted);
  return <div className="overview-blocks">
    {blocks.map(block => {
      if (!isRegistered(block.type)) return null;
      const Renderer = BLOCK_RENDERERS[block.type] as BlockRenderer<BlockType>;
      const prose = !SECTION_TYPES.has(block.type) && !(block.type === 'markdown' && block.provenance === 'observed');
      return <div className={`overview-block${prose ? ' explanation-view' : ''}${SECTION_TYPES.has(block.type) ? ' is-section' : ''}`} data-block-id={block.id} data-block-provenance={block.provenance} data-block-type={block.type} key={block.id}>
        <Renderer block={block} ctx={ctx}/>
      </div>;
    })}
    {note && <p className="overview-blocks-note" role="note">{note}</p>}
  </div>;
}
