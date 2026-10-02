import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchClient, type SearchWorkerPort } from './searchClient';

class Port implements SearchWorkerPort {
  onmessage: SearchWorkerPort['onmessage'] = null;
  onerror: SearchWorkerPort['onerror'] = null;
  onmessageerror: SearchWorkerPort['onmessageerror'] = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  reply(data: unknown) { this.onmessage?.({ data } as MessageEvent); }
}
afterEach(() => vi.useRealTimers());
describe('search client', () => {
  it('closes on browser worker errors and synchronous post failures', () => {
    const port = new Port(); const failed = vi.fn();
    const client = new SearchClient(port, 1, vi.fn(), vi.fn(), failed);
    client.init([]); port.onerror?.({} as ErrorEvent);
    expect(failed).toHaveBeenCalledTimes(1); expect(port.terminate).toHaveBeenCalledTimes(1);
    const broken = new Port(); broken.postMessage.mockImplementation(() => { throw new Error('clone failed'); });
    const fallback = vi.fn(); new SearchClient(broken, 2, vi.fn(), vi.fn(), fallback).init([]);
    expect(fallback).toHaveBeenCalledTimes(1); expect(broken.terminate).toHaveBeenCalledTimes(1);
  });
  it('transfers buffers, isolates revisions and coalesces to the newest query', () => {
    const port = new Port(); const results = vi.fn(); const timings = vi.fn();
    const client = new SearchClient(port, 2, results, vi.fn(), vi.fn(), timings);
    const buffers = [new ArrayBuffer(4)]; client.init(buffers);
    expect(port.postMessage.mock.calls[0][1]).toBe(buffers);
    client.query('first', 7);
    port.reply({ type: 'ready', revision: 1, durationMs: 1 });
    expect(port.postMessage).toHaveBeenCalledTimes(1);
    port.reply({ type: 'ready', revision: 2, durationMs: 1 });
    client.query('second', 7); client.query('third', 7);
    port.reply({ type: 'result', revision: 2, requestId: 1, ids: ['old'], durationMs: 2 });
    expect(results).not.toHaveBeenCalled();
    expect(port.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ query: 'third', requestId: 3 });
    port.reply({ type: 'result', revision: 2, requestId: 3, ids: ['latest'], durationMs: 2 });
    expect(results).toHaveBeenCalledWith(['latest'], 'third');
    expect(timings).toHaveBeenCalledWith('searchStartup', expect.any(Number));
    client.dispose(); expect(port.terminate).toHaveBeenCalledTimes(1);
  });
  it('cancels closed-search results and handles message errors without leaks', () => {
    const port = new Port(); const results = vi.fn(); const failed = vi.fn();
    const client = new SearchClient(port, 1, results, vi.fn(), failed);
    client.init([]); port.reply({ type: 'ready', revision: 1, durationMs: 1 });
    client.query('old', 7); client.cancel();
    port.reply({ type: 'result', revision: 1, requestId: 1, ids: ['old'], durationMs: 2 });
    expect(results).not.toHaveBeenCalled();
    port.onmessageerror?.({} as MessageEvent);
    expect(failed).toHaveBeenCalledTimes(1); expect(port.onmessage).toBeNull();
    client.dispose(); expect(port.terminate).toHaveBeenCalledTimes(1);
  });
  it('fails bounded startup/query timeouts and invalid result payloads', () => {
    vi.useFakeTimers(); const port = new Port(); const failed = vi.fn();
    const client = new SearchClient(port, 1, vi.fn(), vi.fn(), failed, undefined, 50);
    client.init([]); vi.advanceTimersByTime(50); expect(failed).toHaveBeenCalledTimes(1);
    const other = new Port(); const invalid = vi.fn();
    const second = new SearchClient(other, 2, vi.fn(), vi.fn(), invalid);
    second.init([]); other.reply({ type: 'ready', revision: 2, durationMs: 1 }); second.query('x', 7);
    other.reply({ type: 'result', revision: 2, requestId: 1, ids: [42], durationMs: 1 });
    expect(invalid).toHaveBeenCalledTimes(1); expect(other.terminate).toHaveBeenCalledTimes(1);
    const slow = new Port(); const timedOut = vi.fn();
    const third = new SearchClient(slow, 3, vi.fn(), vi.fn(), timedOut, undefined, 50);
    third.init([]); slow.reply({ type: 'ready', revision: 3, durationMs: 1 }); third.query('x', 7);
    vi.advanceTimersByTime(50); expect(timedOut).toHaveBeenCalledTimes(1);
    expect(slow.terminate).toHaveBeenCalledTimes(1);
  });
});
