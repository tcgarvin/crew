/**
 * Seats (slice 4, call 11): which free mess seat an eater takes (`systems/galley/eat.ts`
 * `eatPlan` passes them all), and the captain's table.
 *
 * `seatPreference(ctx, actor, seats)`: `seats` are the free mess seats, nearest the food first,
 * with the one the actor already holds (if any) first of all and marked `held`; seats spoken for
 * by someone else's plan are already left out. The choice: a held seat stays; else a seat
 * adjacent to someone the actor has affinity above `social.preferAbove` with; never one adjacent
 * to someone at or below `social.avoidBelow`; else the nearest. Once a ship's day
 * (`social.captainsTableDay`), the captain's seat is the one beside the crew member at the tables
 * with the highest affinity (even days) or the lowest (odd days): both +1, the crew member
 * `satWithTheCaptain`, `captainsTable` (trace).
 *
 * Owner: W2 of ship life slice 4. Gate stub: the first seat (today's nearest-first rule).
 */
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { LocalKey, MachineId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";

/** A free mess seat: the `use` position to walk to, and its tile. */
export interface SeatOption {
  readonly target: { readonly machineId: MachineId; readonly positionKey: LocalKey };
  readonly tile: TileCoord;
  /** The actor already holds it (standing on it, or walking to it). */
  readonly held: boolean;
}

export function seatPreference(
  _ctx: StepCtx,
  _actor: Actor,
  seats: readonly SeatOption[],
): SeatOption | undefined {
  return seats[0];
}
