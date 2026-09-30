/**
 * Minimal perception (SD §13), phase 6, once per planner cycle per actor. Stand-in until a real perception system
 * exists: an available, awake crew member on deck sees their own compartment and updates their
 * latest-belief table (W0 decision 16):
 *
 * - `itemLocation` for every on-deck item in the compartment; a believed item location in this
 *   compartment where the item is no longer seen is marked `absent` (a discrepancy);
 * - `machineStatus` for machines placed in the compartment (outward status only: output/mode and
 *   temperature, never hidden faults);
 * - `problem` for every open `discovered` problem located at a machine in the compartment
 *   (symptoms are audible/visible on the spot), emitting `problemObserved` when new or revised;
 * - `actorStatus` (availability, asleep, tile, idle) for other people in the compartment.
 *
 * W4a decision ("ship familiarity"): an actor with an empty knowledge table (a freshly spawned
 * crew member) is briefed once with `reported` locations of every on-deck item, standing in for
 * having loaded the ship's stores. Without it nobody would know where the rations are until they
 * happened to walk past them.
 */
import { dueActors } from "../../core/pipeline";
import type { Actor } from "../../core/types/actor";
import type { OnDeckLocation } from "../../core/types/common";
import type { CompartmentId, ItemId, MachineId } from "../../core/types/ids";
import type { DeckGeometry } from "../../core/types/nav";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { Machine } from "../../core/types/ship";
import { compartmentAt } from "../spatial/geometry";
import { isAsleep } from "./activity";
import { directSight, writeFact } from "./facts";
import { tileOf } from "./plans";

function outwardStatus(machine: Machine): "ok" | "degraded" | "failed" | "off" {
  if (machine.actualMode === "off") return "off";
  if (machine.output <= 0) return "failed";
  return machine.output < 1 ? "degraded" : "ok";
}

function brief(ctx: StepCtx, actor: Actor, deckId: OnDeckLocation["deckId"]): void {
  for (const item of Object.values(ctx.state.items)) {
    if (item.location.kind !== "onDeck" || item.location.deckId !== deckId) continue;
    writeFact(
      actor,
      item.id,
      "itemLocation",
      { location: item.location },
      {
        tick: ctx.tick,
        sourceId: actor.id,
        evidence: "report",
        certainty: "reported",
      },
    );
  }
}

function seeItems(ctx: StepCtx, actor: Actor, geometry: DeckGeometry, here: CompartmentId): void {
  const seen = new Set<ItemId>();
  const sight = directSight(actor, ctx.tick);
  for (const item of Object.values(ctx.state.items)) {
    const location = item.location;
    if (location.kind !== "onDeck" || location.deckId !== geometry.deckId) continue;
    if (compartmentAt(geometry, location.x, location.y) !== here) continue;
    seen.add(item.id);
    writeFact(actor, item.id, "itemLocation", { location }, sight);
  }
  for (const fact of Object.values(actor.knowledge)) {
    if (fact.factType !== "itemLocation" || fact.value.absent === true) continue;
    const believed = fact.value.location;
    if (believed.kind !== "onDeck" || believed.deckId !== geometry.deckId) continue;
    const itemId = fact.subjectId as ItemId;
    if (seen.has(itemId) || compartmentAt(geometry, believed.x, believed.y) !== here) continue;
    writeFact(actor, itemId, "itemLocation", { location: believed, absent: true }, sight);
  }
}

function seeMachinesAndProblems(ctx: StepCtx, actor: Actor, here: CompartmentId): void {
  const sight = directSight(actor, ctx.tick);
  const machineIds = new Set<MachineId>(ctx.caches.index.machinesByCompartment[here] ?? []);
  for (const machineId of machineIds) {
    const machine = ctx.state.machines[machineId];
    if (machine === undefined) continue;
    writeFact(
      actor,
      machineId,
      "machineStatus",
      {
        status: outwardStatus(machine),
        temperatureNorm: machine.temperature,
      },
      sight,
    );
  }
  for (const problem of Object.values(ctx.state.work.problems)) {
    if (problem.status !== "open" || problem.visibility !== "discovered") continue;
    const location = problem.location;
    const inView =
      (location.kind === "machine" && machineIds.has(location.machineId)) ||
      (location.kind === "compartment" && location.compartmentId === here);
    if (!inView) continue;
    const known = actor.knowledge[`${problem.id}/problem`];
    const isNew = known?.factType !== "problem" || known.value.revision !== problem.revision;
    writeFact(
      actor,
      problem.id,
      "problem",
      { problemId: problem.id, revision: problem.revision },
      sight,
    );
    if (isNew) {
      ctx.emit({
        type: "problemObserved",
        subjectIds: [actor.id, problem.id],
        causeIds: [],
        source: "sim",
        payload: { problemId: problem.id, kind: problem.kind },
      });
    }
  }
}

function seePeople(ctx: StepCtx, actor: Actor, here: CompartmentId): void {
  const sight = directSight(actor, ctx.tick);
  for (const otherId of ctx.caches.index.actorsByCompartment[here] ?? []) {
    const other = ctx.state.actors[otherId];
    if (other === undefined || other.id === actor.id || other.location.kind !== "onDeck") continue;
    writeFact(
      actor,
      other.id,
      "actorStatus",
      {
        availability: other.availability,
        asleep: isAsleep(other.activity),
        tile: tileOf(other.location),
        idle: other.activity.kind === "idle",
      },
      sight,
    );
  }
}

/** One actor's look around their compartment. */
export function observe(ctx: StepCtx, actor: Actor): void {
  const location = actor.location;
  if (location.kind !== "onDeck") return;
  const geometry = ctx.caches.nav.decks[location.deckId];
  if (geometry === undefined) return;
  if (Object.keys(actor.knowledge).length === 0) brief(ctx, actor, location.deckId);
  const here = compartmentAt(geometry, location.x, location.y);
  if (here === undefined) return;
  seeItems(ctx, actor, geometry, here);
  seeMachinesAndProblems(ctx, actor, here);
  seePeople(ctx, actor, here);
}

/**
 * W4a decision: runs every tick but observes only the actors whose planner is due this tick
 * (same `dueActors` stagger over `config.work.reconsiderEveryTicks` as the planner stage), so
 * every actor looks around in phase 6 of the very tick they plan in phase 7: plans are always
 * made on a fresh look, and the cost is spread across ticks.
 */
export const perceptionSystem: System = {
  name: "work.perception",
  phase: "perception",
  run(ctx) {
    const ids = Object.keys(ctx.state.actors) as Actor["id"][];
    for (const actorId of dueActors(ids, ctx.tick, ctx.config.work.reconsiderEveryTicks)) {
      const actor = ctx.state.actors[actorId];
      if (actor === undefined || !actor.crew || actor.availability !== "available") continue;
      if (isAsleep(actor.activity)) continue;
      observe(ctx, actor);
    }
  },
};
