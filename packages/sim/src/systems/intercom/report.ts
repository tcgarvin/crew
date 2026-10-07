/**
 * D94: a report on the intercom (slice 5 call 12). The `report` step runs at the panel: a panel
 * that turns out dead or unpowered fails it (the reporter now knows, and the planner sends them
 * to the next); otherwise, at the step's end, every damage fact the reporter holds goes to every
 * crew member aboard as `report` evidence with its original `observedTick` (the `tellCrew`
 * pattern in `systems/work/execute.ts`), `alert.reports` is set for each compartment the report
 * covers, and `intercomReport` names the damage.
 *
 * The broadcast also makes each reported problem `public`: once the whole ship has heard it, it
 * is common knowledge, and that is the one marker that survives the next look (perception
 * rewrites a witness's facts as direct sight on every pass). The planner's reflex reports only
 * `discovered` damage (`planner/intercom.ts`), so nothing is reported twice.
 *
 * Owner: W3 of ship life slice 5.
 */
import type { Actor, KnownFact } from "../../core/types/actor";
import type { ReportedDamage } from "../../core/types/events/intercom";
import type { CompartmentId, MachineId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Machine } from "../../core/types/ship";
import type { ActivityStep, Problem, ProblemKind } from "../../core/types/work";
import { isMachineBlocked } from "../equipment/equipment";
import { emitSim } from "../work/events";
import { directSight, writeFact } from "../work/facts";
import { awaitsFamiliarityBrief } from "../work/perception";
import type { StepResult } from "../work/steps";

/** The problem kinds a report carries (the planner's `REPORTED_PROBLEM_KINDS`). */
const REPORTED: ReadonlySet<ProblemKind> = new Set<ProblemKind>([
  "machineDamaged",
  "hullScar",
  "machineSymptom",
]);

/** The panel the reporter's plan walks to (its `moveTo` onto a machine position). */
function panelOf(actor: Actor): MachineId | undefined {
  const activity = actor.activity;
  if (activity.kind !== "personal" || activity.plan === undefined) return undefined;
  for (const step of activity.plan.steps) {
    if (step.kind === "moveTo" && "machineId" in step.target) return step.target.machineId;
  }
  return undefined;
}

function panelWorks(ctx: StepCtx, panel: Machine): boolean {
  const def = ctx.content.machines[panel.defId];
  if (def === undefined) throw new Error(`intercom: panel ${panel.id} has no def ${panel.defId}`);
  return (
    panel.actualMode !== "off" &&
    panel.output > 0 &&
    !isMachineBlocked(panel, def, ctx.config.equipment)
  );
}

/** The compartment a machine stands in (its placement origin's, as the cache indexes it). */
function compartmentOf(ctx: StepCtx, machineId: MachineId): CompartmentId | undefined {
  for (const [compartmentId, ids] of Object.entries(ctx.caches.index.machinesByCompartment)) {
    if (ids.includes(machineId)) return compartmentId as CompartmentId;
  }
  return undefined;
}

/**
 * The damage the reporter can tell: open, still `discovered` damage problems raised since the
 * alert sounded that they saw for themselves. Nothing off alert (it stood down on the walk).
 */
