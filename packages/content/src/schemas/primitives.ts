/**
 * Shared schema building blocks: branded definition IDs, coordinates, closed vocabularies.
 *
 * `@crew/sim` may only be imported for types here (dependency-cruiser `content-sim-types-only`),
 * so the enum values below duplicate the sim `as const` vocabularies. `AssertEqual` checks turn
 * any drift between the two into a compile error.
 */
import type {
  ActivityDefId,
  ActivityOutcome,
  CargoClass,
  CrewDefId,
  DeckDefId,
  DockDefId,
  HullSizeClass,
  InterestTag,
  ItemDefId,
  ItemTag,
  MachineDefId,
  MachineTag,
  MemoryKey,
  PortDefId,
  PowerPriority,
  ProblemKind,
  RecipeActionKind,
  RoleTag,
  ScenarioDefId,
  SkillId,
  SkillLevels,
  ThoughtKey,
  TileCoord,
  TileEdge,
  ToolKind,
  TopicDefId,
  TraitDefId,
  TraitModifierKey,
} from "@crew/sim";
import { z } from "zod";

/** Compile-time equality; resolves to `true` only when A and B are mutually assignable. */
export type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/** Mirrors sim `DEF_ID_PATTERN`. */
export const DEF_ID_REGEX = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

/**
 * A string validated as a definition ID and typed as the sim brand. The cast is sound because the
 * regex is the only thing the brand promises; at runtime this is a plain `ZodString`, so JSON
 * Schema generation is unaffected.
 */
function defId<T extends string>(): z.ZodType<T, string> {
  return z.string().regex(DEF_ID_REGEX) as unknown as z.ZodType<T, string>;
}

export const deckDefIdSchema = defId<DeckDefId>();
export const machineDefIdSchema = defId<MachineDefId>();
export const itemDefIdSchema = defId<ItemDefId>();
export const crewDefIdSchema = defId<CrewDefId>();
export const portDefIdSchema = defId<PortDefId>();
export const traitDefIdSchema = defId<TraitDefId>();
export const scenarioDefIdSchema = defId<ScenarioDefId>();
export const dockDefIdSchema = defId<DockDefId>();
export const activityDefIdSchema = defId<ActivityDefId>();
export const topicDefIdSchema = defId<TopicDefId>();

/** Keys local to one def (compartment, fault, zone keys). */
export const localKeySchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/);

export const nonNegative = z.number().min(0);
export const unitInterval = z.number().min(0).max(1);
export const positive = z.number().gt(0);
export const nonNegativeInt = z.number().int().min(0);
export const positiveInt = z.number().int().min(1);

export const tileCoordSchema = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
}) satisfies z.ZodType<TileCoord>;

export const edgeSideSchema = z.enum(["n", "e", "s", "w"]);

export const tileEdgeSchema = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
  side: edgeSideSchema,
}) satisfies z.ZodType<TileEdge>;

export const rotationSchema = z.union([
  z.literal(0),
  z.literal(90),
  z.literal(180),
  z.literal(270),
]);

// Closed vocabularies ---------------------------------------------------------------------------

