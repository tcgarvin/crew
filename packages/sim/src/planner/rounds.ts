/**
 * What an on-duty actor with nothing else to do does (D77), voluntary class throughout:
 *
 * - the officer of the watch (`self.watch.officerOfTheWatch`) walks rounds, and between them
 *   goes to the captain's chair's `use` tile and stands there idle: it is not a hold, so anything
 *   the planner finds takes them away at once;
 * - an engineer walks the machine round, and between rounds goes to their post;
 * - everyone else goes to their post (W4a), as before.
 *
 * Between rounds is the `rounds` backoff the sim writes when a round is planned
 * (`systems/watch/rounds.ts`), `watches.roundsEveryDays` from its start.
 *
 * Owner: W2 of ship life slice 2.
 */
import type { TileCoord } from "../core/types/common";
import type { RoleTag } from "../core/types/content";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView } from "../core/types/view";
import type { Candidate, Rejection } from "./candidates";
import { backingOff, compartmentTagged, loungeTile, personal, sameTile } from "./common";

/**
 * W4a decision: where an on-duty actor with nothing better to do waits, by role (first role with
 * a matching compartment tag wins). A vocabulary mapping, not a tunable. Being at one's post is
 * also how an engineer comes to hear a grinding pump.
 */
const POST_TAGS: Readonly<Record<RoleTag, readonly string[]>> = {
  captain: ["bridge"],
  firstOfficer: ["bridge"],
  pilot: ["bridge"],
  engineer: ["engineering"],
  deckhand: ["cargoHold"],
  cook: ["galley"],
  medic: ["infirmary"],
};

/** Mirrors the sim's officer's route (`systems/watch/rounds.ts`), for the first leg's estimate. */
const OFFICER_FIRST_STOP = ["engineering"];

/** The backoff ref the sim writes for the cadence (`ROUNDS_REF` in `systems/watch/rounds.ts`). */
const ROUNDS = "rounds";

const inCompartmentWith = (view: AgentView, tile: TileCoord, symbol: string): boolean =>
  view.schematic.deck.tiles[tile.y]?.[tile.x] === symbol;

function postCandidate(view: AgentView): Candidate | Rejection | undefined {
  const tags = view.self.roleTags.flatMap((role) => POST_TAGS[role]);
  const post = compartmentTagged(view, tags);
  const here = view.self.tile;
  if (post === undefined || here === undefined) return undefined;
  if (inCompartmentWith(view, here, post.symbol)) return undefined;
  if (backingOff(view, "wander")) return { ref: "post", reason: "backoff" };
  const tile = loungeTile(view, tags);
  const ticks = tile === undefined ? null : view.estimateTravelTicks(tile);
  if (tile === undefined || ticks === null) return { ref: "post", reason: "unreachableTarget" };
  return personal("post", "voluntaryActivity", ticks, view.tick, {
    kind: "personal",
    activity: "wander",
    tile,
  });
}

/**
 * The captain's chair's `use` tile: a chair in a `bridge` compartment, else any chair. Absent on
 * a ship without one, where the officer waits at their post instead.
 */
function chairTile(view: AgentView): TileCoord | undefined {
  const deck = view.schematic.deck;
  const bridges = new Set(
    deck.compartments.filter((c) => c.tags.includes("bridge")).map((c) => c.symbol),
  );
  const seats = view.schematic.amenities("chair").flatMap((chair) => {
    const seat = chair.interactionTiles.find((t) => t.purposes.includes("use"));
    return seat === undefined ? [] : [seat.tile];
  });
  const onBridge = seats.find((t) => bridges.has(deck.tiles[t.y]?.[t.x] ?? ""));
  return onBridge ?? seats[0];
}

/** The officer of the watch between rounds: to the chair and no further. */
function chairCandidate(view: AgentView): Candidate | Rejection | undefined {
  const tile = chairTile(view);
  if (tile === undefined) return postCandidate(view);
  const here = view.self.tile;
  if (here !== undefined && sameTile(here, tile)) return undefined;
  if (backingOff(view, "wander")) return { ref: "chair", reason: "backoff" };
  const ticks = view.estimateTravelTicks(tile);
  if (ticks === null) return { ref: "chair", reason: "unreachableTarget" };
  return personal("chair", "voluntaryActivity", ticks, view.tick, {
    kind: "personal",
    activity: "wander",
    tile,
  });
}

/**
 * The machines an engineer's round visits, as the schematic shows them: those in engineering
 * with a `repair` position (for the estimate; the sim builds the route).
 */
function engineeringMachineTiles(view: AgentView): TileCoord[] {
  const engineering = compartmentTagged(view, ["engineering"]);
  if (engineering === undefined) return [];
  return view.schematic.machines().flatMap((m) => {
    const origin = m.footprint[0];
    if (origin === undefined || !inCompartmentWith(view, origin, engineering.symbol)) return [];
    const repair = m.interactionTiles.find((t) => t.purposes.includes("repair"));
    return repair === undefined ? [] : [repair.tile];
  });
}

/**
 * A round, unless backing off, out on the dock (rounds are walked aboard: the chair or the post
 * brings them back first) or there is nowhere to go. Its estimate is the walk to the first stop
 * (the sim builds the route; the time at the stops is the same for every round).
 */
function roundsCandidate(
  view: AgentView,
  firstStop: TileCoord | undefined,
): Candidate | Rejection | undefined {
  if (view.self.onDock === true) return undefined;
  if (backingOff(view, ROUNDS) || firstStop === undefined) return undefined;
  const walk = view.estimateTravelTicks(firstStop);
  if (walk === null) return { ref: ROUNDS, reason: "unreachableTarget" };
  return personal(ROUNDS, "voluntaryActivity", walk, view.tick, {
    kind: "personal",
    activity: "rounds",
  });
}

/** A round if one is due, else `between` (the chair or the post), else why not. */
function roundOr(
  rounds: Candidate | Rejection | undefined,
  between: () => Candidate | Rejection | undefined,
): Candidate | Rejection | undefined {
  if (rounds !== undefined && !("reason" in rounds)) return rounds;
  return between() ?? rounds;
}

/** The on-duty idle candidate, voluntary class (see the module comment). */
export function dutyIdleCandidate(
  view: AgentView,
  _config: PlannerConfig,
): Candidate | Rejection | undefined {
  if (!view.self.onDuty) return undefined;
  if (view.self.watch.officerOfTheWatch) {
    const first = loungeTile(view, OFFICER_FIRST_STOP) ?? chairTile(view);
    return roundOr(roundsCandidate(view, first), () => chairCandidate(view));
  }
  if (view.self.roleTags.includes("engineer")) {
    const [first] = engineeringMachineTiles(view);
    return roundOr(roundsCandidate(view, first), () => postCandidate(view));
  }
  return postCandidate(view);
}
