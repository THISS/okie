import type { Camera } from '../renderer/types';
import {
  canonicalNavigationState,
  canonicalNavigationUrl,
  navigationStateFromUrl,
  type NavigationDefaults,
  type NavigationState,
  type NavigationUrlOptions,
} from './navigationState';

export type NavigationHistoryAdapter = {
  getHref(): string;
  pushState(data: unknown, url: string): void;
  replaceState(data: unknown, url: string): void;
  addPopStateListener(listener: () => void): () => void;
  now(): number;
};

export type NavigationCommit = {
  state: NavigationState;
  canonicalUrl: string;
  settledEpoch: number;
  source: 'initialize' | 'push' | 'replace' | 'camera' | 'popstate';
};

export type NavigationHistoryController = {
  start(restoreInitial?: boolean): Promise<NavigationState>;
  current(): NavigationState;
  push(state: NavigationState): void;
  replace(state: NavigationState): void;
  commitSettledCamera(camera: Camera, baseState?: NavigationState): void;
  flush(state: NavigationState): void;
  dispose(): void;
};

export type NavigationHistoryOptions = {
  defaults: NavigationDefaults;
  adapter?: NavigationHistoryAdapter;
  urlOptions?: NavigationUrlOptions;
  restore(state: NavigationState, source: 'initialize' | 'popstate'): void | Promise<void>;
  onCommit?(commit: NavigationCommit): void;
  cameraCoalesceMs?: number;
};

function browserAdapter(): NavigationHistoryAdapter {
  return {
    getHref: () => window.location.href,
    pushState: (data, url) => window.history.pushState(data, '', url),
    replaceState: (data, url) => window.history.replaceState(data, '', url),
    addPopStateListener(listener) {
      window.addEventListener('popstate', listener);
      return () => window.removeEventListener('popstate', listener);
    },
    now: () => performance.now(),
  };
}

export function createNavigationHistoryController(options: NavigationHistoryOptions): NavigationHistoryController {
  const adapter = options.adapter ?? browserAdapter();
  void options.cameraCoalesceMs;
  let state = canonicalNavigationState({}, options.defaults);
  let settledEpoch = 0;
  let restoreGeneration = 0;
  let detach = () => {};

  const notify = (source: NavigationCommit['source'], canonicalUrl: string) => {
    settledEpoch += 1;
    options.onCommit?.({ state, canonicalUrl, settledEpoch, source });
  };

  const historyData = () => ({ atlasNavigationVersion: state.version });

  const write = (mode: 'push' | 'replace', source: NavigationCommit['source']) => {
    restoreGeneration += 1;
    const canonicalUrl = canonicalNavigationUrl(state, adapter.getHref(), options.urlOptions);
    if (mode === 'push') adapter.pushState(historyData(), canonicalUrl);
    else adapter.replaceState(historyData(), canonicalUrl);
    notify(source, canonicalUrl);
  };

  const restoreFromLocation = async (source: 'initialize' | 'popstate') => {
    const generation = ++restoreGeneration;
    const decoded = navigationStateFromUrl(adapter.getHref(), options.defaults, options.urlOptions);
    await options.restore(decoded.state, source);
    if (generation !== restoreGeneration) return state;
    state = decoded.state;
    adapter.replaceState(historyData(), decoded.canonicalUrl);
    notify(source, decoded.canonicalUrl);
    return state;
  };

  return {
    async start(restoreInitial = true) {
      detach();
      detach = adapter.addPopStateListener(() => { void restoreFromLocation('popstate'); });
      if (restoreInitial) return restoreFromLocation('initialize');
      const decoded = navigationStateFromUrl(adapter.getHref(), options.defaults, options.urlOptions);
      state = decoded.state;
      adapter.replaceState(historyData(), decoded.canonicalUrl);
      notify('initialize', decoded.canonicalUrl);
      return state;
    },
    current: () => state,
    push(next) {
      state = canonicalNavigationState(next, options.defaults);
      write('push', 'push');
    },
    replace(next) {
      state = canonicalNavigationState(next, options.defaults);
      write('replace', 'replace');
    },
    commitSettledCamera(camera, baseState = state) {
      state = canonicalNavigationState({ ...baseState, camera }, options.defaults);
      write('replace', 'camera');
    },
    flush(next) {
      state = canonicalNavigationState(next, options.defaults);
      write('replace', 'replace');
    },
    dispose() {
      restoreGeneration += 1;
      detach();
      detach = () => {};
    },
  };
}
