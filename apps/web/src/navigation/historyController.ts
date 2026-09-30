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
  /** Minimum spacing of camera-only URL replacements (default 200 ms); see `write`. */
  cameraUrlMinIntervalMs?: number;
};

const CAMERA_URL_PARAMS = ['cx', 'cy', 'z'] as const;

/** True when two URLs differ at most in the camera query parameters. */
function differsOnlyInCamera(next: string, current: string) {
  try {
    const b = new URL(current);
    const a = new URL(next, b);
    for (const key of CAMERA_URL_PARAMS) {
      a.searchParams.delete(key);
      b.searchParams.delete(key);
    }
    return a.href === b.href;
  } catch {
    return false;
  }
}

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
  const cameraUrlMinIntervalMs = options.cameraUrlMinIntervalMs ?? 200;
  let lastReplaceAtMs = Number.NEGATIVE_INFINITY;
  let pendingReplace: { url: string; timer: ReturnType<typeof setTimeout> } | undefined;

  const cancelPendingReplace = () => {
    if (pendingReplace) clearTimeout(pendingReplace.timer);
    pendingReplace = undefined;
  };
  const replaceNow = (url: string) => {
    cancelPendingReplace();
    lastReplaceAtMs = adapter.now();
    adapter.replaceState(historyData(), url);
  };
  const flushPendingReplace = () => {
    if (pendingReplace) replaceNow(pendingReplace.url);
  };

  const notify = (source: NavigationCommit['source'], canonicalUrl: string) => {
    settledEpoch += 1;
    options.onCommit?.({ state, canonicalUrl, settledEpoch, source });
  };

  const historyData = () => ({ atlasNavigationVersion: state.version });

  const write = (mode: 'push' | 'replace', source: NavigationCommit['source']) => {
    restoreGeneration += 1;
    const canonicalUrl = canonicalNavigationUrl(state, adapter.getHref(), options.urlOptions);
    if (mode === 'push') {
      // A pending camera replacement belongs to the entry being left; land it first
      // so Back returns to the latest camera.
      flushPendingReplace();
      adapter.pushState(historyData(), canonicalUrl);
    } else {
      // CLA-326: wheel/pinch/assist frames commit on every frame. The URL is a side
      // effect: skip identical writes, and space camera-only changes so a long
      // gesture stays under WebKit's replaceState limit (100 per 10 s, which throws
      // a SecurityError). Commits/epochs stay synchronous; any semantic change
      // writes immediately; the trailing write lands the settled camera.
      const href = adapter.getHref();
      const cameraOnly = differsOnlyInCamera(canonicalUrl, href);
      const elapsedMs = adapter.now() - lastReplaceAtMs;
      if (cameraOnly && new URL(canonicalUrl, href).href === new URL(href).href) cancelPendingReplace();
      else if (cameraOnly && elapsedMs < cameraUrlMinIntervalMs) {
        if (pendingReplace) pendingReplace.url = canonicalUrl;
        else {
          pendingReplace = {
            url: canonicalUrl,
            timer: setTimeout(flushPendingReplace, cameraUrlMinIntervalMs - elapsedMs),
          };
        }
      } else replaceNow(canonicalUrl);
    }
    notify(source, canonicalUrl);
  };

  const restoreFromLocation = async (source: 'initialize' | 'popstate') => {
    const generation = ++restoreGeneration;
    // The pending camera URL belonged to the entry the user just left.
    cancelPendingReplace();
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
      flushPendingReplace();
      restoreGeneration += 1;
      detach();
      detach = () => {};
    },
  };
}
