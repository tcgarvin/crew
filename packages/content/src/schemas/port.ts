/** `PortDef` schema. */
import type { PortDef } from "@crew/sim";
import { z } from "zod";
import {
  itemDefIdSchema,
  localKeySchema,
  nonNegativeInt,
  portDefIdSchema,
  positive,
  positiveInt,
} from "./primitives";

export const portDefSchema = z.strictObject({
  id: portDefIdSchema,
  name: z.string().min(1),
  description: z.string(),
  /** Passengers spec §2.4: two or three sentences of port character for the narrator. */
  character: z.string().min(1),
  /** Passengers spec §2.4: two or three named recurring locals. */
  castSeed: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        role: z.string().min(1),
        note: z.string().min(1),
      }),
    )
    .min(2)
    .max(3),
  externalStores: z
    .array(
      z.strictObject({
        key: localKeySchema,
        name: z.string().min(1),
        kind: z.enum(["warehouse", "market", "lounge"]),
      }),
    )
    .min(1),
  /** D47: opening stock; `count` may be 0 so a port can price a part it is out of. */
  market: z.array(
    z.strictObject({ itemDefId: itemDefIdSchema, count: nonNegativeInt, price: positiveInt }),
  ),
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
