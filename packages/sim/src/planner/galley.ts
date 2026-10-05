/**
 * The planner's galley rules (D81): the eat candidate, the mess call, and who may take the
 * galley's tasks. `eatCandidate` and `messTile` moved here verbatim from `candidates.ts` at the
 * slice-3 gate.
 *
 * W1 fills in: `mealCallFor` (a known `meal` item on deck at routine class from
 * `galley.mealCallHungerAbove` when the actor is a dayworker, off watch, or in the section that
 * stands the next watch (`self.watch.nextOnWatch`) before the bell; the section on watch waits
 * for the bell and eats as the off-going), `eatCandidate` taking the call and preferring a known
 * hot meal to a ration, `galleyTaskAllowed` (`cookMeal`: the cook always, anyone with cooking ≥ 1
 * once the problem is `galley.substituteAfterDays` old; `carryMeal`: the cook or a dayworker,
 * anyone after `urgency.routineAgingDays`) and `galleyTaskExempt` (the cook on `cookMeal` skips
 * the off-duty rule and `deferTo`, as the helm's stander does on the helm). `candidates.ts` routes
 * the galley's task types through these the way it routes the helm's through `helm.ts`.
 *
 * Owner: W1 of ship life slice 3.
 */
import type { TileCoord } from "../core/types/common";
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, KnownItemView, ProblemView, TaskView } from "../core/types/view";
import type { Candidate, Rejection } from "./candidates";
import {
  backingOff,
  inCompartmentTagged,
  inMyHands,
  loungeTile,
  needUrgency,
  personal,
} from "./common";

/** Is `task` one whose eligibility this file decides (`cookMeal`, `carryMeal`)? */
export function isGalleyTask(task: TaskView): boolean {
  return task.type === "cookMeal" || task.type === "carryMeal";
}

/**
 * The mess call for this actor: the known hot meal they should go and eat now, if any (see the
 * module comment). Read by `helm.ts` to hold the gangway candidate back while it stands. Gate
 * stub: none.
 */
export function mealCallFor(
  _view: AgentView,
  _config: PlannerConfig,
): { readonly itemId: KnownItemView["itemId"] } | undefined {
  return undefined;
}

/** May this actor take the galley task? Gate stub: yes (today's rule; no task is derived yet). */
export function galleyTaskAllowed(
  _view: AgentView,
  _config: PlannerConfig,
  _task: TaskView,
  _problem: ProblemView,
): boolean {
  return true;
}

/** Is the galley task exempt from the off-duty rule and `deferTo`? Gate stub: no. */
export function galleyTaskExempt(_view: AgentView, _task: TaskView): boolean {
  return false;
}

export function eatCandidate(
  view: AgentView,
  config: PlannerConfig,
): Candidate | Rejection | undefined {
  const urgency = needUrgency(view.self.needs.hunger, config);
  if (urgency === undefined) return undefined;
  // `mealDays` in ticks, inline because the planner may not import `core/clock` (D76).
  const mealTicks = Math.ceil(
    config.needs.mealDays * config.time.daySeconds * config.time.tickRate,
  );
  const food = view.knownItems().filter((i) => i.tags.includes("food") && !i.absent);
  const table = messTile(view);
  const toTable = (from?: TileCoord): number => {
    if (table === undefined) return 0;
    return view.estimateTravelTicks(table, from) ?? 0;
  };
  const atTable = table === undefined ? {} : { tile: table };
  const inHand = food.find((i) => inMyHands(view, i));
  if (inHand !== undefined) {
    return personal("eat", urgency, toTable() + mealTicks, view.tick, {
      kind: "personal",
      activity: "eat",
      itemId: inHand.itemId,
      ...atTable,
    });
  }
  let best: { item: KnownItemView; ticks: number } | undefined;
  for (const item of food) {
    if (item.tile === undefined || backingOff(view, `eat:${item.itemId}`)) continue;
    const ticks = view.estimateTravelTicks(item.tile);
    if (ticks !== null && (best === undefined || ticks < best.ticks)) best = { item, ticks };
  }
  if (best === undefined) return { ref: "eat", reason: "noKnownFood" };
  const fetch = best.ticks + toTable(best.item.tile);
  return personal(`eat:${best.item.itemId}`, urgency, fetch + mealTicks, view.tick, {
    kind: "personal",
    activity: "eat",
    itemId: best.item.itemId,
    ...atTable,
  });
}

/**
 * W4a decision: people carry their food to the mess to eat when the ship has one (and they are
 * not already in it); otherwise they eat where they picked it up.
 */
function messTile(view: AgentView): TileCoord | undefined {
  const here = view.self.tile;
  if (
    here !== undefined &&
    (inCompartmentTagged(view, here, "mess") || inCompartmentTagged(view, here, "galley"))
  ) {
    return undefined;
  }
  return loungeTile(view, ["mess", "galley"]);
}
