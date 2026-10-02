/**
 * Mechanical authority allow-list (D6, review §D.3): which command kinds each source may issue.
 * The kernel rejects anything else with `unauthorized` before validation. This is data the kernel
 * checks, not a prompt instruction.
 */
import type { Command, CommandEnvelope, CommandKind, CommandSource } from "./index";

/**
 * The V1 narrator vocabulary, exactly (PLAN §6 W9). Nothing here can set a body, need, position,
 * knowledge or money directly; no such command exists. D47 (owner-approved vocabulary change,
 * D6/D11): `stockMarket` sets what a port sells, never what the ship has or owes.
 */
export const NARRATOR_COMMAND_KINDS = [
  "offerJob",
  "spawnAtBoundary",
  "scheduleFault",
  "surfaceDecision",
  "stockMarket",
] as const satisfies readonly CommandKind[];

export type NarratorCommandKind = (typeof NARRATOR_COMMAND_KINDS)[number];

/** Commands the narrator may send. A strict subset of `Command`, always with source `narrator`. */
export type NarratorCommand = {
  [K in NarratorCommandKind]: CommandEnvelope<K> & { readonly source: "narrator" };
}[NarratorCommandKind];

/** Compile-time check that every narrator command is a kernel command. */
export type NarratorCommandIsCommand = NarratorCommand extends Command ? true : never;

/**
 * W0 decision: `system` covers the deterministic job source, policy decisions and the host's
 * `acknowledgeHook`; `scenario` may issue everything including narrator kinds, for fixtures.
 */
export const AUTHORITY: Readonly<Record<CommandSource, readonly CommandKind[]>> = {
  /** D14: the player acts only at hooks; option commands of a chosen decision run as `player`. */
  player: [
    "resolveDecision",
    "acceptContract",
    "declineJob",
    "setCourse",
    "holdDepartureForRepairs",
    "acceptDepartureRisk",
  ],
  narrator: NARRATOR_COMMAND_KINDS,
  system: [
    "offerJob",
    "surfaceDecision",
    "acknowledgeHook",
    "acceptContract",
    "declineJob",
    "setCourse",
    "holdDepartureForRepairs",
    "acceptDepartureRisk",
  ],
  scenario: [
    "scenarioSpawn",
    "scenarioInjectFault",
    "scenarioSetNeeds",
    "offerJob",
    "acceptContract",
    "setCourse",
    "scheduleFault",
    "spawnAtBoundary",
    "surfaceDecision",
    "stockMarket",
  ],
};
