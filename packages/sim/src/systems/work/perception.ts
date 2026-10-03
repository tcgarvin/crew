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
 * D61: someone on the dock alongside (in no compartment) looks around the dock instead: its items
 * and people, as above; there are no machines or problems on a dock.
 *
 * W4a decision ("ship familiarity"): an actor with an empty knowledge table (a freshly spawned
 * crew member) is briefed once with `reported` locations of every on-deck item, standing in for
 * having loaded the ship's stores. Without it nobody would know where the rations are until they
 * happened to walk past them.
 */
import { dueActors } from "../../core/pipeline";
import type { Actor } from "../../core/types/actor";
import type { OnDeckLocation } from "../../core/types/common";
import type { ActorId, CompartmentId, ItemId, MachineId } from "../../core/types/ids";
import type { DeckGeometry } from "../../core/types/nav";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { Machine } from "../../core/types/ship";
import { compartmentAt, isDockTile } from "../spatial/geometry";
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

/** What one look covers: a compartment, or (D61) the dock alongside. */
type InView = (x: number, y: number) => boolean;

function seeItems(ctx: StepCtx, actor: Actor, geometry: DeckGeometry, inView: InView): void {
  const seen = new Set<ItemId>();
  const sight = directSight(actor, ctx.tick);
  for (const item of Object.values(ctx.state.items)) {
    const location = item.location;
    if (location.kind !== "onDeck" || location.deckId !== geometry.deckId) continue;
    if (!inView(location.x, location.y)) continue;
    seen.add(item.id);
    writeFact(actor, item.id, "itemLocation", { location }, sight);
  }
  for (const fact of Object.values(actor.knowledge)) {
    if (fact.factType !== "itemLocation" || fact.value.absent === true) continue;
    const believed = fact.value.location;
    if (believed.kind !== "onDeck" || believed.deckId !== geometry.deckId) continue;
    const itemId = fact.subjectId as ItemId;
    if (seen.has(itemId) || !inView(believed.x, believed.y)) continue;
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

function seePeople(ctx: StepCtx, actor: Actor, others: Iterable<ActorId>): void {
  const sight = directSight(actor, ctx.tick);
  for (const otherId of others) {
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

/** D61: everyone standing on the dock floor of this deck's graft. */
function peopleOnDock(ctx: StepCtx, geometry: DeckGeometry): ActorId[] {
  const out: ActorId[] = [];
  for (const other of Object.values(ctx.state.actors)) {
    const l = other.location;
    if (l.kind === "onDeck" && l.deckId === geometry.deckId && isDockTile(geometry, l.x, l.y)) {
      out.push(other.id);
    }
  }
  return out;
}

/**
 * One actor's look around their compartment, or around the dock if they stand on it (D61): dock
 * floor is in no compartment, and the dock is one open region with no machines, so someone there
 * sees the items and people on it. The hull stands between the dock and the ship both ways.
 */
export function observe(ctx: StepCtx, actor: Actor): void {
  const location = actor.location;
  if (location.kind !== "onDeck") return;
  const geometry = ctx.caches.nav.decks[location.deckId];
  if (geometry === undefined) return;
  if (Object.keys(actor.knowledge).length === 0) brief(ctx, actor, location.deckId);
  const here = compartmentAt(geometry, location.x, location.y);
  if (here === undefined) {
    if (!isDockTile(geometry, location.x, location.y)) return;
    seeItems(ctx, actor, geometry, (x, y) => isDockTile(geometry, x, y));
    seePeople(ctx, actor, peopleOnDock(ctx, geometry));
    return;
  }
  seeItems(ctx, actor, geometry, (x, y) => compartmentAt(geometry, x, y) === here);
  seeMachinesAndProblems(ctx, actor, here);
  seePeople(ctx, actor, ctx.caches.index.actorsByCompartment[here] ?? []);
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
