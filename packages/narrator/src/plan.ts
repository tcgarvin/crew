/**
 * The JSON Schema form of a plan schema (W0's `buildNarratorPlanSchema`, or the staging plan's).
 * D45: the schema is the same for every game; ids are plain strings the translator validates
 * against the snapshot and content.
 */
import { z } from "zod";

/**
 * JSON Schema for the prompt (D53): the story plan's, or the staging plan's (D67). `$schema` is
 * dropped: the API wants the bare schema object.
 */
export function planJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return rest;
}
