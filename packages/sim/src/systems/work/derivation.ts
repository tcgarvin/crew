/**
 * Task derivation runner (CONTRACTS "How work is advertised" step 2; SD §14.2).
 *
 * Owning systems register one rule per `ProblemKind` (`registerTaskDerivation(kind, rule)`, or a
 * `Partial<TaskDerivationTable>` passed to `registerWork`). Every pass (phase 7, before the
 * planner) turns open problems into tasks:
 *
 * - identity is `(problemId, derivationKey)`: a task already derived for that pair is never
 *   duplicated;
 * - `Task.revision` records the problem revision it was derived from; when the owner bumps the
 *   problem's revision the task's spec fields are refreshed in place (claims kept);
 * - a task the rule no longer returns is cancelled; a cancelled task the rule returns again is
 *   revived as `pending`;
 * - when a problem is resolved its live tasks complete (cancelled → cancel), releasing claims.
 *   Exception: a claimed `staffStation` task outlives its resolved problem until the staffer's
 *   hold ends (see `execute.ts`), otherwise the pilot would leave the helm the moment the
 *   station counts as staffed and travel would immediately re-raise the problem; likewise a
 *   claimed `buyParts` task (D63) until the buyer has carried the units aboard;
 * - terminal tasks whose problem is no longer open and that no activity references are pruned so
 *   `state.work.tasks` stays small.
 *
 * W4a decision: a problem kind with no registered rule derives no tasks (the slice integrates
 * W5/W6 incrementally); `missingKinds()` lists them for an integration test to assert on.
 */
