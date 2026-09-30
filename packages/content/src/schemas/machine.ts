/** `MachineDef` schema. Fault/recipe cross-references (items, tools) are checked at L2. */
import type { MachineDef, RecipeStep } from "@crew/sim";
import { z } from "zod";
import {
  itemCountSchema,
  itemDefIdSchema,
  localKeySchema,
  machineDefIdSchema,
  machineTagSchema,
  nonNegative,
  positive,
  positiveInt,
  powerPrioritySchema,
  recipeActionSchema,
  skillRequirementSchema,
  tileCoordSchema,
  toolKindSchema,
  unitInterval,
} from "./primitives";

const purposeSchema = z.enum(["operate", "repair", "use"]);

export const recipeStepSchema = z.strictObject({
  key: localKeySchema,
  action: recipeActionSchema,
  workSeconds: positive,
  skill: skillRequirementSchema.exactOptional(),
  tools: z.array(toolKindSchema),
  consumes: z.array(itemCountSchema),
  at: purposeSchema,
}) satisfies z.ZodType<RecipeStep>;

export const machinePowerDefSchema = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("none") }),
  z.strictObject({
    role: z.literal("consumer"),
    drawKw: positive,
    priority: powerPrioritySchema,
    partialPower: z.enum(["derate", "off"]),
  }),
  z.strictObject({ role: z.literal("generator"), supplyKw: positive }),
  z.strictObject({
    role: z.literal("battery"),
    capacityKj: positive,
    maxChargeKw: positive,
    maxDischargeKw: positive,
  }),
]);

export const faultEffectSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("inoperable") }),
  z.strictObject({ kind: z.literal("derate"), outputFactor: unitInterval }),
  z.strictObject({ kind: z.literal("overheat"), extraRisePerSecond: positive }),
]);

export const faultDefSchema = z.strictObject({
  key: localKeySchema,
  name: z.string().min(1),
  weight: positive,
  effect: faultEffectSchema,
  symptom: z.strictObject({
    key: localKeySchema,
    channel: z.enum(["visual", "audible", "sensor"]),
  }),
  repair: z.strictObject({ steps: z.array(recipeStepSchema).min(1) }),
});

export const machineDefSchema = z.strictObject({
  id: machineDefIdSchema,
  name: z.string().min(1),
  tags: z.array(machineTagSchema),
  footprint: z.array(tileCoordSchema).min(1),
  interactionPositions: z.array(
    z.strictObject({
      key: localKeySchema,
      offset: tileCoordSchema,
      purposes: z.array(purposeSchema).min(1),
      capacity: positiveInt,
    }),
  ),
  power: machinePowerDefSchema,
  heat: z.strictObject({
    risePerSecond: nonNegative,
    coolPerSecond: nonNegative,
    derateAbove: unitInterval,
  }),
  operation: z.strictObject({
    requiresOperator: z.boolean(),
    operatorSkill: skillRequirementSchema.exactOptional(),
  }),
  failure: z.strictObject({
    baseHazardPerSecond: nonNegative,
    heatFactor: nonNegative,
    wearPerSecond: nonNegative,
  }),
  faults: z.array(faultDefSchema),
  components: z.array(z.strictObject({ slot: localKeySchema, itemDefId: itemDefIdSchema })),
  maintenance: z
    .strictObject({
      intervalSeconds: positive,
      inspect: recipeStepSchema,
      conditionRestored: unitInterval,
    })
    .exactOptional(),
}) satisfies z.ZodType<MachineDef>;
