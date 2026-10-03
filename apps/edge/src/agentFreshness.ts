import { isPublishedVersionId } from '../../server/src/publishedStoreLayout';

/** Only recorded ISO instants qualify; never substitute scan or pointer time for publication time. */
export function publicationTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const time = Date.parse(value);
  const day = Date.parse(`${value.slice(0,10)}T00:00:00Z`);
  if (!Number.isFinite(time) || !Number.isFinite(day) || new Date(day).toISOString().slice(0,10) !== value.slice(0,10)) return null;
  return new Date(time).toISOString();
}

function ageContext(seconds: number | null, publishedAt: string | null): string {
  if (!publishedAt) return 'Publication time unknown.';
  if (seconds === null) return 'Recorded publication time is in the future; age is unknown.';
  if (seconds < 60) return 'Published less than a minute ago.';
  const [value, unit] = seconds < 3600 ? [Math.floor(seconds / 60), 'minute']
    : seconds < 86400 ? [Math.floor(seconds / 3600), 'hour'] : [Math.floor(seconds / 86400), 'day'];
  return `Published ${value} ${unit}${value === 1 ? '' : 's'} ago.`;
}

/** Store freshness is distinct from repository HEAD, which these read-only tools never fetch. */
export function agentPublicationFreshness(publication: Record<string, unknown>, now: number, latestVersionId?: string) {
  const publishedAt = publicationTimestamp(publication.publishedAt);
  const generatedAt = publicationTimestamp(publication.generatedAt);
  const elapsed = publishedAt ? Math.floor((now - Date.parse(publishedAt)) / 1000) : null;
  const publicationAgeSeconds = elapsed !== null && elapsed >= 0 ? elapsed : null;
  const latest = latestVersionId && isPublishedVersionId(latestVersionId) ? latestVersionId : null;
  return {
    observedAt: new Date(now).toISOString(), generatedAt, publishedAt,
    publicationAgeSeconds, publicationAgeContext: ageContext(publicationAgeSeconds, publishedAt),
    latestPublishedVersionId: latest,
    evidenceComparedWithLatestPublication: latest === null ? 'unknown' : publication.versionId === latest ? 'matches' : 'differs',
    currentRepositoryRevision: 'not-checked',
  };
}
