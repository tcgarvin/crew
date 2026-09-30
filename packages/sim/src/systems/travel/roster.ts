/**
 * Command perspective (D8, PLAN §6 W6 item 6): who the player is currently seeing/acting as.
 * Pure, state-only so both the decisions system and any future AgentView/render code can share it.
 */
import type { Actor } from "../../core/types/actor";
import type { ActorId } from "../../core/types/ids";
import type { ReadonlyWorldState } from "../../core/types/pipeline";

/** True when an actor is asleep right now (sleeping is an activity, not an `Availability`). */
function isAsleep(actor: Pick<Actor, "activity">): boolean {
  return actor.activity.kind === "personal" && actor.activity.activity === "sleep";
}

/** D8: an actor cannot act as the command perspective while incapacitated/dead/off-ship or asleep. */
export function isFitForCommand(actor: Pick<Actor, "availability" | "activity">): boolean {
  return actor.availability === "available" && !isAsleep(actor);
}

/**
 * The actor whose perspective narrator decisions/hooks are framed from: the captain, or the
 * first officer when the captain is asleep or incapacitated (D8). Falls back to the captain (even
 * if unfit) when no first officer exists, and throws only if the ship has neither — a content bug.
 */
export function commandActor(state: ReadonlyWorldState): ActorId {
  const actors = Object.values(state.actors) as Actor[];
  const captain = actors.find((a) => a.roleTags.includes("captain"));
  if (captain === undefined) {
    throw new Error("commandActor: no crew member has the captain role tag");
  }
  if (isFitForCommand(captain)) return captain.id;
  const firstOfficer = actors.find((a) => a.roleTags.includes("firstOfficer"));
  return firstOfficer?.id ?? captain.id;
}
