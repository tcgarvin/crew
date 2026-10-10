/** `ThoughtDef` schema (§thoughts). */
import type { ThoughtDef } from "@crew/sim";
import { z } from "zod";
import { positive, thoughtKeySchema } from "./primitives";

export const thoughtDefSchema = z.strictObject({
  key: thoughtKeySchema,
  label: z.string().min(1),
  /** Contribution to mood, which is the clamped sum in [-1, 1]. */
  value: z.number().min(-1).max(1),
  durationDays: positive,
  stacks: z.boolean(),
}) satisfies z.ZodType<ThoughtDef>;
