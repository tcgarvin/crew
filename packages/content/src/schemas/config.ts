/** `ConfigDef` schema: every tunable. Bounds are sanity limits, not balance. */
import type { ConfigDef } from "@crew/sim";
import { z } from "zod";
import {
  localKeySchema,
  nonNegative,
  nonNegativeInt,
  positive,
  positiveInt,
  powerPrioritySchema,
  unitInterval,
} from "./primitives";

const band = z.strictObject({ min: nonNegative, max: nonNegative });
const unitRange = z
  .strictObject({ min: unitInterval, max: unitInterval })
  .refine((r) => r.min <= r.max, { message: "min must be <= max" });

export const configDefSchema = z.strictObject({
  time: z.strictObject({ tickRate: positiveInt }),
  movement: z.strictObject({
    walkSpeed: positive,
    passDelaySeconds: nonNegative,
    blockedRerouteSeconds: positive,
    fatigueSpeedFloor: unitInterval,
    loadSpeedPerKg: nonNegative,
    loadSpeedFloor: unitInterval,
  }),
  doors: z.strictObject({
    openSeconds: positive,
    closeSeconds: positive,
    autoCloseAfterSeconds: positive,
    manualOpenSeconds: positive,
  }),
  needs: z.strictObject({
    hungerPerSecond: nonNegative,
    fatiguePerSecondAwake: nonNegative,
    fatiguePerSecondWorking: nonNegative,
    fatigueRecoveryPerSecondAsleep: nonNegative,
    comfortPerSecond: nonNegative,
    comfortRecoveryPerSecondResting: nonNegative,
    socialPerSecond: nonNegative,
    socialRecoveryPerSecondChatting: nonNegative,
    seekThreshold: unitInterval,
    mealSeconds: positive,
    sleepMinSeconds: positive,
    wakeBelow: unitInterval,
    initialRange: z.strictObject({
      hunger: unitRange,
      fatigue: unitRange,
      comfort: unitRange,
      social: unitRange,
    }),
  }),
  work: z.strictObject({
    reconsiderEveryTicks: positiveInt,
    switchCooldownSeconds: nonNegative,
    claimLeaseSeconds: positive,
    timeBucketSeconds: positive,
    retryBackoffSeconds: positive,
    skillGainPerSecond: nonNegative,
    workSpeedPerSkillLevel: nonNegative,
  }),
  urgency: z.strictObject({
    needEssentialAbove: unitInterval,
    needSurvivalAbove: unitInterval,
    heatContainmentAbove: unitInterval,
    heatSurvivalAbove: unitInterval,
    routineAgingSeconds: positive,
  }),
  equipment: z.strictObject({
    hazardScale: nonNegative,
    overheatDamagePerSecond: nonNegative,
    maintenanceConditionBelow: unitInterval,
    integrityDerateBelow: unitInterval,
    integrityInoperableBelow: unitInterval,
  }),
  power: z.strictObject({ priorityOrder: z.array(powerPrioritySchema).min(1) }),
  travel: z.strictObject({
    prepareDepartureSeconds: positive,
    undockSeconds: positive,
    departSeconds: positive,
    approachSeconds: positive,
    dockSeconds: positive,
    nominalSpeed: positive,
    staffEstimateSeconds: nonNegative,
    departureMinOutput: unitInterval,
  }),
  commerce: z.strictObject({
    priceBands: z.strictObject({
      general: band,
      fragile: band,
      perishable: band,
      hazardous: band,
      passenger: band,
    }),
    jobOfferTtlSeconds: positive,
    dockingFee: z.number().int().min(0),
    haulEstimateSeconds: nonNegative,
    reofferSeconds: nonNegative,
    maxCratesPerJob: positiveInt,
    passage: z
      .strictObject({
        ashoreSecondsMin: nonNegative,
        ashoreSecondsMax: nonNegative,
        overdueSeconds: nonNegative,
      })
      .refine((p) => p.ashoreSecondsMin <= p.ashoreSecondsMax, {
        message: "ashoreSecondsMin must be <= ashoreSecondsMax",
      }),
    market: z.strictObject({
      priceTiers: z.strictObject({ cheap: positive, fair: positive, dear: positive }),
      maxStockPerCommand: nonNegativeInt,
      defaultPrice: positiveInt,
      buySeconds: nonNegative,
    }),
  }),
  narrator: z.strictObject({
    quietTooLongSeconds: positive,
    approachHookLeadSeconds: positive,
    maxSpawnsPerCommand: positiveInt,
    maxFaultWindowSeconds: positive,
    spawnBudget: z.number().int().min(0),
    faultBudget: z.number().int().min(0),
    budgetRefillSeconds: positive,
    hookOnEvents: z.array(z.string().min(1)),
  }),
  host: z.strictObject({
    runAheadCapSeconds: nonNegative,
    snapshotRingSeconds: positive,
    snapshotEverySeconds: positive,
    localSaveEverySeconds: positive,
    remoteSaveEverySeconds: positive,
    frameEveryTicks: positiveInt,
  }),
  shifts: z.strictObject({
    cycleSeconds: positive,
    shifts: z
      .array(
        z.strictObject({
          key: localKeySchema,
          workWindows: z.array(z.tuple([nonNegative, nonNegative])),
        }),
      )
      .min(1),
  }),
  social: z.strictObject({
    chatRadiusTiles: positive,
    chatCooldownSeconds: nonNegative,
    templateLines: z.array(z.string().min(1)).min(1),
  }),
  events: z.strictObject({ tickerMaxEntries: positiveInt, traceRingSize: positiveInt }),
}) satisfies z.ZodType<ConfigDef>;
