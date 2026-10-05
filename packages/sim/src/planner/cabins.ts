/**
 * The summons candidate (slice 4, call 15): a pending `privateTalk` (`self.summons`) makes a
 * `privateTalk` personal candidate at `essentialOperation` for both the caller and the one called
 * in: it interrupts cards, rounds and rest, not the helm (same class). Rejected `notAboard` when
 * the summons names someone not on the roster, `backoff` after a failed walk, and
 * `unreachableTarget` when the schematic has no way into the cabin.
 *
 * The estimate is the walk to the cabin's desk seat (else its first floor tile); the talk's own
 * length is the same for every way of answering, so it is left out.
 *
 * Owner: W3 of ship life slice 4.
 */
import type { TileCoord } from "../core/types/common";
import type { CompartmentId } from "../core/types/ids";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView } from "../core/types/view";
import type { Candidate, Rejection } from "./candidates";
import { backingOff, personal } from "./common";

const REF = "privateTalk";

/** Where in `cabin` the walk is measured to: the desk's seat, else its first floor tile. */
function cabinTile(view: AgentView, cabin: CompartmentId): TileCoord | undefined {
  const { schematic } = view;
  for (const machine of schematic.amenities("desk")) {
    const at = machine.footprint[0];
    if (at === undefined || schematic.compartmentAt(at) !== cabin) continue;
    const seat = machine.interactionTiles.find((t) => t.purposes.includes("use"));
    if (seat !== undefined) return seat.tile;
  }
  const deck = schematic.deck;
  for (let y = 0; y < deck.height; y++) {
    for (let x = 0; x < deck.width; x++) {
      const tile = { x, y };
      if (schematic.isFloor(tile) && schematic.compartmentAt(tile) === cabin) return tile;
    }
  }
  return undefined;
}

export function summonsCandidate(
  view: AgentView,
  _config: PlannerConfig,
): Candidate | Rejection | undefined {
  const summons = view.self.summons;
  if (summons === undefined) return undefined;
  if (!view.roster().some((entry) => entry.actorId === summons.withActorId)) {
    return { ref: REF, reason: "notAboard" };
  }
  if (backingOff(view, REF)) return { ref: REF, reason: "backoff" };
  const tile = cabinTile(view, summons.compartmentId);
  const ticks = tile === undefined ? null : view.estimateTravelTicks(tile);
  if (ticks === null) return { ref: REF, reason: "unreachableTarget" };
  return personal(REF, "essentialOperation", ticks, view.tick, {
    kind: "personal",
    activity: "privateTalk",
    targetId: summons.withActorId,
  });
}
