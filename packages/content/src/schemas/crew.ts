/** `CrewDef` and `TraitDef` schemas. */
import type { CrewDef, TraitDef } from "@crew/sim";
import { z } from "zod";
import {
  crewDefIdSchema,
  interestTagSchema,
  itemCountSchema,
  roleTagSchema,
  skillLevelsSchema,
  traitDefIdSchema,
  traitModifierSchema,
} from "./primitives";

/**
 * Slice 4: one to three likes (`strong`, a keen one, among them), up to two dislikes, never a tag
 * both liked and disliked.
 */
export const interestsSchema = z
  .strictObject({
    likes: z.array(interestTagSchema).min(1).max(3),
    strong: interestTagSchema.exactOptional(),
    dislikes: z.array(interestTagSchema).max(2),
  })
  .refine((i) => i.strong === undefined || i.likes.includes(i.strong), {
    message: "strong must be one of likes",
  })
  .refine((i) => !i.likes.some((tag) => i.dislikes.includes(tag)), {
    message: "a tag cannot be both liked and disliked",
  })
  .refine((i) => new Set(i.likes).size === i.likes.length, { message: "likes repeat a tag" })
  .refine((i) => new Set(i.dislikes).size === i.dislikes.length, {
    message: "dislikes repeat a tag",
  });

const valueAxis = z.number().int().min(-2).max(2);

/** Slice 4: the three value axes, integers in [-2, 2]. */
export const valuesSchema = z.strictObject({
  orderFreedom: valueAxis,
  faithReason: valueAxis,
  loyaltyAmbition: valueAxis,
});

export const crewDefSchema = z.strictObject({
  id: crewDefIdSchema,
  name: z.string().min(1),
  roleTags: z.array(roleTagSchema),
  skills: skillLevelsSchema,
  traits: z.array(traitDefIdSchema).exactOptional(),
  startingInventory: z.array(itemCountSchema),
  bio: z.string(),
  /**
   * §crew-lines: how they talk and handle the captain; required so every crew member sounds like
   * someone.
   */
  voice: z.string().min(1),
  /** Slice 4: absent, generated at spawn. */
  interests: interestsSchema.exactOptional(),
  values: valuesSchema.exactOptional(),
}) satisfies z.ZodType<CrewDef>;

/** Trait multipliers are bounded so generated traits cannot wreck balance. */
export const traitDefSchema = z.strictObject({
  id: traitDefIdSchema,
  name: z.string().min(1),
  modifiers: z.partialRecord(traitModifierSchema, z.number().min(0.25).max(4)),
  excludes: z.array(traitDefIdSchema),
}) satisfies z.ZodType<TraitDef>;
