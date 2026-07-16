import { describe, expect, it, vi } from 'vitest';
import {
  MAX_NAVIGATION_QUERY_LENGTH,
  canonicalNavigationState,
  canonicalNavigationUrl,
  navigationStateFromUrl,
  serializeNavigationState,
  type NavigationDefaults,
  type NavigationState,
} from './navigation/navigationState';
import {
  createNavigationHistoryController,
  type NavigationHistoryAdapter,
} from './navigation/historyController';
import { ATLAS_CAMERA_BOUNDS } from './renderer/cameraBounds';

const defaults: NavigationDefaults = {
  repositoryId: 'repo:commerce',
  snapshotId: 'snapshot:8f1c2ab',
  viewId: 'view:systems',
  rootEntityId: 'entity:gateway',
  selectedId: 'entity:gateway',
  camera: { x: 245, y: 85, zoom: 0.68 },
  detail: 'container',
  minZoom: ATLAS_CAMERA_BOUNDS.minZoom,
  maxZoom: ATLAS_CAMERA_BOUNDS.maxZoom,
};

function state(overrides: Partial<NavigationState> = {}) {
  return canonicalNavigationState({
    repositoryId: defaults.repositoryId,
    snapshotId: defaults.snapshotId,
    viewId: defaults.viewId,
    rootEntityId: defaults.rootEntityId,
    selectedId: defaults.selectedId,
    camera: defaults.camera,
    detail: defaults.detail,
    ...overrides,
  }, defaults);
}

type FakeHistory = NavigationHistoryAdapter & {
  href: string;
  nowMs: number;
  pushes: string[];
  replacements: string[];
  pop(url: string): void;
};

function fakeHistory(href: string): FakeHistory {
  let listener: (() => void) | undefined;
  return {
    href,
    nowMs: 0,
    pushes: [],
    replacements: [],
    getHref() {
      return this.href;
    },
    pushState(_data, url) {
      this.href = url;
      this.pushes.push(url);
    },
    replaceState(_data, url) {
      this.href = url;
      this.replacements.push(url);
    },
    addPopStateListener(next) {
      listener = next;
      return () => {
        if (listener === next) listener = undefined;
      };
    },
    now() {
      return this.nowMs;
    },
    pop(url) {
      this.href = url;
      listener?.();
    },
  };
}

