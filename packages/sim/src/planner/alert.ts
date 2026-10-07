/**
 * The alert in the planner (D93, D94), pure over the `AgentView`:
 *
 * - `alertCandidate`: the officer of the watch, on alert, holds the bridge (`holdBridge`,
 *   essential) at the captain's chair's `use` tile on the bridge (a chair anywhere on a ship with
 *   none there), else a floor tile of the bridge, instead of walking rounds.
 * - `recreationOffered`: no recreation on alert (call 4).
 * - `damageTaskAllowed`: who takes the damage tasks. On alert the officer of the watch takes none
 *   (they hold the bridge and send scouts, call 11), and the captain or the officer of the watch
 *   never takes a `checkCompartment`. The scout is the nearest available on-duty hand: the
 *   off-duty rule already keeps the off watch in their bunks, and a hand defers the check to a
 *   colleague the view can see right now (awake, available, idle) who stands nearer the room's
 *   door, so of two idle hands the nearer goes. Repairs, patches and plates need only their skill.
 * - `isDamageTask`: the four task types whose rules these are.
 *
 * Owner: W2 of ship life slice 5.
 */
import type { TileCoord } from "../core/types/common";
import type { ActorId } from "../core/types/ids";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, ProblemView, TaskView } from "../core/types/view";
import type { Candidate, Rejection } from "./candidates";
import { backingOff, loungeTile, personal, sameTile } from "./common";

const DAMAGE_TASK_TYPES: ReadonlySet<string> = new Set([
  "repairDamage",
  "patchHull",
  "plateHull",
  "checkCompartment",
]);

/** The personal activity's ref (and its backoff ref, `backoffRef.personal`). */
const HOLD_BRIDGE = "holdBridge";

/** Is this one of damage response's tasks (its rules are `damageTaskAllowed`'s)? */
export function isDamageTask(task: TaskView): boolean {
  return DAMAGE_TASK_TYPES.has(task.type);
}

/**
 * A colleague the actor can see now (awake, available, idle, not the captain) who would reach
 * `tile` sooner than they would. Only fresh sightings count, as for skill deference, so once the
 * colleague is out of sight or busy the actor goes (deference cannot deadlock).
 */
function nearerHand(view: AgentView, config: PlannerConfig, tile: TileCoord): ActorId | undefined {
  const mine = view.estimateTravelTicks(tile);
  if (mine === null) return undefined;
  const fresh = view.tick - 2 * config.work.reconsiderEveryTicks;
  for (const colleague of view.roster()) {
    if (colleague.actorId === view.self.id || colleague.passenger === true) continue;
    if (colleague.roleTags.includes("captain")) continue;
    const status = view.fact(colleague.actorId, "actorStatus");
    if (status === undefined || status.observedTick < fresh) continue;
    const seen = status.value;
    if (seen.availability !== "available" || seen.asleep || seen.idle !== true) continue;
    if (seen.tile === undefined) continue;
    const theirs = view.estimateTravelTicks(tile, seen.tile);
    if (theirs !== null && theirs < mine) return colleague.actorId;
  }
  return undefined;
}

export function damageTaskAllowed(
  view: AgentView,
  config: PlannerConfig,
  task: TaskView,
  _problem: ProblemView,
): boolean {
  const officer = view.self.watch.officerOfTheWatch;
  if (officer && view.alert() !== undefined) return false;
  if (task.type !== "checkCompartment") return true;
  if (officer || view.self.roleTags.includes("captain")) return false;
  const door = task.interactionTiles[0];
  return door === undefined || nearerHand(view, config, door) === undefined;
}

/** The chair's `use` tile on the bridge (a chair anywhere if none is there). */
function chairTile(view: AgentView): TileCoord | undefined {
  const deck = view.schematic.deck;
  const bridges = new Set(
    deck.compartments.filter((c) => c.tags.includes("bridge")).map((c) => c.symbol),
  );
  const seats = view.schematic.amenities("chair").flatMap((chair) => {
    const seat = chair.interactionTiles.find((t) => t.purposes.includes("use"));
    return seat === undefined ? [] : [seat.tile];
  });
  return seats.find((t) => bridges.has(deck.tiles[t.y]?.[t.x] ?? "")) ?? seats[0];
}

export function alertCandidate(
  view: AgentView,
  _config: PlannerConfig,
): Candidate | Rejection | undefined {
  if (view.alert() === undefined || !view.self.watch.officerOfTheWatch) return undefined;
  if (view.self.onDock === true) return undefined;
  if (backingOff(view, HOLD_BRIDGE)) return { ref: HOLD_BRIDGE, reason: "backoff" };
  const post = chairTile(view) ?? loungeTile(view, ["bridge"]);
  if (post === undefined) return { ref: HOLD_BRIDGE, reason: "noBridge" };
  const here = view.self.tile;
  const ticks = here !== undefined && sameTile(here, post) ? 0 : view.estimateTravelTicks(post);
  if (ticks === null) return { ref: HOLD_BRIDGE, reason: "unreachableTarget" };
  return personal(HOLD_BRIDGE, "essentialOperation", ticks, view.tick, {
    kind: "personal",
    activity: "holdBridge",
  });
}

export function recreationOffered(view: AgentView): boolean {
  return view.alert() === undefined;
}
