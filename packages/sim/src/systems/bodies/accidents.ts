/**
 * §accidents-aboard: wounds outside a fight, so the medbay runs on an ordinary voyage. Three
 * hazards, each rolled on a keyed draw of the `failures` stream (`keyedFloat`, so rolling never
 * moves any other system's draws), each chance doubled for someone whose fatigue is past
 * `urgency.needEssentialAbove`:
 *
 * - Hot work (the accidents system, phase `needs` after the bodies system, every half second): a
 *   crew member on a machine's `recipe` or `mend` work step while that machine's temperature is
 *   past its `heat.derateAbove`, at `accidents.hotWorkPerSecond`: a graze to an arm.
 * - A slip (the same system): a crew member carrying cargo (an item with a `cargoClass`, in hand or
 *   on the hand truck they push) in a room that is `filthy`, at `accidents.slipPerSecond`: a graze
 *   to a leg, `serious` while the ship is on alert for an asteroid field.
 * - Thrown (`thrownByImpact`, called by the field as each rock lands, `impacts.ts`): each crew
 *   member awake and on their feet in the struck room who is not braced at a machine (standing on
 *   an `operate` or `use` position), at `accidents.impactThrowChance`: a graze where
 *   `bodies.partTable` puts it, never the head.
 *
 * Every accident is `blunt`, so it never bleeds, and never lands on the head or on a part it would
 * take to its tolerance (that roll is no accident), so it never kills. It goes through
 * `applyDamage` (whose `wounded` is marked `narrated`), emits `accident` with the configured line
 * (`accidents.lines`, `{who}` and `{machine}` filled), and crew in the room take `sawCrewHurt`
 * (`witness.ts`). Passengers, the dock and the site's people are never hurt this way: nobody aboard
 * treats a passenger (§the-wounded-problem). Off (`accidents.enabled` false), nothing is rolled.
 */
import { isOnDock } from "../../core/docks";
import type { Actor } from "../../core/types/actor";
import type { DeepReadonly, TileCoord } from "../../core/types/common";
import {
  type AccidentHazard,
  BODY_PARTS,
  type BodyPart,
  type WoundSeverity,
} from "../../core/types/content";
import type { CompartmentId, MachineId } from "../../core/types/ids";
import type { StepCtx, System } from "../../core/types/pipeline";
import type { Item, Machine } from "../../core/types/ship";
import { shipDeckId } from "../../core/world";
import { positionTiles } from "../galley/kitchen";
import { currentStep, isAsleep } from "../work/activity";
import { emitSim } from "../work/events";
import { BODIES_EVERY_TICKS } from "./bodies";
import { applyDamage } from "./damage";
import { roomOf, witnessHurt } from "./witness";

export const accidentsSystem: System = {
  name: "bodies.accidents",
  phase: "needs",
  every: BODIES_EVERY_TICKS,
  run(ctx) {
    if (!ctx.config.accidents.enabled) return;
    const dt = ctx.elapsedTicks / ctx.config.time.tickRate;
    for (const actor of sortedActors(ctx)) {
      if (!onTheirFeetAboard(ctx, actor)) continue;
      const hot = hotMachineAtWork(ctx, actor);
      if (hot !== undefined) {
        const p = perStep(ctx.config.accidents.hotWorkPerSecond, actor, ctx, dt);
        if (roll(ctx, actor, "hotWork", p)) {
          hurt(ctx, actor, "hotWork", "graze", side(ctx, actor, "hotWork", "arm"), hot);
          continue;
        }
      }
      if (carryingCargo(ctx, actor) && inFilthyRoom(ctx, actor)) {
        const p = perStep(ctx.config.accidents.slipPerSecond, actor, ctx, dt);
        if (roll(ctx, actor, "slip", p)) {
          const severity: WoundSeverity = ctx.state.alert?.cause === "field" ? "serious" : "graze";
          hurt(ctx, actor, "slip", severity, side(ctx, actor, "slip", "leg"));
        }
      }
    }
  },
};

