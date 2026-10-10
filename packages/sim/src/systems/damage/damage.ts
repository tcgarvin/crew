/**
 * §machine-damage, §scouts: damage response, every tick in the `needs` phase (after cabins). Each
 * pass:
 *
 * 1. A `machineDamaged` whose machine is whole again (mended, or an overheat repair that restored
 *    it, §integrity) is resolved.
 * 2. On alert, recreation ends: every `recreate` activity is stopped (its session closes through
 *    `leaveRecreation`), and the planner offers none until the alert clears (`planner/alert.ts`).
 * 3. Each scar's `hullScar` follows the alert: essential while it stands, routine after; a scar
 *    plated away resolves its problem.
 * 4. Scouts (call 11). While the officer of the watch holds the bridge (a `bridge` hold),
 *    `compartmentToCheck` (public, essential, dedupe `check:<compartmentId>`) is raised for each
 *    compartment of the ship nobody has covered since the field's `lastImpactTick`: no intercom
 *    report (`alert.reports`), no crew member in it (awake on duty, or anyone of the crew at all:
 *    an off-watch hand sees a hit in their room and a sleeper there wakes, so either reports it),
 *    nobody of the crew who was in it when the rock hit (their `hullImpact` fact names it), and
 *    no check raised for it since. While the rocks still fall a room is looked at once a field
 *    (no check since the alert sounded); once the field has ended, every room not covered since
 *    the last rock gets one more look (slice-5 integration: re-checking every room after every
 *    rock sent ~35 scouts a heavy field, walking noise that drowned the ticker). An open check
 *    resolves on a report, when one of the crew stands in the room and nobody holds its task (a
 *    scout who holds it resolves it at the end of the look round, `steps.ts` `runCheck`), and
 *    every open check resolves when the alert clears. `scoutSent` names the officer and the scout
 *    the tick a scout claims a check.
 * 5. `hullDamaged` (call 23): docked at a port whose market has a `plating` item in stock, with
 *    fewer plates aboard than scars, the shortfall is a problem for that item (routine, public,
 *    located at the port), revised to the live count and resolved once nothing is short or the
 *    ship is not docked there.
 *
 * Owner: W2 of ship life slice 5.
 */
import { effectiveMarket } from "../../core/markets";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly, Tick } from "../../core/types/common";
import type { ActorId, CompartmentId, ItemDefId } from "../../core/types/ids";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { ProblemOfKind } from "../../core/types/work";
import { shipDeckId } from "../../core/world";
import { unitsAboard } from "../equipment/supplies";
import { isOfficerOfTheWatch } from "../watch/helm";
import { currentHold } from "../work/activity";
import { isTerminal } from "../work/derivation";
import { emitSim } from "../work/events";
import { abortActivity } from "../work/execute";
import { dedupeKeys, raiseOrRevise, resolve, scarUrgency } from "./problems";

/** The problems this pass reads, from one walk over the table. */
interface Owned {
  readonly machineDamaged: ProblemOfKind<"machineDamaged">[];
  readonly hullScar: ProblemOfKind<"hullScar">[];
  readonly hullDamaged: ProblemOfKind<"hullDamaged">[];
  /** Every check ever raised, open or not: when one was raised is the scouts' memory. */
  readonly checks: ProblemOfKind<"compartmentToCheck">[];
}

