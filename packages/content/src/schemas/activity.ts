/** `ActivityDef` schema (slice 4): an off-watch activity. */
import type { ActivityDef, ShorePostKind } from "@crew/sim";
import { z } from "zod";
import {
  type AssertEqual,
  activityDefIdSchema,
  activityOutcomeSchema,
  interestTagSchema,
  itemDefIdSchema,
  itemTagSchema,
  machineTagSchema,
  memoryKeySchema,
  positive,
  positiveInt,
  problemKindSchema,
  skillIdSchema,
  thoughtKeySchema,
  topicDefIdSchema,
  unitInterval,
} from "./primitives";

/** §shore-leave: the dock posts a shore-leave venue may name (sim `SHORE_POST_KINDS`). */
export const shorePostKindSchema = z.enum(["marketStall", "loungeDoor", "bench"]);

// Drift guard against the sim vocabulary: must resolve to `true`.
export const SHORE_POST_KINDS_IN_SYNC: AssertEqual<
  z.infer<typeof shorePostKindSchema>,
  ShorePostKind
> = true;

/**
 * Exactly one of a machine tag, a zone tag, a compartment tag or a dock post kind (§shore-leave);
 * `own` only with a machine.
 */
export const venueDefSchema = z
  .strictObject({
    machineTag: machineTagSchema.exactOptional(),
    zoneTag: z.string().min(1).exactOptional(),
    compartmentTag: z.string().min(1).exactOptional(),
    dockPost: shorePostKindSchema.exactOptional(),
    own: z.literal(true).exactOptional(),
  })
  .refine(
    (v) =>
      [v.machineTag, v.zoneTag, v.compartmentTag, v.dockPost].filter((tag) => tag !== undefined)
        .length === 1,
    { message: "a venue names exactly one of machineTag, zoneTag, compartmentTag, dockPost" },
  )
  .refine((v) => v.own === undefined || v.machineTag !== undefined, {
    message: "own applies only to a machineTag venue",
  });

/** Restores are totals over the duration, each in [0, 1]. */
const restoresSchema = z.strictObject({
  recreation: unitInterval.exactOptional(),
  social: unitInterval.exactOptional(),
  comfort: unitInterval.exactOptional(),
});

export const activityDefSchema = z
  .strictObject({
    id: activityDefIdSchema,
    label: z.string().min(1),
    waitingLabel: z.string().min(1),
    interest: interestTagSchema,
    venue: z.array(venueDefSchema).min(1),
    participants: z
      .strictObject({ min: positiveInt, max: positiveInt })
      .refine((p) => p.max >= p.min, { message: "max must be >= min" }),
    durationDays: positive,
    restores: restoresSchema,
    fatigueCost: unitInterval.exactOptional(),
    solo: z
      .strictObject({
        label: z.string().min(1),
        durationDays: positive,
        restores: restoresSchema,
      })
      .exactOptional(),
    outcome: activityOutcomeSchema,
    thoughts: z
      .strictObject({
        win: thoughtKeySchema.exactOptional(),
        lose: thoughtKeySchema.exactOptional(),
        joined: thoughtKeySchema.exactOptional(),
        listened: thoughtKeySchema.exactOptional(),
        listenedDislike: thoughtKeySchema.exactOptional(),
      })
      .exactOptional(),
    memories: z
      .strictObject({
        together: memoryKeySchema.exactOptional(),
        loserToWinner: memoryKeySchema.exactOptional(),
      })
      .exactOptional(),
    topics: z.array(topicDefIdSchema).min(1).exactOptional(),
    skillGain: z.strictObject({ skill: skillIdSchema, perDay: positive }).exactOptional(),
    risk: z.strictObject({ injuryChance: unitInterval }).exactOptional(),
    dirt: unitInterval.exactOptional(),
    requires: z
      .strictObject({ itemTag: itemTagSchema, own: z.literal(true).exactOptional() })
      .exactOptional(),
    produces: z
      .strictObject({ itemDefId: itemDefIdSchema, count: positiveInt, zoneTag: z.string().min(1) })
      .exactOptional(),
    transitOnly: z.literal(true).exactOptional(),
    blockedByProblems: z.array(problemKindSchema).exactOptional(),
  })
  .refine((a) => a.solo === undefined || a.participants.min > 1, {
    message: "solo is for group activities: forbidden when participants.min is 1",
  }) satisfies z.ZodType<ActivityDef>;
