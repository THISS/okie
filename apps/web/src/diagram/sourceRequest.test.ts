import { describe, expect, it, vi } from 'vitest';
import { createSourceRequestController, sourceContextIsLoading } from './sourceRequest';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
describe('SourceViewer request publication', () => {
  it('does not publish A resolving between B render and effect cleanup', async () => {
    const controller = createSourceRequestController();
    const a = deferred<string>();
    const publish = vi.fn(); const fail = vi.fn();
    controller.select('A');
    const pending = controller.run('A', () => a.promise, publish, fail);
    controller.select('B');
    a.resolve('A source'); await pending;
    expect(publish).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled();
  });
  it('aborts A and only publishes B even when the transport ignores abort', async () => {
    const controller = createSourceRequestController();
    const a = deferred<string>(); const b = deferred<string>();
    const publish = vi.fn(); const fail = vi.fn(); let aSignal!: AbortSignal;
    controller.select('A');
    const first = controller.run('A', signal => { aSignal = signal; return a.promise; }, publish, fail);
    controller.select('B');
    const second = controller.run('B', () => b.promise, publish, fail);
    expect(aSignal.aborted).toBe(true);
    b.resolve('B source'); await second;
    a.resolve('A source'); await first;
    expect(publish.mock.calls).toEqual([['B source']]); expect(fail).not.toHaveBeenCalled();
  });
  it('cancels unmounted requests and suppresses late rejection', async () => {
    const controller = createSourceRequestController(); const pending = deferred<string>();
    const publish = vi.fn(); const fail = vi.fn(); let signal!: AbortSignal;
    controller.select('A');
    const done = controller.run('A', value => { signal = value; return pending.promise; }, publish, fail);
    controller.cancel(); expect(signal.aborted).toBe(true);
    pending.reject(new Error('late source error')); await done;
    expect(publish).not.toHaveBeenCalled(); expect(fail).not.toHaveBeenCalled();
  });
  it('same-identity retry wins and active errors remain visible', async () => {
    const controller = createSourceRequestController(); const first = deferred<string>();
    const publish = vi.fn(); const fail = vi.fn(); controller.select('A');
    const old = controller.run('A', () => first.promise, publish, fail);
    const error = new Error('historical source unavailable');
    await controller.run('A', () => Promise.reject(error), publish, fail);
    first.resolve('obsolete range'); await old;
    expect(publish).not.toHaveBeenCalled(); expect(fail.mock.calls).toEqual([[error]]);
  });
});

it('A→B→A cancellation clears visible loading despite retained A state and allows retry', async () => {
  const controller = createSourceRequestController();
  const first = deferred<string>(); const retry = deferred<string>();
  const publish = vi.fn(); const fail = vi.fn();
  const rememberedLoading = { identity: 'A', loading: true };
  controller.select('A');
  const oldRequest = controller.run('A', () => first.promise, publish, fail);
  expect(sourceContextIsLoading(controller, 'A', rememberedLoading)).toBe(true);
  controller.select('B');
  expect(sourceContextIsLoading(controller, 'B', rememberedLoading)).toBe(false);
  controller.cancel(); // SourceViewer identity-effect cleanup; no B request is made.
  controller.select('A');
  expect(sourceContextIsLoading(controller, 'A', rememberedLoading)).toBe(false);
  const newRequest = controller.run('A', () => retry.promise, publish, fail);
  expect(sourceContextIsLoading(controller, 'A', rememberedLoading)).toBe(true);
  first.resolve('obsolete A'); await oldRequest;
  expect(publish).not.toHaveBeenCalled();
  expect(sourceContextIsLoading(controller, 'A', rememberedLoading)).toBe(true);
  retry.resolve('fresh A'); await newRequest;
  expect(sourceContextIsLoading(controller, 'A', rememberedLoading)).toBe(false);
  expect(publish.mock.calls).toEqual([['fresh A']]);
});
