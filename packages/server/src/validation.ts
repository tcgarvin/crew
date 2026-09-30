/**
 * Zod request/envelope validation (W8). Kept separate from the routes so both `saves.ts` and
 * `narrator.ts` (which embeds a `SaveEnvelope` snapshot) can share the envelope schema.
 */
import { z } from "zod";

/**
 * Shape check only (PLAN §3 "Saves", `SaveEnvelope` in `@crew/sim`). The server never interprets
 * `state`/`config` — it stores and returns them opaquely — so this only validates the envelope's
 * own metadata fields plus "state/config are objects".
 */
export const saveEnvelopeSchema = z.object({
  schemaVersion: z.number().int().min(0),
  simVersion: z.string().min(1),
  contentHash: z.string().min(1),
  configHash: z.string().min(1),
  savedAtTick: z.number().int().min(0),
  config: z.record(z.string(), z.unknown()),
  state: z.record(z.string(), z.unknown()),
});

export const createGameRequestSchema = z.object({
  title: z.string().min(1).max(200),
});

export const putSaveRequestSchema = z.object({
  leaseEpoch: z.number().int().min(0),
  schemaVersion: z.number().int().min(0),
  savedAtTick: z.number().int().min(0),
  contentHash: z.string().min(1),
  blob: z.string().min(1),
  milestone: z.boolean().optional(),
});
