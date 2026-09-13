import type { OperatorScope } from './api';

type Envelope = { versionId: string; explanations: OperatorScope[] };
function isEnvelope(value: unknown): value is Envelope {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.versionId === 'string' && Array.isArray(record.explanations);
}

/** Loads only an immutable sidecar selected by the exact bootstrap publication. */
export async function loadPublishedExplanations(slug: string, versionId: string, fetchImpl: typeof fetch = fetch): Promise<OperatorScope[] | undefined> {
  const path = `/scan/${encodeURIComponent(slug)}/operator-explanations.json?${new URLSearchParams({ version: versionId })}`;
  const response = await fetchImpl(path);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Published explanations are unavailable (${response.status}).`);
  const envelope: unknown = await response.json();
  if (!isEnvelope(envelope) || envelope.versionId !== versionId) throw new Error('Published explanations do not match this atlas publication.');
  return envelope.explanations.filter(scope => typeof scope === 'object' && scope !== null && typeof scope.entityId === 'string' && typeof scope.scopeId === 'string' && typeof scope.name === 'string' && typeof scope.state === 'string');
}
