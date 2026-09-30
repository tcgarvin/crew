/** `ContentBundle` schema: every table keyed by definition ID. */
import type { ContentBundle } from "@crew/sim";
import { z } from "zod";
import { configDefSchema } from "./config";
import { crewDefSchema, traitDefSchema } from "./crew";
import { deckDefSchema } from "./deck";
import { itemDefSchema } from "./item";
import { machineDefSchema } from "./machine";
import { portDefSchema } from "./port";
import {
  crewDefIdSchema,
  deckDefIdSchema,
  itemDefIdSchema,
  machineDefIdSchema,
  portDefIdSchema,
  scenarioDefIdSchema,
  traitDefIdSchema,
} from "./primitives";
import { scenarioDefSchema } from "./scenario";

export const contentBundleSchema = z.strictObject({
  decks: z.record(deckDefIdSchema, deckDefSchema),
  machines: z.record(machineDefIdSchema, machineDefSchema),
  items: z.record(itemDefIdSchema, itemDefSchema),
  crew: z.record(crewDefIdSchema, crewDefSchema),
  traits: z.record(traitDefIdSchema, traitDefSchema),
  ports: z.record(portDefIdSchema, portDefSchema),
  scenarios: z.record(scenarioDefIdSchema, scenarioDefSchema),
  config: configDefSchema,
  /** SHA-256 hex of the canonical bundle, filled in by the bundle compiler. */
  hash: z.string(),
}) satisfies z.ZodType<ContentBundle>;
