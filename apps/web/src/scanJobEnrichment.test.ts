import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { enrichmentStageDetail } from './scanJobEnrichment';

describe('enrichmentStageDetail (CLA-29)', () => {
  it('says skipped (no key) without dumping operator notes', () => {
    expect(enrichmentStageDetail({
      state: 'skipped',
      note: 'no LLM credentials visible (set OKIE_LLM_API_KEY / OPENROUTER_API_KEY)',
    })).toBe('skipped (no key)');
  });

  it('says skipped when enrichment is disabled', () => {
    expect(enrichmentStageDetail({ state: 'skipped', note: 'enrichment disabled' })).toBe('skipped');
  });

  it('says failed without echoing gateway URLs from the note', () => {
    expect(enrichmentStageDetail({
      state: 'failed',
      note: 'llm gateway 401 from https://okietest:okie-test-url-token-cla29-fake@example.invalid/v1',
    })).toBe('failed; the deterministic atlas stands');
  });

  it('says ran with provider and model id, never a key', () => {
    expect(enrichmentStageDetail({
      state: 'complete',
      provider: 'openrouter.ai',
      modelId: 'anthropic/claude-sonnet-4',
      enrichedContainers: 3,
    })).toBe('ran with openrouter.ai · anthropic/claude-sonnet-4');
  });

  it('omits pending and running suffixes', () => {
    expect(enrichmentStageDetail({ state: 'pending' })).toBeUndefined();
    expect(enrichmentStageDetail({ state: 'running', modelId: 'acme/fast' })).toBeUndefined();
  });

  it('scanLanding does not dump enrichment.note (notes can carry gateway errors)', () => {
    const src = readFileSync(new URL('./scanLanding.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/job\.enrichment\.note/);
    expect(src).toMatch(/enrichmentStageDetail/);
    expect(src).toMatch(/data-enrichment-state/);
  });
});
