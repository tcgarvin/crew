/** `ContentBundle` schema: every table keyed by definition ID. */
import type { ContentBundle } from "@crew/sim";
import { z } from "zod";
import { configDefSchema } from "./config";
import { crewDefSchema, traitDefSchema } from "./crew";
import { deckDefSchema } from "./deck";
import { dockDefSchema } from "./dock";
import { itemDefSchema } from "./item";
import { machineDefSchema } from "./machine";
import { peopleTableDefSchema } from "./people";
import { portDefSchema } from "./port";
import {
  crewDefIdSchema,
  deckDefIdSchema,
  dockDefIdSchema,
  itemDefIdSchema,
  machineDefIdSchema,
  portDefIdSchema,
  scenarioDefIdSchema,
  traitDefIdSchema,
} from "./primitives";
import { scenarioDefSchema } from "./scenario";
import { thoughtDefSchema } from "./thought";

export const contentBundleSchema = z.strictObject({
  decks: z.record(deckDefIdSchema, deckDefSchema),
  machines: z.record(machineDefIdSchema, machineDefSchema),
  items: z.record(itemDefIdSchema, itemDefSchema),
  crew: z.record(crewDefIdSchema, crewDefSchema),
  traits: z.record(traitDefIdSchema, traitDefSchema),
  ports: z.record(portDefIdSchema, portDefSchema),
  scenarios: z.record(scenarioDefIdSchema, scenarioDefSchema),
  /** D25: required for authored content; the sim type is optional for hand-built test bundles. */
  people: peopleTableDefSchema,
  /** Dockside §3: required for authored content (it may be empty); optional in the sim type. */
  docks: z.record(dockDefIdSchema, dockDefSchema),
  /** D79: every thought key, each with its def (a missing one fails here). */
  thoughts: z.strictObject({
    stoodLongWatch: thoughtDefSchema,
    doubleWatch: thoughtDefSchema,
    helmCleanPass: thoughtDefSchema,
    helmScrape: thoughtDefSchema,
  }),
  config: configDefSchema,
  /** Cache-busting fingerprint of the canonical bundle, filled in by `loader.ts` (D4/D13). */
  hash: z.string(),
}) satisfies z.ZodType<ContentBundle>;
