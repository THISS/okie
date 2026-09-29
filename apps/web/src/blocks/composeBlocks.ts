import type { ContextualOverview, ContextualOverviewLink } from '../inspector/contextualOverview';
import { explanationViewModel, hasExplanationContent, legacyDiagramSource, type EntityNameLookup } from '../explanation/explanationModel';
import { BLOCK_CAPS, resolvedName, validateBlocks, type DroppedBlock, type OverviewBlock, type TrimmedBlock } from './blockModel';
import { DEFAULT_PLAN_BUDGET, defaultBlockPlanner, runBlockPlanner, type BlockPlan, type BlockPlanInput, type BlockPlanner } from './blockPlanner';

/** Node kinds whose Overview renders as blocks (CLA-149 pilot). Every other kind keeps the classic Overview. */
export const BLOCK_OVERVIEW_KINDS: ReadonlySet<string> = new Set(['container', 'softwareSystem']);
export const usesBlockOverview = (kind: string) => BLOCK_OVERVIEW_KINDS.has(kind);

export interface ComposedOverview {
  blocks: OverviewBlock[];
  dropped: DroppedBlock[];
  /** Rendered blocks with items left out (over a cap or individually invalid). */
  trimmed: TrimmedBlock[];
  plan: BlockPlan;
  /** An accepted explanation contributed at least one valid block. */
  explained: boolean;
  /**
   * A summary exists (captured, or in the accepted explanation) or the explanation has
   * content: decides the "No description" placeholder independently of block survival.
   */
  described: boolean;
  /** Canonical name lookup the blocks were validated against (renderers label from it). */
  entityName: EntityNameLookup;
}

const RELATED_REFS = 6;

/**
 * Deterministic `nodeRefs`: the most-connected direct neighbours with a reason built
 * from the relation labels/kinds ("depends on · calls", "used by · reads").
 */
export function relatedNodeRefs(overview: Pick<ContextualOverview, 'dependencies' | 'dependents'>): Array<{ id: string; reason: string }> {
  const neighbours = new Map<string, { name: string; out: string[]; in: string[] }>();
  const add = (link: ContextualOverviewLink, direction: 'out' | 'in') => {
    const entry = neighbours.get(link.id) ?? { name: link.name, out: [], in: [] };
    if (!entry[direction].includes(link.relationship)) entry[direction].push(link.relationship);
    neighbours.set(link.id, entry);
  };
  overview.dependencies.forEach(link => add(link, 'out'));
  overview.dependents.forEach(link => add(link, 'in'));
  const phrase = (verb: string, labels: string[]) => labels.length ? `${verb} · ${labels.slice(0, 2).join(', ')}${labels.length > 2 ? ` +${labels.length - 2}` : ''}` : '';
  const clip = (value: string) => value.length > BLOCK_CAPS.nodeRefReasonChars ? `${value.slice(0, BLOCK_CAPS.nodeRefReasonChars - 1)}…` : value;
  return [...neighbours.entries()]
    .sort(([leftId, left], [rightId, right]) => (right.out.length + right.in.length) - (left.out.length + left.in.length) || left.name.localeCompare(right.name) || leftId.localeCompare(rightId))
    .slice(0, RELATED_REFS)
    .map(([id, entry]) => ({ id, reason: clip([phrase('depends on', entry.out), phrase('used by', entry.in)].filter(Boolean).join('; ')) }));
}

/** Observed candidate specs from the scanned snapshot (via the contextual overview). */
export function observedBlockSpecs(overview: ContextualOverview): unknown[] {
  const specs: unknown[] = [];
  if (overview.entity.summary) specs.push({ id: 'summary', type: 'markdown', text: overview.entity.summary });
  const refs = relatedNodeRefs(overview);
  if (refs.length) specs.push({ id: 'nodeRefs:related', type: 'nodeRefs', title: 'Related', refs });
  if (overview.parent) specs.push({ id: 'relations:parent', type: 'relations', direction: 'parent', items: [{ id: overview.parent.id, relationship: overview.parent.kind }] });
  if (overview.dependencies.length) specs.push({ id: 'relations:dependencies', type: 'relations', direction: 'dependencies', items: overview.dependencies.map(({ id, relationship }) => ({ id, relationship })) });
  if (overview.dependents.length) specs.push({ id: 'relations:dependents', type: 'relations', direction: 'dependents', items: overview.dependents.map(({ id, relationship }) => ({ id, relationship })) });
  if (overview.children.length) specs.push({ id: 'children', type: 'children', items: overview.children.map(({ id, relationship }) => ({ id, relationship })) });
  return specs;
}

