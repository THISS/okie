/**
 * CLA-75: secret-free copy for a published atlas when enrichment ran but
 * summaries are missing. Maps `enrichment-report.json` / a published status
 * sidecar — never job notes, gateway bodies, keys, spend, or `scanRoot`.
 */

export type EnrichmentHonestyWhy = 'rejected' | 'over-cap' | 'budget' | 'no-key' | 'failed';

export type PublishedEnrichmentHonesty = {
  why: EnrichmentHonestyWhy;
  acceptedContainers: number;
  attemptedContainers: number;
  /** Short chrome: "Enrichment complete — 0 accepted (gate rejected)". */
  chip: string;
  /** Inspector Details line when the selected entity has no accepted summary. */
  details: string;
};

/** Wire shape of published `enrichment-status.json`. No notes, no reasons. */
export type PublishedEnrichmentStatus = {
  state: 'complete' | 'skipped' | 'failed';
  acceptedContainers: number;
  attemptedContainers: number;
  why?: EnrichmentHonestyWhy;
};

export type PublishedEnrichmentDocResult = {
  containerId: string;
  accepted: boolean;
  reasons: string[];
};

export type PublishedEnrichmentReport = {
  enrichedContainers: string[];
  results: PublishedEnrichmentDocResult[];
  systemScope?: { accepted: boolean; reasons: string[] };
};

const SECRET_LEAK = /api[_-]?key|scanRoot|OPENROUTER|gho_|ghp_|github_pat_|sk-|spend|usd|\$\d|https?:\/\//i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * Structural parse. Extra fields (notes, spend, gateway URLs) are dropped so
 * they cannot leak into chrome even if a future publisher adds them.
 */
export function parsePublishedEnrichmentReport(raw: unknown): PublishedEnrichmentReport | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const resultsRaw = record.results;
  if (!Array.isArray(resultsRaw)) return undefined;
  const results: PublishedEnrichmentDocResult[] = [];
  for (const item of resultsRaw) {
    const row = asRecord(item);
    if (!row || typeof row.containerId !== 'string' || typeof row.accepted !== 'boolean') continue;
    results.push({
      containerId: row.containerId,
      accepted: row.accepted,
      reasons: asStringArray(row.reasons),
    });
  }
  const enriched = asStringArray(record.enrichedContainers);
  const system = asRecord(record.systemScope);
  return {
    enrichedContainers: enriched,
    results,
    ...(system && typeof system.accepted === 'boolean'
      ? { systemScope: { accepted: system.accepted, reasons: asStringArray(system.reasons) } }
      : {}),
  };
}

export function parsePublishedEnrichmentStatus(raw: unknown): PublishedEnrichmentStatus | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  if (record.state !== 'complete' && record.state !== 'skipped' && record.state !== 'failed') return undefined;
  const acceptedContainers = typeof record.acceptedContainers === 'number' && Number.isFinite(record.acceptedContainers)
    ? Math.max(0, Math.floor(record.acceptedContainers))
    : 0;
  const attemptedContainers = typeof record.attemptedContainers === 'number' && Number.isFinite(record.attemptedContainers)
    ? Math.max(0, Math.floor(record.attemptedContainers))
    : 0;
  const why = record.why;
  const knownWhy = why === 'rejected' || why === 'over-cap' || why === 'budget' || why === 'no-key' || why === 'failed'
    ? why
    : undefined;
  return {
    state: record.state,
    acceptedContainers,
    attemptedContainers,
    ...(knownWhy ? { why: knownWhy } : {}),
  };
}

/**
 * Classify gate/skip reason strings into a high-level why. The strings themselves
 * never leave this function — they can carry gateway bodies.
 */
export function classifyEnrichmentWhy(reasons: readonly string[]): EnrichmentHonestyWhy | undefined {
  if (reasons.length === 0) return undefined;
  const text = reasons.join('\n').toLowerCase();
  if (/\bcap\b/.test(text) && /code/.test(text)) return 'over-cap';
  if (/budget|max tokens|max dollars|max scopes/.test(text)) return 'budget';
  if (/no llm credentials|credentials visible|no key/.test(text)) return 'no-key';
  return 'rejected';
}

/** CLA-29 skip notes → published why. Unknown / gateway notes are ignored. */
export function honestyWhyFromSkipNote(note: string | undefined): EnrichmentHonestyWhy | undefined {
  if (!note) return undefined;
  if (note === 'enrichment disabled') return undefined;
  if (note === 'global enrichment budget reached') return 'budget';
  if (/no LLM credentials/i.test(note)) return 'no-key';
  return undefined;
}

