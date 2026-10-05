/**
 * The planner's cleaning rule (D82): who may take a `cleanCompartment` task.
 *
 * By the room's tags against the actor's roles (`ROOM_AFFINITY`: cook → galley, mess; deckhand →
 * cargo hold, corridor, gym, airlock; engineer → engineering; medic → infirmary; captain, first
 * officer, pilot → bridge; lounge, quarters, cabins and stores belong to nobody); anyone once the
 * problem is `urgency.routineAgingDays` old; and anyone while it is essential (a filthy galley or
 * infirmary). Cleaning keeps the off-duty rule (`candidates.ts`), so on-duty crew with nothing to
 * do clean before they walk rounds (routine beats voluntary) and off-duty crew never clean.
 *
 * Owner: W2 of ship life slice 3.
 */
import { ROLE_TAGS, type RoleTag } from "../core/types/content";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, ProblemView, TaskView } from "../core/types/view";
import { URGENCY_CLASSES } from "../core/types/work";

/** Which rooms (by compartment tag) each role keeps clean. A vocabulary mapping, not a tunable. */
const ROOM_AFFINITY: Readonly<Record<RoleTag, readonly string[]>> = {
  cook: ["galley", "mess"],
  deckhand: ["cargoHold", "corridor", "gym", "airlock"],
  engineer: ["engineering"],
  medic: ["infirmary"],
  captain: ["bridge"],
  firstOfficer: ["bridge"],
  pilot: ["bridge"],
};

/**
 * The roles that keep a room with these compartment tags clean (`ROOM_AFFINITY`), in `ROLE_TAGS`
 * order; empty for a room nobody keeps (lounge, quarters, cabins, stores). The one table: the
 * narrator reads it to say whose mop a dirty room waits on.
 */
export function cleaningRolesFor(compartmentTags: readonly string[]): RoleTag[] {
  return ROLE_TAGS.filter((role) => ROOM_AFFINITY[role].some((t) => compartmentTags.includes(t)));
}

/** Is `task` one this file decides (`cleanCompartment`)? */
export function isCleaningTask(task: TaskView): boolean {
  return task.type === "cleanCompartment";
}

/** Has the problem waited `urgency.routineAgingDays` (ticks inline: the planner has no clock)? */
function aged(view: AgentView, config: PlannerConfig, problem: ProblemView): boolean {
  const agingTicks =
    config.urgency.routineAgingDays * config.time.daySeconds * config.time.tickRate;
  return view.tick - problem.createdTick >= agingTicks;
}

const essential = (problem: ProblemView): boolean =>
  URGENCY_CLASSES.indexOf(problem.baseUrgency) <= URGENCY_CLASSES.indexOf("essentialOperation");

export function cleanTaskAllowed(
  view: AgentView,
  config: PlannerConfig,
  _task: TaskView,
  problem: ProblemView,
): boolean {
  if (problem.kind !== "compartmentDirty") return false;
  if (essential(problem) || aged(view, config, problem)) return true;
  const room = view.schematic.deck.compartments.find((c) => c.key === problem.payload.key);
  if (room === undefined) return false;
  const keepers = cleaningRolesFor(room.tags);
  return view.self.roleTags.some((role) => keepers.includes(role));
}
