/** Foreground navigation owns one preparation at a time. Real camera input
 * advances its intent epoch; renderer/flight frames never advance that epoch. */
export function createForegroundSceneRequestOwner() {
  let generation = 0;
  let cameraIntentEpoch = 0;
  let active: { generation: number; controller: AbortController } | undefined;
  const cancel = () => { generation++; active?.controller.abort(); active = undefined; };
  return {
    begin() {
      cancel();
      const request = { generation, controller: new AbortController() };
      active = request;
      const cameraEpoch = cameraIntentEpoch;
      return {
        signal: request.controller.signal,
        owns: () => active === request && generation === request.generation
          && cameraIntentEpoch === cameraEpoch && !request.controller.signal.aborted,
        finish: () => { if (active === request) active = undefined; },
      };
    },
    cameraIntent() { cameraIntentEpoch++; cancel(); },
    cancel,
    pending: () => active !== undefined,
  };
}

export function isSceneRequestAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

/** Publication and errors share the same ownership fence, including late worker
 * replies. Finishing an old request must never clear a newer pending request. */
export async function completeForegroundSceneRequest<T>(
  request: { owns(): boolean; finish(): void },
  prepare: () => Promise<T>,
  publish: (result: T) => void,
  onFailure: (error: unknown) => void,
): Promise<void> {
  try {
    const result = await prepare();
    if (request.owns()) publish(result);
  } catch (error) {
    if (request.owns() && !isSceneRequestAbort(error)) onFailure(error);
  } finally { request.finish(); }
}
/** Ensures may advance the graph before compilation. Once compilation begins,
 * the prepared result owns exactly that graph generation through publication. */
export function createSceneGenerationFence(readGeneration: () => number) {
  let captured: number | undefined;
  return {
    allowChanges: () => { captured = undefined; },
    capture: (generation: number) => { captured = generation; },
    owns: () => captured === undefined || captured === readGeneration(),
  };
}
/** Resolve only the prepared protocol's entity, never geometry from an older scene. */
export function preparedSceneEntity<T extends { id: string }>(scene: { entities: readonly T[] }, requestedId: string): T | undefined {
  return scene.entities.find(entity => entity.id === requestedId);
}
/** A planner can retain an earlier aggregate while probing newer snapshots. */
export function createPreparedSceneGenerations<T extends object>(readGeneration: () => number) {
  const generations = new WeakMap<T, number>();
  return {
    record: (scene: T) => { generations.set(scene, readGeneration()); },
    generationOf: (scene: T) => generations.get(scene),
  };
}
/** Tracks visible preparation independently of delayed React effect cleanup. */
export function createForegroundRequestStatus(onPending: (pending: boolean) => void) {
  let active: { owns(): boolean } | undefined;
  return {
    track<T extends { owns(): boolean; finish(): void }>(request: T): T {
      active = request;
      onPending(true);
      return { ...request, finish: () => {
        request.finish();
        if (active === request) { active = undefined; onPending(false); }
      } };
    },
    cancel() { active = undefined; onPending(false); },
    obsolete: () => Boolean(active && !active.owns()),
  };
}
