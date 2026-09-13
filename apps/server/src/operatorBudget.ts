/** Durable-store lock compatible admission ledger. Unknown provider cost is recorded as unknown, never zero. */
export interface OperatorBudgetUsage { inputTokens?: number; outputTokens?: number; measuredCostUsd?: number; estimatedCostUsd?: number; }
export interface OperatorBudgetLedger { admit(maxOutputTokens: number): boolean; record(usage: OperatorBudgetUsage): void; snapshot(): { requests: number; inputTokens: number; outputTokens: number; measuredCostUsd?: number; unknownCostRequests: number }; }
export function createOperatorBudgetLedger(limits: { maxRequests: number; maxTokens: number; maxDollars: number }): OperatorBudgetLedger {
  let requests = 0; let inputTokens = 0; let outputTokens = 0; let dollars = 0; let unknown = 0;
  return { admit(maxOutputTokens) { if (requests >= limits.maxRequests || inputTokens + outputTokens + maxOutputTokens > limits.maxTokens || dollars >= limits.maxDollars) return false; requests += 1; return true; }, record(usage) { inputTokens += usage.inputTokens ?? 0; outputTokens += usage.outputTokens ?? 0; if (usage.measuredCostUsd === undefined) unknown += 1; else dollars += usage.measuredCostUsd; }, snapshot: () => ({ requests, inputTokens, outputTokens, ...(dollars ? { measuredCostUsd: dollars } : {}), unknownCostRequests: unknown }) };
}
