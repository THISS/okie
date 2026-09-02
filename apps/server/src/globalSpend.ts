import type { EnrichmentBudget } from "./llmGateway.js";

/**
 * Process-wide enrichment spend ceiling (CLA-38).
 *
 * Orthogonal to the per-user 5/10min submit limiter (CLA-30) and to the
 * per-scan token/dollar caps (CLA-22). This ledger is shared across GitHub
 * users so many accounts cannot fan the LLM bill. In-memory: jobs are already
 * ephemeral; a process restart resets the totals.
 *
 * Unset env → no global ceiling (scan-level CLA-22 still applies). Never log
 * keys, and never put these totals on GET /healthz.
 */

/** Job/UI note when enrichment is skipped because the process is at the cap. */
export const GLOBAL_ENRICHMENT_BUDGET_SKIP_NOTE = "global enrichment budget reached";

export interface GlobalEnrichmentCap {
  /** Undefined = no global token ceiling. 0 = already exhausted. */
  maxTokens?: number;
  /** Undefined = no global dollar ceiling. Enforced only when usage reports cost. */
  maxDollars?: number;
}

export interface GlobalSpendSnapshot {
  tokens: number;
  dollars: number;
}

export interface GlobalEnrichmentSpend {
  readonly cap: GlobalEnrichmentCap;
  snapshot(): GlobalSpendSnapshot;
  /** Remaining headroom. Undefined field = that dimension is uncapped. */
  remaining(): { tokens?: number; dollars?: number };
  isExhausted(): boolean;
  record(usage: { totalTokens?: number; costUsd?: number }): void;
}

function optionalNonNegative(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
}

function addDollars(left: number, right: number): number {
  return Math.round((left + right) * 1e6) / 1e6;
}

/** Operator env overlay. Missing / invalid values mean no global ceiling on that axis. */
export function resolveGlobalEnrichmentCap(env: NodeJS.Dict<string> = process.env): GlobalEnrichmentCap {
  const maxTokens = optionalNonNegative(env.OKIE_LLM_GLOBAL_MAX_TOKENS);
  const maxDollars = optionalNonNegative(env.OKIE_LLM_GLOBAL_MAX_DOLLARS);
  return {
    ...(maxTokens !== undefined ? { maxTokens: Math.floor(maxTokens) } : {}),
    ...(maxDollars !== undefined ? { maxDollars } : {}),
  };
}

export function createGlobalEnrichmentSpend(
  cap: GlobalEnrichmentCap = {},
): GlobalEnrichmentSpend {
  const spent: GlobalSpendSnapshot = { tokens: 0, dollars: 0 };

  return {
    cap,
    snapshot: () => ({ tokens: spent.tokens, dollars: spent.dollars }),
    remaining: () => ({
      ...(cap.maxTokens !== undefined ? { tokens: Math.max(0, cap.maxTokens - spent.tokens) } : {}),
      ...(cap.maxDollars !== undefined ? { dollars: Math.max(0, cap.maxDollars - spent.dollars) } : {}),
    }),
    isExhausted: () => {
      if (cap.maxTokens !== undefined && spent.tokens >= cap.maxTokens) return true;
      if (cap.maxDollars !== undefined && spent.dollars >= cap.maxDollars) return true;
      return false;
    },
    record: usage => {
      const tokens = usage.totalTokens;
      if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
        spent.tokens += Math.floor(tokens);
      }
      if (usage.costUsd !== undefined && Number.isFinite(usage.costUsd) && usage.costUsd > 0) {
        spent.dollars = addDollars(spent.dollars, usage.costUsd);
      }
    },
  };
}

/** Tighten a per-scan CLA-22 budget so a job cannot spend past the global remainder. */
export function clampEnrichmentBudget(
  budget: EnrichmentBudget,
  spend?: GlobalEnrichmentSpend,
): EnrichmentBudget {
  if (!spend) return budget;
  const remaining = spend.remaining();
  return {
    ...budget,
    maxTokens: remaining.tokens !== undefined
      ? Math.min(budget.maxTokens, Math.max(0, Math.floor(remaining.tokens)))
      : budget.maxTokens,
    maxDollars: remaining.dollars !== undefined
      ? Math.min(budget.maxDollars, Math.max(0, remaining.dollars))
      : budget.maxDollars,
  };
}
