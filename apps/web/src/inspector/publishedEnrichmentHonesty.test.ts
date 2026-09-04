import { describe, expect, it } from 'vitest';
import { inspectorAcceptedSummary, INSPECTOR_EMPTY_SUMMARY } from './inspectorPanel';
import {
  classifyEnrichmentWhy,
  parsePublishedEnrichmentReport,
  parsePublishedEnrichmentStatus,
  publishedEnrichmentHonesty,
} from './publishedEnrichmentHonesty';

const GATEWAY_NOTE = 'llm gateway 401 from https://okietest:okie-test-url-token-cla75-fake@example.invalid/v1 spend $12.34 scanRoot=/home/runner OPENROUTER_API_KEY=sk-fake';

function leakBlob(value: unknown): string {
  return JSON.stringify(value);
}

describe('publishedEnrichmentHonesty (CLA-75)', () => {
  it('maps a 0-accepted report to gate-rejected copy without dumping reasons', () => {
    const honesty = publishedEnrichmentHonesty({
      report: {
        enrichedContainers: [],
        results: [{
          containerId: 'container:apps-web',
          accepted: false,
          reasons: [
            'gate: entities[0].id must restate the scanned container',
            GATEWAY_NOTE,
          ],
        }],
      },
    });
    expect(honesty?.why).toBe('rejected');
    expect(honesty?.chip).toBe('Enrichment complete — 0 accepted (gate rejected)');
    expect(honesty?.details).toContain('Scope stayed deterministic');
    expect(honesty?.acceptedContainers).toBe(0);
    expect(leakBlob(honesty)).not.toMatch(/okie-test-url-token|example\.invalid|scanRoot|\$12|OPENROUTER|sk-fake|must restate/i);
  });

  it('maps a partial report to partial rejected copy', () => {
    const honesty = publishedEnrichmentHonesty({
      report: {
        enrichedContainers: ['container:ok'],
        results: [
          { containerId: 'container:ok', accepted: true, reasons: [] },
          { containerId: 'container:nope', accepted: false, reasons: ['document is not a JSON object'] },
        ],
      },
    });
    expect(honesty?.why).toBe('rejected');
    expect(honesty?.chip).toBe('Enrichment partial — 1 accepted (gate rejected)');
    expect(leakBlob(honesty)).not.toMatch(/document is not a JSON object/);
  });

  it('maps over-cap reason text to over-code-cap copy without counts or spend', () => {
    const honesty = publishedEnrichmentHonesty({
      report: {
        enrichedContainers: [],
        results: [{
          containerId: 'container:apps-web',
          accepted: false,
          reasons: ['skipped (474 code entities > 400 cap; stays deterministic)'],
        }],
      },
    });
    expect(honesty?.why).toBe('over-cap');
    expect(honesty?.chip).toBe('Enrichment skipped (over code cap)');
    expect(leakBlob(honesty)).not.toMatch(/474|400|\$|spend/i);
  });

  it('maps token-budget reason text without dumping the cap numbers', () => {
    const honesty = publishedEnrichmentHonesty({
      report: {
        enrichedContainers: [],
        results: [{
          containerId: 'container:scan',
          accepted: false,
          reasons: ['scan budget max tokens 200000 reached (200041)'],
        }],
      },
    });
    expect(honesty?.why).toBe('budget');
    expect(honesty?.chip).toBe('Enrichment skipped (token budget)');
    expect(leakBlob(honesty)).not.toMatch(/200000|200041/);
  });

  it('maps skipped (no key) from CLA-29 skip notes without dumping operator copy', () => {
    const honesty = publishedEnrichmentHonesty({
      skipNote: 'no LLM credentials visible (set OKIE_LLM_API_KEY / OPENROUTER_API_KEY)',
    });
    expect(honesty?.why).toBe('no-key');
    expect(honesty?.chip).toBe('Enrichment skipped (no key)');
    expect(leakBlob(honesty)).not.toMatch(/OKIE_LLM_API_KEY|OPENROUTER|set /);
  });

  it('maps a published status sidecar for skipped budget', () => {
    const honesty = publishedEnrichmentHonesty({
      status: { state: 'skipped', acceptedContainers: 0, attemptedContainers: 0, why: 'budget' },
    });
    expect(honesty?.chip).toBe('Enrichment skipped (token budget)');
  });

  it('omits chrome when the report is absent (pure deterministic scan)', () => {
    expect(publishedEnrichmentHonesty({})).toBeUndefined();
    expect(publishedEnrichmentHonesty({ report: undefined, status: undefined })).toBeUndefined();
    expect(publishedEnrichmentHonesty({
      skipNote: 'enrichment disabled',
    })).toBeUndefined();
  });

  it('omits chrome when every submitted scope was accepted', () => {
    expect(publishedEnrichmentHonesty({
      report: {
        enrichedContainers: ['container:ok'],
        results: [{ containerId: 'container:ok', accepted: true, reasons: [] }],
      },
    })).toBeUndefined();
  });

  it('accepted summary path still wins over honesty copy', () => {
    const honesty = publishedEnrichmentHonesty({
      report: {
        enrichedContainers: ['container:ok'],
        results: [
          { containerId: 'container:ok', accepted: true, reasons: [] },
          { containerId: 'container:nope', accepted: false, reasons: [GATEWAY_NOTE] },
        ],
      },
    });
    expect(honesty?.why).toBe('rejected');
    expect(inspectorAcceptedSummary({ responsibility: 'Hosts the scan server.' })).toBe('Hosts the scan server.');
    expect(inspectorAcceptedSummary({ responsibility: INSPECTOR_EMPTY_SUMMARY })).toBeUndefined();
    expect(inspectorAcceptedSummary({ responsibility: 'No summary supplied.' })).toBeUndefined();
  });

  it('parse drops unknown fields so keys and scanRoot cannot ride along', () => {
    const report = parsePublishedEnrichmentReport({
      promptVersion: 'okie-enrichment/v2',
      enrichedContainers: ['container:x'],
      results: [{ containerId: 'container:x', accepted: false, reasons: [GATEWAY_NOTE] }],
      scanRoot: '/secret/scan',
      apiKey: 'okie-test-llm-key-cla75-fake',
      note: GATEWAY_NOTE,
    });
    expect(report?.results[0]?.reasons[0]).toBe(GATEWAY_NOTE);
    const honesty = publishedEnrichmentHonesty({ report });
    expect(leakBlob(honesty)).not.toMatch(/scanRoot|okie-test-llm-key|okie-test-url-token|\/secret\/scan/i);

    const status = parsePublishedEnrichmentStatus({
      state: 'skipped',
      acceptedContainers: 0,
      attemptedContainers: 0,
      why: 'no-key',
      note: GATEWAY_NOTE,
      scanRoot: '/secret',
      apiKey: 'x',
    });
    expect(status).toEqual({ state: 'skipped', acceptedContainers: 0, attemptedContainers: 0, why: 'no-key' });
  });

  it('classify never returns the raw reason string', () => {
    expect(classifyEnrichmentWhy(['gate: <root> invalid'])).toBe('rejected');
    expect(classifyEnrichmentWhy([])).toBeUndefined();
  });
});
