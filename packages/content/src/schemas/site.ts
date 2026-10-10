/**
 * Expeditions A1 (§5.2): a site's cast entry (`SiteCastEntryDef`), as a dock map's `defaultCast`
 * authors it. Text lengths are staging's (`STAGING_LIMITS` in `@crew/sim`, which this package may
 * only import as types, so the numbers are restated in `STAGING_TEXT`). The caps (`SITE_LIMITS`)
 * and the posts are checked at L2/L3 (`validate-dock.ts`).
 */
import type { SITE_LIMITS, STAGING_LIMITS, SiteCastEntryDef } from "@crew/sim";
import { z } from "zod";
import {
  type AssertEqual,
  castArmsSchema,
  castPartSchema,
  localKeySchema,
  resolveTierSchema,
  tieTierSchema,
  wantsTierSchema,
} from "./primitives";

/** Mirrors sim `STAGING_LIMITS`' text caps. */
export const STAGING_TEXT = { nameChars: 60, roleChars: 60, lookChars: 120 } as const;

/** Mirrors sim `SITE_LIMITS`. */
export const SITE_CAST_LIMITS = { people: 6, armed: 3, targets: 1, allies: 1 } as const;

export const siteCastEntrySchema = z.strictObject({
  name: z.string().min(1).max(STAGING_TEXT.nameChars),
  role: z.string().min(1).max(STAGING_TEXT.roleChars),
  look: z.string().min(1).max(STAGING_TEXT.lookChars),
  part: castPartSchema,
  arms: castArmsSchema,
  resolve: resolveTierSchema,
  tie: tieTierSchema,
  wants: wantsTierSchema,
  post: localKeySchema,
}) satisfies z.ZodType<SiteCastEntryDef>;

// Drift guards against the sim's caps: each must resolve to `true`.
export const SITE_LIMITS_IN_SYNC: [
  AssertEqual<typeof SITE_CAST_LIMITS, typeof SITE_LIMITS>,
  AssertEqual<typeof STAGING_TEXT, Pick<typeof STAGING_LIMITS, keyof typeof STAGING_TEXT>>,
] = [true, true];
