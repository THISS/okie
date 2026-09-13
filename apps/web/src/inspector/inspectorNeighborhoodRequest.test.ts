import { describe, expect, it } from 'vitest';
import type { NavigationState } from '../navigation/navigationState';
import { createInspectorNeighborhoodRequest, inspectorNavigationIdentity } from './inspectorNeighborhoodRequest';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe('inspector neighborhood publication', () => {
  it('keeps the newer dependency selection when older loads finish last', async () => {
    const controller = createInspectorNeighborhoodRequest();
    const first = deferred();
    const second = deferred();
    const published: string[] = [];
    const old = controller.run(() => first.promise, () => true, () => published.push('old'));
    const current = controller.run(() => second.promise, () => true, () => published.push('current'));
    second.resolve(); await current;
    first.resolve(); await old;
    expect(published).toEqual(['current']);
  });

  it('does not replace a later resident selection or navigation with a loaded neighborhood', async () => {
    const controller = createInspectorNeighborhoodRequest();
    const load = deferred();
    const initial = { selection: 'component', navigation: {} };
    let latest = initial;
    let published = false;
    const pending = controller.run(() => load.promise, () => latest === initial, () => { published = true; });
    latest = { selection: 'other', navigation: {} };
    load.resolve(); await pending;
    expect(published).toBe(false);
  });

  it('invalidates publication and stale errors on fixture replacement or unmount', async () => {
    const controller = createInspectorNeighborhoodRequest();
    const load = deferred();
    let published = false;
    const pending = controller.run(() => load.promise, () => true, () => { published = true; });
    controller.cancel();
    load.reject(new Error('old fixture failed'));
    await expect(pending).resolves.toBeUndefined();
    expect(published).toBe(false);
  });
});


it('compares navigation values across renders while detecting new selection, pan, and lens intent', () => {
  const state: NavigationState = { version: 1, repositoryId: 'repo:app', snapshotId: 'snapshot:app', viewId: 'view:app', rootEntityId: 'container:app', selectedId: 'component:core', camera: { x: 1, y: 2, zoom: 3 }, lensPath: ['system:app'] };
  expect(inspectorNavigationIdentity(structuredClone(state))).toBe(inspectorNavigationIdentity(state));
  expect(inspectorNavigationIdentity({ ...state, selectedId: 'component:other' })).not.toBe(inspectorNavigationIdentity(state));
  expect(inspectorNavigationIdentity({ ...state, camera: { ...state.camera, x: 10 } })).not.toBe(inspectorNavigationIdentity(state));
  expect(inspectorNavigationIdentity({ ...state, lensPath: ['system:app', 'container:app'] })).not.toBe(inspectorNavigationIdentity(state));
});
