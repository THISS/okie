import type { NavigationState } from '../navigation/navigationState';

/** React rebuilds navigation objects on render; identity follows values. */
export function inspectorNavigationIdentity(state: NavigationState): string {
  return JSON.stringify([state.repositoryId, state.snapshotId, state.viewId,
    state.rootEntityId, state.selectedId, state.camera.x, state.camera.y, state.camera.zoom,
    state.detail, state.lensPath ?? [], state.filterId, state.story ?? null]);
}

/** Neighborhood loads may populate the shared cache after navigation changes,
 * but only the latest still-relevant request may publish a scene or error. */
export function createInspectorNeighborhoodRequest() {
  let generation = 0;
  return {
    cancel() { generation += 1; },
    async run(load: () => Promise<unknown>, stillCurrent: () => boolean, publish: () => void) {
      const request = ++generation;
      const active = () => request === generation && stillCurrent();
      try { await load(); } catch (error) {
        if (active()) throw error;
        return;
      }
      if (active()) publish();
    },
  };
}