function honestyCopy(
  why: EnrichmentHonestyWhy,
  acceptedContainers: number,
  attemptedContainers: number,
): PublishedEnrichmentHonesty {
  switch (why) {
    case 'rejected':
      if (acceptedContainers === 0) {
        return {
          why,
          acceptedContainers,
          attemptedContainers,
          chip: 'Enrichment complete — 0 accepted (gate rejected)',
          details: 'Enrichment complete — 0 accepted (gate rejected). Scope stayed deterministic.',
        };
      }
      return {
        why,
        acceptedContainers,
        attemptedContainers,
        chip: `Enrichment partial — ${acceptedContainers} accepted (gate rejected)`,
        details: `Enrichment partial — ${acceptedContainers} accepted (gate rejected). Other scopes stayed deterministic.`,
      };
    case 'over-cap':
      if (acceptedContainers === 0) {
        return {
          why,
          acceptedContainers,
          attemptedContainers,
          chip: 'Enrichment skipped (over code cap)',
          details: 'Enrichment skipped (over code cap). Scope stayed deterministic.',
        };
      }
      return {
        why,
        acceptedContainers,
        attemptedContainers,
        chip: 'Enrichment partial — over code cap',
        details: 'Enrichment partial — over code cap. Scope stayed deterministic.',
      };
    case 'budget':
      return {
        why,
        acceptedContainers,
        attemptedContainers,
        chip: 'Enrichment skipped (token budget)',
        details: 'Enrichment skipped (token budget). Scope stayed deterministic.',
      };
    case 'no-key':
      return {
        why,
        acceptedContainers,
        attemptedContainers,
        chip: 'Enrichment skipped (no key)',
        details: 'Enrichment skipped (no key). Scope stayed deterministic.',
      };
    case 'failed':
      return {
        why,
        acceptedContainers,
        attemptedContainers,
        chip: 'Enrichment failed',
        details: 'Enrichment failed; the deterministic atlas stands.',
      };
  }
}

function stripLeaks(honesty: PublishedEnrichmentHonesty): PublishedEnrichmentHonesty {
  const blob = `${honesty.chip}\n${honesty.details}`;
  if (SECRET_LEAK.test(blob)) {
    return honestyCopy(honesty.why, honesty.acceptedContainers, honesty.attemptedContainers);
  }
  return honesty;
}

export function publishedEnrichmentHonesty(input: {
  report?: PublishedEnrichmentReport;
  status?: PublishedEnrichmentStatus;
  skipNote?: string;
}): PublishedEnrichmentHonesty | undefined {
  const report = input.report;
  const status = input.status;
  const skipWhy = honestyWhyFromSkipNote(input.skipNote);

  if (report) {
    const rejectedReasons = [
      ...report.results.filter(result => !result.accepted).flatMap(result => result.reasons),
      ...(report.systemScope && !report.systemScope.accepted ? report.systemScope.reasons : []),
    ];
    const acceptedContainers = report.results.filter(result => result.accepted).length
      + (report.systemScope?.accepted ? 1 : 0);
    const attemptedContainers = report.results.length + (report.systemScope ? 1 : 0);
    const rejectedCount = report.results.filter(result => !result.accepted).length
      + (report.systemScope && !report.systemScope.accepted ? 1 : 0);
    const why = classifyEnrichmentWhy(rejectedReasons)
      ?? status?.why
      ?? skipWhy
      ?? (rejectedCount > 0 ? 'rejected' : undefined);
    if (!why) return undefined;
    return stripLeaks(honestyCopy(why, acceptedContainers, attemptedContainers));
  }

  if (status?.why) {
    return stripLeaks(honestyCopy(status.why, status.acceptedContainers, status.attemptedContainers));
  }
  if (status?.state === 'failed') {
    return stripLeaks(honestyCopy('failed', status.acceptedContainers, status.attemptedContainers));
  }
  if (status?.state === 'complete' && status.attemptedContainers > 0 && status.acceptedContainers === 0) {
    return stripLeaks(honestyCopy('rejected', 0, status.attemptedContainers));
  }
  if (skipWhy) {
    return stripLeaks(honestyCopy(skipWhy, status?.acceptedContainers ?? 0, status?.attemptedContainers ?? 0));
  }
  return undefined;
}
