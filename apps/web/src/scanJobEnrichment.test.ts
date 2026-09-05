import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { enrichmentStageDetail, scanEntityCountCopy } from './scanJobEnrichment';
import { SCAN_BAND_DEPTH_MIN_ENTITIES } from './renderer/scanFixture';

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

  it('says skipped when the global enrichment budget is reached, without dumping spend', () => {
    expect(enrichmentStageDetail({
      state: 'skipped',
      note: 'global enrichment budget reached',
    })).toBe('skipped');
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

  it('scanLanding requires GitHub sign-in for scan and keeps /r views public', () => {
    const src = readFileSync(new URL('./scanLanding.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/\/api\/auth\/me/);
    expect(src).toMatch(/credentials: 'include'/);
    expect(src).toMatch(/Sign in with GitHub/);
    expect(src).toMatch(/no login wall on the map/);
    expect(src).not.toMatch(/no account needed/);
    expect(src).not.toMatch(/gho_|GITHUB_TOKEN|GH_TOKEN|client_secret/);
  });

  it('CLA-88: job card and Already mapped share one entity-count copy and refresh the manifest', () => {
    expect(scanEntityCountCopy(271)).toBe('271 entities');
    expect(scanEntityCountCopy(378)).toBe('378 entities');
    const src = readFileSync(new URL('./scanLanding.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(/scanEntityCountCopy\(job\.entityCount\)/);
    expect(src).toMatch(/scanEntityCountCopy\(repo\.entityCount\)/);
    expect(src).toMatch(/job\?\.atlasReady, job\?\.entityCount, job\?\.commitSha/);
    expect(src).not.toMatch(/export surface/);
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
  });
});
