/** `ConfigDef` schema: every tunable. Bounds are sanity limits, not balance. */
import type { ConfigDef } from "@crew/sim";
import { z } from "zod";
import {
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
  time: z.strictObject({ tickRate: positiveInt, daySeconds: positive, watchesPerDay: positiveInt }),
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
    rampOpenSeconds: positive,
  }),
  needs: z.strictObject({
    hungerPerDay: nonNegative,
    fatiguePerDayAwake: nonNegative,
    fatiguePerDayWorking: nonNegative,
    fatigueRecoveryPerDayAsleep: nonNegative,
    comfortPerDay: nonNegative,
    comfortRecoveryPerDayResting: nonNegative,
    socialPerDay: nonNegative,
    socialRecoveryPerDayChatting: nonNegative,
    recreationPerDay: nonNegative,
    seekThreshold: unitInterval,
    mealDays: positive,
    sleepDays: positive,
    wakeBelow: unitInterval,
    bedtimeAbove: unitInterval,
    initialRange: z.strictObject({
      hunger: unitRange,
      fatigue: unitRange,
      comfort: unitRange,
      social: unitRange,
      recreation: unitRange,
    }),
  }),
  work: z.strictObject({
    reconsiderEveryTicks: positiveInt,
    switchCooldownSeconds: nonNegative,
    claimLeaseSeconds: positive,
    timeBucketSeconds: positive,
    retryBackoffSeconds: positive,
    skillGainPerDay: nonNegative,
    workSpeedPerSkillLevel: nonNegative,
  }),
  urgency: z.strictObject({
    needEssentialAbove: unitInterval,
    needSurvivalAbove: unitInterval,
    heatContainmentAbove: unitInterval,
    heatSurvivalAbove: unitInterval,
    routineAgingDays: positive,
    cleaningAgingDays: positive,
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
    limpSpeedFraction: unitInterval,
    recallAboardSeconds: positive,
    localShuffleSeconds: positive,
    dockHandGiveUpSeconds: positive,
    talkSeconds: positive,
    gateVisitSeconds: positive,
    cardDeliveryGiveUpSeconds: positive,
  }),
  commerce: z.strictObject({
    priceBands: z.strictObject({
      general: band,
      fragile: band,
      perishable: band,
      hazardous: band,
      passenger: band,
    }),
    jobOfferTtlDays: positive,
    dockingFee: z.number().int().min(0),
    haulEstimateSeconds: nonNegative,
    reofferDays: nonNegative,
    maxCratesPerJob: positiveInt,
    passage: z
      .strictObject({
        ashoreDaysMin: nonNegative,
        ashoreDaysMax: nonNegative,
        overdueDays: nonNegative,
      })
      .refine((p) => p.ashoreDaysMin <= p.ashoreDaysMax, {
        message: "ashoreDaysMin must be <= ashoreDaysMax",
      }),
    sparesReserve: nonNegativeInt,
    foodReserve: z
      .strictObject({ lowBelowDays: nonNegative, restockToDays: nonNegative })
      .refine((r) => r.lowBelowDays <= r.restockToDays, {
        message: "lowBelowDays must be <= restockToDays",
      }),
    market: z.strictObject({
      priceTiers: z.strictObject({ cheap: positive, fair: positive, dear: positive }),
      maxStockPerCommand: nonNegativeInt,
      defaultPrice: positiveInt,
      buySeconds: nonNegative,
    }),
  }),
  narrator: z.strictObject({
    quietTooLongDays: positive,
    approachHookLeadSeconds: positive,
    maxSpawnsPerCommand: positiveInt,
    maxFaultWindowSeconds: positive,
    spawnBudget: z.number().int().min(0),
    faultBudget: z.number().int().min(0),
    budgetRefillDays: positive,
    hookOnEvents: z.array(z.string().min(1)),
    hazardBudget: z.number().int().min(0),
  }),
  host: z.strictObject({
    runAheadCapSeconds: nonNegative,
    snapshotRingSeconds: positive,
    snapshotEverySeconds: positive,
    localSaveEverySeconds: positive,
    remoteSaveEverySeconds: positive,
    frameEveryTicks: positiveInt,
    slowDownOnEvents: z.array(z.string().min(1)),
    dirtFrameEverySeconds: positive,
  }),
  watches: z.strictObject({
    dayworkerOnWatches: z.array(nonNegativeInt),
    handoverLeadSeconds: nonNegative,
    handoverSeconds: nonNegative,
    reliefMaxDays: positive,
    reliefNoShowSeconds: nonNegative,
    longWatchFactor: z.number().min(1),
    helmUnattendedSeconds: nonNegative,
    roundsStopSeconds: nonNegative,
    roundsEveryDays: nonNegative,
    plotCourseSeconds: nonNegative,
  }),
  mood: z
    .strictObject({
      lowBelow: z.number().min(-1).max(1),
      highAbove: z.number().min(-1).max(1),
      lowWorkSpeed: positive,
      highWorkSpeed: positive,
    })
    .refine((m) => m.lowBelow < m.highAbove, { message: "lowBelow must be < highAbove" }),
  galley: z
    .strictObject({
      mealLeadDays: positive,
      mealGraceDays: nonNegative,
      cookSeconds: nonNegative,
      substituteAfterDays: nonNegative,
      spareServings: nonNegativeInt,
      servingsPerCrate: positiveInt,
      mealSpoilDays: positive,
      mealCallHungerAbove: unitInterval,
      lowBelowDays: nonNegative,
      restockToDays: nonNegative,
      goodCookingAbove: z.number().min(0).max(10),
      poorCookingBelow: z.number().min(0).max(10),
      treatHungerAbove: unitInterval,
    })
    .refine((g) => g.lowBelowDays <= g.restockToDays, {
      message: "lowBelowDays must be <= restockToDays",
    })
    .refine((g) => g.poorCookingBelow <= g.goodCookingAbove, {
      message: "poorCookingBelow must be <= goodCookingAbove",
    }),
  dirt: z
    .strictObject({
      footfallPerStep: nonNegative,
      bootsPickup: unitInterval,
      bootsShed: unitInterval,
      dockGrimePerStep: nonNegative,
      airborneDustPerDay: nonNegative,
      airborneDustRadiusTiles: nonNegative,
      airborneDustVisitCap: nonNegative,
      deposits: z.strictObject({
        cooking: nonNegative,
        serving: nonNegative,
        eating: nonNegative,
        spoiledMeal: nonNegative,
        repair: nonNegative,
        cargo: nonNegative,
      }),
      depositRadiusTiles: nonNegativeInt,
      roomMaxWeight: unitInterval,
      tiers: z.strictObject({ untidy: unitInterval, dirty: unitInterval, filthy: unitInterval }),
      tierHysteresis: unitInterval,
      mopPerTile: nonNegative,
      mopSecondsPerTile: nonNegative,
      mopTilesPerTrip: positiveInt,
      updateEverySeconds: positive,
      tintScale: nonNegative,
      tintMaxAlpha: unitInterval,
    })
    .refine((d) => d.tiers.untidy <= d.tiers.dirty && d.tiers.dirty <= d.tiers.filthy, {
      message: "tiers must rise: untidy <= dirty <= filthy",
    }),
  hazards: z.strictObject({
    difficulty: z.strictObject({
      easy: z.number().int().min(1).max(10),
      hard: z.number().int().min(1).max(10),
      brutal: z.number().int().min(1).max(10),
    }),
    delaySeconds: nonNegative,
  }),
  social: z.strictObject({
    chatRadiusTiles: positive,
    chatCooldownSeconds: nonNegative,
    templateLines: z.array(z.string().min(1)).min(1),
    chatAffinity: z.number().int().min(0).max(3),
    chatAffinityEveryDays: nonNegative,
    affinityRange: positiveInt,
    avoidBelow: z.number().int(),
    preferAbove: z.number().int(),
    rivalry: z.strictObject({ streakFor: positiveInt }),
    debate: z
      .strictObject({ agreeWithin: nonNegative, argueBeyond: nonNegative })
      .refine((d) => d.agreeWithin < d.argueBeyond, {
        message: "agreeWithin must be < argueBeyond",
      }),
  }),
  recreation: z.strictObject({
    joinAbove: unitInterval,
    gatherSeconds: positive,
    lateJoinSeconds: nonNegative,
    collapseBackoffDays: nonNegative,
  }),
  cabins: z.strictObject({
    noisySeconds: positive,
    checkEverySeconds: positive,
    privateTalkSeconds: positive,
    privateTalkWaitSeconds: positive,
  }),
  events: z.strictObject({ tickerMaxEntries: positiveInt, traceRingSize: positiveInt }),
}) satisfies z.ZodType<ConfigDef>;
