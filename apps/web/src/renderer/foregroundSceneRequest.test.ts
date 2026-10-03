import { expect, it, vi } from 'vitest';
import { completeForegroundSceneRequest, createForegroundSceneRequestOwner, createSceneGenerationFence, preparedSceneEntity, createForegroundRequestStatus } from './foregroundSceneRequest';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
it('delayed scene cleanup preserves a newer owner and stale finish cannot clear its loading cue', () => {
  const pending = vi.fn();
  const status = createForegroundRequestStatus(pending);
  const owner = createForegroundSceneRequestOwner();
  let scene = 'old';
  const old = owner.begin();
  const first = status.track({ ...old, owns: () => old.owns() && scene === 'old' });
  scene = 'new'; // First publication updates the refs before React runs its effect.
  const current = owner.begin();
  const next = status.track({ ...current, owns: () => current.owns() && scene === 'new' });
  expect(status.obsolete()).toBe(false);
  first.finish();
  expect(pending.mock.calls).toEqual([[true], [true]]);
  expect(current.owns()).toBe(true);
  scene = 'unrelated';
  expect(status.obsolete()).toBe(true);
  owner.cancel(); status.cancel();
  next.finish();
  expect(pending.mock.calls).toEqual([[true], [true], [false]]);
  expect(current.signal.aborted).toBe(true);
});
it('missing Open-inside target and relationship selection stay unavailable instead of borrowing stale geometry', () => {
  const oldSelection = { id: 'selected', x: 100, revision: 1 };
  const prepared = { entities: [{ id: 'other', x: 5, revision: 2 }] };
  expect(preparedSceneEntity(prepared, 'requested')).toBeUndefined();
  expect(preparedSceneEntity(prepared, oldSelection.id)).toBeUndefined();
  expect(prepared.entities).toEqual([{ id: 'other', x: 5, revision: 2 }]);
  const retained = { ...prepared, entities: [...prepared.entities, { id: 'selected', x: 7, revision: 2 }] };
  expect(preparedSceneEntity(retained, oldSelection.id)).toEqual({ id: 'selected', x: 7, revision: 2 });
});
it('permits own ensure merges, but rejects generation changes in a cached reply publication microtask', async () => {
  let generation = 1;
  const fence = createSceneGenerationFence(() => generation);
  generation++;
  expect(fence.owns()).toBe(true);
  const owner = createForegroundSceneRequestOwner();
  const request = owner.begin();
  const publish = vi.fn();
  const pending = completeForegroundSceneRequest({ ...request, owns: () => request.owns() && fence.owns() }, async () => {
    fence.capture(generation);
    queueMicrotask(() => generation++);
    return 'cached compiled scene';
  }, publish, vi.fn());
  await pending;
  expect(publish).not.toHaveBeenCalled();
  fence.allowChanges();
  generation++;
  expect(fence.owns()).toBe(true);
  fence.capture(generation);
  expect(fence.owns()).toBe(true);
});
it('only publishes the latest preparation after rapid Open-inside/story/history requests', async () => {
  const owner = createForegroundSceneRequestOwner();
  const first = owner.begin();
  const firstReply = deferred<string>();
  const publish = vi.fn(); const failure = vi.fn();
  const old = completeForegroundSceneRequest(first, () => firstReply.promise, publish, failure);
  const second = owner.begin();
  const secondReply = deferred<string>();
  const latest = completeForegroundSceneRequest(second, () => secondReply.promise, publish, failure);
  firstReply.resolve('old scene'); await old;
  expect(first.signal.aborted).toBe(true);
  expect(owner.pending()).toBe(true);
  secondReply.resolve('latest scene'); await latest;
  expect(publish.mock.calls).toEqual([['latest scene']]);
  expect(failure).not.toHaveBeenCalled(); expect(owner.pending()).toBe(false);
});
it('camera rendering does not cancel preparation, but a real camera intent rejects stale publication', async () => {
  const owner = createForegroundSceneRequestOwner();
  const request = owner.begin(); const reply = deferred<string>();
  const publish = vi.fn(); const failure = vi.fn();
  const currentCamera = { x: 0 };
  const pending = completeForegroundSceneRequest(request, () => reply.promise, () => publish(currentCamera.x), failure);
  for (let frame = 0; frame < 60; frame++) currentCamera.x = frame;
  reply.resolve('scene'); await pending;
  expect(publish).toHaveBeenCalledWith(59);
  const moved = owner.begin(); const movedReply = deferred<string>();
  const stale = completeForegroundSceneRequest(moved, () => movedReply.promise, publish, failure);
  owner.cameraIntent(); movedReply.resolve('stale scene'); await stale;
  expect(moved.signal.aborted).toBe(true);
  expect(publish).toHaveBeenCalledTimes(1); expect(failure).not.toHaveBeenCalled();
});
it('does not publish late scenes/errors after fixture, scene or selection ownership changes', async () => {
  for (const action of ['late scene', 'late error', 'abort error']) {
    const owner = createForegroundSceneRequestOwner();
    const request = owner.begin(); const reply = deferred<string>();
    let sameSource = true;
    const publish = vi.fn(); const failure = vi.fn();
    const pending = completeForegroundSceneRequest({ ...request, owns: () => request.owns() && sameSource }, () => reply.promise, publish, failure);
    if (action === 'abort error') reply.reject(new DOMException('Snapshot changed', 'AbortError'));
    else {
      sameSource = false;
      if (action === 'late scene') reply.resolve('late'); else reply.reject(new Error('late failure'));
    }
    await pending;
    expect(publish).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled(); expect(owner.pending()).toBe(false);
  }
});
it('current genuine failure is reported once and releases foreground compilation ownership', async () => {
  const owner = createForegroundSceneRequestOwner(); const request = owner.begin();
  const error = new Error('unavailable map'); const failure = vi.fn();
  await completeForegroundSceneRequest(request, async () => { throw error; }, vi.fn(), failure);
  expect(failure).toHaveBeenCalledWith(error); expect(owner.pending()).toBe(false);
});
