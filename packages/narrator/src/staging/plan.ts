/**
 * The staging call's output schema (Dockside §6.1, §staging-prompt). Its own schema, not the story
 * plan's: a rationale and a list of three intent kinds that together make one `stageDock` command.
 * It rides in the prompt as JSON Schema, like the story plan (D53), and follows the
 * §narrator-authority rules: ids are plain strings the translator checks, optional text is empty
 * for none, only small fixed sets are enums.
 *
 * `runStaging` parses the reply with `stagingEnvelopeSchema` (the intents unparsed), so a reply
 * that slips in a story intent still parses and the translator drops that intent with a reason
 * instead of the whole call falling back.
 */
import { z } from "zod";

/** Who a placement is (`StagedPersonSpec.kind` in the sim). */
export const STAGED_PERSON_KINDS = ["seed", "cast", "newFace"] as const;
/**
 * A prop's unit count as the model writes it (a digit-string enum, as for `stockMarket`,
 * §market-lever; 1..4 in the kernel).
 */
export const PROP_COUNTS = ["1", "2", "3", "4"] as const;
/** `placeProp.at` for the dock's staging area; anything else is a post key. */
export const STAGING_AREA_SPOT = "staging";

export const STAGING_INTENT_KINDS = ["placePerson", "placeProp", "setAmbience"] as const;
export type StagingIntentKind = (typeof STAGING_INTENT_KINDS)[number];

/** One schema per intent kind, so the translator can say which field of which intent is wrong. */
export function buildStagingIntentSchemas() {
  const placePerson = z.strictObject({
    kind: z.literal("placePerson"),
    who: z
      .enum(STAGED_PERSON_KINDS)
      .describe(
        "seed: one of this port's people; cast: someone in your notes' cast; newFace: someone new.",
      ),
    name: z
      .string()
      .describe("Full name; for a seed or cast member exactly as the digest lists them."),
    role: z.string().describe("What they do, lower case; empty for a seed."),
    look: z.string().describe("newFace only: one line on how they look; otherwise empty."),
    post: z.string().describe("A post key of this dock, from the digest."),
    label: z.string().describe("What they are doing, a few words, present tense; empty for none."),
  });
  const placeProp = z.strictObject({
    kind: z.literal("placeProp"),
    item: z.string().describe("Item id from the catalogue."),
    count: z.enum(PROP_COUNTS),
    at: z
      .string()
      .describe(
        `"${STAGING_AREA_SPOT}" for the staging area, or a post key to set it by that post.`,
      ),
  });
  const setAmbience = z.strictObject({
    kind: z.literal("setAmbience"),
    line: z.string().describe("One sentence for the ship's log as the dock comes alongside."),
  });
  return { placePerson, placeProp, setAmbience } as const;
}

export function buildStagingPlanSchema() {
  const { placePerson, placeProp, setAmbience } = buildStagingIntentSchemas();
  return z.strictObject({
    /** Private: what this arrival sets up, and why. Never shown to the player. */
    rationale: z.string(),
    intents: z.array(z.union([placePerson, placeProp, setAmbience])),
  });
}

export type StagingPlanSchema = ReturnType<typeof buildStagingPlanSchema>;
export type StagingModelPlan = z.infer<StagingPlanSchema>;
export type StagingIntent = StagingModelPlan["intents"][number];

/**
 * What `runStaging` validates the reply against before translation: the same two keys, nothing
 * else, but each intent left as written so the translator can drop a bad one with a reason.
 */
export const stagingEnvelopeSchema = z.strictObject({
  rationale: z.string(),
  intents: z.array(z.unknown()),
});
export type StagingEnvelope = z.infer<typeof stagingEnvelopeSchema>;
