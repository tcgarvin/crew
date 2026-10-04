/**
 * `PUT/GET /api/games/:id/save` (W8). Blobs are gzip(JSON(SaveEnvelope)), base64-encoded on the
 * wire (contract.ts); the server never inflates further than needed to validate the envelope
 * shape and never interprets `state`/`config`.
 */
import { gunzipSync } from "node:zlib";
import type { Hono } from "hono";
import type { AppEnv } from "../auth";
import type { GetSaveResponse, PutSaveResponse } from "../contract";
import type { Db, GameRow, SaveRow } from "../db/types";
import type { Env } from "../env";
import { apiError, loadOwnedGame, parseJsonBody } from "../http";
import { putSaveRequestSchema, saveEnvelopeSchema } from "../validation";

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

export function registerSaveRoutes(app: Hono<AppEnv>, db: Db, env: Env): void {
  app.put("/api/games/:id/save", async (c) => {
    const gameId = c.req.param("id");
    const game = await loadOwnedGame(db, c.get("userId"), gameId);
    if (!game) return apiError(c, 404, "notFound", "No such game.");

    const parsed = await parseJsonBody(c, putSaveRequestSchema);
    if (!parsed.success) return apiError(c, 400, "badRequest", "Invalid save request body.");
    const body = parsed.data;

    if (body.leaseEpoch < game.leaseEpoch) {
      return apiError(
        c,
        409,
        "staleLease",
        "This tab's lease has been superseded by a newer one; reopen the game.",
      );
    }

    // `Buffer.from` skips characters outside the base64 alphabet rather than throwing; a blob
    // that decodes to garbage fails the gunzip below.
    const gzipped = Buffer.from(body.blob, "base64");
    // Vercel functions cap request bodies at 4.5 MB; MAX_SAVE_BYTES (default 4 MB, gzipped)
    // leaves headroom for the base64 and JSON envelope overhead around it.
    if (gzipped.byteLength > env.maxSaveBytes) {
      return apiError(
        c,
        413,
        "payloadTooLarge",
        `Save exceeds the ${env.maxSaveBytes}-byte (gzipped) limit.`,
      );
    }

    let envelopeJson: unknown;
    try {
      envelopeJson = JSON.parse(gunzipSync(gzipped).toString("utf8"));
    } catch {
      return apiError(c, 400, "badRequest", "blob does not gunzip to JSON.");
    }
    const envelope = saveEnvelopeSchema.safeParse(envelopeJson);
    if (!envelope.success) {
      return apiError(c, 400, "badRequest", "Save envelope failed validation.");
    }
    if (
      envelope.data.schemaVersion !== body.schemaVersion ||
      envelope.data.savedAtTick !== body.savedAtTick ||
      envelope.data.contentHash !== body.contentHash
    ) {
      return apiError(c, 400, "badRequest", "Envelope metadata does not match the request fields.");
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
    const gameId = c.req.param("id");
    const game = await loadOwnedGame(db, c.get("userId"), gameId);
    if (!game) return apiError(c, 404, "notFound", "No such game.");
    const head = await db.getHeadSave(gameId);
    if (!head) return apiError(c, 404, "notFound", "This game has no save yet.");
    return c.json(buildGetSaveResponse(game, head));
  });
}