function owned(ctx: StepCtx): Owned {
  const out: Owned = { machineDamaged: [], hullScar: [], hullDamaged: [], checks: [] };
  for (const problem of Object.values(ctx.state.work.problems)) {
    if (problem.owner !== "damage") continue;
    if (problem.kind === "compartmentToCheck") out.checks.push(problem);
    else if (problem.status !== "open") continue;
    else if (problem.kind === "machineDamaged") out.machineDamaged.push(problem);
    else if (problem.kind === "hullScar") out.hullScar.push(problem);
    else if (problem.kind === "hullDamaged") out.hullDamaged.push(problem);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Machines, recreation and scars
// ---------------------------------------------------------------------------------------------

function settleMended(ctx: StepCtx, open: readonly ProblemOfKind<"machineDamaged">[]): void {
  for (const problem of open) {
    const machine = ctx.state.machines[problem.payload.machineId];
    if (machine === undefined || machine.integrity >= 1) resolve(ctx, problem);
  }
}

function endRecreation(ctx: StepCtx): void {
  for (const actor of Object.values(ctx.state.actors)) {
    const activity = actor.activity;
    if (activity.kind === "personal" && activity.activity === "recreate") {
      abortActivity(ctx, actor, "interrupted");
    }
  }
}

function syncScars(ctx: StepCtx, open: readonly ProblemOfKind<"hullScar">[]): void {
  const urgency = scarUrgency(ctx);
  const scars = new Set(ctx.state.hull.scars.map((s) => s.id));
  for (const problem of open) {
    if (!scars.has(problem.payload.scarId)) {
      resolve(ctx, problem);
      continue;
    }
    if (problem.baseUrgency === urgency) continue;
    problem.baseUrgency = urgency;
    problem.revision += 1;
  }
}

// ---------------------------------------------------------------------------------------------
// Scouts
// ---------------------------------------------------------------------------------------------

/**
 * Any crew member aboard, on watch or off, awake or asleep: a rock in their room is seen (a
 * sleeper there wakes, `onImpact`) and reported, so the room needs no scout.
 */
function crewAboard(actor: DeepReadonly<Actor>): boolean {
  return actor.crew && actor.passenger !== true && actor.availability === "available";
}

function eyesIn(ctx: StepCtx, compartmentId: CompartmentId): boolean {
  const ids = ctx.caches.index.actorsByCompartment[compartmentId] ?? [];
  return ids.some((id) => {
    const actor = ctx.state.actors[id];
    return actor !== undefined && crewAboard(actor);
  });
}

/** Someone on duty was in the room when the last rock hit (their `hullImpact` places it). */
function sawTheHit(ctx: StepCtx, compartmentId: CompartmentId, since: Tick): boolean {
  const fieldId = ctx.state.field?.id;
  if (fieldId === undefined) return false;
  return Object.values(ctx.state.actors).some((actor) => {
    const fact = actor.knowledge[`${fieldId}/hullImpact`];
    return (
      fact?.factType === "hullImpact" &&
      fact.observedTick >= since &&
      fact.value.compartmentId === compartmentId &&
      crewAboard(actor)
    );
  });
}

const reported = (ctx: StepCtx, compartmentId: CompartmentId, since: Tick): boolean =>
  (ctx.state.alert?.reports[compartmentId] ?? -1) >= since;

/** The officer of the watch, if they are holding the bridge now. */
function officerOnTheBridge(ctx: StepCtx): Actor | undefined {
  return Object.values(ctx.state.actors).find(
    (actor) => currentHold(actor.activity) === "bridge" && isOfficerOfTheWatch(ctx, actor.id),
  );
}

function officerOfTheWatch(ctx: StepCtx): ActorId | undefined {
  return (Object.keys(ctx.state.actors) as ActorId[]).find((id) => isOfficerOfTheWatch(ctx, id));
}

/** Does anyone hold a claim on one of the problem's live tasks? */
function heldByAnyone(ctx: StepCtx, problem: { readonly id: string }): boolean {
  const tasks = new Set<string>();
  for (const task of Object.values(ctx.state.work.tasks)) {
    if (task.problemId === problem.id && !isTerminal(task)) tasks.add(task.id);
  }
  return Object.values(ctx.state.work.claims).some((claim) => tasks.has(claim.taskId));
}

/** `scoutSent` for every check task claimed this tick. */
function announceScouts(ctx: StepCtx, open: readonly ProblemOfKind<"compartmentToCheck">[]): void {
  if (open.length === 0) return;
  const byProblem = new Map<string, ProblemOfKind<"compartmentToCheck">>(
    open.map((p) => [p.id, p]),
  );
  let officer: ActorId | undefined;
  for (const claim of Object.values(ctx.state.work.claims)) {
    if (claim.claimedTick !== ctx.tick) continue;
    const task = ctx.state.work.tasks[claim.taskId];
    const problem = task === undefined ? undefined : byProblem.get(task.problemId);
    if (task?.type !== "checkCompartment" || problem === undefined) continue;
    officer ??= officerOfTheWatch(ctx);
    // With nobody holding the watch there is no officer to have sent them.
    if (officer === undefined) return;
    const { compartmentId } = problem.payload;
    emitSim(ctx, "scoutSent", [officer, claim.ownerActorId, compartmentId], {
      officerId: officer,
      scoutId: claim.ownerActorId,
      compartmentId,
    });
  }
}

function sweepChecks(ctx: StepCtx, checks: readonly ProblemOfKind<"compartmentToCheck">[]): void {
  const open = checks.filter((p) => p.status === "open");
  if (ctx.state.alert === undefined) {
    for (const problem of open) resolve(ctx, problem);
    return;
  }
  announceScouts(ctx, open);
  const since = ctx.state.field?.lastImpactTick;
  if (since === undefined) return;
  const pending = new Set<CompartmentId>();
  for (const problem of open) {
    const { compartmentId } = problem.payload;
    const covered =
      reported(ctx, compartmentId, since) ||
      (eyesIn(ctx, compartmentId) && !heldByAnyone(ctx, problem));
    if (covered) resolve(ctx, problem);
    else pending.add(compartmentId);
  }
  if (officerOnTheBridge(ctx) === undefined) return;
  // While the rocks fall, one look a room a field; after, one more for rooms hit since.
  const lookedSince =
    ctx.state.field?.phase.kind === "active" ? Math.min(since, ctx.state.alert.sinceTick) : since;
  const checked = new Set<CompartmentId>();
  for (const problem of checks) {
    if (problem.createdTick >= lookedSince) checked.add(problem.payload.compartmentId);
  }
  const deckId = shipDeckId(ctx.state);
  for (const compartment of Object.values(ctx.state.compartments)) {
    const id = compartment.id;
    if (compartment.deckId !== deckId || pending.has(id) || checked.has(id)) continue;
    if (reported(ctx, id, since) || eyesIn(ctx, id) || sawTheHit(ctx, id, since)) continue;
    raiseOrRevise(ctx, {
      kind: "compartmentToCheck",
      payload: { compartmentId: id },
      dedupeKey: dedupeKeys.compartmentToCheck(id),
      visibility: "public",
      baseUrgency: "essentialOperation",
      location: { kind: "compartment", compartmentId: id },
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Plating at port
// ---------------------------------------------------------------------------------------------

const isPlating = (ctx: StepCtx, defId: ItemDefId): boolean =>
  ctx.content.items[defId]?.tags.includes("plating") === true;

/** The plates to buy here: one per scar beyond the plates aboard, of a line in stock. */
function platingShortfall(ctx: StepCtx): { itemDefId: ItemDefId; count: number } | undefined {
  const travel = ctx.state.travel;
  if (travel.stage !== "docked" || ctx.state.hull.scars.length === 0) return undefined;
  let plates = 0;
  for (const [defId, units] of unitsAboard(ctx.state)) {
    if (isPlating(ctx, defId)) plates += units;
  }
  const short = ctx.state.hull.scars.length - plates;
  if (short <= 0) return undefined;
  const line = Object.entries(effectiveMarket(ctx.state, ctx.content, travel.portId))
    .filter(([defId, stock]) => stock.count > 0 && isPlating(ctx, defId as ItemDefId))
    .map(([defId]) => defId as ItemDefId)
    .sort()[0];
  return line === undefined ? undefined : { itemDefId: line, count: short };
}

function sweepHullDamaged(ctx: StepCtx, open: readonly ProblemOfKind<"hullDamaged">[]): void {
  const wanted = platingShortfall(ctx);
  let kept = false;
  for (const problem of open) {
    if (wanted === undefined || problem.payload.itemDefId !== wanted.itemDefId) {
      resolve(ctx, problem);
      continue;
    }
    kept = true;
    if (problem.payload.count !== wanted.count) {
      problem.payload = { ...problem.payload, count: wanted.count };
      problem.revision += 1;
    }
  }
  const travel = ctx.state.travel;
  if (kept || wanted === undefined || travel.stage !== "docked") return;
  raiseOrRevise(ctx, {
    kind: "hullDamaged",
    payload: wanted,
    dedupeKey: dedupeKeys.hullDamaged(wanted.itemDefId),
    visibility: "public",
    baseUrgency: "routineObligation",
    location: { kind: "port", portId: travel.portId },
  });
}

export const damageSystem: System = {
  name: "damage.response",
  phase: "needs",
  run(ctx) {
    const problems = owned(ctx);
    settleMended(ctx, problems.machineDamaged);
    if (ctx.state.alert !== undefined) endRecreation(ctx);
    syncScars(ctx, problems.hullScar);
    sweepChecks(ctx, problems.checks);
    sweepHullDamaged(ctx, problems.hullDamaged);
  },
};
