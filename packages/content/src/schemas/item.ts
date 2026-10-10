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
  woundSeveritySchema,
} from "./primitives";

/** Expeditions A1 (§7.2): what a weapon does. */
export const weaponDefSchema = z.strictObject({
  kind: z.enum(["blaster", "baton"]),
  range: positive,
  aimSeconds: positive,
  hit: z.number().gt(0).max(1),
  severity: woundSeveritySchema,
  damageType: z.enum(["blaster", "blunt"]),
  stun: z.boolean(),
});

/** Expeditions A1: `weapon` exactly on a `weapon`-tagged item (the refinement). */
export const itemDefSchema = z
  .strictObject({
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
    weapon: weaponDefSchema.exactOptional(),
  })
  .superRefine((item, ctx) => {
    if (item.tags.includes("weapon") !== (item.weapon !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["weapon"],
        message: "an item has `weapon` exactly when it has the `weapon` tag",
      });
    }
  }) satisfies z.ZodType<ItemDef>;
