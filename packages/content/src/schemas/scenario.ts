/** `ScenarioDef` schema. */
import type { ScenarioDef } from "@crew/sim";
import { z } from "zod";
import {
  crewDefIdSchema,
  deckDefIdSchema,
  itemDefIdSchema,
  localKeySchema,
  nonNegativeInt,
  portDefIdSchema,
  positiveInt,
  scenarioDefIdSchema,
} from "./primitives";

/**
 * D77: the watch bill. Structure here (at least one section, distinct keys, nobody listed twice
 * across sections and dayworkers); that every member is in the scenario's crew is L2, and the
 * section count against `config.time.watchesPerDay` and a qualified helm-stander per section L3.
 */
const watchBillSchema = z
  .strictObject({
    sections: z
      .array(z.strictObject({ key: localKeySchema, members: z.array(crewDefIdSchema) }))
      .min(1),
    dayworkers: z.array(crewDefIdSchema),
  })
  .superRefine((bill, ctx) => {
    const keys = new Set<string>();
    bill.sections.forEach((section, i) => {
      if (keys.has(section.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["sections", i, "key"],
          message: `duplicate section key "${section.key}"`,
        });
      }
      keys.add(section.key);
    });
    const listed = new Set<string>();
    const once = (id: string, path: (string | number)[]) => {
      if (listed.has(id)) {
        ctx.addIssue({ code: "custom", path, message: `"${id}" is listed twice in the bill` });
      }
      listed.add(id);
    };
    bill.sections.forEach((section, i) => {
      section.members.forEach((id, j) => once(id, ["sections", i, "members", j]));
    });
    bill.dayworkers.forEach((id, j) => once(id, ["dayworkers", j]));
  });

export const scenarioDefSchema = z.strictObject({
  id: scenarioDefIdSchema,
  name: z.string().min(1),
  deckId: deckDefIdSchema,
  startPortId: portDefIdSchema,
  crew: z.array(crewDefIdSchema).min(1),
  startingMoney: nonNegativeInt,
  startingItems: z.array(
    z.strictObject({ itemDefId: itemDefIdSchema, count: positiveInt, zoneKey: localKeySchema }),
  ),
  initialFaults: z.array(
    z.strictObject({ placementKey: localKeySchema, faultKey: localKeySchema }),
  ),
  watchBill: watchBillSchema.exactOptional(),
}) satisfies z.ZodType<ScenarioDef>;
