/** `TopicDef` schema (slice 4): something a debate is about, weighted on the value axes. */
import type { TopicDef } from "@crew/sim";
import { z } from "zod";
import { topicDefIdSchema } from "./primitives";

const weight = z.number().min(-1).max(1);

export const topicDefSchema = z.strictObject({
  id: topicDefIdSchema,
  label: z.string().min(1),
  weights: z.strictObject({
    orderFreedom: weight,
    faithReason: weight,
    loyaltyAmbition: weight,
  }),
}) satisfies z.ZodType<TopicDef>;
