/**
 * `PeopleTableDef` schema (§issuers-and-pitches): the name table the deterministic job source draws
 * issuers from.
 */
import type { PeopleTableDef } from "@crew/sim";
import { z } from "zod";
import { cargoClassSchema, portDefIdSchema } from "./primitives";

const PLACEHOLDERS = ["cargo", "from", "to"];

/**
 * A pitch line: dialogue, no digits (§cards-never-mention-pay: no pay, no numbers on cards), and
 * only the placeholders the job source fills.
 */
const pitchSchema = z
  .string()
  .min(1)
  .refine(
    (line) => !/\d/.test(line),
    "pitch lines must not contain numbers (§cards-never-mention-pay)",
  )
  .refine(
    (line) => [...line.matchAll(/\{(\w+)\}/g)].every((m) => PLACEHOLDERS.includes(m[1] ?? "")),
    `pitch placeholders are limited to ${PLACEHOLDERS.map((p) => `{${p}}`).join(", ")}`,
  );

const nameList = z.array(z.string().min(1)).min(1);

export const peopleTableDefSchema = z.strictObject({
  givenNames: nameList,
  familyNames: nameList,
  pitches: z.array(pitchSchema).min(1),
  cargoWords: z.record(cargoClassSchema, z.string().min(1)),
  ports: z.record(
    portDefIdSchema,
    z.strictObject({
      roles: nameList,
      orgs: nameList,
      pitches: z.array(pitchSchema),
    }),
  ),
}) satisfies z.ZodType<PeopleTableDef>;
