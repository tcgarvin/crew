/**
 * The dirt system (D82), phase `equipment`, registered after the equipment systems. It runs its
 * pass every `config.dirt.updateEverySeconds` (checked against the tick inside `run`, since a
 * system's `every` is fixed at registration and the config is not known then).
 *
 * W2 fills this in: airborne dust near an open ramp while docked, capped per visit
 * (`state.dirt.dustThisVisit`, reset on undocking); each room's `roomDirt` and `tierOf` against
 * the stored tier, writing `state.dirt.tiers` and emitting `roomDirty` / `roomFilthy` /
 * `roomTidied` once per transition; `compartmentDirty` raised at `dirty`, revised on each tier
 * change (`baseUrgency` essential while `filthy` in a galley or infirmary), resolved below
 * `untidy` with `roomCleaned` when someone holds its task.
 *
 * Gate stub: a no-op, so nothing gets dirty until W2 lands.
 *
 * Owner: W2 of ship life slice 3.
 */
import { configTicks } from "../../core/clock";
import type { StepCtx, System } from "../../core/types/pipeline";

/** Is this a tick the dirt pass runs on (`dirt.updateEverySeconds`, at least every tick)? */
export function dirtPassDue(ctx: Pick<StepCtx, "config" | "tick">): boolean {
  const every = Math.max(1, configTicks(ctx.config, ctx.config.dirt.updateEverySeconds));
  return ctx.tick % every === 0;
}

export const dirtSystem: System = {
  name: "dirt",
  phase: "equipment",
  run(ctx) {
    if (!dirtPassDue(ctx)) return;
    // W2: dust, tiers and `compartmentDirty` (see the module comment).
  },
};
