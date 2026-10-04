/**
 * The planner's helm rule (D77): who may claim the helm's posts and the course plot, and gangway
 * watch in port. The sim decides who stands the helm (`SelfView.watch.helmRole`); this file only
 * reads it.
 *
 * - The `watch` post is the stander's and the oncoming's, the `relief` post the relief's; nobody
 *   else's, however idle or skilled.
 * - A helm task one may take skips the off-duty rejection (the oncoming claims before their bell,
 *   a relief and a fallback are off watch) and `deferTo` (Noor stands Red's helm with Mara idle
 *   beside her: the junior stands under the captain's eye). The course plot is anyone's who has
 *   its skill, on the same terms.
 * - Gangway watch: in port with no helm watch, the stander (never an officer) stands at the
 *   deck's `gangway` zone, routine class.
 *
 * Owner: W1 of ship life slice 2.
 */
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, TaskView } from "../core/types/view";
import type { Candidate, Rejection } from "./candidates";
import { backingOff, personal } from "./common";

/** Is `task` one whose eligibility this file decides (`staffStation`, `plotCourse`)? */
export function isHelmTask(task: TaskView): boolean {
  return task.type === "staffStation" || task.type === "plotCourse";
}

/** The helm post a `staffStation` task mans (`staff:watch` or `staff:relief`). */
function postOf(task: TaskView): "watch" | "relief" {
  return task.derivationKey === "staff:relief" ? "relief" : "watch";
}

/**
 * May this actor take the helm task? The `watch` post for its `stander` and `oncoming`, the
 * `relief` post for a `relief`; `plotCourse` for anyone meeting its skills (checked before).
 */
export function helmTaskAllowed(view: AgentView, task: TaskView): boolean {
  if (task.type === "plotCourse") return true;
  const role = view.self.watch.helmRole;
  if (postOf(task) === "relief") return role === "relief";
  return role === "stander" || role === "oncoming";
}

/**
 * Is the helm task exempt from the off-duty rejection and from `deferTo`? Yes for every helm task
 * the actor is allowed (`helmTaskAllowed` runs first): the sim chose them.
 */
export function helmTaskExempt(_view: AgentView, task: TaskView): boolean {
  return isHelmTask(task);
}

/** A helm watch is wanted: the `watch` post is open (a course planned, or underway). */
function helmWatchOpen(view: AgentView): boolean {
  return view
    .knownProblems()
    .some((p) => p.kind === "stationToStaff" && p.payload.post === "watch");
}

/**
 * Gangway watch while docked with no helm watch, for the section's stander who is not an
 * officer (the captain goes ashore to look for work, D70), routine class. Not offered while
 * already standing it, so the hold is simply kept.
 */
export function gangwayCandidate(
  view: AgentView,
  _config: PlannerConfig,
): Candidate | Rejection | undefined {
  const self = view.self;
  if (self.watch.helmRole !== "stander") return undefined;
  if (self.roleTags.some((role) => role === "captain" || role === "firstOfficer")) return undefined;
  const activity = self.activity;
  if (activity.kind === "personal" && activity.activity === "standWatch") return undefined;
  if (helmWatchOpen(view)) return undefined;
  const tile = view.schematic.deck.zones.find((zone) => zone.tags.includes("gangway"))?.tiles[0];
  if (tile === undefined) return undefined;
  if (backingOff(view, "standWatch")) return { ref: "standWatch", reason: "backoff" };
  const ticks = view.estimateTravelTicks(tile);
  if (ticks === null) return { ref: "standWatch", reason: "unreachableTarget" };
  return personal("standWatch", "routineObligation", ticks, view.tick, {
    kind: "personal",
    activity: "standWatch",
    tile: { x: tile.x, y: tile.y },
  });
}