export const skillIdSchema = z.enum([
  "engineering",
  "electrical",
  "piloting",
  "cargo",
  "medical",
  "cooking",
]);
export const roleTagSchema = z.enum([
  "captain",
  "firstOfficer",
  "engineer",
  "pilot",
  "deckhand",
  "cook",
  "medic",
]);
export const itemTagSchema = z.enum([
  "tool",
  "consumable",
  "food",
  "spare",
  "cargo",
  "medical",
  "container",
  "personal",
  "provisions",
  "meal",
  "book",
  "instrument",
  "treat",
]);
export const toolKindSchema = z.enum([
  "wrench",
  "multimeter",
  "welder",
  "diagnosticScanner",
  "handTruck",
  "mop",
]);
export const cargoClassSchema = z.enum(["general", "fragile", "perishable", "hazardous"]);
export const machineTagSchema = z.enum([
  "bed",
  "medBed",
  "stove",
  "messTable",
  "pilotStation",
  "navStation",
  "opsStation",
  "chair",
  "desk",
  "gamesTable",
  "vidScreen",
  "exerciseRig",
  "workbench",
  "console",
  "engine",
  "generator",
  "battery",
  "lifeSupport",
  "cooling",
  "rampControl",
]);
export const powerPrioritySchema = z.enum([
  "lifeSupport",
  "criticalCooling",
  "propulsion",
  "domestic",
  "cargo",
]);
export const recipeActionSchema = z.enum([
  "inspect",
  "diagnose",
  "repair",
  "removeComponent",
  "installComponent",
  "test",
]);
/** D72: hull size classes (sim `HULL_SIZE_CLASSES`). */
export const hullSizeClassSchema = z.enum(["S", "M", "L"]);
/** D79, D81, D82: the thoughts the sim raises (sim `THOUGHT_KEYS`). */
export const thoughtKeySchema = z.enum([
  "stoodLongWatch",
  "doubleWatch",
  "helmCleanPass",
  "helmScrape",
  "ateWell",
  "burntDinner",
  "ateRationPack",
  "ateInDirtyMess",
  "ateInFilthyMess",
  "wonContest",
  "lostContest",
  "keepsBeatingMe",
  "goodCompany",
  "spiritedTalk",
  "argued",
  "gotLectured",
  "enjoyedMusic",
  "hatedTheNoise",
  "sparringBruise",
  "ownCabin",
  "noisyBunkroom",
  "noBunkOfMyOwn",
  "satWithTheCaptain",
  "heardOut",
  "dressedDown",
  "ateATreat",
]);
/** D88: what one person remembers about another (sim `MEMORY_KEYS`). */
export const memoryKeySchema = z.enum([
  "chatted",
  "rubbedWrong",
  "goodTime",
  "beatMe",
  "keepsBeatingMe",
  "goodTalk",
  "argued",
  "playedForMe",
  "sharedATable",
  "heardMeOut",
  "dressedMeDown",
  "talkedItThrough",
]);
export const traitModifierSchema = z.enum([
  "hungerRate",
  "fatigueRate",
  "comfortRate",
  "socialRate",
  "workSpeed",
  "walkSpeed",
  "recreationRate",
]);
/** Slice 4: what people like doing off watch (sim `INTEREST_TAGS`). */
export const interestTagSchema = z.enum([
  "cards",
  "boardgames",
  "vids",
  "debate",
  "music",
  "exercise",
  "sparring",
  "reading",
  "tinkering",
  "cooking",
  "stargazing",
  "gossip",
]);
/** Slice 4: how an activity ends (sim `ACTIVITY_OUTCOMES`). */
export const activityOutcomeSchema = z.enum(["contest", "bond", "debate", "perform", "none"]);
/** Slice 4: problem kinds an activity may be blocked by (sim `ProblemKind`). */
export const problemKindSchema = z.enum([
  "machineSymptom",
  "machineFault",
  "maintenanceDue",
  "cargoToLoad",
  "cargoToUnload",
  "stationToStaff",
  "courseToPlot",
  "partsNeeded",
  "reserveLow",
  "mealToCook",
  "mealToCarry",
  "compartmentDirty",
]);

export const skillLevelsSchema = z.partialRecord(
  skillIdSchema,
  z.number().min(0).max(10),
) satisfies z.ZodType<SkillLevels>;

export const skillRequirementSchema = z.strictObject({
  skill: skillIdSchema,
  min: z.number().min(0).max(10),
});

export const itemCountSchema = z.strictObject({
  itemDefId: itemDefIdSchema,
  count: positiveInt,
});

// Drift guards: each must resolve to `true`.
export const VOCABULARY_IN_SYNC: [
  AssertEqual<z.infer<typeof skillIdSchema>, SkillId>,
  AssertEqual<z.infer<typeof roleTagSchema>, RoleTag>,
  AssertEqual<z.infer<typeof itemTagSchema>, ItemTag>,
  AssertEqual<z.infer<typeof toolKindSchema>, ToolKind>,
  AssertEqual<z.infer<typeof cargoClassSchema>, CargoClass>,
  AssertEqual<z.infer<typeof machineTagSchema>, MachineTag>,
  AssertEqual<z.infer<typeof powerPrioritySchema>, PowerPriority>,
  AssertEqual<z.infer<typeof recipeActionSchema>, RecipeActionKind>,
  AssertEqual<z.infer<typeof traitModifierSchema>, TraitModifierKey>,
  AssertEqual<z.infer<typeof hullSizeClassSchema>, HullSizeClass>,
  AssertEqual<z.infer<typeof thoughtKeySchema>, ThoughtKey>,
  AssertEqual<z.infer<typeof memoryKeySchema>, MemoryKey>,
  AssertEqual<z.infer<typeof interestTagSchema>, InterestTag>,
  AssertEqual<z.infer<typeof activityOutcomeSchema>, ActivityOutcome>,
  AssertEqual<z.infer<typeof problemKindSchema>, ProblemKind>,
] = [true, true, true, true, true, true, true, true, true, true, true, true, true, true, true];
