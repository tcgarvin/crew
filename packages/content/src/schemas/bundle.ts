/** `ContentBundle` schema: every table keyed by definition ID. */
import type { ContentBundle } from "@crew/sim";
import { z } from "zod";
import { activityDefSchema } from "./activity";
import { configDefSchema } from "./config";
import { crewDefSchema, traitDefSchema } from "./crew";
import { deckDefSchema } from "./deck";
import { dockDefSchema } from "./dock";
import { itemDefSchema } from "./item";
import { machineDefSchema } from "./machine";
import { peopleTableDefSchema } from "./people";
import { portDefSchema } from "./port";
import {
  activityDefIdSchema,
  crewDefIdSchema,
  deckDefIdSchema,
  dockDefIdSchema,
  itemDefIdSchema,
  machineDefIdSchema,
  portDefIdSchema,
  scenarioDefIdSchema,
  topicDefIdSchema,
  traitDefIdSchema,
} from "./primitives";
import { scenarioDefSchema } from "./scenario";
import { thoughtDefSchema } from "./thought";
import { topicDefSchema } from "./topic";

export const contentBundleSchema = z.strictObject({
  decks: z.record(deckDefIdSchema, deckDefSchema),
  machines: z.record(machineDefIdSchema, machineDefSchema),
  items: z.record(itemDefIdSchema, itemDefSchema),
  crew: z.record(crewDefIdSchema, crewDefSchema),
  traits: z.record(traitDefIdSchema, traitDefSchema),
  ports: z.record(portDefIdSchema, portDefSchema),
  scenarios: z.record(scenarioDefIdSchema, scenarioDefSchema),
  /**
   * §issuers-and-pitches: required for authored content; the sim type is optional for hand-built
   * test bundles.
   */
  people: peopleTableDefSchema,
  /** Dockside §3: required for authored content (it may be empty); optional in the sim type. */
  docks: z.record(dockDefIdSchema, dockDefSchema),
  /** §thoughts: every thought key, each with its def (a missing one fails here). */
  thoughts: z.strictObject({
    stoodLongWatch: thoughtDefSchema,
    doubleWatch: thoughtDefSchema,
    helmCleanPass: thoughtDefSchema,
    helmScrape: thoughtDefSchema,
    ateWell: thoughtDefSchema,
    burntDinner: thoughtDefSchema,
    ateRationPack: thoughtDefSchema,
    ateInDirtyMess: thoughtDefSchema,
    ateInFilthyMess: thoughtDefSchema,
    wonContest: thoughtDefSchema,
    lostContest: thoughtDefSchema,
    keepsBeatingMe: thoughtDefSchema,
    goodCompany: thoughtDefSchema,
    spiritedTalk: thoughtDefSchema,
    argued: thoughtDefSchema,
    gotLectured: thoughtDefSchema,
    enjoyedMusic: thoughtDefSchema,
    hatedTheNoise: thoughtDefSchema,
    sparringBruise: thoughtDefSchema,
    ownCabin: thoughtDefSchema,
    noisyBunkroom: thoughtDefSchema,
    noBunkOfMyOwn: thoughtDefSchema,
    satWithTheCaptain: thoughtDefSchema,
    heardOut: thoughtDefSchema,
    dressedDown: thoughtDefSchema,
    ateATreat: thoughtDefSchema,
    nearMiss: thoughtDefSchema,
    killedSomeone: thoughtDefSchema,
    sawCrewHurt: thoughtDefSchema,
    heldTheLine: thoughtDefSchema,
    ranFromAFight: thoughtDefSchema,
    wounded: thoughtDefSchema,
    worriedAbout: thoughtDefSchema,
    grieving: thoughtDefSchema,
    shaken: thoughtDefSchema,
    heartened: thoughtDefSchema,
  }),
  /** Slice 4: the off-watch activities and the debate topics, keyed by id. */
  activities: z.record(activityDefIdSchema, activityDefSchema),
  topics: z.record(topicDefIdSchema, topicDefSchema),
  config: configDefSchema,
  /** Cache-busting fingerprint of the canonical bundle, filled in by `loader.ts` (D4/D13). */
  hash: z.string(),
}) satisfies z.ZodType<ContentBundle>;
