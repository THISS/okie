export type ClaimOrigin = 'observed' | 'inferred' | 'ai-explanation';

export type ClaimProvenance = {
  origin: ClaimOrigin;
  evidenceCount: number;
  /** Confidence in a derived claim or its supporting claims, never in observed source text. */
  confidence?: number;
  commitPinned?: boolean;
};

export type ClaimProvenancePresentation = {
  badge: string;
  heading: string;
  description: string;
  evidenceLabel: string;
  confidenceLabel?: string;
  accessibleSummary: string;
  tone: 'observed' | 'inferred' | 'explanation';
};

function normalizedEvidenceCount(value: number) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function confidencePercent(value: number | undefined) {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1
    ? Math.round(value * 100)
    : undefined;
}

function evidenceLabel(count: number) {
  if (count === 0) return 'No source evidence linked';
  return `${count} source ${count === 1 ? 'reference' : 'references'}`;
}

/**
 * Keeps provenance language deterministic and prevents a model-generated
 * explanation from being presented as source evidence or observed truth.
 */
export function presentClaimProvenance(value: ClaimProvenance): ClaimProvenancePresentation {
  const count = normalizedEvidenceCount(value.evidenceCount);
  const evidence = evidenceLabel(count);

  if (value.origin === 'observed') {
    const description = value.commitPinned
      ? 'Read directly from commit-pinned source.'
      : 'Read directly from source. Pin a commit before relying on this observation.';
    return {
      badge: 'Observed',
      heading: 'Observed in source',
      description,
      evidenceLabel: evidence,
      accessibleSummary: `Observed in source. ${description} ${evidence}.`,
      tone: 'observed',
    };
  }

  const percent = confidencePercent(value.confidence);
  if (value.origin === 'inferred') {
    const description = count > 0
      ? 'Derived deterministically from linked source facts.'
      : 'Derived without linked source evidence; review before relying on it.';
    const confidenceLabel = percent === undefined ? undefined : `Inference confidence ${percent}%`;
    return {
      badge: 'Inferred',
      heading: 'Inferred from source',
      description,
      evidenceLabel: evidence,
      ...(confidenceLabel ? { confidenceLabel } : {}),
      accessibleSummary: `Inferred from source. ${description} ${confidenceLabel ? `${confidenceLabel}. ` : ''}${evidence}.`,
      tone: 'inferred',
    };
  }

  const description = 'AI-authored wording based on supporting claims. It is not source evidence; verify the linked claims.';
  const confidenceLabel = percent === undefined ? undefined : `Supporting-claim confidence ${percent}%`;
  return {
    badge: 'AI explanation',
    heading: 'AI-authored explanation',
    description,
    evidenceLabel: evidence,
    ...(confidenceLabel ? { confidenceLabel } : {}),
    accessibleSummary: `AI-authored explanation. ${description} ${confidenceLabel ? `${confidenceLabel}. ` : ''}${evidence}.`,
    tone: 'explanation',
  };
}
