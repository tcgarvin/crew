/**
 * D92: stuck is a clock, not a cliff (slice 5 call 9). With the engines out the ship makes no
 * way, stays in the rocks at `field.stuckRateFactor` of the rate, and after
 * `field.stuckDriftImpacts` impacts taken while stuck it drifts clear and the field ends. Engines
 * back, it is under way again and leaves by progress.
 *
 * The field reads travel and never writes it: travel already halts progress when propulsion is
 * lost (`drifting`), unless the ship limps on (D80), so "stuck" is "drifting and not limping"
 * in transit. A ship with its engines switched off by choice is as stuck as one with them shot
 * away, which is the design: stopping is never the safe play.
 *
 * Owner: W1 of ship life slice 5.
 */
import type { StepCtx } from "../../core/types/pipeline";
import type { ActiveField } from "../../core/types/state";

type ActivePhase = Extract<ActiveField["phase"], { kind: "active" }>;

/** Is the ship in transit and making no way (drifting, not limping)? */
export function makingNoWay(travel: StepCtx["state"]["travel"]): boolean {
  return travel.stage === "transit" && travel.drifting && travel.limping !== true;
}

/** Is the active field's ship stuck in it right now (as last updated)? */
export function isStuck(phase: ActivePhase): boolean {
  return phase.stuckSinceTick !== undefined;
}

/** Start or end the stuck spell for this tick: `shipStuck` / `shipUnstuck` on the change. */
export function updateStuck(ctx: StepCtx, field: ActiveField, phase: ActivePhase): void {
  const stuck = makingNoWay(ctx.state.travel);
  if (stuck === isStuck(phase)) return;
  if (stuck) {
    phase.stuckSinceTick = ctx.tick;
  } else {
    // biome-ignore lint/performance/noDelete: state must omit the key, never hold `undefined`.
    delete phase.stuckSinceTick;
  }
  ctx.emit({
    type: stuck ? "shipStuck" : "shipUnstuck",
    subjectIds: [field.id],
    causeIds: [],
    source: "sim",
    payload: { fieldId: field.id },
  });
}

/** Has the ship taken enough impacts while stuck to drift clear (call 9)? */
export function driftedClear(ctx: Pick<StepCtx, "config">, field: ActiveField): boolean {
  return field.stuckImpacts >= ctx.config.field.stuckDriftImpacts;
}
