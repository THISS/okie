import type { SearchMetric } from './recorder';

export type SearchTimingName = 'searchStartup' | 'searchPrepare' | 'searchIndex' | 'searchQuery' | 'searchRoundTrip' | 'searchFallback';
const names: Record<SearchTimingName, SearchMetric> = {
  searchStartup: 'search-startup', searchPrepare: 'search-prepare', searchIndex: 'search-index', searchQuery: 'search-query',
  searchRoundTrip: 'search-round-trip', searchFallback: 'search-fallback',
};
const listeners = new Set<(metric: SearchMetric, durationMs: number) => void>();
/** Numeric durations only. Nothing is retained when local diagnostics are stopped. */
export function recordSearchTiming(name: SearchTimingName, durationMs: number): void {
  if (!Object.hasOwn(names, name)) return;
  const metric = names[name];
  if (!metric || !Number.isFinite(durationMs) || durationMs < 0) return;
  for (const listener of listeners) listener(metric, durationMs);
}
export function subscribeSearchTiming(listener: (metric: SearchMetric, durationMs: number) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
