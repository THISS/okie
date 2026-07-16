import { describe, expect, it } from 'vitest';
import { presentClaimProvenance } from './presentation';

describe('presentClaimProvenance', () => {
  it('presents an observed fact as commit-pinned evidence without probabilistic confidence', () => {
    const presentation = presentClaimProvenance({
      origin: 'observed',
      evidenceCount: 1,
      confidence: 0.42,
      commitPinned: true,
    });

    expect(presentation).toMatchObject({
      badge: 'Observed',
      heading: 'Observed in source',
      description: 'Read directly from commit-pinned source.',
      evidenceLabel: '1 source reference',
      tone: 'observed',
    });
    expect(presentation.confidenceLabel).toBeUndefined();
  });

  it('labels confidence as inference confidence and discloses missing evidence', () => {
    const presentation = presentClaimProvenance({ origin: 'inferred', evidenceCount: 0, confidence: 0.934 });

    expect(presentation.confidenceLabel).toBe('Inference confidence 93%');
    expect(presentation.description).toContain('without linked source evidence');
    expect(presentation.evidenceLabel).toBe('No source evidence linked');
  });

  it('describes AI output as authored wording and assigns confidence only to supporting claims', () => {
    const presentation = presentClaimProvenance({ origin: 'ai-explanation', evidenceCount: 3, confidence: 0.86 });

    expect(presentation.heading).toBe('AI-authored explanation');
    expect(presentation.description).toContain('not source evidence');
    expect(presentation.confidenceLabel).toBe('Supporting-claim confidence 86%');
    expect(presentation.accessibleSummary).toContain('verify the linked claims');
  });

  it('omits invalid confidence rather than clamping or inventing certainty', () => {
    const presentation = presentClaimProvenance({
      origin: 'inferred',
      evidenceCount: Number.NaN,
      confidence: 1.2,
    });

    expect(presentation.evidenceLabel).toBe('No source evidence linked');
    expect(presentation.confidenceLabel).toBeUndefined();
  });
});
