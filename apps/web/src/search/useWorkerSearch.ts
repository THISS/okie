import { useEffect, useRef, useState } from 'react';
import type { SceneEntity } from '../renderer/types';
import { DEFAULT_SEARCH_RESULT_LIMIT } from '../searchSuggestions';
import { SearchClient, type SearchClientState } from './searchClient';
import { fallbackSearch, prepareSearchCorpus, type SearchTiming } from './searchEngine';

// Capture before the app canonicalizes navigation queries. Production ignores this QA switch.
const forceFallback = import.meta.env.DEV && typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('searchWorker') === '0';

const EMPTY_IDS: string[] = [];

export type WorkerSearchState = {
  ids: string[];
  status: 'idle' | SearchClientState;
  backend: 'worker' | 'fallback' | 'none';
};

export function useWorkerSearch(entities: readonly SceneEntity[], query: string, enabled: boolean, onTiming?: SearchTiming): WorkerSearchState {
  const completed = useRef<{ query: string; entities: readonly SceneEntity[] } | null>(null);
  const [state, setState] = useState<WorkerSearchState>({ ids: EMPTY_IDS, status: 'idle', backend: 'none' });
  const timing = useRef(onTiming);
  timing.current = onTiming;
  const latestQuery = useRef(query);
  latestQuery.current = query;
  const generation = useRef(0);
  const active = useRef(enabled);
  active.current = enabled;
  const session = useRef<{ submit(query: string): void; cancel(): void } | null>(null);
  const teardown = useRef<(() => void) | null>(null);
  useEffect(() => () => { teardown.current?.(); teardown.current = null; session.current = null; }, [entities]);

  useEffect(() => {
    if (!enabled) {
      session.current?.cancel();
      setState(previous => ({ ...previous, ids: EMPTY_IDS, status: 'idle' }));
      return;
    }
    if (session.current) return;
    const revision = ++generation.current;
    let disposed = false;
    let preparationCancelled = false;
    let fallbackSerial = 0;
    let client: SearchClient | undefined;
    const cancelled = () => disposed || generation.current !== revision;
    const report: SearchTiming = (metric, duration) => {
      if (!cancelled()) timing.current?.(metric, duration);
    };
    setState({ ids: EMPTY_IDS, status: enabled ? 'building' : 'idle', backend: 'none' });

    const fallback = (value: string) => {
      const token = ++fallbackSerial;
      const start = performance.now();
      setState({ ids: EMPTY_IDS, status: 'searching', backend: 'fallback' });
      void fallbackSearch(entities, value, DEFAULT_SEARCH_RESULT_LIMIT, () => cancelled() || token !== fallbackSerial).then(ids => {
        if (ids === null || cancelled() || token !== fallbackSerial || !active.current) return;
        report('searchFallback', performance.now() - start);
        completed.current = { query: value, entities };
        setState({ ids, status: 'fallback', backend: 'fallback' });
      });
    };
    const activateFallback = () => {
      if (cancelled()) return;
      preparationCancelled = true;
      session.current = { submit: fallback, cancel: () => { fallbackSerial++; } };
      if (active.current) fallback(latestQuery.current);
    };
    try {
      // A development-only capability switch for fallback QA; ignored in production.
      if (forceFallback) {
        throw new Error('Development search fallback');
      }
      const worker = new Worker(new URL('./searchWorker.ts', import.meta.url), { type: 'module' });
      client = new SearchClient(worker, revision,
        (ids, resultQuery) => { if (!cancelled() && active.current) { completed.current = { query: resultQuery, entities }; setState({ ids, status: 'ready', backend: 'worker' }); } },
        status => { if (!cancelled() && active.current && status !== 'fallback') setState(previous => ({ ...previous, status, backend: 'worker' })); },
        activateFallback, report);
      session.current = { submit: value => { if (!cancelled()) { setState(previous => ({ ...previous, ids: [] })); client?.query(value, DEFAULT_SEARCH_RESULT_LIMIT); } }, cancel: () => client?.cancel() };
      const start = performance.now();
      void prepareSearchCorpus(entities, () => cancelled() || preparationCancelled).then(buffer => {
        if (!buffer || cancelled() || preparationCancelled) return;
        report('searchPrepare', performance.now() - start);
        client?.init(buffer);
      }).catch(() => { client?.dispose(); activateFallback(); });
    } catch { activateFallback(); }
    teardown.current = () => {
      disposed = true;
      fallbackSerial++;
      client?.dispose();
      session.current = null;
    };
  }, [entities, enabled]);

  useEffect(() => { if (enabled) session.current?.submit(query); }, [query, entities, enabled]);
  const matches = completed.current?.query === query && completed.current?.entities === entities;
  return !enabled ? { ...state, ids: EMPTY_IDS, status: 'idle' } : matches ? state : { ...state, ids: EMPTY_IDS, status: state.status === 'idle' ? 'building' : state.status === 'ready' || state.status === 'fallback' ? 'searching' : state.status };
}
