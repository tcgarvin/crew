/**
 * Mechanical authority allow-list (D6, review §D.3): which command kinds each source may issue.
 * The kernel rejects anything else with `unauthorized` before validation. This is data the kernel
 * checks, not a prompt instruction.
 */
import type { Command, CommandEnvelope, CommandKind, CommandSource } from "./index";

/**
 * The narrator vocabulary, exactly (PLAN §6 W9). No command writes a body, need, position,
 * knowledge or money as raw state: each goes through the sim's own entry point. §market-lever (owner-approved vocabulary
 * change, D6): `stockMarket` sets what a port sells, never what the ship has or owes.
 * §debris-fields-and-ion-storms: the sixth lever, `scheduleHazard`, places a piloting check the sim
 * rolls; it never decides the outcome. §hazard-and-field-levers: the seventh, `scheduleField`,
 * places an asteroid field; the sim rolls the impacts, and the narrator's scripted ones can never
 * alone sink the ship. §requested-call-back: the eighth, `requestCall`, asks when the narrator is
 * called next; it changes nothing in the world. D105: `markUnseen` marks one side of a pending
 * arrival card as the way in unseen; the player still chooses, and the sim runs the fight.
 * D106 (§outcome-levers): the narrator may decide outcomes, so `strike` wounds a person through
 * the one damage entry point (the body rules say whether they go down or die) and `transact` moves
 * the ship's money; each is refused only when it is impossible. `plantMemory`, `fallOut` and
 * `giveThought` reach who feels what about whom through the social system's memories and the
 * thoughts (§memory-levers, §thought-and-reveal-levers), `reveal` lets the crew notice a fault, and
 * `injectFault` breaks a machine now (§forced-faults-and-hazards).
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
  "markUnseen",
  "strike",
  "transact",
  "plantMemory",
  "fallOut",
  "giveThought",
  "reveal",
  "injectFault",
] as const satisfies readonly CommandKind[];

export type NarratorCommandKind = (typeof NARRATOR_COMMAND_KINDS)[number];

/**
 * §staging-plan-command (owner ruling D57, Dockside §6.1): the staging call sets the stage and
 * never moves the plot. These kinds are valid from the narrator only while a `stageDock` hook is
 * pending, and while one is, they are the only narrator kinds the kernel accepts
 * (`hookWindowRejection`, `core/commands.ts`). A staging-only kind is never valid in answer to a
 * story hook.
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
    /** Expeditions A1: A2's card sides at the site; nothing issues them yet. */
    "adoptPlan",
    "withdrawParty",
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
    "scenarioStartExpedition",
    "adoptPlan",
    "withdrawParty",
    "markUnseen",
    "strike",
    "transact",
    "plantMemory",
    "fallOut",
    "giveThought",
    "reveal",
    "injectFault",
  ],
};