async function settleAsyncRestore() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('canonical navigation state QA', () => {
  it('normalizes non-finite values, negative zero, coordinate precision, zoom bounds, and story integers', () => {
    const normalized = canonicalNavigationState({
      camera: { x: -0, y: 12.34567, zoom: 99 },
      story: { id: ' story:checkout ', step: -1, positionMs: 25.5 },
    }, defaults);

    expect(Object.is(normalized.camera.x, -0)).toBe(false);
    expect(normalized.camera).toEqual({ x: 0, y: 12.346, zoom: ATLAS_CAMERA_BOUNDS.maxZoom });
    expect(normalized.story).toEqual({ id: 'story:checkout', step: 0, positionMs: 0 });

    expect(canonicalNavigationState({
      camera: { x: Number.NaN, y: Number.POSITIVE_INFINITY, zoom: Number.NaN },
    }, defaults).camera).toEqual(defaults.camera);
  });

  it('emits one deterministic, hash-free URL with ordered preserved parameters', () => {
    const canonical = canonicalNavigationUrl(state({
      selectedId: 'entity:orders',
      camera: { x: 1.125, y: -0, zoom: 0.82 },
      filterId: 'tag:critical path',
      story: { id: 'story:checkout', step: 2, positionMs: 1_250 },
    }), 'https://atlas.example/map?seed=42&backend=webgpu&backend=canvas2d#private-fragment', {
      preserveParams: ['seed', 'backend'],
    });

    expect(canonical).toBe(
      'https://atlas.example/map?nav=1&repo=repo%3Acommerce&snap=snapshot%3A8f1c2ab&view=view%3Asystems&root=entity%3Agateway&sel=entity%3Aorders&cx=1.125&cy=0&z=0.82&detail=container&filter=tag%3Acritical%20path&story=story%3Acheckout&step=2&t=1250&backend=canvas2d&backend=webgpu&seed=42',
    );
  });

  it('round-trips canonical bytes and restores an omitted root selection', () => {
    const deepRoot = state({
      viewId: 'view:components',
      rootEntityId: 'entity:orders',
      selectedId: 'entity:orders',
      camera: { x: 145.12349, y: 299.98751, zoom: 1.234567 },
      detail: 'component',
    });
    const firstUrl = canonicalNavigationUrl(deepRoot, 'https://atlas.example/map');
    expect(new URL(firstUrl).searchParams.has('sel')).toBe(false);

    const decoded = navigationStateFromUrl(firstUrl, defaults);
    const secondUrl = canonicalNavigationUrl(decoded.state, firstUrl);

    expect(decoded.state).toEqual(deepRoot);
    expect(secondUrl).toBe(firstUrl);
    expect(serializeNavigationState(decoded.state)).toBe(serializeNavigationState(deepRoot));
  });

  it('round-trips an ordered three-level semantic lens path as repeated parameters', () => {
    const path = ['system:okie', 'container:web', 'component:map'];
    const expanded = state({ detail: 'context', lensPath: path });
    const firstUrl = canonicalNavigationUrl(expanded, 'https://atlas.example/map');
    const parsed = new URL(firstUrl);
    expect(parsed.searchParams.getAll('lens')).toEqual(path);

    const decoded = navigationStateFromUrl(firstUrl, defaults, {
      references: { hasEntity: id => path.includes(id) || id === defaults.rootEntityId },
    });
    expect(decoded.state.lensPath).toEqual(path);
    expect(canonicalNavigationUrl(decoded.state, decoded.canonicalUrl)).toBe(firstUrl);
  });

  it('fails closed to defaults for unsupported versions and stale references while reporting unique warnings', () => {
    const references = {
      hasSnapshot: (id: string) => id === defaults.snapshotId,
      hasView: (id: string) => id === defaults.viewId,
      hasEntity: (id: string) => id === defaults.rootEntityId,
      hasStory: (id: string) => id === 'story:checkout',
    };
    const stale = navigationStateFromUrl(
      'https://atlas.example/map?nav=1&snap=gone&view=unknown&root=missing&sel=missing&cx=NaN&cy=Infinity&z=-10&detail=database&story=missing&step=-2&t=1.5&extra=%3Cscript%3E',
      defaults,
      { references },
    );

    expect(stale.state).toEqual(state({ camera: { ...defaults.camera, zoom: defaults.minZoom! } }));
    expect(stale.canonicalUrl).not.toContain('extra=');
    expect(stale.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('Unknown snapshot'),
      expect.stringContaining('Unknown view'),
      expect.stringContaining('Unknown root entity'),
      expect.stringContaining('Unknown selected entity'),
      expect.stringContaining('Invalid numeric navigation parameter cx'),
      expect.stringContaining('Unknown semantic detail'),
      expect.stringContaining('Unknown story'),
      expect.stringContaining('Ignoring unknown navigation parameter extra'),
    ]));
    expect(new Set(stale.warnings).size).toBe(stale.warnings.length);

    const unsupported = navigationStateFromUrl(
      'https://atlas.example/map?nav=999&repo=private&snap=gone&sel=missing&cx=999',
      defaults,
    );
    expect(unsupported.state).toEqual(state());
    expect(unsupported.warnings).toContain('Unsupported navigation URL version 999; using defaults.');
  });

  it('uses the last duplicate value, canonicalizes once, and reports the ambiguity', () => {
    const decoded = navigationStateFromUrl(
      'https://atlas.example/map?nav=1&sel=entity%3Aold&sel=entity%3Aorders&cx=1&cx=2',
      defaults,
    );

    expect(decoded.state.selectedId).toBe('entity:orders');
    expect(decoded.state.camera.x).toBe(2);
    expect(decoded.warnings).toContain('Duplicate navigation parameter sel; using the last value.');
    expect(decoded.warnings).toContain('Duplicate navigation parameter cx; using the last value.');
    expect(canonicalNavigationUrl(decoded.state, decoded.canonicalUrl)).toBe(decoded.canonicalUrl);
  });

  it('drops an oversized query before parsing any navigation or preserved values', () => {
    const oversized = navigationStateFromUrl(
      `https://atlas.example/map?nav=1&sel=entity%3Aorders&payload=${'x'.repeat(MAX_NAVIGATION_QUERY_LENGTH)}`,
      defaults,
      { preserveParams: ['payload'] },
    );

    expect(oversized.state).toEqual(state());
    expect(oversized.canonicalUrl).toBe(canonicalNavigationUrl(state(), 'https://atlas.example/map'));
    expect(oversized.warnings).toContain(
      `Navigation query exceeds ${MAX_NAVIGATION_QUERY_LENGTH} characters; using defaults.`,
    );
  });

  it('never emits an ID or canonical query that its own decoder cannot safely replay', () => {
    const controlCharacter = { ...state(), selectedId: 'entity:orders\nprivate' };
    expect(() => canonicalNavigationUrl(controlCharacter, 'https://atlas.example/map')).toThrow(
      /selected entity ID must be/,
    );

    const expansionHeavyId = '界'.repeat(512);
    const expansionHeavy = {
      ...state(),
      repositoryId: expansionHeavyId,
      snapshotId: expansionHeavyId,
      viewId: expansionHeavyId,
      rootEntityId: expansionHeavyId,
      selectedId: `selected:${expansionHeavyId}`.slice(0, 512),
      filterId: expansionHeavyId,
      story: { id: expansionHeavyId, step: 1, positionMs: 1 },
    };
    expect(() => canonicalNavigationUrl(expansionHeavy, 'https://atlas.example/map')).toThrow(
      `Canonical navigation query exceeds ${MAX_NAVIGATION_QUERY_LENGTH} characters.`,
    );
  });
});

