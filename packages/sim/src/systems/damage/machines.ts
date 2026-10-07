/**
 * D93: what a rock does to the crew's world beyond the hull: the two points where the field (W1)
 * calls into damage response. `damageMachine` for every graze, damage and knockout (call 7);
 * `onImpact` once per impact, after the hull is charged and the scar written (calls 4, 10, 11):
 * the `hullImpact` fact to everyone aboard, sleepers in the hit room woken, the scar's
 * `hullScar` problem.
 *
 * Gate stub: `damageMachine` lowers integrity and raises nothing; `onImpact` does nothing.
 *
 * Owner: W2 of ship life slice 5.
 */
import type { TileCoord } from "../../core/types/common";
import type { CompartmentId, FieldId, ScarId } from "../../core/types/ids";
import type { StepCtx } from "../../core/types/pipeline";
import type { Machine } from "../../core/types/ship";

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
 * Takes `integrityLoss` off `machine` (clamped to [0, 1]); W2 raises or revises its
 * `machineDamaged` problem (call 21).
 */
export function damageMachine(ctx: StepCtx, machine: Machine, integrityLoss: number): void {
  if (!(integrityLoss >= 0)) {
    throw new Error(`damageMachine: integrity loss must be >= 0, got ${integrityLoss}`);
  }
  machine.integrity = Math.min(1, Math.max(0, machine.integrity - integrityLoss));
  ctx.dirty.power = true;
}

/** Damage response to one impact (see the module comment). Gate stub: nothing. */
export function onImpact(_ctx: StepCtx, _impact: ImpactReport): void {}
