import { describe, expect, it, vi } from 'vitest';
import { PORTABLE_ATLAS_MAX_BYTES, type PortableAtlas } from '@okie/architecture';
import { readPortableFile, rememberPortableSession, forgetPortableSession } from './session';
import { createIndexedDbPortableStore, createPortablePersistence } from './storage';

describe('portable in-memory sessions', () => {
  it('rejects oversized file metadata before reading or parsing its contents', async () => {
    const text = vi.fn(async () => '{}');
    await expect(readPortableFile({ size: PORTABLE_ATLAS_MAX_BYTES + 1, text })).resolves.toEqual({ error: 'Scan bundle exceeds the 128 MiB import limit.' });
    expect(text).not.toHaveBeenCalled();
  });

  it('reports parse failures after reading a bounded file', async () => {
    await expect(readPortableFile({ size: 3, text: async () => '{no' })).resolves.toEqual({ error: 'Scan bundle is not valid JSON.' });
  });

  it('permits replacement and forget with truthful notices when IndexedDB is unavailable', async () => {
    const persistence = createPortablePersistence(createIndexedDbPortableStore(undefined), () => 'valid artifact');
    const notice = await rememberPortableSession(persistence, {} as PortableAtlas);
    expect(notice).toContain('Opened for this session');
    expect(notice).toContain('previous saved atlas may reappear');
    expect(await forgetPortableSession(persistence)).toContain('saved browser copy could not be cleared');
  });

  it('does not show a storage warning after successful persistence', async () => {
    const persistence = createPortablePersistence({ read: async () => undefined, write: async () => undefined, clear: async () => undefined }, () => 'valid artifact');
    expect(await rememberPortableSession(persistence, {} as PortableAtlas)).toBeUndefined();
    expect(await forgetPortableSession(persistence)).toBeUndefined();
  });
});
