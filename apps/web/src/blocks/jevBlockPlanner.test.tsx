import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ContextualOverview } from '../inspector/contextualOverview';
import { ContextualOverviewView } from '../inspector/ContextualOverviewView';
import { composeOverviewBlocks } from './composeBlocks';
import { defaultBlockPlanner, resolveBlockPlanner, type BlockPlanInput } from './blockPlanner';
import { captureBlockPlannerQueryFlag, resetBlockPlannerQueryFlag, setBlockPlannerScan } from './blockPlannerScan';
import { blockPlannerFlagEnabled, createJevBlockPlanner, createViewPlanner, jevBlockPlanner, JEV_PLAN_RETRY_DELAYS_MS, plannerNote } from './jevBlockPlanner';

const container: ContextualOverview = {
  entity: { id: 'container:web', name: 'Web', kind: 'container', summary: 'Captured responsibility.' },
  parent: { id: 'system:okie', name: 'okie', kind: 'softwareSystem' },
  children: [{ id: 'component:app', name: 'App', relationship: 'component' }],
  dependencies: [{ id: 'container:api', name: 'API', relationship: 'calls' }],
  dependents: [],
};
const v3 = { format: 'v3', summary: 'Renders the **atlas**.', keyPoints: ['Start in `App.tsx`.', 'Stories are deterministic.'], evidence: [{ entityId: 'component:app', path: 'apps/web/src/App.tsx', startLine: 1 }] };
const SCAN = { slug: 'thiss__okie', versionId: 'publication-1' };
const inputFor = (overview = container) => composeOverviewBlocks({ overview, explanation: v3 }).planInput;
const flush = async () => { for (let index = 0; index < 4; index += 1) await new Promise(resolve => setTimeout(resolve, 0)); };
const planned = (order: string[], reasons: Record<string, string> = {}) => vi.fn(async () => Response.json({ state: 'planned', order, reasons, omitted: [], source: 'jev', cacheKey: 'k', modelId: 'jev-1.13.0', questionVersion: 'block-order-v2', replayed: false }));
const unavailable = (reason: string, status = 200) => vi.fn(async () => Response.json({ state: 'unavailable', reason }, { status }));
const order = (markup: string) => [...markup.matchAll(/data-block-id="([^"]+)"/gu)].map(match => match[1]);

afterEach(() => { vi.unstubAllGlobals(); setBlockPlannerScan(undefined); resetBlockPlannerQueryFlag(); });

