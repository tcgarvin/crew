/**
 * The structured-output schema for one call: W0's `buildNarratorPlanSchema` over this game's
 * vocabulary, plus its JSON Schema form for `output_config.format`.
 */
import { z } from "zod";
import {
  type NarratorPlanSchema,
  type NarratorVocabulary,
  buildNarratorPlanSchema,
} from "./contract";

export function planSchemaFor(vocab: NarratorVocabulary): NarratorPlanSchema {
  return buildNarratorPlanSchema(vocab);
}

/** JSON Schema for the API. `$schema` is dropped: the API wants the bare schema object. */
export function planJsonSchema(schema: NarratorPlanSchema): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  return rest;
}
