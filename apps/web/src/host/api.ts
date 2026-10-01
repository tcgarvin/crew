/**
 * Thin client for the `@crew/server` HTTP API (routes and bodies in
 * `packages/server/src/contract.ts`). `apps/web/src` may not import the server package
 * (dependency-cruiser `web-no-secrets`), so the few response shapes used here are restated
 * structurally.
 *
 * Every call has a timeout and reports failure as a value (`ApiResult`), never by throwing: the
 * game must keep running offline, and the callers decide what (if anything) to tell the player.
 */

const TOKEN_KEY = "crew.auth.token";

export type ApiResult<T> =
  | { readonly ok: true; readonly status: number; readonly body: T }
  | {
      readonly ok: false;
      /** HTTP status, or 0 when the server was unreachable or the call timed out. */
      readonly status: number;
      readonly code: string;
      readonly message: string;
      /** The error body's `reason`, when the route gave one (narrator 429/502/503, D43). */
      readonly reason?: string;
      /** The error body's `retryable`, when the route gave one (narrator 502/503, D43). */
      readonly retryable?: boolean;
    };

export interface ApiCallOptions {
  readonly method: "GET" | "POST" | "PUT";
  readonly body?: unknown;
  readonly token?: string;
  readonly timeoutMs?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function apiCall<T>(path: string, options: ApiCallOptions): Promise<ApiResult<T>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      method: options.method,
      signal: controller.signal,
      headers: {
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(options.token === undefined ? {} : { Authorization: `Bearer ${options.token}` }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!response.ok) {
      const error = (
        parsed as
          | { error?: { code?: string; message?: string; reason?: string; retryable?: boolean } }
          | undefined
      )?.error;
      return {
        ok: false,
        status: response.status,
        code: error?.code ?? "http",
        message: error?.message ?? `HTTP ${response.status}`,
        ...(typeof error?.reason === "string" ? { reason: error.reason } : {}),
        ...(typeof error?.retryable === "boolean" ? { retryable: error.retryable } : {}),
      };
    }
    if (parsed === undefined) {
      // e.g. the Vite dev server's HTML fallback when no API is running behind the proxy.
      return { ok: false, status: response.status, code: "badResponse", message: "not JSON" };
    }
    return { ok: true, status: response.status, body: parsed as T };
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === "AbortError";
    return {
      ok: false,
      status: 0,
      code: aborted ? "timeout" : "network",
      message: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function readStorage(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeStorage(key: string, value: string | undefined): void {
  try {
    if (value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Storage blocked (private mode etc.): the session simply won't survive a reload.
  }
}

export const storage = { read: readStorage, write: writeStorage };

/**
 * The anonymous bearer token: from localStorage, or minted once with `POST /api/auth/anon`.
 * `forceNew` discards a stored token the server no longer recognises (e.g. a dev server's
 * in-memory db restarted). Returns `undefined` when the server is unreachable.
 */
export async function ensureToken(forceNew = false): Promise<string | undefined> {
  if (!forceNew) {
    const stored = readStorage(TOKEN_KEY);
    if (stored !== undefined) return stored;
  }
  const result = await apiCall<{ userId: string; token: string }>("/api/auth/anon", {
    method: "POST",
    body: {},
    timeoutMs: 5_000,
  });
  if (!result.ok) return undefined;
  writeStorage(TOKEN_KEY, result.body.token);
  return result.body.token;
}