describe('Jev block planner client', () => {
  it('returns undefined on a miss, sends only ids and types once, then answers from the cache and notifies', async () => {
    const fetchImpl = planned(['children', 'enrichment:summary'], { children: 'Lead (90%): x' });
    const planner = createJevBlockPlanner({ scan: () => SCAN, fetchImpl });
    const listener = vi.fn();
    planner.subscribe(listener);
    const input = inputFor();
    expect(planner.plan(input)).toBeUndefined();
    expect(planner.plan(input)).toBeUndefined();
    expect(planner.status(input)).toEqual({ state: 'pending' });
    await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>;
    expect(sent).toEqual({ scan: SCAN, nodeId: 'container:web', node: { kind: 'container' }, context: 'overview', budget: { maxBlocks: 16 }, candidates: input.candidates.map(({ id, type }) => ({ id, type })) });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(planner.plan(input)).toEqual({ order: ['children', 'enrichment:summary'], reasons: { children: 'Lead (90%): x' }, source: 'planner' });
    const composed = composeOverviewBlocks({ overview: container, explanation: v3, planner: resolveBlockPlanner({ remotePlanner: true }, planner) });
    expect(composed.blocks.map(block => block.id)).toEqual(['children', 'enrichment:summary']);
    expect(plannerNote(composed.plan, planner.status(input))).toBe('Order: Jev planner');
  });

  it('falls back to the default order when the plan is invalid', async () => {
    const invalid = createJevBlockPlanner({ scan: () => SCAN, fetchImpl: planned(['ghost']) });
    invalid.plan(inputFor()); await flush();
    const composed = composeOverviewBlocks({ overview: container, explanation: v3, planner: resolveBlockPlanner({ remotePlanner: true }, invalid) });
    expect(composed.plan).toMatchObject({ source: 'default', fallback: 'plan names an unknown block' });
    expect(composed.blocks.map(block => block.id)).toEqual(defaultBlockPlanner.plan(inputFor())!.order);
  });

  it.each([['disabled', 200], ['no-global-cap', 200], ['invalid-response', 200], ['planner-budget', 200], ['bad request', 400], ['not found', 404]])('caches the terminal answer %s (%i) for the session', async (reason, status) => {
    let clock = 0;
    const fetchImpl = status === 200 ? unavailable(reason) : vi.fn(async () => Response.json({ error: reason }, { status }));
    const planner = createJevBlockPlanner({ scan: () => SCAN, fetchImpl, now: () => clock });
    planner.plan(inputFor()); await flush();
    clock = 60_000;
    expect(planner.plan(inputFor())).toBeUndefined(); await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(planner.status(inputFor())).toEqual({ state: 'unavailable', reason: status === 200 ? reason : `http ${status}` });
  });

  it.each(['busy', 'rate-limited', 'timeout', 'provider-failure', 'http 5xx', 'network'])('retries the transient answer %s with a bounded backoff (2 retries at most)', async reason => {
    let clock = 0;
    const fetchImpl = reason === 'network' ? vi.fn(async () => { throw new Error('offline'); }) : reason === 'http 5xx' ? vi.fn(async () => new Response('oops', { status: 502 })) : unavailable(reason);
    const planner = createJevBlockPlanner({ scan: () => SCAN, fetchImpl, now: () => clock });
    const input = inputFor();
    planner.plan(input); await flush();
    expect(planner.status(input)).toEqual({ state: 'unavailable', reason });
    clock = JEV_PLAN_RETRY_DELAYS_MS[0] - 1; planner.plan(input); await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(1); // still backing off
    clock = JEV_PLAN_RETRY_DELAYS_MS[0]; planner.plan(input); await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    clock += JEV_PLAN_RETRY_DELAYS_MS[1]; planner.plan(input); await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    clock += 3_600_000; planner.plan(input); planner.plan(input); await flush();
    expect(fetchImpl).toHaveBeenCalledTimes(3); // attempts exhausted for this session
  });

  it('a retry can still succeed', async () => {
    let clock = 0; let calls = 0;
    const fetchImpl = vi.fn(async () => (calls += 1) === 1 ? Response.json({ state: 'unavailable', reason: 'busy' }) : Response.json({ state: 'planned', order: ['children'], reasons: {} }));
    const planner = createJevBlockPlanner({ scan: () => SCAN, fetchImpl, now: () => clock });
    planner.plan(inputFor()); await flush();
    clock = JEV_PLAN_RETRY_DELAYS_MS[0]; planner.plan(inputFor()); await flush();
    expect(planner.plan(inputFor())).toMatchObject({ order: ['children'], source: 'planner' });
  });

  it('plans nothing without a published scan or outside the Overview', () => {
    const fetchImpl = planned(['children']);
    expect(createJevBlockPlanner({ scan: () => undefined, fetchImpl }).plan(inputFor())).toBeUndefined();
    const ask: BlockPlanInput = { ...inputFor(), context: { mode: 'ask', question: 'why?' } };
    expect(createJevBlockPlanner({ scan: () => SCAN, fetchImpl }).plan(ask)).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('is off by default; the ?planner=jev flag is captured at boot and survives the URL rewrite', () => {
    expect(blockPlannerFlagEnabled(false, undefined)).toBe(false);
    expect(blockPlannerFlagEnabled(false, { getItem: key => key === 'okie.blockPlanner' ? 'jev' : null })).toBe(true);
    expect(blockPlannerFlagEnabled(false, { getItem: () => { throw new Error('blocked'); } })).toBe(false);
    expect(blockPlannerFlagEnabled(undefined, undefined)).toBe(false);
    captureBlockPlannerQueryFlag('?planner=default&sel=x');
    expect(blockPlannerFlagEnabled(undefined, undefined)).toBe(false);
    captureBlockPlannerQueryFlag('?planner=jev&sel=container%3Apackages-scan');
    // The app then rewrites the URL without `planner`; a later capture cannot turn the flag off.
    captureBlockPlannerQueryFlag('?nav=1&repo=thiss__okie');
    expect(blockPlannerFlagEnabled(undefined, undefined)).toBe(true);
    expect(resolveBlockPlanner({ remotePlanner: false }, jevBlockPlanner)).toBe(defaultBlockPlanner);
  });

  it('keeps the default order for a view that painted before the plan arrived, and applies it on the next visit', async () => {
    const fetchImpl = planned(['children', 'enrichment:summary', 'relations:dependencies']);
    const planner = createJevBlockPlanner({ scan: () => SCAN, fetchImpl });
    const defaults = defaultBlockPlanner.plan(inputFor())!.order;
    const compose = (view: ReturnType<typeof createViewPlanner>) => composeOverviewBlocks({ overview: container, explanation: v3, planner: resolveBlockPlanner({ remotePlanner: true }, view.planner) });
    const first = createViewPlanner(planner);
    expect(compose(first).blocks.map(block => block.id)).toEqual(defaults); // painted with the default order
    await flush();
    expect(planner.status(inputFor())).toEqual({ state: 'planned' });
    // The same view re-renders after the plan arrived: no reorder, and the dev note says why.
    const again = compose(first);
    expect(again.blocks.map(block => block.id)).toEqual(defaults);
    expect(first.deferred(again.planInput)).toBe(true);
    expect(plannerNote(again.plan, { state: 'deferred' })).toBe('Order: default (Jev plan cached for next visit)');
    // Next visit (a new view of the node): the cached plan applies from the first paint.
    const next = createViewPlanner(planner);
    expect(compose(next).blocks.map(block => block.id)).toEqual(['children', 'enrichment:summary', 'relations:dependencies']);
    expect(next.deferred(inputFor())).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('the real Overview applies a cached plan on first paint with the boot-captured flag', async () => {
    const fetchImpl = planned(['children', 'enrichment:summary', 'relations:dependencies']);
    vi.stubGlobal('fetch', fetchImpl);
    captureBlockPlannerQueryFlag('?planner=jev');
    setBlockPlannerScan({ slug: 'thiss__okie', versionId: 'publication-view' });
    const scope = { scopeId: 'container:web', entityId: 'container:web', name: 'Web', state: 'accepted' as const, explanation: v3 as never };
    const view = () => renderToStaticMarkup(<ContextualOverviewView explanation={scope} onOpenEntity={() => undefined} overview={container}/>);
    const first = view();
    expect(order(first)).toEqual(defaultBlockPlanner.plan(inputFor())!.order);
    await flush();
    const next = view();
    expect(order(next)).toEqual(['children', 'enrichment:summary', 'relations:dependencies']);
    // (The dev note is client-only: server rendering reads dev mode as off. Its text is covered by plannerNote.)
    expect(next).not.toContain('overview-planner-note');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps the default planner (and no request) with the flag off', async () => {
    const fetchImpl = planned(['children']);
    vi.stubGlobal('fetch', fetchImpl);
    setBlockPlannerScan(SCAN);
    const markup = renderToStaticMarkup(<ContextualOverviewView onOpenEntity={() => undefined} overview={{ ...container, entity: { ...container.entity, id: 'container:other' } }}/>);
    expect(markup).toContain('data-block-id="summary"');
    await flush();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('names the deferred state in the dev note', () => {
    expect(plannerNote({ order: [], source: 'default', fallback: 'planner unavailable' }, { state: 'deferred' })).toBe('Order: default (Jev plan cached for next visit)');
    expect(plannerNote({ order: [], source: 'default' }, { state: 'off' })).toBe('Order: default');
  });
});
