/**
 * Course plotting (§course-plotting): a planned course must be plotted at the nav terminal before
 * departure prep begins. `courseSystem` raises `courseToPlot` while a course is planned and not yet
 * plotted; it derives one `plotCourse` task at the `navStation` machine; the plot's commit
 * (`runPlot`) sets `travel.coursePlotted` and emits `coursePlotted`.
 *
 * A ship with no nav terminal aboard (the hand-built test decks) needs no plot: every course
 * counts as plotted.
 *
 * Owner: travel (W2 of ship life slice 2).
 */
import { configTicks } from "../../core/clock";
import { allocateId } from "../../core/ids";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly } from "../../core/types/common";
import type { ContentBundle, SkillRequirement } from "../../core/types/content";
import type { PortDefId, ProblemId } from "../../core/types/ids";
import type { ReadonlyWorldState, StepCtx, System } from "../../core/types/pipeline";
import type { Machine } from "../../core/types/ship";
import type {
  ActivityStep,
  DerivationCtx,
  ProblemOfKind,
  Task,
  TaskSpec,
} from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { helmMachine } from "../watch/helm";
import { emitSim } from "../work/events";
import { type PlanResult, interactionTarget } from "../work/plans";
import { type StepResult, workRate } from "../work/steps";
import { operateTiles } from "./tasks";

type CourseCtx = { readonly state: ReadonlyWorldState; readonly content: ContentBundle };

/** The ship's nav terminal: the first `navStation` machine on the ship's deck. */
export function navTerminal(ctx: CourseCtx): DeepReadonly<Machine> | undefined {
  const deckId = shipDeckId(ctx.state);
  return Object.values(ctx.state.machines).find(
    (m) => m.deckId === deckId && ctx.content.machines[m.defId]?.tags.includes("navStation"),
  );
}

/** Does a course set now have to be plotted before departure (is there a nav terminal)? */
export function coursePlotRequired(ctx: CourseCtx): boolean {
  return navTerminal(ctx) !== undefined;
}

/**
 * May departure prep begin as far as the course goes? Yes with no course planned, with no nav
 * terminal aboard, or once the planned course is plotted.
 */
export function coursePlotted(ctx: CourseCtx): boolean {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked" || travel.plannedDestinationId === undefined) return true;
  return travel.coursePlotted === true || !coursePlotRequired(ctx);
}

/** The course still to plot: docked, a course planned, a nav terminal aboard, not plotted. */
function courseToPlot(ctx: CourseCtx): PortDefId | undefined {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked" || travel.plannedDestinationId === undefined) return undefined;
  if (travel.coursePlotted === true || !coursePlotRequired(ctx)) return undefined;
  return travel.plannedDestinationId;
}

const openCourseProblems = (ctx: Pick<StepCtx, "state">): ProblemOfKind<"courseToPlot">[] =>
  Object.values(ctx.state.work.problems).filter(
    (p): p is ProblemOfKind<"courseToPlot"> => p.kind === "courseToPlot" && p.status === "open",
  );

/** Is `toPortId` the course the ship is docked with, plotted? */
function plottedFor(ctx: Pick<StepCtx, "state">, toPortId: PortDefId): boolean {
  const travel = ctx.state.travel;
  return (
    travel.stage === "docked" &&
    travel.plannedDestinationId === toPortId &&
    travel.coursePlotted === true
  );
}

function raiseCourseProblem(ctx: StepCtx, toPortId: PortDefId): void {
  const nav = navTerminal(ctx);
  if (nav === undefined) throw new Error("courseToPlot raised with no nav terminal aboard");
  const id = allocateId(ctx.state, "problem") as ProblemId;
  ctx.state.work.problems[id] = {
    id,
    kind: "courseToPlot",
    payload: { toPortId },
    owner: "travel",
    visibility: "public",
    // One per destination: a detour closes the old course's problem and opens its own.
    dedupeKey: `courseToPlot:${toPortId}`,
    status: "open",
    createdTick: ctx.tick,
    revision: 1,
    baseUrgency: "essentialOperation",
    location: { kind: "machine", machineId: nav.id },
  };
}

/**
 * Keep `courseToPlot` in step with the course: open for the planned destination while it is
 * unplotted; resolved once plotted; cancelled when the course changes (a detour, a course
 * dropped) or the ship leaves without it. A `coursePlotted` flag left behind by a dropped
 * course (passage's put-off deletes the plan) is cleared, so it cannot plot the next one.
 */
