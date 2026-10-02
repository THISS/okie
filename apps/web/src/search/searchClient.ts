import type { SearchTiming } from './searchEngine';

export interface SearchWorkerPort {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
}
export type SearchClientState = 'building' | 'searching' | 'ready' | 'fallback';
type Query = { requestId: number; query: string; limit: number };

/** One active request, one latest pending request. Every failure closes the port. */
export class SearchClient {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private ready = false;
  private closed = false;
  private serial = 0;
  private pending: Query | undefined;
  private active: Query | undefined;
  private started = 0;
  private startup = performance.now();

  constructor(private port: SearchWorkerPort, private revision: number,
    private onResult: (ids: string[], query: string) => void,
    private onState: (state: SearchClientState) => void,
    private onFailure: () => void,
    private timing?: SearchTiming,
    private timeoutMs = 10_000) {
    port.onmessage = event => this.receive(event.data);
    port.onerror = () => this.fail();
    port.onmessageerror = () => this.fail();
  }

  init(buffer: ArrayBuffer[]) {
    if (this.closed) return;
    this.onState('building');
    this.armTimeout();
    try { this.port.postMessage({ type: 'init', revision: this.revision, buffer }, buffer); }
    catch { this.fail(); }
  }

  query(query: string, limit: number) {
    if (this.closed) return;
    this.pending = { requestId: ++this.serial, query, limit };
    this.onState(this.ready ? 'searching' : 'building');
    if (this.active) {
      try { this.port.postMessage({ type: 'cancel' }); } catch { this.fail(); }
    }
    this.dispatch();
  }

  cancel() {
    if (this.closed) return;
    this.serial++;
    this.pending = undefined;
    if (this.active) {
      try { this.port.postMessage({ type: 'cancel' }); } catch { this.fail(); }
    }
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.pending = undefined;
    this.active = undefined;
    this.port.onmessage = null;
    this.port.onerror = null;
    this.port.onmessageerror = null;
    this.port.terminate();
  }

  private armTimeout() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail(), this.timeoutMs);
  }
  private fail() {
    if (this.closed) return;
    this.dispose();
    this.onState('fallback');
    this.onFailure();
  }
  private dispatch() {
    if (!this.ready || this.closed || this.active || !this.pending) return;
    this.active = this.pending;
    this.pending = undefined;
    this.started = performance.now();
    this.armTimeout();
    try { this.port.postMessage({ type: 'query', ...this.active }); } catch { this.fail(); }
  }
  private receive(message: unknown) {
    if (this.closed || typeof message !== 'object' || message === null) return;
    const data = message as Record<string, unknown>;
    if (data.revision !== this.revision) return;
    if (data.type === 'error') { this.fail(); return; }
    if (data.type === 'ready' && !this.ready) {
      if (typeof data.durationMs !== 'number' || !Number.isFinite(data.durationMs) || data.durationMs < 0) { this.fail(); return; }
      clearTimeout(this.timer);
      this.ready = true;
      this.timing?.('searchStartup', performance.now() - this.startup);
      this.timing?.('searchIndex', data.durationMs);
      this.onState('ready');
      this.dispatch();
    } else if (data.type === 'result' && this.active && data.requestId === this.active.requestId) {
      if ((data.ids !== null && (!Array.isArray(data.ids) || data.ids.length > this.active.limit || !data.ids.every(id => typeof id === 'string'))) || typeof data.durationMs !== 'number' || !Number.isFinite(data.durationMs) || data.durationMs < 0) { this.fail(); return; }
      clearTimeout(this.timer);
      this.timing?.('searchQuery', data.durationMs);
      this.timing?.('searchRoundTrip', performance.now() - this.started);
      const resultQuery = this.active.query;
      const isLatest = this.active.requestId === this.serial;
      this.active = undefined;
      if (isLatest && Array.isArray(data.ids)) {
        this.onResult(data.ids, resultQuery);
        this.onState('ready');
      }
      this.dispatch();
    }
  }
}