/**
 * Legacy adapter: an accepted explanation (CLA-260 `v3`, or format-less v1/v2) →
 * enrichment block specs. v3: summary → markdown, keyPoints → keyPoints, diagram →
 * mermaid, table → table, evidence → evidence. Legacy: summary, a named diagram
 * built from `{nodes, edges}`, evidence; `roleWithinParent`/`interactions` stay
 * operator-only, as in the CLA-260 atlas view. Empty explanations adapt to nothing.
 */
export function explanationBlockSpecs(explanation: unknown, subjectName: string, entityName: EntityNameLookup): unknown[] {
  const model = explanationViewModel(explanation);
  if (!hasExplanationContent(model)) return [];
  const specs: unknown[] = [];
  if (model.summary.trim()) specs.push({ id: 'enrichment:summary', type: 'markdown', text: model.summary });
  if (model.format === 'v3') {
    if (model.keyPoints.length) specs.push({ id: 'enrichment:keyPoints', type: 'keyPoints', title: 'Worth a look', items: model.keyPoints });
    if (model.diagram) specs.push({ id: 'enrichment:diagram', type: 'mermaid', title: `${subjectName} at a glance`, source: model.diagram });
    if (model.table) specs.push({ id: 'enrichment:table', type: 'table', title: `${subjectName} details`, ...model.table });
  } else {
    const source = legacyDiagramSource(model.diagram, entityName);
    if (source) specs.push({ id: 'enrichment:diagram', type: 'mermaid', title: `${subjectName} and its neighbours`, source });
  }
  if (model.evidence.length) specs.push({ id: 'enrichment:evidence', type: 'evidence', items: model.evidence });
  return specs;
}

export interface ComposeOptions {
  overview: ContextualOverview;
  /** The accepted explanation content (`OperatorScope.explanation`), if any. */
  explanation?: unknown;
  entityName?: EntityNameLookup;
  planner?: BlockPlanner;
  context?: BlockPlanInput['context'];
  revision?: string;
}

/**
 * Deterministic composer: observed + enrichment candidates, validated per source
 * (provenance is assigned here, by source), then ordered by the planner with the
 * default recipe as the validated fallback.
 */
export function composeOverviewBlocks({ overview, explanation, entityName, planner = defaultBlockPlanner, context = { mode: 'overview' }, revision }: ComposeOptions): ComposedOverview {
  // Canonical names: names the overview already resolved from the snapshot first (cheap), then the host lookup.
  const known = new Map<string, string>([...overview.children, ...overview.dependencies, ...overview.dependents].map(link => [link.id, link.name]));
  if (overview.parent) known.set(overview.parent.id, overview.parent.name);
  known.set(overview.entity.id, overview.entity.name);
  const names: EntityNameLookup = id => resolvedName(key => known.get(key), id) ?? (entityName ? resolvedName(entityName, id) : undefined);

  const model = explanationViewModel(explanation);
  const explanationSpecs = explanationBlockSpecs(explanation, overview.entity.name, names);
  const enrichment = validateBlocks(explanationSpecs, { source: 'enrichment', entityName: names });
  const explained = enrichment.blocks.length > 0;
  // An accepted explanation summary replaces the captured one, as in the CLA-260 Overview.
  const explainedSummary = enrichment.blocks.some(block => block.id === 'enrichment:summary');
  const observedSpecs = observedBlockSpecs(overview).filter(spec => !(explainedSummary && (spec as { id: string }).id === 'summary'));
  const observed = validateBlocks(observedSpecs, { source: 'observed', entityName: names });
  const described = Boolean(overview.entity.summary?.trim()) || hasExplanationContent(model);

  const candidates = [...observed.blocks, ...enrichment.blocks];
  const input: BlockPlanInput = {
    node: { id: overview.entity.id, kind: overview.entity.kind, size: { children: overview.children.length, dependencies: overview.dependencies.length, dependents: overview.dependents.length } },
    ...(revision ? { revision } : {}),
    context,
    candidates: candidates.map(({ id, type, provenance }) => ({ id, type, provenance })),
    budget: DEFAULT_PLAN_BUDGET,
  };
  const plan = runBlockPlanner(planner, input);
  const byId = new Map(candidates.map(block => [block.id, block]));
  return { blocks: plan.order.flatMap(id => byId.get(id) ?? []), dropped: [...enrichment.dropped, ...observed.dropped], trimmed: [...enrichment.trimmed, ...observed.trimmed], plan, explained, described, entityName: names };
}
