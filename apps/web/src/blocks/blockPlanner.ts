import { BLOCK_CAPS, type BlockProvenance, type BlockType } from './blockModel';

/**
 * CLA-149 block planner seam. A planner may only select and reorder blocks the
 * composer already built (by id); it never supplies content. The deterministic
 * default recipe is always the fallback. See docs/roadmap/overview-blocks.md.
 */
/** Only ids, types and provenance: a remote planner derives any content digest server-side. */
export interface BlockCandidate { id: string; type: BlockType; provenance: BlockProvenance }
export interface BlockPlanInput {
  node: { id: string; kind: string; size: { children: number; dependencies: number; dependents: number } };
  /** Snapshot/explanation revision the plan is cached against (future planners). */
  revision?: string;
  /** Reading context: the Overview, or an Ask question (CLA-265) to rank blocks by relevance. */
  context: { mode: 'overview' } | { mode: 'ask'; question: string };
  candidates: readonly BlockCandidate[];
  budget: { maxBlocks: number };
}
export type BlockPlanSource = 'default' | 'planner';
export interface BlockPlan {
  /** Ordered subset of candidate ids. */
  order: string[];
  /** Short per-block reason (planner output; never rendered as a fact). */
  reasons?: Record<string, string>;
  source: BlockPlanSource;
  /** Why a planner's output was replaced by the default (validated plans only). */
  fallback?: string;
}
/**
 * Synchronous by design: a future remote planner (Jev) resolves plans ahead of time
 * into a cache keyed by node id + revision and answers from it, returning `undefined`
 * on a miss so the Overview never waits on a model.
 */
export interface BlockPlanner { readonly name: string; plan(input: BlockPlanInput): BlockPlan | undefined }

/**
 * Default recipes: candidate ids in display order per node kind. Candidates a recipe
 * does not name keep their composition order after the named ones.
 */
export const DEFAULT_BLOCK_RECIPES: Readonly<Record<'container' | 'softwareSystem', readonly string[]>> = {
  container: ['enrichment:summary', 'summary', 'enrichment:keyPoints', 'nodeRefs:related', 'relations:parent', 'relations:dependencies', 'relations:dependents', 'enrichment:diagram', 'children', 'enrichment:table', 'enrichment:evidence'],
  softwareSystem: ['enrichment:summary', 'summary', 'enrichment:keyPoints', 'children', 'nodeRefs:related', 'relations:parent', 'relations:dependencies', 'relations:dependents', 'enrichment:diagram', 'enrichment:table', 'enrichment:evidence'],
};

export function defaultBlockOrder(kind: string, candidates: readonly BlockCandidate[]): string[] {
  const recipe = DEFAULT_BLOCK_RECIPES[kind as keyof typeof DEFAULT_BLOCK_RECIPES] ?? DEFAULT_BLOCK_RECIPES.container;
  const rank = (id: string) => { const index = recipe.indexOf(id); return index < 0 ? recipe.length : index; };
  return candidates.map((candidate, index) => ({ id: candidate.id, index }))
    .sort((left, right) => rank(left.id) - rank(right.id) || left.index - right.index)
    .map(item => item.id);
}

export const defaultBlockPlanner: BlockPlanner = {
  name: 'default',
  plan: input => ({ order: defaultBlockOrder(input.node.kind, input.candidates).slice(0, input.budget.maxBlocks), source: 'default' }),
};

const REASON_CHARS = 120;

/**
 * (Internal to `runBlockPlanner`.) Accepts a planner's plan only when every id is a known candidate, none repeats,
 * the plan is non-empty and within budget; otherwise the default plan is returned
 * with the rejection recorded in `fallback`.
 */
function validatePlan(plan: unknown, input: BlockPlanInput): BlockPlan {
  const fallback = (why: string): BlockPlan => ({ ...defaultBlockPlanner.plan(input)!, fallback: why });
  if (!plan || typeof plan !== 'object') return fallback('planner returned no plan');
  const { order, reasons } = plan as Record<string, unknown>;
  if (!Array.isArray(order) || !order.length) return fallback('plan order is empty');
  if (order.length > input.budget.maxBlocks) return fallback('plan exceeds the block budget');
  const known = new Set(input.candidates.map(candidate => candidate.id));
  const seen = new Set<string>();
  for (const id of order) {
    if (typeof id !== 'string' || !known.has(id)) return fallback('plan names an unknown block');
    if (seen.has(id)) return fallback('plan repeats a block');
    seen.add(id);
  }
  const kept: Record<string, string> = {};
  if (reasons && typeof reasons === 'object') for (const id of seen) {
    const reason = (reasons as Record<string, unknown>)[id];
    if (typeof reason === 'string' && reason.trim()) kept[id] = reason.trim().slice(0, REASON_CHARS);
  }
  return { order: order as string[], ...(Object.keys(kept).length ? { reasons: kept } : {}), source: 'planner' };
}

export interface BlockPlannerFlags {
  /** Enable the remote (Jev) planner (`jevBlockPlanner.ts`). Off by default. */
  remotePlanner?: boolean;
}

/** The seam for a future planner: the remote planner only when its flag is on, otherwise the default recipe. */
export function resolveBlockPlanner(flags: BlockPlannerFlags = {}, remote?: BlockPlanner): BlockPlanner {
  return flags.remotePlanner && remote ? remote : defaultBlockPlanner;
}

/**
 * The single place a plan is produced and validated. The default planner is trusted;
 * any other planner's output goes through `validatePlan`, and the default recipe
 * applies (with `fallback` recorded) when it is unavailable (`undefined`, e.g. a
 * cache miss), throws, or returns an invalid plan.
 */
export function runBlockPlanner(planner: BlockPlanner, input: BlockPlanInput): BlockPlan {
  const fallback = (why: string): BlockPlan => ({ ...defaultBlockPlanner.plan(input)!, fallback: why });
  if (planner === defaultBlockPlanner) return defaultBlockPlanner.plan(input)!;
  let proposed: BlockPlan | undefined;
  try { proposed = planner.plan(input); } catch { return fallback('planner failed'); }
  return proposed === undefined ? fallback('planner unavailable') : validatePlan(proposed, input);
}

export const DEFAULT_PLAN_BUDGET = { maxBlocks: BLOCK_CAPS.maxBlocks } as const;
