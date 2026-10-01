/**
 * The structured-output schema for one call: W0's `buildNarratorPlanSchema`, plus its JSON
 * Schema form for `output_config.format`. D45: the schema is the same for every game; ids are
 * plain strings the translator validates against the snapshot and content.
 */
import { z } from "zod";
import { type NarratorPlanSchema, buildNarratorPlanSchema } from "./contract";

export function planSchemaFor(): NarratorPlanSchema {
  return buildNarratorPlanSchema();
}

/** JSON Schema for the API. `$schema` is dropped: the API wants the bare schema object. */
export function planJsonSchema(schema: NarratorPlanSchema): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return rest;
}
