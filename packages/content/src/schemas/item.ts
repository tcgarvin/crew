/** `ItemDef` schema. `unique` implies `maxStack: 1` (checked here as a refinement-free rule at L2). */
import type { ItemDef } from "@crew/sim";
import { z } from "zod";
import {
  cargoClassSchema,
  itemDefIdSchema,
  itemTagSchema,
  nonNegative,
  positive,
  positiveInt,
  toolKindSchema,
} from "./primitives";

export const itemDefSchema = z.strictObject({
  id: itemDefIdSchema,
  name: z.string().min(1),
  stacking: z.enum(["unique", "stackable"]),
  maxStack: positiveInt,
  tags: z.array(itemTagSchema),
  toolKinds: z.array(toolKindSchema),
  mass: nonNegative,
  cargoClass: cargoClassSchema.exactOptional(),
  nutrition: positive.exactOptional(),
  capacityUnits: positiveInt.exactOptional(),
}) satisfies z.ZodType<ItemDef>;
