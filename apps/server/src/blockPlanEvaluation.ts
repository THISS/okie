import { createBlockPlanService, type BlockPlanCandidate } from "./blockPlans.js";
import { createOperatorBudgetLedger } from "./operatorBudget.js";
import type { JudgmentProvider } from "./operatorJudgments.js";

/**
 * CLA-149 phase 2 evaluation harness, shared by the CI replay test and scripts/evaluate-block-planner.mjs.
 * It drives the real planner service (validation, question, cache key, answer validation, derivation)
 * over captured thiss/okie jobs (fixtures/judgments/block-planner/nodes.json). The captured jobs hold the
 * SERVER-derived previews (`derivedBlockCandidates`) for the block ids the web composer rendered.
 */
export interface EvaluationNode {
  nodeId: string; name: string; kind: string;
  size: { children: number; dependencies: number; dependents: number };
  maxBlocks: number;
  /** Server-derived previews, in the default recipe order. */
  candidates: BlockPlanCandidate[];
}
export interface EvaluationNodesFixture { origin: string; scan: { slug: string; versionId: string }; nodes: EvaluationNode[] }
export interface EvaluationNodeResult {
  nodeId: string; name: string; kind: string;
  defaultOrder: string[];
  jevOrder?: string[];
  reasons?: Record<string, string>;
  omitted?: Array<{ id: string; why: string }>;
  unavailable?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Input-only billing at $0.042 / 1M input tokens (jev-1.13.0, 2026-09-19); Jev reports no cost. */
  estimatedCostUsd?: number;
}
export const JEV_INPUT_DOLLARS_PER_TOKEN = 0.042 / 1_000_000;

export async function runBlockPlanEvaluation(options: { fixture: EvaluationNodesFixture; provider: JudgmentProvider; timeoutMs?: number; maxDollars?: number }): Promise<EvaluationNodeResult[]> {
  const { fixture, provider } = options;
  const maxDollars = options.maxDollars ?? 0.1;
  const service = createBlockPlanService({
    config: { enabled: true, maxRequests: fixture.nodes.length, maxDollars, timeoutMs: options.timeoutMs ?? 30_000, perIp: fixture.nodes.length },
    provider,
    // Offline evaluation: an in-memory planner ledger capped at this run's dollars.
    plannerLedger: createOperatorBudgetLedger({ maxRequests: fixture.nodes.length, maxTokens: Number.MAX_SAFE_INTEGER, maxDollars }),
  });
  const results: EvaluationNodeResult[] = [];
  for (const node of fixture.nodes) {
    const before = service.calls().length;
    const body = await service.planJob({ scan: fixture.scan, nodeId: node.nodeId, name: node.name, kind: node.kind, size: node.size, budget: { maxBlocks: node.maxBlocks }, candidates: node.candidates }, "evaluation");
    const call = service.calls()[before];
    const base: EvaluationNodeResult = { nodeId: node.nodeId, name: node.name, kind: node.kind, defaultOrder: node.candidates.map(candidate => candidate.id) };
    const usage = call ? { latencyMs: call.latencyMs, ...(call.usage.inputTokens !== undefined ? { inputTokens: call.usage.inputTokens, estimatedCostUsd: Math.round(call.usage.inputTokens * JEV_INPUT_DOLLARS_PER_TOKEN * 1e7) / 1e7 } : {}), ...(call.usage.outputTokens !== undefined ? { outputTokens: call.usage.outputTokens } : {}) } : {};
    if (body.state === "planned") results.push({ ...base, jevOrder: body.order, reasons: body.reasons, omitted: body.omitted, ...usage });
    else results.push({ ...base, unavailable: body.reason, ...usage });
  }
  return results;
}