describe('navigation history restoration QA', () => {
  it('canonicalizes initial state with replace and restores Back/Forward without writing new entries', async () => {
    const adapter = fakeHistory('https://atlas.example/map?nav=1&sel=entity%3Aorders&cx=145&cy=95&z=0.82');
    const restore = vi.fn<(value: NavigationState, source: 'initialize' | 'popstate') => void>();
    const commits: string[] = [];
    const controller = createNavigationHistoryController({
      defaults,
      adapter,
      restore,
      onCommit: commit => commits.push(`${commit.source}:${commit.state.selectedId}:${commit.settledEpoch}`),
    });

    await controller.start();
    const initialUrl = adapter.href;
    expect(adapter.pushes).toHaveLength(0);
    expect(adapter.replacements).toEqual([initialUrl]);
    expect(restore).toHaveBeenLastCalledWith(expect.objectContaining({ selectedId: 'entity:orders' }), 'initialize');

    const orders = state({ selectedId: 'entity:orders', camera: { x: 145, y: 95, zoom: 0.82 } });
    const payments = state({ selectedId: 'entity:payments', camera: { x: 410, y: 180, zoom: 0.95 } });
    controller.push(payments);
    const forwardUrl = adapter.href;
    expect(adapter.pushes).toEqual([forwardUrl]);

    adapter.pop(initialUrl);
    await settleAsyncRestore();
    expect(controller.current()).toEqual(orders);
    expect(adapter.pushes).toHaveLength(1);
    expect(restore).toHaveBeenLastCalledWith(orders, 'popstate');

    adapter.pop(forwardUrl);
    await settleAsyncRestore();
    expect(controller.current()).toEqual(payments);
    expect(adapter.pushes).toHaveLength(1);
    expect(restore).toHaveBeenLastCalledWith(payments, 'popstate');
    expect(commits.at(-1)).toBe('popstate:entity:payments:4');
    controller.dispose();
  });

  it('replaces camera state after every settled gesture without polluting semantic history', async () => {
    const adapter = fakeHistory('https://atlas.example/map');
    const sources: string[] = [];
    const controller = createNavigationHistoryController({
      defaults,
      adapter,
      restore: vi.fn(),
      cameraCoalesceMs: 500,
      onCommit: commit => sources.push(commit.source),
    });
    await controller.start(false);
    adapter.pushes.length = 0;
    adapter.replacements.length = 0;

    adapter.nowMs = 100;
    controller.commitSettledCamera({ x: 250, y: 85, zoom: 0.7 });
    adapter.nowMs = 450;
    controller.commitSettledCamera({ x: 275, y: 100, zoom: 0.75 });
    adapter.nowMs = 1_200;
    controller.commitSettledCamera({ x: 300, y: 115, zoom: 0.8 });

    expect(adapter.pushes).toHaveLength(0);
    expect(adapter.replacements).toHaveLength(3);
    expect(controller.current().camera).toEqual({ x: 300, y: 115, zoom: 0.8 });
    expect(sources.slice(1)).toEqual(['camera', 'camera', 'camera']);
    controller.dispose();
  });

  it('does not let a pending asynchronous pop restore overwrite a newer local semantic push', async () => {
    const adapter = fakeHistory('https://atlas.example/map');
    let releasePopRestore = () => {};
    const restore = vi.fn((_value: NavigationState, source: 'initialize' | 'popstate') => {
      if (source !== 'popstate') return undefined;
      return new Promise<void>(resolve => {
        releasePopRestore = resolve;
      });
    });
    const controller = createNavigationHistoryController({ defaults, adapter, restore });
    await controller.start(false);

    const popped = canonicalNavigationUrl(state({ selectedId: 'entity:orders' }), adapter.href);
    const local = state({ selectedId: 'entity:payments' });
    adapter.pop(popped);
    controller.push(local);
    releasePopRestore();
    await settleAsyncRestore();

    expect(controller.current()).toEqual(local);
    expect(adapter.href).toBe(canonicalNavigationUrl(local, popped));
    expect(adapter.pushes).toHaveLength(1);
    controller.dispose();
  });

  it('makes replace/flush non-navigating and detaches popstate on dispose', async () => {
    const adapter = fakeHistory('https://atlas.example/map');
    const restore = vi.fn();
    const controller = createNavigationHistoryController({ defaults, adapter, restore });
    await controller.start(false);
    adapter.pushes.length = 0;
    adapter.replacements.length = 0;

    controller.replace(state({ filterId: 'filter:critical' }));
    controller.flush(state({ selectedId: 'entity:orders', filterId: 'filter:critical' }));
    expect(adapter.pushes).toHaveLength(0);
    expect(adapter.replacements).toHaveLength(2);

    controller.dispose();
    adapter.pop(canonicalNavigationUrl(state({ selectedId: 'entity:payments' }), adapter.href));
    await settleAsyncRestore();
    expect(restore).not.toHaveBeenCalled();
  });
});
