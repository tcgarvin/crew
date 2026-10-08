/**
 * Server HTTP contract (PLAN §3, W8). JSON over HTTPS, same origin as the SPA. Every route except
 * `POST /api/auth/anon` and `GET /api/health` requires `Authorization: Bearer <token>`.
 *
 * Save blobs travel as base64 of the gzipped JSON `SaveEnvelope` (the host gzips; the server
 * stores bytes and reads only the metadata fields it is given, never trusting them for authority).
 *
 * **W8 implementation changes to this contract** (additive; nothing above was removed):
 * - Added `POST /api/games/:id/open` (bumps `lease_epoch`, returns the new one + the head save)
 *   per the W8 task brief — needed for D9's "stale tab goes read-only" flow, missing from the
 *   original sketch.
 * - `PutSaveRequest` gained an optional `milestone?: boolean` (defaults false); milestone saves
 *   are exempt from the rolling-5 prune. `PutSaveResponse` gained `savedAtTick` (echoes the
 *   request) so the client doesn't have to track it separately.
 * - Added `"budgetExceeded"` to `ApiError["error"]["code"]` for the narrator route's 429.
 * - Table sketch below is the actual implemented schema (`src/db/schema.ts`); it renames/extends
 *   the original sketch: `users.token_hash` → `anon_token_hash`; `games.title` (wire field,
 *   unchanged) is stored as `games.name`; `saves` gained `sim_version` and `is_milestone`;
 *   `narrator_calls` gained `basis_save_id` (the milestone save taken at call time — doubles as
 *   the audit trail for what the model saw) and `prompt_version`/`status`, and
 *   `request_digest`/`plan`/`commands`/`dropped`/`hook_tick` were folded into `request jsonb` +
 *   `response jsonb` (the whole `NarratorRequest`/`NarratorResponse`, W9's dropped-intents list
 *   included) to avoid guessing W9's internal shape before it exists.
 *
 * Table sketch (Neon Postgres, W8 owns the migrations):
 *
 *   users(
 *     id uuid pk,
 *     anon_token_hash text unique not null,      -- sha256 of the anon bearer token
 *     created_at timestamptz not null default now()
 *   )
 *   games(
 *     id uuid pk,
 *     user_id uuid not null references users,
 *     name text not null,
 *     head_save_id uuid null,                    -- latest save (one linear timeline, D9)
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
 *     sim_version text not null,
 *     content_hash text not null,
 *     saved_at_tick bigint not null,
 *     is_milestone boolean not null default false,
 *     created_at timestamptz not null default now()
 *   )  -- W8 prunes non-milestone saves to the last 5 per game; D9 forbids offering older ones
 *   narrator_calls(
 *     id uuid pk,
 *     game_id uuid not null references games,
 *     hook_kind text not null,
 *     basis_save_id uuid not null references saves,  -- the milestone snapshot the call used
 *     model text not null,
 *     prompt_version text not null,
 *     input_tokens integer, output_tokens integer, latency_ms integer,
 *     status text not null,                  -- 'ok' | 'error' | 'budgetExceeded'
 *     request jsonb not null,
 *     response jsonb null,
 *     error text null,
 *     created_at timestamptz not null default now()
 *   )
 */
import type { NarratorRequest, NarratorResponse } from "@crew/narrator";

/** Uniform error body for every non-2xx response. */
export interface ApiError {
  readonly error: {
    readonly code:
      | "unauthorized"
      | "notFound"
      | "badRequest"
      | "staleLease"
      | "payloadTooLarge"
      | "budgetExceeded"
      | "narratorFailed"
      | "narratorUnavailable"
      | "internal";
    readonly message: string;
    /**
     * `budgetExceeded`: `"spacing"` (too soon after the last call; a rate rule, not a failure,
     * and only for hooks the sim raises again: never `stageDock`, `policyDecision`,
     * `captainAshore` or `requestedCall`); D102 removed the per-game hourly cap.
     * `narratorUnavailable` (D43): the narrator's `FallbackReason` (`notConfigured`,
     * `apiError`, `timeout`, `refusal`, `truncated`, `schemaInvalid`).
     */
    readonly reason?: string;
    /** `narratorUnavailable` only: false for `notConfigured`, true for every model failure. */
    readonly retryable?: boolean;
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

// POST /api/games/:id/open -----------------------------------------------------------------------

/** Opening a game bumps `lease_epoch` and returns the new one; other tabs' saves then fail. */
export type OpenGameRequest = Record<string, never>;

export interface OpenGameResponse {
  readonly leaseEpoch: number;
  readonly headSave?: GetSaveResponse;
}

// PUT /api/games/:id/save, GET /api/games/:id/save ----------------------------------------------

export interface PutSaveRequest {
  /** From create, open, or the last GET; a lower epoch than the game's gets `409 staleLease`. */
  readonly leaseEpoch: number;
  readonly schemaVersion: number;
  readonly savedAtTick: number;
  readonly contentHash: string;
  /** base64(gzip(JSON.stringify(SaveEnvelope))). */
  readonly blob: string;
  /** Exempts this save from the rolling-5 prune (W8 addition). Default false. */
  readonly milestone?: boolean;
}

export interface PutSaveResponse {
  readonly saveId: string;
  readonly savedAtTick: number;
}

export interface GetSaveResponse {
  readonly saveId: string;
  readonly leaseEpoch: number;
  readonly schemaVersion: number;
  readonly simVersion: string;
  readonly savedAtTick: number;
  readonly contentHash: string;
  readonly blob: string;
  readonly narrativeNotes: string;
}

// POST /api/games/:id/narrator ------------------------------------------------------------------

/** The body is a `NarratorRequest`; `gameId` must match `:id`. */
export type NarratorRouteRequest = NarratorRequest;
export type NarratorRouteResponse = NarratorResponse;
