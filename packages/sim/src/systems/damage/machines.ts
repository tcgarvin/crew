/**
 * §machine-damage: what a rock does to the crew's world beyond the hull: the two points where the
 * field (W1) calls into damage response.
 *
 * - `damageMachine`, for every graze, damage and knockout (call 7): integrity down, clamped to
 *   [0, 1], and the machine's `machineDamaged` problem raised (discovered, located at the
 *   machine, essential) or, when one is open already, revised so its repair re-derives at the
 *   new size (call 21).
 * - `onImpact`, once per impact after the hull is charged and the scar written (calls 4, 10, 11):
 *   the scar's `hullScar` problem (discovered, located at its compartment, essential on alert and
 *   routine otherwise); the `hullImpact` fact to everyone aboard, awake or asleep, with the
 *   compartment only for those in it; sleepers in the hit compartment woken (`abortActivity`),
 *   and everyone awake there takes a look round at once (`observe`), so they see the scar and
 *   whatever the rock did there without waiting for their next look.
 *
 * Owner: W2 of ship life slice 5.
 */
import type { Actor } from "../../core/types/actor";
import type { TileCoord } from "../../core/types/common";
import type { CompartmentId, FieldId, ScarId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Machine } from "../../core/types/ship";
import { shipDeckId } from "../../core/world";
import { compartmentAt, isDockTile } from "../spatial/geometry";
import { isAsleep } from "../work/activity";
import { abortActivity } from "../work/execute";
import { directSight, writeFact } from "../work/facts";
import { awaitsFamiliarityBrief, observe } from "../work/perception";
import { dedupeKeys, raiseOrRevise, scarUrgency } from "./problems";

/** One impact as damage response hears of it (W1 builds it after charging the hull). */
export interface ImpactReport {
  readonly fieldId: FieldId;
  readonly scarId: ScarId;
  readonly compartmentId: CompartmentId;
  /** The centre tile (ship deck frame). */
  readonly tile: TileCoord;
  /** Every tile the blast covered. */
  readonly tiles: readonly TileCoord[];
}

/**
 * Takes `integrityLoss` off `machine` (clamped to [0, 1]) and raises or revises its
 * `machineDamaged` problem (call 21). A loss that leaves the machine whole raises nothing.
 */
export function damageMachine(ctx: StepCtx, machine: Machine, integrityLoss: number): void {
  if (!(integrityLoss >= 0)) {
    throw new Error(`damageMachine: integrity loss must be >= 0, got ${integrityLoss}`);
  }
  machine.integrity = Math.min(1, Math.max(0, machine.integrity - integrityLoss));
  ctx.dirty.power = true;
  if (machine.integrity >= 1) return;
  raiseOrRevise(ctx, {
    kind: "machineDamaged",
    payload: { machineId: machine.id },
    dedupeKey: dedupeKeys.machineDamaged(machine.id),
    visibility: "discovered",
    baseUrgency: "essentialOperation",
    location: { kind: "machine", machineId: machine.id },
  });
}

/** Damage response to one impact (see the module comment). */
export function onImpact(ctx: StepCtx, impact: ImpactReport): void {
  const scar = ctx.state.hull.scars.find((s) => s.id === impact.scarId);
  if (scar === undefined) {
    throw new Error(`onImpact: scar ${impact.scarId} is not on the hull (charge it first)`);
  }
  raiseOrRevise(ctx, {
    kind: "hullScar",
    payload: { scarId: scar.id, compartmentId: impact.compartmentId, tile: { ...impact.tile } },
    dedupeKey: dedupeKeys.hullScar(scar.id),
    visibility: "discovered",
    baseUrgency: scarUrgency(ctx),
    location: { kind: "compartment", compartmentId: impact.compartmentId },
  });
  for (const { actor, here } of peopleAboard(ctx)) {
    // Their first look's familiarity brief must still run; a fact written now would stop it.
    if (awaitsFamiliarityBrief(actor)) continue;
    const inRoom = here === impact.compartmentId;
    writeFact(
      actor,
      impact.fieldId,
      "hullImpact",
      inRoom
        ? { fieldId: impact.fieldId, compartmentId: impact.compartmentId }
        : { fieldId: impact.fieldId },
      directSight(actor, ctx.tick),
    );
    if (!inRoom) continue;
    if (isAsleep(actor.activity)) abortActivity(ctx, actor, "interrupted");
    if (actor.crew && actor.availability === "available") observe(ctx, actor);
  }
}

/**
 * Everyone aboard who feels the ship shudder: on the ship's deck (not out on the dock alongside),
 * neither dead nor ashore; with the compartment they stand in.
 */
function peopleAboard(ctx: StepCtx): { actor: Actor; here: CompartmentId | undefined }[] {
  const deckId = shipDeckId(ctx.state);
  const geometry = ctx.caches.nav.decks[deckId];
  if (geometry === undefined)
    throw new Error(`onImpact: no geometry for the ship's deck ${deckId}`);
  const out: { actor: Actor; here: CompartmentId | undefined }[] = [];
  for (const actor of Object.values(ctx.state.actors)) {
    const location = actor.location;
    if (location.kind !== "onDeck" || location.deckId !== deckId) continue;
    if (actor.availability === "dead" || actor.availability === "offShip") continue;
    if (isDockTile(geometry, location.x, location.y)) continue;
    out.push({ actor, here: compartmentAt(geometry, location.x, location.y) });
  }
  return out;
}
