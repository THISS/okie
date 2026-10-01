import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readLocalAskThread, writeLocalAskThread } from './localAskThreads';
import type { AskThreadView } from './askAtlas';

const atlas = { owner: 'source-for', repo: 'atlas', commitSha: 'abc' };
const thread: AskThreadView = { ...atlas, turns: [{ id: '1', question: 'How?', answer: 'An answer', citations: ['node'], scopeIds: [], createdAt: 1 }] };

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()));

describe('browser-local Ask history', () => {
  it('survives database closure and keeps accounts and commits apart', async () => {
    expect(await writeLocalAskThread('123', thread)).toBe(true);
    expect(await readLocalAskThread('123', atlas)).toEqual(thread);
    expect(await readLocalAskThread('456', atlas)).toBeUndefined();
    expect(await readLocalAskThread('123', { ...atlas, commitSha: 'other' })).toBeUndefined();
    expect(await writeLocalAskThread('456', { ...thread, turns: [] })).toBe(true);
    expect(await readLocalAskThread('123', atlas)).toEqual(thread);
  });

  it('bounds histories and handles disabled storage without losing the live answer', async () => {
    const turns = Array.from({ length: 105 }, (_, id) => ({ ...thread.turns[0]!, id: String(id) }));
    await writeLocalAskThread('123', { ...thread, turns });
    const loaded = await readLocalAskThread('123', atlas);
    expect(loaded?.turns).toHaveLength(100);
    expect(loaded?.turns[0]?.id).toBe('5');
    vi.stubGlobal('indexedDB', { open: () => { throw new Error('blocked'); } });
    expect(await readLocalAskThread('123', atlas)).toBeUndefined();
    expect(await writeLocalAskThread('123', thread)).toBe(false);
  });
});

it('does not block Ask forever when opening IndexedDB never completes', async () => {
  vi.useFakeTimers();
  try {
    vi.stubGlobal('indexedDB', { open: () => ({}) });
    const loading = readLocalAskThread('123', atlas);
    await vi.advanceTimersByTimeAsync(3_001);
    expect(await loading).toBeUndefined();
  } finally { vi.useRealTimers(); }
});
