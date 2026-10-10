/** `ConfigDef` schema: every tunable. Bounds are sanity limits, not balance. */
import type { ConfigDef, MemoryKey } from "@crew/sim";
import { z } from "zod";
import {
  memoryKeySchema,
  nonNegative,
  nonNegativeInt,
  positive,
  positiveInt,
  powerPrioritySchema,
  unitInterval,
} from "./primitives";

/** §memories: one memory kind's opinion (a whole number, never 0), duration and stack limit. */
const memoryDefSchema = z.strictObject({
  label: z.string().min(1),
  opinion: z
    .number()
    .int()
    .min(-5)
    .max(5)
    .refine((n) => n !== 0, { message: "a memory that moves nothing is not a memory" }),
  durationDays: positive,
  stackLimit: positiveInt,
});

const band = z.strictObject({ min: nonNegative, max: nonNegative });

/** Expeditions A1 (§7.1): one number per body part. */
const partRecord = (value: z.ZodNumber) =>
  z.strictObject({
    head: value,
    torso: value,
    leftArm: value,
    rightArm: value,
    leftLeg: value,
    rightLeg: value,
  });

/** Expeditions A1 (§7.1): one number per wound severity. */
const severityRecord = (value: z.ZodNumber) =>
  z.strictObject({ graze: value, serious: value, grave: value });

/** Expeditions A1: where a hit lands, relative weights that are not all 0. */
const weightTable = partRecord(nonNegative).refine((t) => Object.values(t).some((w) => w > 0), {
  message: "part weights must not all be 0",
});

/** Expeditions A1 (§5.2): a tie's factor on resolve and its loyalty. */
const tieSchema = z.strictObject({ resolve: positive, loyalty: unitInterval });

/**
 * §scheduling-a-field: one field severity: its mean impact rate, share of large rocks and length.
 */
const severitySchema = z.strictObject({
  impactsPerMinute: positive,
  largeShare: unitInterval,
  lengthSeconds: positive,
});
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
    maintenanceEssentialBelow: unitInterval,
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
    /**
     * §notable-event-hook: events that raise the narrator's aftermath call, at any significance.
     */
    aftermathHookOnEvents: z.array(z.string().min(1)),
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
    chatMemoryEveryDays: nonNegative,
    chatSour: z.strictObject({ atZero: unitInterval, perPoint: nonNegative }),
    compatibility: z.strictObject({
      base: z.number(),
      perValuePoint: nonNegative,
      perSharedLike: nonNegative,
      perClash: nonNegative,
      range: positiveInt,
    }),
    memories: z.strictObject(
      Object.fromEntries(memoryKeySchema.options.map((key) => [key, memoryDefSchema])) as Record<
        MemoryKey,
        typeof memoryDefSchema
      >,
    ),
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
  field: z.strictObject({
    warningSeconds: nonNegative,
    alertClearSeconds: nonNegative,
    severities: z.strictObject({
      light: severitySchema,
      heavy: severitySchema,
      brutal: severitySchema,
    }),
    helmThreading: unitInterval,
    unmannedRateFactor: positive,
    stuckRateFactor: positive,
    stuckDriftImpacts: positiveInt,
    hullDamage: z.strictObject({ small: positive, large: positive }),
    machineEffects: z
      .strictObject({
        none: nonNegative,
        graze: nonNegative,
        damage: nonNegative,
        knockout: nonNegative,
        fault: nonNegative,
      })
      .refine((w) => w.none + w.graze + w.damage + w.knockout + w.fault > 0, {
        message: "machine effect weights must not all be 0",
      }),
    effectIntegrity: z.strictObject({ graze: unitInterval, damage: unitInterval }),
    patchRecovers: unitInterval,
    maxScripted: positiveInt,
  }),
  damage: z.strictObject({
    patchSeconds: positive,
    plateSeconds: positive,
    repairSecondsPerIntegrity: positive,
    checkSeconds: positive,
  }),
  intercom: z.strictObject({ reportSeconds: positive }),
  bodies: z.strictObject({
    tolerance: partRecord(positive),
    severityDamage: severityRecord(nonNegative),
    severityPain: severityRecord(unitInterval),
    painDecayPerSecond: nonNegative,
    bleedPerSecond: severityRecord(nonNegative),
    bleedStopsAfterSeconds: severityRecord(nonNegative),
    bloodRecoverPerSecond: nonNegative,
    stunPerHit: unitInterval,
    stunDecayPerSecond: nonNegative,
    incapacitatedBelow: z.strictObject({ consciousness: unitInterval, movement: unitInterval }),
    deadBelowBlood: unitInterval,
    healPerDay: nonNegative,
    partTable: weightTable,
    stunPartTable: weightTable,
  }),
  expedition: z.strictObject({
    decideEverySeconds: positive,
    maxFightSeconds: positive,
    alertClearSeconds: nonNegative,
    hitSkillBase: nonNegative,
    hitPerFighting: nonNegative,
    rangeFalloffFloor: unitInterval,
    coverPenalty: unitInterval,
    movingTargetFactor: unitInterval,
    movingShooterFactor: unitInterval,
    meleeAdjacentOnly: z.boolean(),
    resolveTiers: z.strictObject({ shaky: unitInterval, steady: unitInterval, hard: unitInterval }),
    tie: z.strictObject({ paid: tieSchema, bound: tieSchema, devoted: tieSchema }),
    castFighting: z.strictObject({
      shaky: z.number().min(0).max(10),
      steady: z.number().min(0).max(10),
      hard: z.number().min(0).max(10),
    }),
    crewResolve: z.strictObject({
      base: unitInterval,
      perFighting: nonNegative,
      perMood: nonNegative,
      perLeaderAffinity: nonNegative,
    }),
    morale: z
      .strictObject({
        hitSelf: z.number(),
        allyDown: z.number(),
        allyDead: z.number(),
        underFireNoCoverPerSecond: z.number(),
        outnumberedPerSecond: z.number(),
        allyHit: z.number(),
        inCoverPerSecond: z.number(),
        leaderNearPerSecond: z.number(),
        outflanked: z.number(),
        targetTaken: z.number(),
        waverBelow: unitInterval,
        breakBelow: unitInterval,
        recoverAbove: unitInterval,
      })
      .refine((m) => m.breakBelow < m.waverBelow && m.waverBelow < m.recoverAbove, {
        message: "breakBelow < waverBelow < recoverAbove",
      }),
    withdrawWhen: z.strictObject({ firstDown: positiveInt, halfDown: unitInterval }),
    leaderNearTiles: positive,
    surrenderIfCornered: z.boolean(),
    blasters: nonNegativeInt,
    batons: nonNegativeInt,
  }),
  events: z.strictObject({ tickerMaxEntries: positiveInt, traceRingSize: positiveInt }),
}) satisfies z.ZodType<ConfigDef>;
