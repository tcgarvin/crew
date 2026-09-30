/**
 * `GET/POST /api/games` and `POST /api/games/:id/open` (W8).
 */
import type { Hono } from "hono";
import type {
  CreateGameResponse,
  GameSummary,
  ListGamesResponse,
  OpenGameResponse,
} from "../contract";
import type { Db } from "../db/types";
import { createGameRequestSchema } from "../validation";
import { buildGetSaveResponse } from "./saves";

export interface GameRouteEnv {
  Variables: { userId: string };
}

export function registerGameRoutes(app: Hono<GameRouteEnv>, db: Db): void {
  app.get("/api/games", async (c) => {
    const userId = c.get("userId");
    const rows = await db.listGames(userId);
    // One query per game for its head save; V1 game lists are small (single-digit per user).
    const games: GameSummary[] = await Promise.all(
      rows.map(async (game) => {
        const head = await db.getHeadSave(game.id);
        return {
          id: game.id,
          title: game.name,
          savedAtTick: head?.savedAtTick ?? null,
          updatedAt: game.updatedAt.toISOString(),
        };
      }),
    );
    const body: ListGamesResponse = { games };
    return c.json(body);
  });

  app.post("/api/games", async (c) => {
    const userId = c.get("userId");
    const raw = await c.req.json().catch(() => undefined);
    const parsed = createGameRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: { code: "badRequest", message: "Expected { title: string }." } }, 400);
    }
    const game = await db.createGame(userId, parsed.data.title);
    const body: CreateGameResponse = {
      game: {
        id: game.id,
        title: game.name,
        savedAtTick: null,
        updatedAt: game.updatedAt.toISOString(),
      },
      leaseEpoch: game.leaseEpoch,
    };
    return c.json(body, 201);
  });

  app.post("/api/games/:id/open", async (c) => {
    const userId = c.get("userId");
    const gameId = c.req.param("id");
    const game = await db.getGame(gameId);
    if (!game || game.userId !== userId) {
      return c.json({ error: { code: "notFound", message: "No such game." } }, 404);
    }
    const bumped = await db.bumpLease(gameId);
    const head = await db.getHeadSave(gameId);
    const body: OpenGameResponse = {
      leaseEpoch: bumped.leaseEpoch,
      ...(head ? { headSave: buildGetSaveResponse(bumped, head) } : {}),
    };
    return c.json(body);
  });
}
