import { describe, expect, it } from 'vitest';
import { initialRun, runIdFromSearch, searchWithRun } from './runUrl';

describe('selected run in the URL', () => {
  it('reads and writes ?run= without disturbing other parameters', () => {
    expect(runIdFromSearch('?run=run-1')).toBe('run-1'); expect(runIdFromSearch('')).toBeUndefined(); expect(runIdFromSearch('?run=')).toBeUndefined();
    expect(searchWithRun('', 'run-1')).toBe('?run=run-1');
    expect(searchWithRun('?x=1&run=old', 'run-2')).toBe('?x=1&run=run-2');
    expect(searchWithRun('?run=old', undefined)).toBe('');
  });
  it('reopens the requested run, else the only run, else none', () => {
    const runs = [{ runId: 'a' }, { runId: 'b' }];
    expect(initialRun(runs, 'b')?.runId).toBe('b');
    expect(initialRun(runs, 'gone')).toBeUndefined();
    expect(initialRun(runs, undefined)).toBeUndefined();
    expect(initialRun([{ runId: 'solo' }], undefined)?.runId).toBe('solo');
    expect(initialRun([{ runId: 'solo' }], 'gone')?.runId).toBe('solo');
  });
});
