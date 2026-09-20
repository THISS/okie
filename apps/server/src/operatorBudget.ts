import { randomUUID } from "node:crypto";
import type { OperatorStore } from "./operatorStore.js";

export interface OperatorBudgetUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  measuredCostUsd?: number | undefined;
  estimatedCostUsd?: number | undefined;
}
export interface OperatorBudgetSnapshot {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  reservedTokens: number;
  reservedCostUsd: number;
  measuredCostUsd?: number;
  estimatedCostUsd?: number;
  unknownCostRequests: number;
}
type BudgetEvent = { type: string; detail?: Record<string, string | number | boolean | null> };
const amount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

/** Reservations survive restart and are shared by retries of the same run.
 * Missing usage retains the token reservation. Dollar limits stop admission on
 * reported/estimated spend; they cannot promise a hard provider billing cap.
 */
export function createOperatorBudgetLedger(
  limits: { maxRequests: number; maxTokens: number; maxDollars: number; maxConcurrent?: number },
  durable?: { store: OperatorStore; runId: string; kind?: "judgment" },
) {
  for (const value of Object.values(limits)) {
    if (amount(value) === undefined) throw new Error("invalid operator budget");
  }
  const memory: BudgetEvent[] = [];
  const events = (): BudgetEvent[] => durable
    ? durable.store.snapshot().events.filter(event => event.runId === durable.runId && event.type.startsWith("budget.") && (!durable.kind || event.detail?.kind === durable.kind))
    : memory;
  const append = (event: BudgetEvent) => {
    if (durable) durable.store.appendEvent({ runId: durable.runId, ...event, detail: { ...event.detail, ...(durable.kind ? { kind: durable.kind } : {}) } });
    else memory.push(event);
  };
  const locked = <T>(work: () => T): T => durable ? durable.store.withExclusiveLock(work) : work();
  const read = () => {
    const reservations = new Map<string, { tokens: number; dollars: number; attemptId?: string; usage?: OperatorBudgetUsage }>();
    for (const event of events()) {
      const id = event.detail?.requestId;
      if (typeof id !== "string") continue;
      if (event.type === "budget.reserved") reservations.set(id, { tokens: amount(event.detail?.tokens) ?? 0, dollars: amount(event.detail?.dollars) ?? 0, ...(typeof event.detail?.attemptId === "string" ? { attemptId: event.detail.attemptId } : {}) });
      if (event.type === "budget.settled") {
        const row = reservations.get(id);
        if (row && !row.usage) row.usage = {
          inputTokens: amount(event.detail?.inputTokens),
          outputTokens: amount(event.detail?.outputTokens),
          measuredCostUsd: amount(event.detail?.measuredCostUsd),
          estimatedCostUsd: amount(event.detail?.estimatedCostUsd),
        };
      }
    }
    const snapshot: OperatorBudgetSnapshot = {
      requests: reservations.size, inputTokens: 0, outputTokens: 0,
      reservedTokens: 0, reservedCostUsd: 0, unknownCostRequests: 0,
    };
    for (const { tokens, dollars, usage } of reservations.values()) {
      snapshot.inputTokens += usage?.inputTokens ?? 0;
      snapshot.outputTokens += usage?.outputTokens ?? 0;
      if (usage?.inputTokens === undefined || usage.outputTokens === undefined) snapshot.reservedTokens += tokens;
      if (usage?.measuredCostUsd !== undefined) snapshot.measuredCostUsd = (snapshot.measuredCostUsd ?? 0) + usage.measuredCostUsd;
      else if (usage?.estimatedCostUsd !== undefined) snapshot.estimatedCostUsd = (snapshot.estimatedCostUsd ?? 0) + usage.estimatedCostUsd;
      else { snapshot.unknownCostRequests += 1; snapshot.reservedCostUsd += dollars; }
    }
    return { reservations, snapshot };
  };
  return {
    reserve(maxTokens: number, maxDollars = 0, attemptId?: string): string | undefined {
      if (amount(maxTokens) === undefined || !Number.isInteger(maxTokens)) throw new Error("invalid token reservation");
      if (amount(maxDollars) === undefined) throw new Error("invalid dollar reservation");
      return locked(() => {
        const { snapshot, reservations } = read();
        const attempts = durable?.store.snapshot().attempts;
        const active = [...reservations.values()].filter(row => {
          if (row.usage) return false;
          if (!row.attemptId || !attempts) return true;
          const attempt = attempts.find(value => value.attemptId === row.attemptId);
          return !attempt || attempt.state === "running" || attempt.state === "queued";
        });
        if (snapshot.requests >= limits.maxRequests ||
            (limits.maxConcurrent !== undefined && active.length >= limits.maxConcurrent) ||
            snapshot.inputTokens + snapshot.outputTokens + snapshot.reservedTokens + maxTokens > limits.maxTokens ||
            (snapshot.measuredCostUsd ?? 0) + (snapshot.estimatedCostUsd ?? 0) + snapshot.reservedCostUsd >= limits.maxDollars ||
            (snapshot.measuredCostUsd ?? 0) + (snapshot.estimatedCostUsd ?? 0) + snapshot.reservedCostUsd + maxDollars > limits.maxDollars) return undefined;
        const requestId = randomUUID();
        append({ type: "budget.reserved", detail: { requestId, tokens: maxTokens, dollars: maxDollars, ...(attemptId ? { attemptId } : {}) } });
        return requestId;
      });
    },
    settle(requestId: string, usage: OperatorBudgetUsage = {}): void {
      locked(() => {
        const row = read().reservations.get(requestId);
        if (!row) throw new Error("unknown budget reservation");
        if (row.usage) return;
        const detail: NonNullable<BudgetEvent["detail"]> = { requestId };
        for (const [key, value] of Object.entries(usage)) {
          if (!["inputTokens", "outputTokens", "measuredCostUsd", "estimatedCostUsd"].includes(key)) continue;
          if (value !== undefined && amount(value) === undefined) throw new Error("invalid budget usage");
          if (value !== undefined) detail[key] = value;
        }
        append({ type: "budget.settled", detail });
      });
    },
    snapshot: (): OperatorBudgetSnapshot => read().snapshot,
  };
}
