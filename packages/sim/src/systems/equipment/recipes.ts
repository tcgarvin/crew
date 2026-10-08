/**
 * Repair/diagnosis/maintenance stage state machine (SD §14.3–14.4). These are the pure functions
 * W4 (work execution, phase "actions") drives: it owns claiming and the actor-facing `Action`,
 * and calls into these to advance and commit the underlying recipe. They are pure with respect to
 * events (returned as drafts for the caller to `ctx.emit`, since a `RecipeCtx` has no `emit`) but
 * they do mutate `state` — same mutation model as everything else in the kernel (CONTRACTS rule 11).
 *
 * Dispatch is on `Task.derivationKey`, set by `tasks.ts`: `"inspect"` (symptom -> diagnosis),
 * `"repair"` (fault -> repair recipe) and `"maintain"` (maintenanceDue -> routine inspection).
 *
 * Progress lives on the target, never on the task or the actor (SD §14.4), so a worker swap and a
 * save/restore both resume exactly where the recipe left off:
 * - `"inspect"`: `MachineFault.repairStepIndex`/`repairStepProgress` on the *undiagnosed* fault
 *   (index is always 0 pre-diagnosis; reused for the repair steps once diagnosed).
 * - `"repair"`: the same two fields on the (now diagnosed) `MachineFault`, indexing
 *   `FaultDef.repair.steps`.
 * - `"maintain"`: `Machine.maintenanceProgress` (W5 addition to `ship.ts`, see report).
 *
 * Commit points (SD §8.2): a step's `consumes` are removed from the acting actor's carried
 * inventory exactly once, when that step's progress reaches 1 — for a `repair` task this is
 * whichever step lists them (typically `installComponent`); a required tool is never consumed.
 * // W5 decision: item consumption is performed inline here rather than deferred to W4, since the
 * commit point is intrinsically tied to recipe-step completion; W4 may want to move this to a
 * shared inventory-transfer helper later without changing the calling convention.
 */
import { configTicks } from "../../core/clock";
import type { Tick } from "../../core/types/common";
import type { ConfigDef, ContentBundle, ItemCount, RecipeStep } from "../../core/types/content";
import type { EventDraft } from "../../core/types/events";
import type { ActorId, MachineId, TaskId } from "../../core/types/ids";
import type { WorldState } from "../../core/types/state";
import type { Task } from "../../core/types/work";
import { depositDirt } from "../dirt/deposit";
import { DIAGNOSE_SECONDS, REPAIR_CONDITION_RESTORE } from "./equipment";
import { raiseProblem, resolveProblem } from "./problems";
import { clamp, machineEvent } from "./util";

export interface RecipeCtx {
  readonly state: WorldState;
  readonly content: ContentBundle;
  readonly config: ConfigDef;
  readonly tick: Tick;
}

export type RecipeOutcome =
  /** The task/target no longer resolves (unknown task, wrong derivation kind, fault vanished). */
  | { readonly status: "notFound" }
  | { readonly status: "inProgress"; readonly progress: number }
  /** One recipe step finished but the whole task has not (only `"repair"` has more than one step). */
  | { readonly status: "stepComplete"; readonly events: readonly EventDraft[] }
  /** The whole task finished: fault repaired, symptom diagnosed, or maintenance done. */
  | { readonly status: "recipeComplete"; readonly events: readonly EventDraft[] };

function consumeItems(state: WorldState, actorId: ActorId, consumes: readonly ItemCount[]): void {
  for (const need of consumes) {
    let remaining = need.count;
    for (const item of Object.values(state.items)) {
      if (remaining <= 0) break;
      if (item.location.kind !== "carriedBy" || item.location.actorId !== actorId) continue;
      if (item.defId !== need.itemDefId) continue;
      if (item.stacking === "stack") {
        const take = Math.min(remaining, item.count - item.reserved);
        item.count -= take;
        remaining -= take;
        if (item.count <= 0) delete state.items[item.id];
      } else {
        delete state.items[item.id];
        remaining -= 1;
      }
    }
  }
}

function advanceInspect(ctx: RecipeCtx, task: Task, ticks: number): RecipeOutcome {
  if (task.progressRef.kind !== "fault") return { status: "notFound" };
  const { machineId, faultKey } = task.progressRef;
  const machine = ctx.state.machines[machineId];
  const fault = machine?.faults.find((f) => f.faultKey === faultKey);
  if (machine === undefined || fault === undefined || fault.diagnosed)
    return { status: "notFound" };
  const stepTicks = configTicks(ctx.config, DIAGNOSE_SECONDS);
  fault.repairStepProgress =
    stepTicks <= 0 ? 1 : clamp(fault.repairStepProgress + ticks / stepTicks, 0, 1);
  if (fault.repairStepProgress < 1)
    return { status: "inProgress", progress: fault.repairStepProgress };
  fault.diagnosed = true;
  fault.repairStepIndex = 0;
  fault.repairStepProgress = 0;
  const events: EventDraft[] = [machineEvent("faultDiagnosed", machineId, { machineId, faultKey })];
  const resolvedSymptom = resolveProblem(ctx.state, `machineSymptom:${machineId}:${faultKey}`);
  if (resolvedSymptom !== undefined) events.push(resolvedSymptom);
  const { event: raised } = raiseProblem(ctx.state, ctx.tick, {
    kind: "machineFault",
    payload: { machineId, faultKey },
    dedupeKey: `machineFault:${machineId}:${faultKey}`,
    visibility: "public",
    baseUrgency: "essentialOperation",
    location: { kind: "machine", machineId },
  });
  if (raised !== undefined) events.push(raised);
  return { status: "recipeComplete", events };
}

