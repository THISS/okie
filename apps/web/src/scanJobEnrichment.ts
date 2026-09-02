/**
 * Paste-a-repo job enrichment copy (CLA-29). The landing shows whether magic
 * ran, was skipped (no key), or failed. Provider/model id come from the job
 * row; notes are never dumped here — they can carry gateway error text.
 */

export type PublicEnrichmentState = 'pending' | 'running' | 'complete' | 'skipped' | 'failed';

export type PublicEnrichment = {
  state: PublicEnrichmentState;
  enrichedContainers?: number;
  note?: string;
  modelId?: string;
  provider?: string;
};

/** Suffix on the "Writing AI descriptions" step. `undefined` while pending/running. */
export function enrichmentStageDetail(enrichment: PublicEnrichment): string | undefined {
  if (enrichment.state === 'skipped') {
    if (enrichment.note === 'enrichment disabled' || enrichment.note === 'global enrichment budget reached') {
      return 'skipped';
    }
    return 'skipped (no key)';
  }
  if (enrichment.state === 'failed') {
    return 'failed; the deterministic atlas stands';
  }
  if (enrichment.state === 'complete') {
    const model = enrichment.modelId?.trim();
    const provider = enrichment.provider?.trim();
    if (model && provider) return `ran with ${provider} · ${model}`;
    if (model) return `ran with ${model}`;
    return 'ran';
  }
  return undefined;
}
