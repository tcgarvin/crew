/**
 * D92, D93: the field's side of the hull bar (slice 5 calls 6, 10, 13, 24). Every impact costs
 * the hull once, recorded on a scar at its centre tile; the charge is clamped so the integrity
 * never goes below zero and the scar records what was actually lost, so the bar always equals
 * `max` less every scar's damage not recovered (`core/hull.ts`). At zero the ship is lost and the
 * kernel halts for good (`hull.lostAtTick`, `shipLost`).
 *
 * Owner: W1 of ship life slice 5.
 */
import { integrityFromScars } from "../../core/hull";
import { allocateId } from "../../core/ids";
import type { TileCoord } from "../../core/types/common";
import type { RockSize } from "../../core/types/content";
import type { CompartmentId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { ActiveField, HullScar } from "../../core/types/state";

/** Where a rock landed, for its scar. */
export interface ScarSite {
  readonly tile: TileCoord;
  readonly compartmentId: CompartmentId;
  readonly rock: RockSize;
}

/**
 * Charge the hull for one impact (`field.hullDamage[rock]`, at most what is left) and leave its
 * scar. Returns the scar, whose `damage` is the points actually lost.
 */
export function chargeHull(ctx: StepCtx, field: ActiveField, site: ScarSite): HullScar {
  const hull = ctx.state.hull;
  const cost = ctx.config.field.hullDamage[site.rock];
  const lost = Math.min(cost, hull.integrity);
  const scar: HullScar = {
    id: allocateId(ctx.state, "scar"),
    fieldId: field.id,
    tile: { x: site.tile.x, y: site.tile.y },
    compartmentId: site.compartmentId,
    rock: site.rock,
    damage: lost,
    recovered: 0,
    patched: false,
    tick: ctx.tick,
  };
  hull.scars.push(scar);
  hull.integrity = integrityFromScars(hull);
  field.hullLost += lost;
  return scar;
}

/** The loss check: a hull at zero is a lost ship (`lostAtTick`, `shipLost`), once. */
export function loseShipIfSunk(ctx: StepCtx, field: ActiveField): boolean {
  const hull = ctx.state.hull;
  if (hull.lostAtTick !== undefined) return true;
  if (hull.integrity > 0) return false;
  hull.lostAtTick = ctx.tick;
  ctx.emit({
    type: "shipLost",
    subjectIds: [field.id],
    causeIds: [],
    source: "sim",
    payload: { fieldId: field.id },
  });
  return true;
}

/**
 * `fieldCleared` with the hull as the field left it. A field nobody aboard ever noticed (no
 * sighting, no impact) ends as a trace: the narrator's record has it, but no hook fires and no
 * ticker line tells the player the ship is clear of rocks it never knew of.
 */
export function emitFieldCleared(
  ctx: StepCtx,
  field: ActiveField,
  how: "crossed" | "drifted",
): void {
  const hull = ctx.state.hull;
  ctx.emit({
    type: "fieldCleared",
    subjectIds: [field.id],
    causeIds: field.causeCommandId === undefined ? [] : [field.causeCommandId],
    source: "sim",
    ...(field.noticedAtTick === undefined ? { significance: "trace" as const } : {}),
    payload: {
      fieldId: field.id,
      how,
      impacts: field.impacts,
      hullLost: field.hullLost,
      integrity: hull.integrity,
      max: hull.max,
    },
  });
}
