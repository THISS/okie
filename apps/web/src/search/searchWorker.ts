import { decodeSearchCorpus, querySearchRows, type SearchRow } from './searchEngine';

// DOM and Worker libs conflict in this application; describe only the dedicated port used here.
const port = globalThis as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
};
let rows: SearchRow[] = [];
let revision = 0;
let latest = 0;
port.onmessage = event => {
  const message = event.data;
  if (message.type === 'init') {
    revision = message.revision;
    latest++;
    const start = performance.now();
    try {
      rows = decodeSearchCorpus(message.buffer);
      port.postMessage({ type: 'ready', revision, durationMs: performance.now() - start });
    } catch {
      port.postMessage({ type: 'error', revision });
    }
  } else if (message.type === 'cancel') {
    latest++;
  } else if (message.type === 'query') {
    const token = ++latest;
    const currentRevision = revision;
    const start = performance.now();
    void querySearchRows(rows, message.query, message.limit, () => token !== latest || currentRevision !== revision).then(ids => {
      port.postMessage({ type: 'result', revision: currentRevision, requestId: message.requestId, ids, durationMs: performance.now() - start });
    });
  }
};