function damageToReport(ctx: StepCtx, actor: Actor): Problem[] {
  const alert = ctx.state.alert;
  if (alert === undefined) return [];
  const out: Problem[] = [];
  for (const fact of Object.values(actor.knowledge)) {
    if (fact.factType !== "problem" || fact.evidence !== "direct") continue;
    const problem = ctx.state.work.problems[fact.value.problemId];
    if (problem === undefined || problem.status !== "open") continue;
    if (!REPORTED.has(problem.kind) || problem.visibility !== "discovered") continue;
    if (problem.createdTick < alert.sinceTick) continue;
    out.push(problem);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The machine a damage problem is about, if any. */
function machineOf(problem: Problem): MachineId | undefined {
  if (problem.kind === "machineDamaged" || problem.kind === "machineSymptom") {
    return problem.payload.machineId;
  }
  return undefined;
}

/** "out" is what the reporter last saw: the machine dead or shut down. */
function seenOut(actor: Actor, machineId: MachineId): boolean {
  const status = actor.knowledge[`${machineId}/machineStatus`];
  return (
    status?.factType === "machineStatus" &&
    (status.value.status === "failed" || status.value.status === "off")
  );
}

/** What the report names, one entry per machine and per scarred compartment. */
function describe(actor: Actor, problems: readonly Problem[]): ReportedDamage[] {
  const scars = new Set<CompartmentId>();
  const machines = new Set<MachineId>();
  for (const problem of problems) {
    if (problem.kind === "hullScar") scars.add(problem.payload.compartmentId);
    const machineId = machineOf(problem);
    if (machineId !== undefined) machines.add(machineId);
  }
  return [
    ...[...scars].map((compartmentId): ReportedDamage => ({ kind: "scar", compartmentId })),
    ...[...machines].map(
      (machineId): ReportedDamage => ({
        kind: "machine",
        machineId,
        out: seenOut(actor, machineId),
      }),
    ),
  ];
}

/** The reporter's fact, as `listener` hears it: the same observation, learned now, reported. */
function relayed(fact: KnownFact, reporter: Actor, tick: number): KnownFact {
  return {
    ...fact,
    learnedTick: tick,
    sourceId: reporter.id,
    evidence: "report",
    certainty: "reported",
  };
}

/** Every crew member aboard hears it (not passengers; not someone ashore or awaiting a brief). */
function listeners(ctx: StepCtx, reporter: Actor): Actor[] {
  return Object.values(ctx.state.actors).filter(
    (other) =>
      other.id !== reporter.id &&
      other.crew &&
      other.passenger !== true &&
      other.location.kind === "onDeck" &&
      !awaitsFamiliarityBrief(other),
  );
}

function broadcast(ctx: StepCtx, actor: Actor, panelId: MachineId): void {
  const problems = damageToReport(ctx, actor);
  if (problems.length === 0) return;
  const facts: KnownFact[] = [];
  const covered = new Set<CompartmentId>();
  for (const problem of problems) {
    const problemFact = actor.knowledge[`${problem.id}/problem`];
    if (problemFact !== undefined) facts.push(problemFact);
    const machineId = machineOf(problem);
    if (machineId !== undefined) {
      const status = actor.knowledge[`${machineId}/machineStatus`];
      if (status !== undefined && !facts.includes(status)) facts.push(status);
      const where = compartmentOf(ctx, machineId);
      if (where !== undefined) covered.add(where);
    }
    if (problem.kind === "hullScar") covered.add(problem.payload.compartmentId);
  }
  for (const listener of listeners(ctx, actor)) {
    for (const fact of facts) {
      const key = `${fact.subjectId}/${fact.factType}` as const;
      // Someone who has looked since knows better than the report.
      const held = listener.knowledge[key];
      if (held !== undefined && held.observedTick > fact.observedTick) continue;
      listener.knowledge[key] = relayed(fact, actor, ctx.tick);
    }
  }
  for (const problem of problems) problem.visibility = "public";
  const alert = ctx.state.alert;
  if (alert !== undefined) {
    for (const compartmentId of covered) alert.reports[compartmentId] = ctx.tick;
  }
  const panelRoom = compartmentOf(ctx, panelId);
  if (panelRoom === undefined) throw new Error(`intercom: panel ${panelId} is in no compartment`);
  emitSim(ctx, "intercomReport", [actor.id, panelId], {
    actorId: actor.id,
    panelId,
    compartmentId: panelRoom,
    damage: describe(actor, problems),
  });
}

export function runReport(
  ctx: StepCtx,
  actor: Actor,
  step: Extract<ActivityStep, { kind: "work" }>,
): StepResult {
  const panelId = panelOf(actor);
  const panel = panelId === undefined ? undefined : ctx.state.machines[panelId];
  if (panelId === undefined || panel === undefined) return { fail: "unreachableTarget" };
  if (!panelWorks(ctx, panel)) {
    // They see it is dead, so the planner's next look sends them to another panel.
    writeFact(
      actor,
      panelId,
      "machineStatus",
      {
        status: panel.actualMode === "off" ? "off" : "failed",
        temperatureNorm: panel.temperature,
      },
      directSight(actor, ctx.tick),
    );
    return { fail: "unavailablePower" };
  }
  step.ticksDone += 1;
  if (step.ticksDone < step.ticksNeeded) return "wait";
  broadcast(ctx, actor, panelId);
  return "done";
}
