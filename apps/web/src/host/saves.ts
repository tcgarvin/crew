/**
 * Save plumbing stub (PLAN §6 W7, W8 to follow). Writes a `SaveEnvelope` to IndexedDB every ~15
 * sim-seconds and on every decision; loads it on startup if present. Minimal hand-rolled
 * IndexedDB wrapper (idb-keyval-style single object store, no dependency) — good enough for one
 * slot; W8 adds server sync.
 */
import type { SaveEnvelope } from "@crew/sim";

const DB_NAME = "crew-saves";
const STORE_NAME = "saves";
const SAVE_KEY = "current";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("failed to open IndexedDB"));
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      const request = fn(store);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });
  } finally {
    db.close();
  }
}

/** Persist the current save. Called on the ~15 sim-second timer and on every decision. */
export async function writeLocalSave(envelope: SaveEnvelope): Promise<void> {
  await withStore("readwrite", (store) => store.put(envelope, SAVE_KEY));
}

/** Load the save on startup, if one exists. */
export async function readLocalSave(): Promise<SaveEnvelope | undefined> {
  try {
    const result = await withStore<SaveEnvelope | undefined>("readonly", (store) =>
      store.get(SAVE_KEY),
    );
    return result ?? undefined;
  } catch {
    // No DB yet, private browsing without storage, etc. — treat as "no save".
    return undefined;
  }
}

/** "New game": clears the local save so the next load starts a fresh scenario. */
export async function clearLocalSave(): Promise<void> {
  await withStore("readwrite", (store) => store.delete(SAVE_KEY));
}

/**
 * TODO(W8): sync saves to the server (Neon-backed `GameStore`) instead of, or in addition to,
 * IndexedDB. This should upload on the same cadence (~15 sim-s, every decision) plus on an
 * explicit "New game"/sign-in boundary, and reconcile with `readLocalSave` on startup (last
 * write wins is probably wrong — needs a real design pass with W8's auth work).
 */
export async function syncSaveToServer(_envelope: SaveEnvelope): Promise<void> {
  // Intentionally not implemented in W7.
}
