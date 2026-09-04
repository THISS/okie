/**
 * CLA-75: secret-free sidecar written next to published atlas artifacts.
 * Maps job enrichment state + the merge report into {state, counts, why} —
 * never notes, reasons, keys, spend, gateway URLs, or scanRoot.
 */

import { GLOBAL_ENRICHMENT_BUDGET_SKIP_NOTE } from "./globalSpend.js";
import type { EnrichmentState } from "./jobs.js";

export type PublishedEnrichmentWhy = "rejected" | "over-cap" | "budget" | "no-key" | "failed";

export type PublishedEnrichmentStatus = {
  state: "complete" | "skipped" | "failed";
  acceptedContainers: number;
  attemptedContainers: number;
  why?: PublishedEnrichmentWhy;
};

export type PublishedReportShape = {
  results?: ReadonlyArray<{ accepted?: boolean }>;
};

function classifySkipNote(note: string | undefined): PublishedEnrichmentWhy | undefined {
  if (!note || note === "enrichment disabled") return undefined;
  if (note === GLOBAL_ENRICHMENT_BUDGET_SKIP_NOTE) return "budget";
  if (/no LLM credentials/i.test(note)) return "no-key";
  return undefined;
}

/**
 * Build the published sidecar. Returns undefined for pure deterministic scans
 * (enrichment off / disabled) so the atlas omits honesty chrome.
 */
export function publishedEnrichmentStatus(input: {
  state: EnrichmentState;
  note?: string;
  report?: PublishedReportShape;
}): PublishedEnrichmentStatus | undefined {
  if (input.state === "pending" || input.state === "running") return undefined;
  if (input.state === "skipped" && input.note === "enrichment disabled") return undefined;

  const results = input.report?.results ?? [];
  const acceptedContainers = results.filter(result => result.accepted === true).length;
  const attemptedContainers = results.length;

  let why: PublishedEnrichmentWhy | undefined;
  if (input.state === "failed") why = "failed";
  else if (input.state === "skipped") {
    why = classifySkipNote(input.note) ?? "no-key";
  } else if (input.state === "complete") {
    const rejected = results.some(result => result.accepted === false);
    if (rejected) why = "rejected";
  }

  if (input.state !== "complete" && input.state !== "skipped" && input.state !== "failed") {
    return undefined;
  }

  return {
    state: input.state,
    acceptedContainers,
    attemptedContainers,
    ...(why ? { why } : {}),
  };
}
