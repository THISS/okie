import { parsePortableAtlas, serializePortableAtlas, type PortableAtlas } from '@okie/architecture';

const DATABASE = 'okie-portable-atlas';
const STORE = 'bundles';
const ACTIVE_KEY = 'active-v1';

/** Remember replacements only within one viewer and one deployed artifact. */
export async function portableStorageKey(viewerUrl: string, packagedText?: string): Promise<string> {
  const directory = new URL('./', viewerUrl).pathname;
  if (packagedText === undefined) return `${ACTIVE_KEY}:${directory}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(packagedText));
  const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${ACTIVE_KEY}:${directory}:${fingerprint}`;
}

export interface PortableAtlasTextStore {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
  clear(): Promise<void>;
}

export type PortablePersistence = {
  restore(): Promise<{ bundle?: PortableAtlas; error?: string }>;
  remember(bundle: PortableAtlas): Promise<{ saved: boolean; error?: string }>;
  forget(): Promise<{ cleared: boolean; error?: string }>;
};

function unavailable(): Error {
  return new Error('Browser storage is unavailable; this atlas will only remain open for this session.');
}

function openDatabase(factory: IDBFactory | undefined): Promise<IDBDatabase> {
  if (!factory) return Promise.reject(unavailable());
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? unavailable());
    request.onblocked = () => reject(new Error('Browser storage is blocked by another open Okie viewer.'));
  });
}

export function createIndexedDbPortableStore(factory: IDBFactory | undefined, activeKey = ACTIVE_KEY): PortableAtlasTextStore {
  const transaction = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await openDatabase(factory);
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      let result: T;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error ?? new Error('Browser storage request failed.'));
      tx.onabort = () => reject(tx.error ?? new Error('Browser storage transaction failed.'));
      tx.oncomplete = () => {
        db.close();
        resolve(result!);
      };
    });
  };
  return {
    read: async () => transaction('readonly', store => store.get(activeKey)).then(value => typeof value === 'string' ? value : undefined),
    write: async text => { await transaction('readwrite', store => store.put(text, activeKey)); },
    clear: async () => { await transaction('readwrite', store => store.delete(activeKey)); },
  };
}

export function createPortablePersistence(
  store: PortableAtlasTextStore,
  serialize: (bundle: PortableAtlas) => string = serializePortableAtlas,
): PortablePersistence {
  return {
    async restore() {
      try {
        const text = await store.read();
        return text ? { bundle: parsePortableAtlas(text) } : {};
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    async remember(bundle) {
      try {
        await store.write(serialize(bundle));
        return { saved: true };
      } catch (error) {
        return { saved: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    async forget() {
      try {
        await store.clear();
        return { cleared: true };
      } catch (error) {
        return { cleared: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
