/**
 * Mechanical authority allow-list (D6, review §D.3): which command kinds each source may issue.
 * The kernel rejects anything else with `unauthorized` before validation. This is data the kernel
 * checks, not a prompt instruction.
 */
import type { Command, CommandEnvelope, CommandKind, CommandSource } from "./index";

/**
 * The V1 narrator vocabulary, exactly (PLAN §6 W9). Nothing here can set a body, need, position,
 * knowledge or money directly; no such command exists. D47 (owner-approved vocabulary change,
 * D6/D11): `stockMarket` sets what a port sells, never what the ship has or owes. D78: the sixth
 * lever, `scheduleHazard`, places a piloting check the sim rolls; it never decides the outcome.
 * D92: the seventh, `scheduleField`, places an asteroid field; the sim rolls the impacts, and the
 * narrator's scripted ones can never alone sink the ship. D99: the eighth, `requestCall`, asks
 * when the narrator is called next; it changes nothing in the world.
 */
export const NARRATOR_COMMAND_KINDS = [
  "offerJob",
  "spawnAtBoundary",
  "scheduleFault",
  "surfaceDecision",
  "stockMarket",
  "stageDock",
  "scheduleHazard",
  "scheduleField",
  "requestCall",
] as const satisfies readonly CommandKind[];

export type NarratorCommandKind = (typeof NARRATOR_COMMAND_KINDS)[number];

/**
 * D66 (owner ruling D57, Dockside §6.1): the staging call sets the stage and never moves the
 * plot. These kinds are valid from the narrator only while a `stageDock` hook is pending, and
 * while one is, they are the only narrator kinds the kernel accepts (`hookWindowRejection`,
 * `core/commands.ts`). A staging-only kind is never valid in answer to a story hook.
 */
export const STAGING_COMMAND_KINDS = [
  "stageDock",
] as const satisfies readonly NarratorCommandKind[];

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
    "endPassage",
    /** Slice 4: a card side's word in the captain's cabin (never the narrator's directly). */
    "privateTalk",
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
    "endPassage",
    "privateTalk",
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
    "endPassage",
    "stageDock",
    "scheduleHazard",
    "privateTalk",
    "scheduleField",
    "requestCall",
  ],
};