import { allocateId } from "../../core/ids";
import type { Unregister } from "../../core/registry";
import type { ActorId, ProblemId, TaskId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type {
  DeriveTasks,
  Problem,
  ProblemKind,
  Task,
  TaskDerivationTable,
  TaskSpec,
} from "../../core/types/work";
import { completeTask, releaseClaimsForTask } from "./claims";
import { emitSim } from "./events";

const PROBLEM_KIND_SET = {
  machineSymptom: true,
  machineFault: true,
  maintenanceDue: true,
  cargoToLoad: true,
  cargoToUnload: true,
  stationToStaff: true,
  partsNeeded: true,
} as const satisfies Record<ProblemKind, true>;

export const PROBLEM_KINDS = Object.keys(PROBLEM_KIND_SET) as ProblemKind[];

/** A mutable, per-registry set of derivation rules. */
export interface TaskDerivationRegistry {
  register<K extends ProblemKind>(kind: K, rule: DeriveTasks<K>): Unregister;
  rule<K extends ProblemKind>(kind: K): DeriveTasks<K> | undefined;
  /** Problem kinds with no rule yet. */
  missingKinds(): ProblemKind[];
}

export function createTaskDerivationRegistry(
  initial: Partial<TaskDerivationTable> = {},
): TaskDerivationRegistry {
  const rules: Partial<Record<ProblemKind, unknown>> = {};
  const registry: TaskDerivationRegistry = {
    register(kind, rule) {
      if (rules[kind] !== undefined) {
        throw new Error(`A task derivation rule for "${kind}" is already registered`);
      }
      rules[kind] = rule;
      return () => {
        if (rules[kind] === rule) delete rules[kind];
      };
    },
    rule<K extends ProblemKind>(kind: K) {
      return rules[kind] as DeriveTasks<K> | undefined;
    },
    missingKinds: () => PROBLEM_KINDS.filter((kind) => rules[kind] === undefined),
  };
  for (const kind of PROBLEM_KINDS) {
    const rule = initial[kind];
    if (rule !== undefined) registry.register(kind, rule as DeriveTasks<typeof kind>);
  }
  return registry;
}

/**
 * Rules registered here are used by `registerWork` when no explicit table is passed, mirroring
 * `defaultRegistry` in core. W5/W6 call this at module init or from their `register*` function.
 */
export const defaultTaskDerivations: TaskDerivationRegistry = createTaskDerivationRegistry();

export function registerTaskDerivation<K extends ProblemKind>(
  problemKind: K,
  rule: DeriveTasks<K>,
): Unregister {
  return defaultTaskDerivations.register(problemKind, rule);
}

const TERMINAL: ReadonlySet<Task["status"]> = new Set(["completed", "cancelled"]);
export const isTerminal = (task: Pick<Task, "status">): boolean => TERMINAL.has(task.status);

function deriveFor(
  ctx: StepCtx,
  rules: TaskDerivationRegistry,
  problem: Problem,
): TaskSpec[] | null {
  const rule = rules.rule(problem.kind) as DeriveTasks<ProblemKind> | undefined;
  if (rule === undefined) return null;
  return rule(problem as never, {
    content: ctx.content,
    config: ctx.config,
    tick: ctx.tick,
    state: ctx.state,
  });
}

function createTask(ctx: StepCtx, problem: Problem, spec: TaskSpec): void {
  const id = allocateId(ctx.state, "task");
  const task: Task = {
    ...structuredCopy(spec),
    id,
    problemId: problem.id,
    createdTick: ctx.tick,
    revision: problem.revision,
    status: "pending",
    claimState: { kind: "unclaimed" },
  };
  ctx.state.work.tasks[id] = task;
  emitSim(ctx, "taskCreated", [id, problem.id], {
    taskId: id,
    type: task.type,
    problemId: problem.id,
  });
}

/** Rules may return shared arrays (zone tiles from content); state must own its own copies. */
function structuredCopy(spec: TaskSpec): TaskSpec {
  return JSON.parse(JSON.stringify(spec)) as TaskSpec;
}

function refreshTask(task: Task, problem: Problem, spec: TaskSpec): void {
  Object.assign(task, structuredCopy(spec));
  task.revision = problem.revision;
  if (task.status === "cancelled") task.status = "pending";
}

function cancelTask(ctx: StepCtx, task: Task): void {
  releaseClaimsForTask(ctx, task, "cancelled");
  task.status = "cancelled";
}

function settleClosedProblem(ctx: StepCtx, problem: Problem, tasks: readonly Task[]): void {
  for (const task of tasks) {
    if (isTerminal(task)) continue;
    if (problem.status === "resolved") {
      // D63: a buyer's purchase resolves `partsNeeded` while the units are still in their hands
      // on the dock; their task lives until they have carried them aboard (its plan's end).
      const held =
        (task.type === "staffStation" || task.type === "buyParts") &&
        task.claimState.kind === "claimed";
      if (!held) completeTask(ctx, task);
    } else {
      cancelTask(ctx, task);
    }
  }
}

function referencedTaskIds(ctx: StepCtx): Set<TaskId> {
  const ids = new Set<TaskId>();
  for (const actor of Object.values(ctx.state.actors)) {
    const activity = actor.activity;
    if (activity.kind !== "task") continue;
    ids.add(activity.taskId);
    // D65: a hand-truck trip's other tasks are referenced too.
    for (const leg of activity.haul?.legs ?? []) ids.add(leg.taskId);
  }
  return ids;
}

function pruneTasks(ctx: StepCtx): void {
  const referenced = referencedTaskIds(ctx);
  const problems = ctx.state.work.problems;
  for (const task of Object.values(ctx.state.work.tasks)) {
    const problemOpen = problems[task.problemId]?.status === "open";
    if (isTerminal(task) && !problemOpen && !referenced.has(task.id)) {
      delete ctx.state.work.tasks[task.id];
    }
  }
}

/** One derivation pass over every problem. */
export function runDerivation(ctx: StepCtx, rules: TaskDerivationRegistry): void {
  const byProblem = new Map<ProblemId, Task[]>();
  for (const task of Object.values(ctx.state.work.tasks)) {
    const list = byProblem.get(task.problemId);
    if (list === undefined) byProblem.set(task.problemId, [task]);
    else list.push(task);
  }
  for (const problem of Object.values(ctx.state.work.problems)) {
    const tasks = byProblem.get(problem.id) ?? [];
    if (problem.status !== "open") {
      settleClosedProblem(ctx, problem, tasks);
      continue;
    }
    const specs = deriveFor(ctx, rules, problem);
    if (specs === null) continue;
    const keys = new Set<string>();
    for (const spec of specs) {
      keys.add(spec.derivationKey);
      const existing = tasks.find((t) => t.derivationKey === spec.derivationKey);
      if (existing === undefined) createTask(ctx, problem, spec);
      else if (existing.revision !== problem.revision || existing.status === "cancelled") {
        refreshTask(existing, problem, spec);
      }
    }
    for (const task of tasks) {
      if (!keys.has(task.derivationKey) && !isTerminal(task)) cancelTask(ctx, task);
    }
  }
  // Tasks whose problem row vanished entirely.
  for (const task of Object.values(ctx.state.work.tasks)) {
    if (ctx.state.work.problems[task.problemId] === undefined && !isTerminal(task)) {
      cancelTask(ctx, task);
    }
  }
  pruneTasks(ctx);
}

/** Every actor currently holding a claim on `taskId`. */
export function claimantsOf(ctx: Pick<StepCtx, "state">, taskId: TaskId): ActorId[] {
  return Object.values(ctx.state.work.claims)
    .filter((claim) => claim.taskId === taskId)
    .map((claim) => claim.ownerActorId);
}
