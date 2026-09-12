import { describe, expect, it } from 'vitest';
import { createPortablePersistence, portableStorageKey, type PortableAtlasTextStore } from './storage';

describe('portable persistence', () => {
  it('isolates viewer directories and redeployed package contents while retaining reload identity', async () => {
    const original = await portableStorageKey('https://example.test/a/', '{"description":"first"}');
    expect(await portableStorageKey('https://example.test/a/index.html?open=1', '{"description":"first"}')).toBe(original);
    expect(await portableStorageKey('https://example.test/b/', '{"description":"first"}')).not.toBe(original);
    expect(await portableStorageKey('https://example.test/a/', '{"description":"enriched"}')).not.toBe(original);
    expect(await portableStorageKey('https://example.test/a/')).not.toBe(original);
    expect(await portableStorageKey('https://example.test/a/?portable=1')).toBe(await portableStorageKey('https://example.test/a/'));
  });
  it('does not restore malformed stored data', async () => {
    const store: PortableAtlasTextStore = {
      read: async () => '{not json',
      write: async () => undefined,
      clear: async () => undefined,
    };
    const restored = await createPortablePersistence(store).restore();
    expect(restored.bundle).toBeUndefined();
    expect(restored.error).toMatch(/not valid JSON/);
  });

  it('reports browser storage failures without throwing from the UI action', async () => {
    const store: PortableAtlasTextStore = {
      read: async () => undefined,
      write: async () => { throw new Error('quota denied'); },
      clear: async () => { throw new Error('storage denied'); },
    };
    const persistence = createPortablePersistence(store, () => 'validated bundle');
    const bundle = {} as Parameters<typeof persistence.remember>[0];
    await expect(persistence.remember(bundle)).resolves.toEqual({ saved: false, error: 'quota denied' });
    await expect(persistence.forget()).resolves.toEqual({ cleared: false, error: 'storage denied' });
  });
});
