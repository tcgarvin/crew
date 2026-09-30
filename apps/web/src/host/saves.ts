/**
 * Saves, two tiers (PLAN §3 "Saves"):
 *
 * - **Local**: IndexedDB, one slot, written every ~15 sim-seconds and at every decision. Fast,
 *   works offline. Minimal hand-rolled wrapper (idb-keyval-style single object store).
 * - **Server** (Integration 2): `ServerSaves` keeps an anonymous token and a game id in
 *   localStorage, opens the game once per tab (`POST /api/games/:id/open`, which bumps the lease
 *   epoch), and PUTs gzipped envelopes every ~60 wall-seconds and at milestones. A `409
 *   staleLease` means another tab opened the game: writing stops for good in this tab.
 *   Unreachable server = local only, silently; the next write simply tries again.
 */
import type { SaveEnvelope } from "@crew/sim";
import { apiCall, ensureToken, storage } from "./api";

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

// ---------------------------------------------------------------------------------------------
// Server tier
// ---------------------------------------------------------------------------------------------

const GAME_ID_KEY = "crew.gameId";

async function gzipBase64(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function gunzipBase64(base64: string): Promise<string> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** Structural copy of the server's `GetSaveResponse` (web may not import `@crew/server`). */
interface HeadSave {
  readonly blob: string;
  readonly savedAtTick: number;
}

export interface ServerSession {
  readonly token: string;
  readonly gameId: string;
  readonly leaseEpoch: number;
}

export interface OpenedServerGame {
  readonly session: ServerSession;
  /** The game's head save, if it has one and it decodes. */
  readonly headSave?: SaveEnvelope;
}

async function createServerGame(
  token: string,
): Promise<OpenedServerGame | "unauthorized" | undefined> {
  const created = await apiCall<{ game: { id: string }; leaseEpoch: number }>("/api/games", {
    method: "POST",
    token,
    body: { title: "Freighter run" },
    timeoutMs: 5_000,
  });
  if (!created.ok) return created.status === 401 ? "unauthorized" : undefined;
  storage.write(GAME_ID_KEY, created.body.game.id);
  return { session: { token, gameId: created.body.game.id, leaseEpoch: created.body.leaseEpoch } };
}

async function openWithToken(
  token: string,
): Promise<OpenedServerGame | "unauthorized" | undefined> {
  const gameId = storage.read(GAME_ID_KEY);
  if (gameId === undefined) return createServerGame(token);
  const opened = await apiCall<{ leaseEpoch: number; headSave?: HeadSave }>(
    `/api/games/${encodeURIComponent(gameId)}/open`,
    { method: "POST", token, body: {}, timeoutMs: 5_000 },
  );
  if (!opened.ok) {
    if (opened.status === 401) return "unauthorized";
    // The game is gone (e.g. a dev server's in-memory db restarted): start a new server game.
    if (opened.status === 404) return createServerGame(token);
    return undefined;
  }
  const session = { token, gameId, leaseEpoch: opened.body.leaseEpoch };
  const head = opened.body.headSave;
  if (head === undefined) return { session };
  try {
    const headSave = JSON.parse(await gunzipBase64(head.blob)) as SaveEnvelope;
    return { session, headSave };
  } catch (error) {
    console.warn("[saves] server head save did not decode; ignoring it", error);
    return { session };
  }
}

let opening: Promise<OpenedServerGame | undefined> | undefined;

/**
 * Sign in anonymously (once), then create or open this browser's game. `undefined` when the
 * server is unreachable: the caller carries on with local saves only. Single-flight per page
 * load (React StrictMode mounts effects twice in dev; two opens would mint two users).
 */
export function openServerGame(): Promise<OpenedServerGame | undefined> {
  opening ??= openServerGameOnce();
  return opening;
}

async function openServerGameOnce(): Promise<OpenedServerGame | undefined> {
  const token = await ensureToken();
  if (token === undefined) return undefined;
  const first = await openWithToken(token);
  if (first !== "unauthorized") return first;
  // The stored token is unknown to this server (e.g. its in-memory db restarted): mint a new one.
  storage.write(GAME_ID_KEY, undefined);
  const fresh = await ensureToken(true);
  if (fresh === undefined) return undefined;
  const second = await openWithToken(fresh);
  return second === "unauthorized" ? undefined : second;
}

/** "New game": the next load creates a new server game instead of reopening this one. */
export function forgetServerGame(): void {
  storage.write(GAME_ID_KEY, undefined);
}

/** Pick the save to load: the newer of local and server by `savedAtTick` (server wins ties). */
export function newerSave(
  local: SaveEnvelope | undefined,
  server: SaveEnvelope | undefined,
): SaveEnvelope | undefined {
  if (local === undefined) return server;
  if (server === undefined) return local;
  return server.savedAtTick >= local.savedAtTick ? server : local;
}

export interface ServerSavesEvents {
  /** Another tab opened this game (`409 staleLease`); this tab must stop writing. */
  onStale(): void;
}

/**
 * Remote save writer for one session. At most one PUT in flight; while one is, only the newest
 * requested envelope is kept (a milestone flag is never lost to a later non-milestone write).
 */
export class ServerSaves {
  private inFlight = false;
  private pending: { envelope: SaveEnvelope; milestone: boolean } | undefined;
  private stale = false;

  constructor(
    private readonly session: ServerSession,
    private readonly events: ServerSavesEvents,
  ) {}

  get gameId(): string {
    return this.session.gameId;
  }

  get token(): string {
    return this.session.token;
  }

  get isStale(): boolean {
    return this.stale;
  }

  write(envelope: SaveEnvelope, milestone = false): void {
    if (this.stale) return;
    const merged = milestone || (this.pending?.milestone ?? false);
    this.pending = { envelope, milestone: merged };
    if (!this.inFlight) void this.flush();
  }

  private async flush(): Promise<void> {
    while (this.pending !== undefined && !this.stale) {
      const { envelope, milestone } = this.pending;
      this.pending = undefined;
      this.inFlight = true;
      try {
        const blob = await gzipBase64(JSON.stringify(envelope));
        const result = await apiCall<{ saveId: string }>(
          `/api/games/${encodeURIComponent(this.session.gameId)}/save`,
          {
            method: "PUT",
            token: this.session.token,
            headers: { "X-Lease-Epoch": String(this.session.leaseEpoch) },
            body: {
              leaseEpoch: this.session.leaseEpoch,
              schemaVersion: envelope.schemaVersion,
              savedAtTick: envelope.savedAtTick,
              contentHash: envelope.contentHash,
              blob,
              milestone,
            },
            timeoutMs: 15_000,
          },
        );
        if (!result.ok && result.status === 409) {
          this.stale = true;
          this.pending = undefined;
          this.events.onStale();
        }
        // Any other failure (offline, 5xx): drop it quietly; the next save carries newer state.
      } finally {
        this.inFlight = false;
      }
    }
  }
}
