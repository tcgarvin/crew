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
}) satisfies z.ZodType<ScenarioDef>;
