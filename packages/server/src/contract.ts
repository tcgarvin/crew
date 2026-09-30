/**
 * Server HTTP contract (PLAN §3, W8). JSON over HTTPS, same origin as the SPA. Every route except
 * `POST /api/auth/anon` and `GET /api/health` requires `Authorization: Bearer <token>`.
 *
 * Save blobs travel as base64 of the gzipped JSON `SaveEnvelope` (the host gzips; the server
 * stores bytes and reads only the metadata fields it is given, never trusting them for authority).
 *
 * Table sketch (Neon Postgres, W8 owns the migrations):
 *
 *   users(
 *     id uuid pk,
 *     token_hash text unique not null,      -- sha256 of the anon bearer token
 *     created_at timestamptz not null default now()
 *   )
 *   games(
 *     id uuid pk,
 *     user_id uuid not null references users,
 *     title text not null,
 *     head_save_id uuid null references saves,   -- latest save (one linear timeline, D9)
 *     lease_epoch integer not null default 0,    -- bumped on open; stale tabs' saves are rejected
 *     narrative_notes jsonb not null default '{}'::jsonb,  -- running summary, rewritten each call
 *     created_at timestamptz not null default now(),
 *     updated_at timestamptz not null default now()
 *   )
 *   saves(
 *     id uuid pk,
 *     game_id uuid not null references games,
 *     blob bytea not null,                  -- gzipped SaveEnvelope JSON
 *     schema_version integer not null,
 *     saved_at_tick bigint not null,
 *     content_hash text not null,
 *     created_at timestamptz not null default now()
 *   )  -- W8 may prune to the last N per game; D9 forbids offering older ones to the player
 *   narrator_calls(
 *     id uuid pk,
 *     game_id uuid not null references games,
 *     hook_kind text not null,
 *     hook_tick bigint not null,
 *     request_digest jsonb not null,        -- what the model saw (not the whole snapshot)
 *     plan jsonb null,                      -- raw NarratorPlan
 *     commands jsonb null,                  -- translated NarratorCommand[]
 *     dropped jsonb null,
 *     model text not null,
 *     input_tokens integer, output_tokens integer, latency_ms integer,
 *     error text null,
 *     created_at timestamptz not null default now()
 *   )
 */
import type { NarratorRequest, NarratorResponse } from "@crew/narrator";

/** Every route, for the client and for tests. */
export const ROUTES = {
  health: { method: "GET", path: "/api/health" },
  authAnon: { method: "POST", path: "/api/auth/anon" },
  listGames: { method: "GET", path: "/api/games" },
  createGame: { method: "POST", path: "/api/games" },
  putSave: { method: "PUT", path: "/api/games/:id/save" },
  getSave: { method: "GET", path: "/api/games/:id/save" },
  narrator: { method: "POST", path: "/api/games/:id/narrator" },
} as const;

export type RouteName = keyof typeof ROUTES;

/** Uniform error body for every non-2xx response. */
export interface ApiError {
  readonly error: {
    readonly code:
      | "unauthorized"
      | "notFound"
      | "badRequest"
      | "staleLease"
      | "narratorFailed"
      | "internal";
    readonly message: string;
  };
}

// POST /api/auth/anon ---------------------------------------------------------------------------

/** Creates an anonymous user. The token is shown once; the client keeps it in localStorage. */
export type AuthAnonRequest = Record<string, never>;
export interface AuthAnonResponse {
  readonly userId: string;
  readonly token: string;
}

// GET /api/games, POST /api/games ---------------------------------------------------------------

export interface GameSummary {
  readonly id: string;
  readonly title: string;
  readonly savedAtTick: number | null;
  readonly updatedAt: string;
}

export interface ListGamesResponse {
  readonly games: readonly GameSummary[];
}

export interface CreateGameRequest {
  readonly title: string;
}

/**
 * The client then creates the world locally (D3) and PUTs its first save. `leaseEpoch` must
 * accompany every later save of this game from this tab.
 */
export interface CreateGameResponse {
  readonly game: GameSummary;
  readonly leaseEpoch: number;
}

// PUT /api/games/:id/save, GET /api/games/:id/save ----------------------------------------------

export interface PutSaveRequest {
  /** From create or the last GET; a lower epoch than the game's gets `409 staleLease`. */
  readonly leaseEpoch: number;
  readonly schemaVersion: number;
  readonly savedAtTick: number;
  readonly contentHash: string;
  /** base64(gzip(JSON.stringify(SaveEnvelope))). */
  readonly blob: string;
}

export interface PutSaveResponse {
  readonly saveId: string;
}

/** Opening a game bumps `lease_epoch` and returns the new one; other tabs' saves then fail. */
export interface GetSaveResponse {
  readonly saveId: string;
  readonly leaseEpoch: number;
  readonly schemaVersion: number;
  readonly savedAtTick: number;
  readonly contentHash: string;
  readonly blob: string;
  readonly narrativeNotes: string;
}

// POST /api/games/:id/narrator ------------------------------------------------------------------

/** The body is a `NarratorRequest`; `gameId` must match `:id`. */
export type NarratorRouteRequest = NarratorRequest;
export type NarratorRouteResponse = NarratorResponse;
