/** `ActivityDef` schema (slice 4): an off-watch activity. */
import type { ActivityDef } from "@crew/sim";
import { z } from "zod";
import {
  activityDefIdSchema,
  activityOutcomeSchema,
  interestTagSchema,
  itemDefIdSchema,
  itemTagSchema,
  machineTagSchema,
  positive,
  positiveInt,
  problemKindSchema,
  skillIdSchema,
  thoughtKeySchema,
  topicDefIdSchema,
  unitInterval,
} from "./primitives";

/** Exactly one of a machine tag, a zone tag or a compartment tag; `own` only with a machine. */
export const venueDefSchema = z
  .strictObject({
    machineTag: machineTagSchema.exactOptional(),
    zoneTag: z.string().min(1).exactOptional(),
    compartmentTag: z.string().min(1).exactOptional(),
    own: z.literal(true).exactOptional(),
  })
  .refine(
    (v) =>
      [v.machineTag, v.zoneTag, v.compartmentTag].filter((tag) => tag !== undefined).length === 1,
    { message: "a venue names exactly one of machineTag, zoneTag, compartmentTag" },
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

const affinityDelta = z.number().int().min(-3).max(3);

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
    affinity: z
      .strictObject({
        participants: affinityDelta,
        winnerToLoser: affinityDelta,
        loserToWinner: affinityDelta,
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
