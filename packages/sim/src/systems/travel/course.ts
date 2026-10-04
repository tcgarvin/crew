/**
 * Course plotting (D78): a planned course must be plotted at the nav terminal before departure
 * prep begins. A small `courseSystem` raises `courseToPlot` while a course is planned and not yet
 * plotted; it derives one `plotCourse` task at the `navStation` machine; the plot's commit sets
 * `travel.coursePlotted` and emits `coursePlotted`.
 *
 * Owner: W2 of ship life slice 2. Gate B stubs keep today's behaviour: every course counts as
 * plotted, no problem is raised, and nothing derives or plans a plot.
 */
import { NotImplementedError } from "../../core/registry";
import type { Actor } from "../../core/types/actor";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { ActivityStep, DeriveTasks, Task } from "../../core/types/work";
import type { PlanResult } from "../work/plans";
import type { StepResult } from "../work/steps";

/**
 * Raises `courseToPlot` while a course is planned and not plotted, resolves it once plotted.
 * Phase `equipment`, registered before travel's state machine. Stub: nothing to raise (W2).
 */
export const courseSystem: System = {
  name: "travel.course",
  phase: "equipment",
  run() {},
};

/** May departure prep begin as far as the course goes? Stub: always (W2: no plan, or plotted). */
export function coursePlotted(_ctx: Pick<StepCtx, "state">): boolean {
  return true;
}

/** `courseToPlot` → one `plotCourse` task at the nav terminal. Stub: none (W2). */
export const deriveCourseToPlot: DeriveTasks<"courseToPlot"> = () => [];

/** The plan for a `plotCourse` task: to the terminal's operate tile, then `plot` work. Stub. */
export function plotCoursePlan(_ctx: StepCtx, _actor: Actor, _task: Task): PlanResult {
  return { ok: false, reason: "unreachableTarget" };
}

/**
 * The `plot` work step: ticks scaled by `workRate`, then the commit. Nothing plans one until W2,
 * so reaching it is a bug, not a no-op.
 */
export function runPlot(
  _ctx: StepCtx,
  _actor: Actor,
  _step: Extract<ActivityStep, { kind: "work" }>,
): StepResult {
  throw new NotImplementedError("course plotting (runPlot)");
}
