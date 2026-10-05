/**
 * The planner's cleaning rule (D82): who may take a `cleanCompartment` task.
 *
 * W2 fills this in (`cleanTaskAllowed`): by the room's tags against the actor's roles (cook →
 * galley, mess; deckhand → cargoHold, corridor, gym, airlock; engineer → engineering; medic →
 * infirmary; captain, first officer, pilot → bridge; lounge, quarters, cabins and stores belong to
 * nobody), anyone once the problem is `urgency.routineAgingDays` old, and anyone at essential
 * class. Cleaning is routine and keeps the off-duty rule, so on-duty crew with nothing to do
 * clean before they walk rounds and off-duty crew never clean.
 *
 * Gate stub: allowed (no task is derived yet).
 *
 * Owner: W2 of ship life slice 3.
 */
import type { PlannerConfig } from "../core/types/pipeline";
import type { AgentView, ProblemView, TaskView } from "../core/types/view";

/** Is `task` one this file decides (`cleanCompartment`)? */
export function isCleaningTask(task: TaskView): boolean {
  return task.type === "cleanCompartment";
}

export function cleanTaskAllowed(
  _view: AgentView,
  _config: PlannerConfig,
  _task: TaskView,
  _problem: ProblemView,
): boolean {
  return true;
}
