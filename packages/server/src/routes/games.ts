/**
 * `GET/POST /api/games` and `POST /api/games/:id/open` (W8).
 */
import type { Hono } from "hono";
import type { AppEnv } from "../auth";
import type {
  CreateGameResponse,
  GameSummary,
  ListGamesResponse,
  OpenGameResponse,
} from "../contract";
import type { Db, GameRow } from "../db/types";
import { apiError, loadOwnedGame, parseJsonBody } from "../http";
import { createGameRequestSchema } from "../validation";
import { buildGetSaveResponse } from "./saves";

function gameSummary(game: GameRow, savedAtTick: number | null): GameSummary {
  return {
    id: game.id,
    title: game.name,
    savedAtTick,
    updatedAt: game.updatedAt.toISOString(),
  };
}

export function registerGameRoutes(app: Hono<AppEnv>, db: Db): void {
  app.get("/api/games", async (c) => {
    const rows = await db.listGames(c.get("userId"));
    // One query per game for its head save; V1 game lists are small (single-digit per user).
    const games = await Promise.all(
      rows.map(async (game) => {
        const head = await db.getHeadSave(game.id);
        return gameSummary(game, head?.savedAtTick ?? null);
      }),
    );
    const body: ListGamesResponse = { games };
    return c.json(body);
  });

  app.post("/api/games", async (c) => {
    const parsed = await parseJsonBody(c, createGameRequestSchema);
    if (!parsed.success) return apiError(c, 400, "badRequest", "Expected { title: string }.");
    const game = await db.createGame(c.get("userId"), parsed.data.title);
    const body: CreateGameResponse = { game: gameSummary(game, null), leaseEpoch: game.leaseEpoch };
    return c.json(body, 201);
  });

  app.post("/api/games/:id/open", async (c) => {
    const gameId = c.req.param("id");
    const game = await loadOwnedGame(db, c.get("userId"), gameId);
    if (!game) return apiError(c, 404, "notFound", "No such game.");
    const bumped = await db.bumpLease(gameId);
    const head = await db.getHeadSave(gameId);
    const body: OpenGameResponse = {
      leaseEpoch: bumped.leaseEpoch,
      ...(head ? { headSave: buildGetSaveResponse(bumped, head) } : {}),
    };
    return c.json(body);
  });
}
