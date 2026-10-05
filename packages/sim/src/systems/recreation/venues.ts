/**
 * Venues (slice 4, call 12): where an activity happens on this deck, from content tags at plan
 * time, against the reservation cache. `ActivityDef.venue` is an ordered list; the first
 * alternative present on the deck wins. A machine venue stands at a `use` position not reserved
 * and not under another member; a zone venue at a zone tile free of actors; a compartment venue
 * at a free floor tile chosen by `loungeTile`'s rule (computed over state); `own` restricts a
 * machine to the actor's berth compartment. With `session`, the session's venue is fixed and a
 * free position of it is taken.
 *
 * Owner: W1 of ship life slice 4. Gate stub: no venue.
 */
import type { Actor } from "../../core/types/actor";
import type { ActivityDef } from "../../core/types/content";
import type { StepCtx } from "../../core/types/pipeline";
import type { GroupSession, SessionVenue } from "../../core/types/state";
import type { StepTarget } from "../../core/types/work";

/** A venue and the spot in it this actor takes. */
export interface ResolvedVenue {
  readonly venue: SessionVenue;
  readonly target: StepTarget;
}

/** Where `actor` would do `def` (joining `session` if given); undefined when nowhere. */
export function resolveVenue(
  _ctx: StepCtx,
  _actor: Actor,
  _def: ActivityDef,
  _session?: GroupSession,
): ResolvedVenue | undefined {
  return undefined;
}
