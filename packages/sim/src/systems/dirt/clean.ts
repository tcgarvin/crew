/**
 * Cleaning (D82): the `cleanCompartment` plan and its `mop` work stage.
 *
 * W2 fills these in: `cleanPlan` (the mop through the generic `supplySteps`: it is unique; then
 * for each of the task's `interactionTiles` a `moveTo` and `work mop` of `dirt.mopSecondsPerTile`
 * scaled by `workRate`; then back to the `cleaningLocker` zone and `putDown`); `runMop` counts the
 * tile's ticks and sets its cell to `max(0, cell − mopPerTile × 255)`. A trip that leaves the room
 * dirty releases the task and the next derivation picks the dirtiest tiles again.
 *
 * Gate stubs: the plan is blocked (`missingTool`) and the step throws; no task is derived yet.
 *
 * Owner: W2 of ship life slice 3.
 */
import { NotImplementedError } from "../../core/registry";
import type { Actor } from "../../core/types/actor";
import type { StepCtx } from "../../core/types/pipeline";
import type { ActivityStep, Task } from "../../core/types/work";
import type { PlanResult } from "../work/plans";
import type { StepResult } from "../work/steps";

type StepOf<K extends ActivityStep["kind"]> = Extract<ActivityStep, { kind: K }>;

export function cleanPlan(_ctx: StepCtx, _actor: Actor, _task: Task): PlanResult {
  return { ok: false, reason: "missingTool" };
}

export function runMop(_ctx: StepCtx, _actor: Actor, _step: StepOf<"work">): StepResult {
  throw new NotImplementedError("runMop (W2)");
}
