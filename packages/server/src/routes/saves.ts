/**
 * `PUT/GET /api/games/:id/save` (W8). Blobs are gzip(JSON(SaveEnvelope)), base64-encoded on the
 * wire (contract.ts); the server never inflates further than needed to validate the envelope
 * shape and never interprets `state`/`config`.
 */
import { gunzipSync } from "node:zlib";
import type { Hono } from "hono";
import type { GetSaveResponse, PutSaveResponse } from "../contract";
import type { Db, GameRow, SaveRow } from "../db/types";
import type { Env } from "../env";
import { putSaveRequestSchema, saveEnvelopeSchema } from "../validation";

export interface SaveRouteEnv {
  Variables: { userId: string };
}

/** Shared with `routes/games.ts` (open) and `routes/narrator.ts`. */
export function buildGetSaveResponse(game: GameRow, save: SaveRow): GetSaveResponse {
  const narrativeNotes =
    typeof game.narrativeNotes === "string"
      ? game.narrativeNotes
      : JSON.stringify(game.narrativeNotes ?? "");
  return {
    saveId: save.id,
    leaseEpoch: game.leaseEpoch,
    schemaVersion: save.schemaVersion,
    simVersion: save.simVersion,
    savedAtTick: save.savedAtTick,
    contentHash: save.contentHash,
    blob: save.blob.toString("base64"),
    narrativeNotes,
  };
}

async function loadOwnedGame(db: Db, userId: string, gameId: string): Promise<GameRow | undefined> {
  const game = await db.getGame(gameId);
  if (!game || game.userId !== userId) return undefined;
  return game;
}

export function registerSaveRoutes(app: Hono<SaveRouteEnv>, db: Db, env: Env): void {
  app.put("/api/games/:id/save", async (c) => {
    const userId = c.get("userId");
    const gameId = c.req.param("id");
    const game = await loadOwnedGame(db, userId, gameId);
    if (!game) return c.json({ error: { code: "notFound", message: "No such game." } }, 404);

    const raw = await c.req.json().catch(() => undefined);
    const parsed = putSaveRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: { code: "badRequest", message: "Invalid save request body." } }, 400);
    }
    const body = parsed.data;

    if (body.leaseEpoch < game.leaseEpoch) {
      return c.json(
        {
          error: {
            code: "staleLease",
            message: "This tab's lease has been superseded by a newer one; reopen the game.",
          },
        },
        409,
      );
    }

    let gzipped: Buffer;
    try {
      gzipped = Buffer.from(body.blob, "base64");
    } catch {
      return c.json({ error: { code: "badRequest", message: "blob is not valid base64." } }, 400);
    }
    // Vercel functions cap request bodies at 4.5 MB; MAX_SAVE_BYTES (default 4 MB, gzipped)
    // leaves headroom for the base64 and JSON envelope overhead around it.
    if (gzipped.byteLength > env.maxSaveBytes) {
      return c.json(
        {
          error: {
            code: "payloadTooLarge",
            message: `Save exceeds the ${env.maxSaveBytes}-byte (gzipped) limit.`,
          },
        },
        413,
      );
    }

    let envelopeJson: unknown;
    try {
      envelopeJson = JSON.parse(gunzipSync(gzipped).toString("utf8"));
    } catch {
      return c.json(
        { error: { code: "badRequest", message: "blob does not gunzip to JSON." } },
        400,
      );
    }
    const envelope = saveEnvelopeSchema.safeParse(envelopeJson);
    if (!envelope.success) {
      return c.json(
        { error: { code: "badRequest", message: "Save envelope failed validation." } },
        400,
      );
    }
    if (
      envelope.data.schemaVersion !== body.schemaVersion ||
      envelope.data.savedAtTick !== body.savedAtTick ||
      envelope.data.contentHash !== body.contentHash
    ) {
      return c.json(
        {
          error: {
            code: "badRequest",
            message: "Envelope metadata does not match the request fields.",
          },
        },
        400,
      );
    }

    const saved = await db.putSave({
      gameId,
      blob: gzipped,
      schemaVersion: body.schemaVersion,
      simVersion: envelope.data.simVersion,
      contentHash: body.contentHash,
      savedAtTick: body.savedAtTick,
      isMilestone: body.milestone ?? false,
    });

    const responseBody: PutSaveResponse = { saveId: saved.id, savedAtTick: saved.savedAtTick };
    return c.json(responseBody, 201);
  });

  app.get("/api/games/:id/save", async (c) => {
    const userId = c.get("userId");
    const gameId = c.req.param("id");
    const game = await loadOwnedGame(db, userId, gameId);
    if (!game) return c.json({ error: { code: "notFound", message: "No such game." } }, 404);
    const head = await db.getHeadSave(gameId);
    if (!head) {
      return c.json({ error: { code: "notFound", message: "This game has no save yet." } }, 404);
    }
    return c.json(buildGetSaveResponse(game, head));
  });
}
