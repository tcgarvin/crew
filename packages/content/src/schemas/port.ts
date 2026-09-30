/** `PortDef` schema. */
import type { PortDef } from "@crew/sim";
import { z } from "zod";
import {
  itemDefIdSchema,
  localKeySchema,
  portDefIdSchema,
  positive,
  positiveInt,
} from "./primitives";

export const portDefSchema = z.strictObject({
  id: portDefIdSchema,
  name: z.string().min(1),
  description: z.string(),
  externalStores: z
    .array(
      z.strictObject({
        key: localKeySchema,
        name: z.string().min(1),
        kind: z.enum(["warehouse", "market", "lounge"]),
      }),
    )
    .min(1),
  jobTemplates: z.array(
    z.strictObject({
      key: localKeySchema,
      issuer: z.string().min(1),
      toPortId: portDefIdSchema,
      cargo: z
        .array(
          z.strictObject({
            itemDefId: itemDefIdSchema,
            countMin: positiveInt,
            countMax: positiveInt,
          }),
        )
        .min(1),
      weight: positive,
    }),
  ),
  routes: z.array(z.strictObject({ toPortId: portDefIdSchema, distance: positive })),
}) satisfies z.ZodType<PortDef>;
