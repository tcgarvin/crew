/**
 * Response and request helpers every route shares: the uniform `ApiError` body, JSON-body
 * parsing, and the owned-game lookup behind every `/api/games/:id/*` route.
 */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";
import type { ApiError } from "./contract";
import type { Db, GameRow } from "./db/types";

type ApiErrorDetail = ApiError["error"];

/** Sends the uniform `ApiError` body with `status`. */
export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: ApiErrorDetail["code"],
  message: string,
  extra: Pick<ApiErrorDetail, "reason" | "retryable"> = {},
) {
  const body: ApiError = { error: { code, message, ...extra } };
  return c.json(body, status);
}

/** Parses the request body as JSON against `schema`; a body that is not JSON fails the parse. */
export async function parseJsonBody<T extends z.ZodType>(
  c: Context,
  schema: T,
): Promise<z.ZodSafeParseResult<z.infer<T>>> {
  const raw = await c.req.json().catch(() => undefined);
  return schema.safeParse(raw);
}

/** The game, when it exists and belongs to `userId`; a game someone else owns is "not found". */
export async function loadOwnedGame(
  db: Db,
  userId: string,
  gameId: string,
): Promise<GameRow | undefined> {
  const game = await db.getGame(gameId);
  if (!game || game.userId !== userId) return undefined;
  return game;
}
