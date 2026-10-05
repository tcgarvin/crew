/**
 * Content schemas: Zod 4 schemas for every definition the kernel consumes, each asserted against
 * the sim interface with `satisfies z.ZodType<Def>`, plus their JSON Schema form for editor
 * `$schema` support and tooling.
 */
import { z } from "zod";
import { activityDefSchema } from "./activity";
import { contentBundleSchema } from "./bundle";
import { configDefSchema } from "./config";
import { crewDefSchema, traitDefSchema } from "./crew";
import { deckDefSchema } from "./deck";
import { dockDefSchema } from "./dock";
import { itemDefSchema } from "./item";
import { machineDefSchema } from "./machine";
import { peopleTableDefSchema } from "./people";
import { portDefSchema } from "./port";
import { scenarioDefSchema } from "./scenario";
import { thoughtDefSchema } from "./thought";
import { topicDefSchema } from "./topic";

export * from "./activity";
export * from "./bundle";
export * from "./config";
export * from "./crew";
export * from "./deck";
export * from "./dock";
export * from "./item";
export * from "./machine";
export * from "./people";
export * from "./port";
export * from "./primitives";
export * from "./scenario";
export * from "./thought";
export * from "./topic";
export * from "./validate";
export { HULL_CLASS_BOX, shipAtInBerth } from "./geometry";
export { dockRampLandings, dockWalkableMask } from "./validate-dock";

/** Every def schema by name; the JSON Schema export and tests iterate this. */
export const DEF_SCHEMAS = {
  deck: deckDefSchema,
  machine: machineDefSchema,
  item: itemDefSchema,
  crew: crewDefSchema,
  trait: traitDefSchema,
  port: portDefSchema,
  scenario: scenarioDefSchema,
  people: peopleTableDefSchema,
  config: configDefSchema,
  dock: dockDefSchema,
  thought: thoughtDefSchema,
  activity: activityDefSchema,
  topic: topicDefSchema,
  bundle: contentBundleSchema,
} as const;

export type DefSchemaName = keyof typeof DEF_SCHEMAS;

/** JSON Schema (draft 2020-12) for each def, describing the authored (input) form. */
export function contentJsonSchemas(): Record<DefSchemaName, z.core.JSONSchema.BaseSchema> {
  const out = {} as Record<DefSchemaName, z.core.JSONSchema.BaseSchema>;
  for (const name of Object.keys(DEF_SCHEMAS) as DefSchemaName[]) {
    out[name] = z.toJSONSchema(DEF_SCHEMAS[name], { io: "input" });
  }
  return out;
}