function syncCourseProblem(ctx: StepCtx): void {
  const travel = ctx.state.travel;
  if (
    travel.stage === "docked" &&
    travel.plannedDestinationId === undefined &&
    travel.coursePlotted === true
  ) {
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete travel.coursePlotted;
  }
  const wanted = courseToPlot(ctx);
  let open = false;
  for (const problem of openCourseProblems(ctx)) {
    const toPortId = problem.payload.toPortId;
    if (toPortId === wanted) {
      open = true;
      continue;
    }
    problem.status = plottedFor(ctx, toPortId) ? "resolved" : "cancelled";
  }
  if (wanted !== undefined && !open) raiseCourseProblem(ctx, wanted);
}

/**
 * Raises `courseToPlot` while a course is planned and not plotted, settles it otherwise. Phase
 * `equipment`, registered before travel's state machine, so a course plotted in the actions
 * phase lets departure prep begin the same tick.
 */
export const courseSystem: System = {
  name: "travel.course",
  phase: "equipment",
  run(ctx) {
    syncCourseProblem(ctx);
  },
};

/** The helm's operator skill: who may plot is who may stand the helm (§course-plotting). */
function plotSkills(ctx: CourseCtx): SkillRequirement[] {
  const helm = helmMachine(ctx.state, ctx.content);
  const skill =
    helm === undefined ? undefined : ctx.content.machines[helm.defId]?.operation.operatorSkill;
  return skill === undefined ? [] : [{ skill: skill.skill, min: skill.min }];
}

/**
 * `courseToPlot` → one `plotCourse` task at the nav terminal's operate position. A function
 * declaration, not a `const`: `tasks.ts` reads it at module load, and this module imports
 * `tasks.ts` back (directly and through the helm), so it must be bound before either runs.
 */
export function deriveCourseToPlot(
  problem: ProblemOfKind<"courseToPlot">,
  ctx: DerivationCtx,
): TaskSpec[] {
  const nav = navTerminal(ctx);
  if (nav === undefined) return [];
  return [
    {
      derivationKey: "plot",
      type: "plotCourse",
      target: { kind: "machine", machineId: nav.id },
      baseUrgency: problem.baseUrgency,
      requiredSkills: plotSkills(ctx),
      requiredTools: [],
      consumables: [],
      workerSlots: 1,
      interactionTiles: operateTiles(ctx, nav.id),
      dependencyIds: [],
      // A plot keeps its progress on the plotter's step: an interrupted plot starts again.
      progressRef: { kind: "occupancy", machineId: nav.id },
      completion: { kind: "problemResolved" },
      estimatedWorkSeconds: ctx.config.watches.plotCourseSeconds,
    },
  ];
}

/** The plan for a `plotCourse` task: to the terminal's operate position, then `plot` work. */
export function plotCoursePlan(ctx: StepCtx, actor: Actor, task: Task): PlanResult {
  if (task.target.kind !== "machine") return { ok: false, reason: "unreachableTarget" };
  const target = interactionTarget(ctx, actor, task.target.machineId, "operate");
  if (target === undefined) return { ok: false, reason: "unreachableTarget" };
  const ticksNeeded = configTicks(ctx.config, ctx.config.watches.plotCourseSeconds);
  return {
    ok: true,
    plan: {
      steps: [
        { kind: "moveTo", target, requested: false },
        { kind: "work", stage: "plot", ticksDone: 0, ticksNeeded },
      ],
      stepIndex: 0,
    },
  };
}

/**
 * The `plot` work step: `workRate` ticks of progress per tick (skill above the helm's minimum
 * plots faster: skill sets how long, not how good; §course-plotting), then the commit: the course
 * is plotted, its problem resolved and `coursePlotted` emitted. A course that changed under the
 * plotter fails the step (`dependencyPending`); `courseSystem` has already cancelled its problem,
 * so this only guards the tick in between.
 */
export function runPlot(
  ctx: StepCtx,
  actor: Actor,
  step: Extract<ActivityStep, { kind: "work" }>,
): StepResult {
  const activity = actor.activity;
  const task = activity.kind === "task" ? ctx.state.work.tasks[activity.taskId] : undefined;
  const problem = task === undefined ? undefined : ctx.state.work.problems[task.problemId];
  if (task === undefined || problem?.kind !== "courseToPlot" || problem.status !== "open") {
    return { fail: "dependencyPending" };
  }
  const travel = ctx.state.travel;
  const toPortId = problem.payload.toPortId;
  if (travel.stage !== "docked" || travel.plannedDestinationId !== toPortId) {
    return { fail: "dependencyPending" };
  }
  if (task.status === "claimed") task.status = "active";
  step.ticksDone += workRate(ctx, actor, task);
  if (step.ticksDone < step.ticksNeeded) return "wait";
  travel.coursePlotted = true;
  problem.status = "resolved";
  emitSim(ctx, "coursePlotted", [actor.id], { toPortId, actorId: actor.id });
  return "done";
}
