import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { idbStoreName } from './idb-name';
import type { DeleteRecordStore } from './excalidraw-live';

/** The store's name among this vault's documents: no folder id, so no document's name can be it. */
export const DELETE_RECORD_STORE = 'excalidraw-deletes';
const KEY = 'nectenda-excalidraw-deletes';

/**
 * Where `DeleteWitness` keeps what drawings deleted across a restart: one
 * IndexedDB store per vault, beside the documents' own (idb-name.ts), through
 * the same y-indexeddb key-value side they keep their agreed text in. Its
 * document is never written; only the key is. Opened on first use, so a vault
 * that never draws never creates it.
 */
export function deleteRecordStore(vaultKey: () => string): DeleteRecordStore {
  let idb: IndexeddbPersistence | null = null;
  const open = (): IndexeddbPersistence => (idb ??= new IndexeddbPersistence(idbStoreName(vaultKey(), DELETE_RECORD_STORE), new Y.Doc()));
  return {
    async load() {
      const v: unknown = await open().get(KEY);
      return typeof v === 'string' ? v : null;
    },
    async save(text) {
      await open().set(KEY, text);
    },
  };
}