/**
 * §accidents-aboard: a rock has struck `compartmentId`; each crew member awake on their feet there
 * and not braced at a machine may be thrown. Called by the field as the impact lands.
 */
export function thrownByImpact(ctx: StepCtx, compartmentId: CompartmentId): void {
  const accidents = ctx.config.accidents;
  if (!accidents.enabled) return;
  const here = ctx.caches.index.actorsByCompartment[compartmentId] ?? [];
  const braced = bracedTiles(ctx);
  for (const actor of sortedActors(ctx)) {
    if (!here.includes(actor.id) || !onTheirFeetAboard(ctx, actor)) continue;
    if (actor.location.kind !== "onDeck") continue;
    const tile = `${Math.floor(actor.location.x)},${Math.floor(actor.location.y)}`;
    if (braced.has(tile)) continue;
    const p = Math.min(1, accidents.impactThrowChance * tiredFactor(ctx, actor));
    if (!roll(ctx, actor, "thrown", p)) continue;
    hurt(ctx, actor, "thrown", "graze", thrownPart(ctx, actor));
  }
}

/** Living crew in id order, so the rolls and the events come out the same every run. */
function sortedActors(ctx: StepCtx): Actor[] {
  return Object.values(ctx.state.actors).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Crew (not a passenger), up and awake, on the ship's own floor, not in a fight. */
function onTheirFeetAboard(ctx: StepCtx, actor: DeepReadonly<Actor>): boolean {
  if (!actor.crew || actor.passenger === true || actor.combatant !== undefined) return false;
  if (actor.availability !== "available" || isAsleep(actor.activity)) return false;
  const location = actor.location;
  if (location.kind !== "onDeck" || location.deckId !== shipDeckId(ctx.state)) return false;
  return !isOnDock(ctx.content, ctx.state, location);
}

/** Fatigue past the essential threshold doubles every chance. */
function tiredFactor(ctx: StepCtx, actor: DeepReadonly<Actor>): number {
  return actor.needs.fatigue > ctx.config.urgency.needEssentialAbove ? 2 : 1;
}

/** A per-second chance over `dt` seconds, so a chance of 1 is certain and 0 never. */
function perStep(perSecond: number, actor: DeepReadonly<Actor>, ctx: StepCtx, dt: number): number {
  const rate = Math.min(1, perSecond * tiredFactor(ctx, actor));
  return 1 - (1 - rate) ** dt;
}

function roll(ctx: StepCtx, actor: DeepReadonly<Actor>, hazard: AccidentHazard, p: number) {
  return ctx.rng.keyedFloat("failures", `accident:${hazard}:${actor.id}`, ctx.tick) < p;
}

/** Left or right `limb`, on a keyed draw. */
function side(
  ctx: StepCtx,
  actor: DeepReadonly<Actor>,
  hazard: AccidentHazard,
  limb: "arm" | "leg",
): BodyPart {
  const left = ctx.rng.keyedFloat("failures", `accident:${hazard}:${actor.id}:side`, ctx.tick);
  if (limb === "arm") return left < 0.5 ? "leftArm" : "rightArm";
  return left < 0.5 ? "leftLeg" : "rightLeg";
}

/** Where a throw lands: `bodies.partTable` without the head, on a keyed draw. */
function thrownPart(ctx: StepCtx, actor: DeepReadonly<Actor>): BodyPart {
  const table = ctx.config.bodies.partTable;
  const parts = BODY_PARTS.filter((part) => part !== "head");
  const total = parts.reduce((sum, part) => sum + table[part], 0);
  if (total <= 0) throw new Error("accidents: bodies.partTable gives no weight below the head");
  let at = ctx.rng.keyedFloat("failures", `accident:thrown:${actor.id}:part`, ctx.tick) * total;
  for (const part of parts) {
    at -= table[part];
    if (at < 0) return part;
  }
  return parts[parts.length - 1] as BodyPart;
}

/** The machine `actor` is repairing or mending right now, when it runs past its derate heat. */
function hotMachineAtWork(ctx: StepCtx, actor: DeepReadonly<Actor>): Machine | undefined {
  const activity = actor.activity;
  if (activity.kind !== "task") return undefined;
  const step = currentStep(activity);
  if (step?.kind !== "work" || (step.stage !== "recipe" && step.stage !== "mend")) return undefined;
  const task = ctx.state.work.tasks[activity.taskId];
  if (task?.target.kind !== "machine") return undefined;
  const machine = ctx.state.machines[task.target.machineId];
  if (machine === undefined) return undefined;
  const def = ctx.content.machines[machine.defId];
  if (def === undefined) throw new Error(`accidents: no machine def ${machine.defId}`);
  return machine.temperature > def.heat.derateAbove ? machine : undefined;
}

/** Is `item` in `actor`'s hands, or in a container (the hand truck) they hold? */
function heldBy(ctx: StepCtx, item: DeepReadonly<Item>, actor: DeepReadonly<Actor>): boolean {
  const location = item.location;
  if (location.kind === "carriedBy") return location.actorId === actor.id;
  if (location.kind !== "inContainer") return false;
  const container = ctx.state.items[location.containerId];
  return container?.location.kind === "carriedBy" && container.location.actorId === actor.id;
}

function carryingCargo(ctx: StepCtx, actor: DeepReadonly<Actor>): boolean {
  return Object.values(ctx.state.items).some(
    (item) => ctx.content.items[item.defId]?.cargoClass !== undefined && heldBy(ctx, item, actor),
  );
}

function inFilthyRoom(ctx: StepCtx, actor: DeepReadonly<Actor>): boolean {
  const room = roomOf(ctx, actor.id);
  if (room === undefined) return false;
  const key = ctx.state.compartments[room]?.key;
  return key !== undefined && ctx.state.dirt.tiers[key] === "filthy";
}

/** The `operate` and `use` tiles of the ship's machines, where someone is braced. */
function bracedTiles(ctx: StepCtx): Set<string> {
  const deckId = shipDeckId(ctx.state);
  const tiles = new Set<string>();
  const key = (t: TileCoord) => `${t.x},${t.y}`;
  for (const machine of Object.values(ctx.state.machines)) {
    if (machine.deckId !== deckId) continue;
    for (const t of positionTiles(ctx.state, ctx.content, machine.id, "operate")) tiles.add(key(t));
    for (const t of positionTiles(ctx.state, ctx.content, machine.id, "use")) tiles.add(key(t));
  }
  return tiles;
}

/**
 * Land the accident: unless it would take `part` to its tolerance (then nothing happens), a
 * `blunt` hit through `applyDamage`, the `accident` event with its line, and the witnesses.
 */
function hurt(
  ctx: StepCtx,
  actor: Actor,
  hazard: AccidentHazard,
  severity: WoundSeverity,
  part: BodyPart,
  machine?: Machine,
): void {
  const bodies = ctx.config.bodies;
  if (actor.body.parts[part].damage + bodies.severityDamage[severity] >= bodies.tolerance[part]) {
    return;
  }
  const how = lineFor(ctx, hazard, actor, machine);
  const machineId: { machineId?: MachineId } =
    machine === undefined ? {} : { machineId: machine.id };
  emitSim(ctx, "accident", machine === undefined ? [actor.id] : [actor.id, machine.id], {
    actorId: actor.id,
    hazard,
    how,
    ...machineId,
  });
  applyDamage(ctx, actor.id, { severity, type: "blunt", part, narrated: true });
  witnessHurt(ctx, actor);
}

function lineFor(
  ctx: StepCtx,
  hazard: AccidentHazard,
  actor: DeepReadonly<Actor>,
  machine: DeepReadonly<Machine> | undefined,
): string {
  const name = machine === undefined ? "" : (ctx.content.machines[machine.defId]?.name ?? "");
  return ctx.config.accidents.lines[hazard]
    .replaceAll("{who}", actor.name)
    .replaceAll("{machine}", name.toLowerCase());
}
