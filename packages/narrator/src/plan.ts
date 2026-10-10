/**
 * The JSON Schema form of a plan schema (W0's `buildNarratorPlanSchema`, or the staging plan's).
 * §narrator-authority: the schema is the same for every game; ids are plain strings the translator
 * validates against the snapshot and content.
 */
import { z } from "zod";

/**
 * JSON Schema for the prompt (D53): the story plan's, or the staging plan's
 * (§staging-call-on-the-server). `$schema` is dropped: the API wants the bare schema object.
 */
export function planJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return rest;
}

/**
 * The schema block. It depends only on the plan schema, never on the game state, so it stays in
 * the cached static prefix.
 */
export function schemaInstruction(jsonSchema: Readonly<Record<string, unknown>>): string {
  return [
    "Answer with one JSON object and nothing else: no prose, no code fence.",
    "It must validate against this JSON Schema (every property is required):",
    JSON.stringify(jsonSchema),
  ].join("\n");
}
