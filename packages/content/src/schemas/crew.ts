/** `CrewDef` and `TraitDef` schemas. */
import type { CrewDef, TraitDef } from "@crew/sim";
import { z } from "zod";
import {
  crewDefIdSchema,
  itemCountSchema,
  localKeySchema,
  roleTagSchema,
  skillLevelsSchema,
  traitDefIdSchema,
  traitModifierSchema,
} from "./primitives";

export const crewDefSchema = z.strictObject({
  id: crewDefIdSchema,
  name: z.string().min(1),
  roleTags: z.array(roleTagSchema),
  skills: skillLevelsSchema,
  traits: z.array(traitDefIdSchema).exactOptional(),
  startingInventory: z.array(itemCountSchema),
  shift: localKeySchema,
  bio: z.string(),
  /** D38: how they talk and handle the captain; required so every crew member sounds like someone. */
  voice: z.string().min(1),
}) satisfies z.ZodType<CrewDef>;

/** Trait multipliers are bounded so generated traits cannot wreck balance. */
export const traitDefSchema = z.strictObject({
  id: traitDefIdSchema,
  name: z.string().min(1),
  modifiers: z.partialRecord(traitModifierSchema, z.number().min(0.25).max(4)),
  excludes: z.array(traitDefIdSchema),
}) satisfies z.ZodType<TraitDef>;