function advanceRepair(ctx: RecipeCtx, task: Task, actorId: ActorId, ticks: number): RecipeOutcome {
  if (task.progressRef.kind !== "fault") return { status: "notFound" };
  const { machineId, faultKey } = task.progressRef;
  const machine = ctx.state.machines[machineId];
  const fault = machine?.faults.find((f) => f.faultKey === faultKey);
  if (machine === undefined || fault === undefined || !fault.diagnosed)
    return { status: "notFound" };
  const def = ctx.content.machines[machine.defId];
  const faultDef = def?.faults.find((f) => f.key === faultKey);
  const steps: readonly RecipeStep[] | undefined = faultDef?.repair.steps;
  if (def === undefined || faultDef === undefined || steps === undefined || steps.length === 0) {
    return { status: "notFound" };
  }

  let remainingTicks = ticks;
  const events: EventDraft[] = [];
  while (remainingTicks > 0 && fault.repairStepIndex < steps.length) {
    const step = steps[fault.repairStepIndex] as RecipeStep;
    const stepTicks = configTicks(ctx.config, step.workSeconds);
    if (stepTicks <= 0) {
      fault.repairStepProgress = 1;
    } else {
      const need = (1 - fault.repairStepProgress) * stepTicks;
      const use = Math.min(remainingTicks, need);
      fault.repairStepProgress = clamp(fault.repairStepProgress + use / stepTicks, 0, 1);
      remainingTicks -= use;
    }
    if (fault.repairStepProgress < 1) break;

    // Commit point: this step's parts are spent now; tools are never consumed.
    consumeItems(ctx.state, actorId, step.consumes);
    fault.repairStepIndex += 1;
    fault.repairStepProgress = 0;

    if (fault.repairStepIndex >= steps.length) {
      machine.faults = machine.faults.filter((f) => f.faultKey !== faultKey);
      machine.condition = clamp(machine.condition + REPAIR_CONDITION_RESTORE, 0, 1);
      // D35: a completed repair is the only path that restores integrity (overheat is the only
      // thing that costs it), so a machine blocked on integrity can come back once it is fixed.
      machine.integrity = clamp(
        Math.max(machine.integrity, ctx.config.equipment.integrityDerateBelow),
        0,
        1,
      );
      // D100: the repair names what caused the fault, so the narrator's aftermath call comes
      // for a fault it (or its hazard, or its field) caused, never for wear.
      const causes = fault.causeCommandId === undefined ? [] : [fault.causeCommandId];
      events.push(machineEvent("faultRepaired", machineId, { machineId, faultKey }, causes));
      // D82: a repair leaves its mess round the machine (its placement's origin tile).
      const origin = ctx.content.decks[machine.deckId]?.machines.find(
        (p) => p.key === machine.placementKey,
      )?.origin;
      if (origin !== undefined) {
        depositDirt(
          ctx.state,
          ctx.content,
          ctx.config,
          machine.deckId,
          origin,
          ctx.config.dirt.deposits.repair,
        );
      }
      const resolved = resolveProblem(ctx.state, `machineFault:${machineId}:${faultKey}`);
      if (resolved !== undefined) events.push(resolved);
      return { status: "recipeComplete", events };
    }
  }
  if (events.length > 0) return { status: "stepComplete", events };
  return { status: "inProgress", progress: fault.repairStepProgress };
}

function advanceMaintain(ctx: RecipeCtx, task: Task, ticks: number): RecipeOutcome {
  if (task.progressRef.kind !== "maintenance") return { status: "notFound" };
  const { machineId } = task.progressRef;
  const machine = ctx.state.machines[machineId];
  const def = machine === undefined ? undefined : ctx.content.machines[machine.defId];
  const step = def?.maintenance?.inspect;
  if (
    machine === undefined ||
    def === undefined ||
    step === undefined ||
    def.maintenance === undefined
  ) {
    return { status: "notFound" };
  }
  const stepTicks = configTicks(ctx.config, step.workSeconds);
  machine.maintenanceProgress =
    stepTicks <= 0 ? 1 : clamp(machine.maintenanceProgress + ticks / stepTicks, 0, 1);
  if (machine.maintenanceProgress < 1)
    return { status: "inProgress", progress: machine.maintenanceProgress };
  machine.maintenanceProgress = 0;
  machine.condition = clamp(machine.condition + def.maintenance.conditionRestored, 0, 1);
  machine.lastMaintainedTick = ctx.tick;
  const events: EventDraft[] = [machineEvent("maintenanceCompleted", machineId, { machineId })];
  const resolved = resolveProblem(ctx.state, `maintenanceDue:${machineId}`);
  if (resolved !== undefined) events.push(resolved);
  return { status: "recipeComplete", events };
}

/** Advance the task's current stage by `ticks` of work from `actorId`. */
export function advanceStage(
  ctx: RecipeCtx,
  taskId: TaskId,
  actorId: ActorId,
  ticks: number,
): RecipeOutcome {
  const task = ctx.state.work.tasks[taskId];
  if (task === undefined) return { status: "notFound" };
  if (task.derivationKey === "inspect") return advanceInspect(ctx, task, ticks);
  if (task.derivationKey === "repair") return advanceRepair(ctx, task, actorId, ticks);
  if (task.derivationKey === "maintain") return advanceMaintain(ctx, task, ticks);
  return { status: "notFound" };
}
