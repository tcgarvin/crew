/**
 * Command perspective (D8): the captain, or the first officer when the captain is asleep or
 * incapacitated. Lives in core so the kernel's own decision code (`surfaceDecision`'s default
 * perspective, D70's in-person delivery) and the systems (`systems/travel/roster.ts` re-exports
 * it) share one rule; it used to be written out twice because core may not import systems.
 */
import type { Actor } from "./types/actor";
import type { DeepReadonly } from "./types/common";
import type { ActorId } from "./types/ids";
import type { WorldState } from "./types/state";

type ActorTable = { readonly actors: DeepReadonly<WorldState["actors"]> };

/** True when an actor is asleep right now (sleeping is an activity, not an `Availability`). */
function isAsleepNow(activity: DeepReadonly<Actor["activity"]>): boolean {
  return activity.kind === "personal" && activity.activity === "sleep";
}

/**
 * D63/D70: out through the dock's gate on an errand (a `throughGate` step): off ship, but only
 * just. Mirrors `systems/work/activity.ts` `isOutThroughGate` (core may not import systems).
 */
function outThroughGate(actor: DeepReadonly<Pick<Actor, "availability" | "activity">>): boolean {
  const activity = actor.activity;
  if (actor.availability !== "offShip" || activity.kind === "idle") return false;
  const plan = activity.plan;
  return plan !== undefined && plan.steps[plan.stepIndex]?.kind === "throughGate";
}

/**
 * D8: an actor cannot act as the command perspective while incapacitated, off ship or asleep.
 * D70: a captain out through the gate (to see someone, or on a market errand) is still fit for
 * command: going ashore does not hand the ship to the first officer (dockside §6.2).
 */
export function isFitForCommand(
  actor: DeepReadonly<Pick<Actor, "availability" | "activity">>,
): boolean {
  const present = actor.availability === "available" || outThroughGate(actor);
  return present && !isAsleepNow(actor.activity);
}

/**
 * The actor whose perspective decisions and hooks are framed from: the captain, or the first
 * officer when the captain is unfit (D8). Falls back to the captain (even if unfit) when no first
 * officer exists, and throws only if the ship has neither, which is a content bug.
 */
export function commandActor(state: ActorTable): ActorId {
  const actors = Object.values(state.actors);
  const captain = actors.find((a) => a.roleTags.includes("captain"));
  if (captain === undefined) {
    throw new Error("commandActor: no crew member has the captain role tag");
  }
  if (isFitForCommand(captain)) return captain.id;
  const firstOfficer = actors.find((a) => a.roleTags.includes("firstOfficer"));
  return firstOfficer?.id ?? captain.id;
}
